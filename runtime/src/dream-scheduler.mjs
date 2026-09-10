import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, stat, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

export const DREAM_PHASES = Object.freeze([
  'ORIENT', 'GATHER', 'CONSOLIDATE', 'VERIFY', 'REVIEW', 'PRUNE'
]);

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const ACTIVE_PROJECT_LOCKS = new Set();
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const defaultOwnerAlive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

const clone = (value) => structuredClone(value);
const countOf = (value) => Array.isArray(value) ? value.length : undefined;
const unsignedRun = (run) => {
  const { recordDigest: _recordDigest, ...unsigned } = run;
  return unsigned;
};
const runDigest = (run) => digest(unsignedRun(run));

const sealRun = (run) => ({ ...run, recordDigest: runDigest(run) });

const evaluateGates = (gates = {}) => {
  if (!gates || typeof gates !== 'object' || Array.isArray(gates)) throw new Error('DREAM_GATES_INVALID');
  const reasons = [];
  if (gates.idle === false || gates.idleReady === false) reasons.push('DEVICE_NOT_IDLE');
  if (gates.safetyAllowed === false) reasons.push('SAFETY_PROFILE_BLOCKED');
  if (Number.isFinite(gates.activeRuns) && gates.activeRuns > 0) reasons.push('HIGH_PRIORITY_RUN_ACTIVE');
  if (Number.isFinite(gates.sessionCount) && Number.isFinite(gates.minSessions) && gates.sessionCount < gates.minSessions) reasons.push('INSUFFICIENT_NEW_SESSIONS');
  if (Number.isFinite(gates.idleForMs) && Number.isFinite(gates.minIdleMs) && gates.idleForMs < gates.minIdleMs) reasons.push('IDLE_WINDOW_TOO_SHORT');
  if (Number.isFinite(gates.minutesSinceLastRun) && Number.isFinite(gates.minIntervalMinutes) && gates.minutesSinceLastRun < gates.minIntervalMinutes) reasons.push('DREAM_INTERVAL_NOT_REACHED');
  return { allowed: reasons.length === 0, reasons };
};

const lockPathFor = (storagePath, projectId) => storagePath
  ? `${storagePath}.${String(projectId).replace(/[^A-Za-z0-9_.-]/g, '_')}.lock`
  : undefined;

const acquireProjectLock = async (projectId, storagePath) => {
  const key = String(projectId || 'default');
  if (ACTIVE_PROJECT_LOCKS.has(key)) throw new Error('DREAM_PROJECT_LOCKED');
  const path = lockPathFor(storagePath, key);
  let token;
  if (path) {
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(path, 'wx');
      token = randomUUID();
      try {
        await handle.writeFile(JSON.stringify({
          token,
          projectId: key,
          ownerPid: process.pid,
          acquiredAtMs: Date.now()
        }), 'utf8');
      }
      finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        let ownerAlive;
        try {
          const lock = JSON.parse(await readFile(path, 'utf8'));
          ownerAlive = Number.isInteger(lock?.ownerPid) ? defaultOwnerAlive(lock.ownerPid) : undefined;
        } catch {
          ownerAlive = undefined;
        }
        const metadata = await stat(path);
        if (ownerAlive === false || (ownerAlive === undefined && Date.now() - metadata.mtimeMs > LOCK_MAX_AGE_MS)) {
          await unlink(path);
          return acquireProjectLock(key, storagePath);
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        return acquireProjectLock(key, storagePath);
      }
      throw new Error('DREAM_PROJECT_LOCKED');
    }
  }
  ACTIVE_PROJECT_LOCKS.add(key);
  return { key, path, token };
};

