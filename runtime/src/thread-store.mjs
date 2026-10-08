import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const THREAD_STATES = Object.freeze(['IDLE', 'RUNNING', 'PAUSED', 'FAILED', 'COMPLETED']);
const CHECKPOINT_PHASES = Object.freeze(['CLASSIFYING', 'PRECHECKING', 'ROUTING', 'ALLOCATING_CONTEXTS', 'PLANNING', 'EXECUTING', 'VERIFYING', 'DIAGNOSING', 'RECOVERING']);
const CHECKPOINT_FORBIDDEN = /(?:prompt|message|reasoning|credential|password|secret|token|authorization|api[_-]?key|private[_-]?key)/i;
// Classify the legacy progress marker separately from a real planner DAG.
// PLAN is a shape hint for the UI; execution still validates the full DAG.
export const checkpointResumeMode = (checkpoint) => {
  if (!checkpoint) return 'NONE';
  const plan = checkpoint.plan;
  if (plan && !Array.isArray(plan) && Array.isArray(plan.steps ?? plan.plan)
    && (plan.steps ?? plan.plan).length > 0) return 'PLAN';
  if (['CLASSIFYING', 'PRECHECKING', 'ROUTING', 'ALLOCATING_CONTEXTS', 'PLANNING'].includes(checkpoint.phase)
    && Array.isArray(plan) && plan.length === 1 && plan[0]?.id === 'classify'
    && plan[0]?.status === 'RUNNING' && /^sha256:[0-9a-f]{64}$/u.test(plan[0]?.actionDigest ?? '')) {
    return 'PREPARATION';
  }
  return 'INVALID';
};
const checkpointDigest = (value) => {
  const { checkpointDigest: _ignored, ...unsigned } = value;
  return `sha256:${createHash('sha256').update(canonical(unsigned), 'utf8').digest('hex')}`;
};
const titleDigest = (value) => `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;
// Storage pages are ordered by random run ID for stable pagination, not time.
// A thread can span several runs; replay it in the same order as its history.
export const compareThreadEvents = (a, b) => a.emittedAtMs - b.emittedAtMs
  || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0) || a.sequence - b.sequence;
export const checkpointClearApplies = (checkpointRunId, event) => {
  const clearingRunId = event.payload?.runId ?? event.runId;
  return !checkpointRunId || clearingRunId === checkpointRunId
    || clearingRunId === `thread:${event.payload?.threadId}`;
};
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';

const safeCheckpoint = (value, depth = 0) => {
  if (depth > 5) throw new Error('THREAD_CHECKPOINT_TOO_DEEP');
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, 1000);
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error('THREAD_CHECKPOINT_TOO_LARGE');
    return value.map((item) => safeCheckpoint(item, depth + 1));
  }
  if (typeof value !== 'object') throw new Error('THREAD_CHECKPOINT_INVALID');
  const result = {};
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error('THREAD_CHECKPOINT_TOO_LARGE');
  for (const [key, child] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(key) || CHECKPOINT_FORBIDDEN.test(key)) throw new Error(`THREAD_CHECKPOINT_FORBIDDEN_FIELD:${key}`);
    // JSON.stringify omits undefined object properties.  Omit them here too
    // so the signed checkpoint representation is stable across reloads.
    if (child === undefined) continue;
    result[key] = safeCheckpoint(child, depth + 1);
  }
  return result;
};

export class ThreadStore {
  #storagePath;
  #threads = new Map();
  #loaded = false;
  #loadPromise;
  #queue = Promise.resolve();
  #eventStore;
  constructor({ storagePath, eventStore } = {}) { this.#storagePath = storagePath; this.#eventStore = eventStore; }
  async load() {
    if (this.#loaded) return;
    // Coalesce concurrent calls in one process and only mark the store loaded
    // after a complete, validated snapshot is installed.  A failed load must
    // remain retryable instead of poisoning all subsequent operations.
    if (!this.#loadPromise) {
      this.#loadPromise = (async () => {
        if (this.#eventStore?.list) {
          let events;
          try { events = await this.#eventStore.list(); } catch { throw new Error('THREAD_STORE_INVALID'); }
          events = [...events].sort(compareThreadEvents);
          const restoredThreads = new Map();
          const titleDigests = new Map();
          for (const event of events) {
            const payload = event.payload ?? {};
            if (event.kind !== 'ThreadCreated') continue;
            if (typeof payload.threadId !== 'string' || !payload.threadId) continue;
            if (typeof payload.titleDigest === 'string') titleDigests.set(payload.threadId, payload.titleDigest);
            const thread = {
              id: payload.threadId,
              title: `Thread ${payload.threadId.slice(-8)}`,
              cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
              turns: Array.isArray(payload.turns) ? structuredClone(payload.turns) : [],
              state: THREAD_STATES.includes(payload.state) ? payload.state : 'IDLE',
              createdAtMs: Number.isFinite(payload.createdAtMs) ? payload.createdAtMs : event.emittedAtMs,
              updatedAtMs: Number.isFinite(payload.updatedAtMs) ? payload.updatedAtMs : event.emittedAtMs,
              ...(typeof payload.forkedFrom === 'string' ? { forkedFrom: payload.forkedFrom } : {})
            };
            restoredThreads.set(thread.id, thread);
          }
          for (const event of events) {
            const payload = event.payload ?? {};
            if (event.kind === 'ThreadCreated') continue;
            const thread = restoredThreads.get(payload.threadId);
            if (!thread) continue;
            if (event.kind === 'ThreadTurnAppended' && payload.turn?.id) {
              if (!thread.turns.some((turn) => turn.id === payload.turn.id)) thread.turns.push(structuredClone(payload.turn));
            } else if (event.kind === 'ThreadStateChanged') {
              if (THREAD_STATES.includes(payload.state)) thread.state = payload.state;
              if (typeof payload.activeRunId === 'string' && payload.activeRunId) thread.activeRunId = payload.activeRunId;
              else delete thread.activeRunId;
              if (typeof payload.stateReason === 'string' && payload.stateReason) thread.stateReason = payload.stateReason;
            } else if (event.kind === 'ThreadCheckpointCommitted') {
              if (THREAD_STATES.includes(payload.state)) thread.state = payload.state;
              if (typeof payload.runId === 'string' && payload.runId) thread.activeRunId = payload.runId;
              const checkpoint = payload.checkpoint;
              if (checkpoint && checkpoint.checkpointDigest === checkpointDigest(checkpoint)) {
                thread.checkpoint = structuredClone(checkpoint);
                thread.state = THREAD_STATES.includes(checkpoint.state) ? checkpoint.state : 'RUNNING';
              }
            } else if (event.kind === 'ThreadCheckpointCleared') {
              // A late completion from another run must not clear this run's
              // checkpoint or overwrite its state with COMPLETED.
              if (!checkpointClearApplies(thread.checkpoint?.runId, event)) continue;
              delete thread.checkpoint;
              if (THREAD_STATES.includes(payload.state)) thread.state = payload.state;
              delete thread.activeRunId;
            } else {
              continue;
            }
            if (Number.isFinite(payload.updatedAtMs)) thread.updatedAtMs = Math.max(thread.updatedAtMs ?? 0, payload.updatedAtMs);
          }
          if (restoredThreads.size > 0) {
            // The event stream remains authoritative for membership, turns,
            // state and checkpoints. A matching local snapshot contributes
            // only the user-visible title because ThreadCreated intentionally
            // persists its digest instead of the original prompt text.
            if (this.#storagePath) {
              try {
                const local = await readPersistentJsonFile(this.#storagePath);
                if (local?.schemaVersion === '1.0' && Array.isArray(local.threads)) {
                  for (const candidate of local.threads) {
                    const restored = typeof candidate?.id === 'string' ? restoredThreads.get(candidate.id) : undefined;
                    const expected = restored ? titleDigests.get(candidate.id) : undefined;
                    if (restored && typeof candidate.title === 'string' && candidate.title
                      && candidate.title.length <= 240 && typeof expected === 'string'
                      && titleDigest(candidate.title) === expected) restored.title = candidate.title;
                  }
                }
              } catch {
                // A corrupt optional title cache must not make durable thread
                // history unreadable. The placeholder is the fail-closed UI.
              }
            }
            this.#threads = restoredThreads;
            return;
          }
        }
        if (!this.#storagePath) return;
        let parsed;
        try {
          parsed = await readPersistentJsonFile(this.#storagePath);
        } catch {
          throw new Error('THREAD_STORE_INVALID');
        }
        if (parsed === undefined) return;
        if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.threads)) throw new Error('THREAD_STORE_INVALID');
        const restoredThreads = new Map();
        for (const thread of parsed.threads) {
          if (!thread?.id || typeof thread.id !== 'string') continue;
          const restored = structuredClone(thread);
          if (restored.state === undefined) restored.state = 'IDLE';
          if (!THREAD_STATES.includes(restored.state)) throw new Error('THREAD_STORE_INVALID');
          if (restored.checkpoint !== undefined) {
            if (!restored.checkpoint || restored.checkpoint.checkpointDigest !== checkpointDigest(restored.checkpoint) ||
                typeof restored.checkpoint.runId !== 'string' || !CHECKPOINT_PHASES.includes(restored.checkpoint.phase)) {
              throw new Error('THREAD_STORE_INVALID');
            }
          }
          restoredThreads.set(restored.id, restored);
        }
        this.#threads = restoredThreads;
      })();
    }
    try {
      await this.#loadPromise;
      this.#loaded = true;
    } finally {
      this.#loadPromise = undefined;
    }
  }
  async create({ cwd, title = 'New thread' } = {}) {
    await this.load();
    const thread = { id: `thread-${randomUUID()}`, title: String(title).slice(0, 240), cwd: String(cwd ?? '').slice(0, 1024), turns: [], state: 'IDLE', checkpoint: undefined, createdAtMs: Date.now(), updatedAtMs: Date.now() };
    this.#threads.set(thread.id, thread);
    await this.#appendThreadEvent('ThreadCreated', {
      threadId: thread.id,
      titleDigest: titleDigest(thread.title),
      cwd: thread.cwd,
      state: thread.state,
      createdAtMs: thread.createdAtMs,
      updatedAtMs: thread.updatedAtMs,
      turns: []
    }, `thread-created:${thread.id}`);
    await this.#persist();
    return structuredClone(thread);
  }
  async appendTurn(threadId, turn) {
    await this.load();
    const thread = this.#threads.get(threadId); if (!thread) throw new Error('THREAD_NOT_FOUND');
    const summary = String(turn?.summary ?? '')
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
      .trim()
      .slice(0, 2000);
    const turnRecord = {
      id: turn?.id ?? `turn-${randomUUID()}`,
      ...(typeof turn?.runId === 'string' && turn.runId.trim() ? { runId: turn.runId.trim().slice(0, 160) } : {}),
      summary,
      state: typeof turn?.state === 'string' ? turn.state.slice(0, 40) : 'COMPLETED',
      atMs: Date.now()
    };
    thread.turns.push(turnRecord);
    thread.updatedAtMs = Date.now();
    await this.#appendThreadEvent('ThreadTurnAppended', {
      threadId,
      turn: structuredClone(turnRecord),
      updatedAtMs: thread.updatedAtMs
    }, `thread-turn:${threadId}:${turnRecord.id}`);
    await this.#persist();
    return structuredClone(thread);
  }

  async setState(threadId, state, { runId, reason } = {}) {
    await this.load();
    if (!THREAD_STATES.includes(state)) throw new Error('THREAD_STATE_INVALID');
    const thread = this.#threads.get(threadId); if (!thread) throw new Error('THREAD_NOT_FOUND');
    thread.state = state;
    if (runId !== undefined) thread.activeRunId = String(runId).slice(0, 240);
    if (reason !== undefined) thread.stateReason = String(reason).replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').slice(0, 500);
    if (state === 'COMPLETED' || state === 'IDLE') delete thread.activeRunId;
    thread.updatedAtMs = Date.now();
    await this.#appendThreadEvent('ThreadStateChanged', {
      threadId,
      state,
      ...(thread.activeRunId ? { activeRunId: thread.activeRunId } : {}),
      ...(thread.stateReason ? { stateReason: thread.stateReason } : {}),
      updatedAtMs: thread.updatedAtMs
    }, `thread-state:${threadId}:${state}:${thread.updatedAtMs}`);
    await this.#persist();
    return structuredClone(thread);
  }

  async setCheckpoint(threadId, checkpoint = {}) {
    await this.load();
    const thread = this.#threads.get(threadId); if (!thread) throw new Error('THREAD_NOT_FOUND');
    const safe = safeCheckpoint(checkpoint);
    if (typeof safe.runId !== 'string' || !safe.runId || typeof safe.phase !== 'string' || !CHECKPOINT_PHASES.includes(safe.phase)) throw new Error('THREAD_CHECKPOINT_INVALID');
    const record = { ...safe, updatedAtMs: Date.now() };
    record.checkpointDigest = checkpointDigest(record);
    if (this.#eventStore) await this.#commitCheckpointEvent({
      threadId, runId: record.runId, kind: 'ThreadCheckpointCommitted',
      payload: { threadId, runId: record.runId, phase: record.phase, state: record.state, checkpointDigest: record.checkpointDigest, checkpoint: structuredClone(record), updatedAtMs: record.updatedAtMs },
      commandId: `thread-checkpoint:${threadId}:${record.checkpointDigest}`
    });
    thread.checkpoint = record;
    thread.state = safe.state && THREAD_STATES.includes(safe.state) ? safe.state : 'RUNNING';
    thread.activeRunId = safe.runId;
    thread.updatedAtMs = record.updatedAtMs;
    await this.#persist();
    return structuredClone(record);
  }

  async clearCheckpoint(threadId, { state = 'IDLE', reason } = {}) {
    await this.load();
    const thread = this.#threads.get(threadId); if (!thread) throw new Error('THREAD_NOT_FOUND');
    if (!THREAD_STATES.includes(state)) throw new Error('THREAD_STATE_INVALID');
    const runId = typeof thread.activeRunId === 'string' && thread.activeRunId ? thread.activeRunId : `thread:${threadId}`;
    if (this.#eventStore) await this.#commitCheckpointEvent({
      threadId, runId, kind: 'ThreadCheckpointCleared',
      payload: { threadId, runId, state, reasonCode: typeof reason === 'string' ? reason.slice(0, 120) : undefined, updatedAtMs: thread.updatedAtMs },
      commandId: `thread-checkpoint-clear:${threadId}:${state}:${thread.updatedAtMs}`
    });
    delete thread.checkpoint;
    thread.state = state;
    delete thread.activeRunId;
    if (reason !== undefined) thread.stateReason = String(reason).replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').slice(0, 500);
    thread.updatedAtMs = Date.now();
    await this.#persist();
    return structuredClone(thread);
  }
  async fork(threadId, { title } = {}) {
    await this.load(); const source = this.#threads.get(threadId); if (!source) throw new Error('THREAD_NOT_FOUND');
    const fork = { ...structuredClone(source), id: `thread-${randomUUID()}`, title: String(title ?? `${source.title} (fork)`).slice(0, 240), turns: source.turns.slice(), createdAtMs: Date.now(), updatedAtMs: Date.now(), forkedFrom: source.id };
    this.#threads.set(fork.id, fork);
    await this.#appendThreadEvent('ThreadCreated', {
      threadId: fork.id,
      titleDigest: titleDigest(fork.title),
      cwd: fork.cwd,
      state: fork.state,
      createdAtMs: fork.createdAtMs,
      updatedAtMs: fork.updatedAtMs,
      forkedFrom: source.id,
      turns: structuredClone(fork.turns)
    }, `thread-created:${fork.id}`);
    await this.#persist();
    return structuredClone(fork);
  }
  async get(threadId) { await this.load(); const value = this.#threads.get(threadId); return value ? structuredClone(value) : undefined; }
  async list() { await this.load(); return [...this.#threads.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((thread) => structuredClone(thread)); }
  async #commitCheckpointEvent({ threadId, runId, kind, payload, commandId }) {
    await this.#eventStore.append({
      runId, aggregateType: 'TaskRun', aggregateId: runId, kind, payload,
      sensitivity: 'SECURITY_AUDIT', commandId
    });
  }

  async #appendThreadEvent(kind, payload, commandId) {
    if (!this.#eventStore?.append) return;
    await this.#eventStore.append({
      runId: `thread:${payload.threadId}`,
      aggregateType: 'Thread',
      aggregateId: payload.threadId,
      kind,
      payload,
      sensitivity: 'INTERNAL',
      ...(commandId ? { commandId } : {})
    });
  }

  async #persist() {
    if (!this.#storagePath) return;
    const write = async () => {
      const incoming = { schemaVersion: '1.0', threads: [...this.#threads.values()] };
      await persistJsonFile(this.#storagePath, incoming, {
        merge: (existing, snapshot) => mergeRecordsById(existing, snapshot, {
          collection: 'threads',
          merge: (left, right) => {
            const newest = (right.updatedAtMs ?? 0) >= (left.updatedAtMs ?? 0) ? right : left;
            const turns = new Map();
            for (const turn of [...(Array.isArray(left.turns) ? left.turns : []), ...(Array.isArray(right.turns) ? right.turns : [])]) {
              const previous = turn?.id ? turns.get(turn.id) : undefined;
              if (turn?.id && (!previous || (turn.atMs ?? 0) >= (previous.atMs ?? 0))) turns.set(turn.id, turn);
            }
            return { ...newest, turns: [...turns.values()].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0)) };
          }
        })
      });
    };
    this.#queue = this.#queue.then(write, write); await this.#queue;
  }
}

export const createThreadStore = (options) => new ThreadStore(options);
export { THREAD_STATES, CHECKPOINT_PHASES, checkpointDigest, titleDigest };