const releaseProjectLock = async (lock) => {
  if (!lock) return;
  ACTIVE_PROJECT_LOCKS.delete(lock.key);
  if (!lock.path) return;
  try {
    const persisted = JSON.parse(await readFile(lock.path, 'utf8'));
    if (!lock.token || persisted?.token === lock.token) await unlink(lock.path);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
};

export class DreamScheduler {
  #running = false;
  #cancelled = false;
  #storagePath;
  #history = [];
  #queue = Promise.resolve();
  #loaded = false;
  #now;
  #projectId;
  #lock;
  #ownerPid;
  #runtimeInstanceId;
  #eventStore;

  constructor({
    storagePath,
    projectId = 'default',
    now = Date.now,
    ownerPid = process.pid,
    runtimeInstanceId = `runtime-${randomUUID()}`,
    eventStore
  } = {}) {
    this.#storagePath = storagePath;
    this.#projectId = String(projectId || 'default').slice(0, 256);
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#ownerPid = ownerPid;
    this.#runtimeInstanceId = String(runtimeInstanceId || '').slice(0, 240);
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath && this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'DreamRun' }); }
      catch { throw new Error('DREAM_STORE_READ_FAILED'); }
      let projected = false;
      for (const event of events) {
        if (!['DreamRunStarted', 'DreamPhaseCheckpointed', 'DreamRunFinished', 'DreamRunReconciled'].includes(event.kind)) continue;
        const record = clone(event.payload ?? {});
        if (typeof record.startedAtMs !== 'number') continue;
        delete record.gateAllowed;
        if (record.state === 'RUNNING') delete record.gateReasons;
        delete record.previousState;
        delete record.status;
        if (typeof record.runId !== 'string' || record.recordDigest !== runDigest(record)) throw new Error('DREAM_STORE_INVALID');
        const prior = this.#history.find((run) => run.runId === record.runId);
        if (!prior || (record.finishedAtMs ?? record.updatedAtMs ?? record.startedAtMs ?? 0) >= (prior.finishedAtMs ?? prior.updatedAtMs ?? prior.startedAtMs ?? 0)) {
          this.#history = this.#history.filter((run) => run.runId !== record.runId);
          this.#history.push(record);
        }
        projected = true;
      }
      if (projected) {
        this.#loaded = true;
        return;
      }
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#loaded = true;
        return;
      }
      throw new Error('DREAM_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.runs) || parsed.runs.length > 256) throw new Error('DREAM_STORE_INVALID');
    const ids = new Set();
    this.#history = parsed.runs.filter((run) => run && typeof run.runId === 'string').map((run) => {
      if (ids.has(run.runId)) throw new Error('DREAM_STORE_INVALID');
      if (run.recordDigest !== undefined && run.recordDigest !== runDigest(run)) throw new Error('DREAM_STORE_INVALID');
      ids.add(run.runId);
      return clone(run);
    });
    this.#loaded = true;
  }

  get running() { return this.#running; }
  get projectId() { return this.#projectId; }

  async run({
    orient = async () => ({}),
    gather,
    consolidate,
    verify,
    review = async (items) => items,
    prune = async (items) => items,
    gates = {},
    projectId = this.#projectId,
    signal
  } = {}) {
    await this.load();
    if (this.#running) throw new Error('DREAM_ALREADY_RUNNING');
    if ([gather, consolidate, verify, review, prune].some((callback) => typeof callback !== 'function') || typeof orient !== 'function') {
      throw new Error('DREAM_PIPELINE_INVALID');
    }
    const gateResult = evaluateGates(gates);
    const runId = `dream-${randomUUID()}`;
    const startedAtMs = this.#now();
    const record = sealRun({
      runId,
      projectId: String(projectId || this.#projectId).slice(0, 256),
      state: gateResult.allowed ? 'RUNNING' : 'WAITING_GATE',
      phase: gateResult.allowed ? 'ORIENT' : undefined,
      startedAtMs,
      ...(gateResult.allowed ? {
        ownerPid: this.#ownerPid,
        runtimeInstanceId: this.#runtimeInstanceId
      } : {}),
      ...(gateResult.allowed ? {} : { gateReasons: gateResult.reasons })
    });
    await this.#commitDreamEvent('DreamRunStarted', record, { gateAllowed: gateResult.allowed, gateReasons: gateResult.reasons });
    this.#history.push(record);
    this.#schedulePersist();
    if (!gateResult.allowed) return { status: 'WAITING_GATE', runId, startedAtMs, gateReasons: gateResult.reasons };

    if (signal?.aborted) return await this.#finish(runId, 'CANCELLED', startedAtMs);
    try {
      this.#lock = await acquireProjectLock(record.projectId, this.#storagePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.#finish(runId, 'FAILED', startedAtMs, undefined, {
        status: 'FAILED', runId, startedAtMs, errorCode: /^[A-Z][A-Z0-9_]{1,96}/u.exec(reason)?.[0] ?? 'DREAM_LOCK_FAILED'
      });
    }
    this.#running = true;
    this.#cancelled = false;
    const cancelled = () => this.#cancelled || signal?.aborted === true;
    const context = { runId, projectId: record.projectId, cancelled, gates: clone(gates) };
    let source;
    let candidates;
    let verified;
    let reviewed;
    let pruned;
    try {
      await this.#checkpoint(runId, 'ORIENT');
      const orientation = await orient(context);
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      await this.#checkpoint(runId, 'GATHER', { orientation, orientationCount: countOf(orientation) });
      source = await gather(cancelled, { ...context, orientation });
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      await this.#checkpoint(runId, 'CONSOLIDATE', { sourceCount: countOf(source) });
      candidates = await consolidate(source, { ...context, orientation });
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      await this.#checkpoint(runId, 'VERIFY', { candidateCount: countOf(candidates) });
      verified = await verify(candidates, { ...context, source, orientation });
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      await this.#checkpoint(runId, 'REVIEW', { verifiedCount: countOf(verified) });
      reviewed = await review(verified, { ...context, source, candidates, orientation });
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      await this.#checkpoint(runId, 'PRUNE', { reviewedCount: countOf(reviewed) });
      pruned = await prune(reviewed, { ...context, source, candidates, verified, orientation });
      if (cancelled()) return this.#finish(runId, 'CANCELLED', startedAtMs);
      const resultCandidates = Array.isArray(pruned)
        ? pruned
        : (Array.isArray(pruned?.candidates) ? pruned.candidates : (Array.isArray(reviewed) ? reviewed : verified));
      const result = {
        status: 'COMPLETED',
        candidates: resultCandidates,
        ...(Array.isArray(verified) ? { verifiedCount: verified.length } : {}),
        ...(Array.isArray(reviewed) ? { reviewedCount: reviewed.length } : {}),
        ...(Array.isArray(resultCandidates) ? { prunedCount: resultCandidates.length } : {})
      };
      return this.#finish(runId, 'COMPLETED', startedAtMs, resultCandidates, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.#finish(runId, 'FAILED', startedAtMs, undefined, {
        status: 'FAILED', runId, startedAtMs, errorCode: /^[A-Z][A-Z0-9_]{1,96}/u.exec(reason)?.[0] ?? 'DREAM_FAILED'
      });
    } finally {
      this.#running = false;
      const lock = this.#lock;
      this.#lock = undefined;
      await releaseProjectLock(lock).catch(() => {});
    }
  }

  cancel() { this.#cancelled = true; }
  async list() { await this.load(); return this.#history.map((run) => clone(run)); }
  async flush() { await this.#queue; }

  async reconcile({ isOwnerAlive = defaultOwnerAlive } = {}) {
    if (typeof isOwnerAlive !== 'function') throw new Error('DREAM_RECONCILE_INVALID');
    await this.load();
    const reconciled = [];
    for (const current of this.#history) {
      if (current.state !== 'RUNNING') continue;
      const ownerAlive = Number.isInteger(current.ownerPid) && current.ownerPid > 0
        && isOwnerAlive(current.ownerPid);
      if (ownerAlive) continue;
      const next = { ...current, state: 'FAILED', finishedAtMs: this.#now(), errorCode: 'DREAM_OWNER_PROCESS_LOST' };
      next.recordDigest = runDigest(next);
      await this.#commitDreamEvent('DreamRunReconciled', next, { previousState: current.state });
      Object.assign(current, next);
      reconciled.push(clone(current));
    }
    if (reconciled.length) {
      this.#schedulePersist();
      await this.flush();
    }
    return {
      reconciled: reconciled.length,
      runs: reconciled.map((run) => ({
        runId: run.runId,
        projectId: run.projectId,
        state: run.state,
        errorCode: run.errorCode
      }))
    };
  }

  async #checkpoint(runId, phase, details = {}) {
    const current = this.#history.find((run) => run.runId === runId);
    if (!current) return;
    const phaseUpdatedAtMs = this.#now();
    const next = { ...current, phase, phaseUpdatedAtMs, phaseDigest: digest({ phase, details: { ...details, runId } }), checkpoint: { phase, atMs: phaseUpdatedAtMs, ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined && typeof value !== 'object')) } };
    next.recordDigest = runDigest(next);
    await this.#commitDreamEvent('DreamPhaseCheckpointed', next, { phase, phaseDigest: next.phaseDigest });
    Object.assign(current, next);
    this.#schedulePersist();
    await this.flush();
  }

  async #finish(runId, status, startedAtMs, candidates = undefined, result = { status }) {
    const current = this.#history.find((run) => run.runId === runId);
    if (current) {
      const next = { ...current, state: status, phase: status === 'COMPLETED' ? 'PRUNE' : current.phase, finishedAtMs: this.#now(), ...(candidates === undefined ? {} : { candidateDigest: digest(candidates), candidateCount: Array.isArray(candidates) ? candidates.length : undefined }), ...(status === 'FAILED' && result.errorCode ? { errorCode: result.errorCode } : {}) };
      next.recordDigest = runDigest(next);
      await this.#commitDreamEvent('DreamRunFinished', next, { status, candidateCount: next.candidateCount });
      Object.assign(current, next);
    }
    this.#schedulePersist();
    return { ...result, runId, startedAtMs };
  }

  async #commitDreamEvent(kind, record, details = {}) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') return;
    await this.#eventStore.append({ runId: record.runId, aggregateType: 'DreamRun', aggregateId: record.runId, kind, payload: { ...clone(record) }, sensitivity: 'INTERNAL' });
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: '1.0', runs: this.#history }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'runs', id: 'runId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export { digest as dreamDigest, evaluateGates };
export const createDreamScheduler = (options) => new DreamScheduler(options);
