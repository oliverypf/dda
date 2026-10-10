import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_HISTORY = 4096;
const MAX_EVENTS = 4096;
const MAX_RECEIPTS = 4096;
const MAX_JSON_CHARS = 4 * 1024 * 1024;
const LOCK_MAX_AGE_MS = 30_000;
const PLAN_STEP_STATUSES = new Set(['PENDING', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'SKIPPED']);

const transitions = Object.freeze({
  CREATED: ['CLASSIFYING', 'PLANNING', 'RECOVERING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  CLASSIFYING: ['PRECHECKING', 'ROUTING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  PRECHECKING: ['ROUTING', 'PLANNING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  ROUTING: ['ALLOCATING_CONTEXTS', 'PLANNING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  ALLOCATING_CONTEXTS: ['PLANNING', 'SAFETY_EVALUATING', 'EXECUTING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  PLANNING: ['SAFETY_EVALUATING', 'WAITING_APPROVAL', 'EXECUTING', 'VERIFYING', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  SAFETY_EVALUATING: ['WAITING_APPROVAL', 'EXECUTING', 'PAUSING', 'PAUSED', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  WAITING_APPROVAL: ['EXECUTING', 'PAUSING', 'PAUSED', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  EXECUTING: ['VERIFYING', 'WAITING_APPROVAL', 'PAUSING', 'PAUSED', 'FAILED', 'CANCELLED', 'CANCELLING', 'RECOVERING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  VERIFYING: ['PLANNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DIAGNOSING', 'PAUSING', 'PAUSED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  DIAGNOSING: ['PLANNING', 'RECOVERING', 'FAILED', 'CANCELLED', 'PAUSING', 'PAUSED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  RECOVERING: ['CLASSIFYING', 'EXECUTING', 'PLANNING', 'PAUSED', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  PAUSING: ['PAUSED', 'FAILED', 'CANCELLED', 'CANCELLING', 'PAUSED_UNSUPPORTED', 'QUARANTINED'],
  PAUSED: ['RECOVERING', 'CANCELLED', 'FAILED', 'CANCELLING', 'QUARANTINED'],
  PAUSED_UNSUPPORTED: ['RECOVERING', 'CANCELLED', 'FAILED', 'CANCELLING', 'QUARANTINED'],
  CANCELLING: ['CANCELLED', 'FAILED', 'QUARANTINED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  QUARANTINED: []
});

const TERMINAL_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);

// Canonical JSON makes a persisted snapshot self-checking and keeps command
// digests stable when callers construct equivalent objects in a different key order.
const canonical = (value) => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item) ?? 'null').join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key]) ?? 'null'}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

const safeReason = (value) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
  : undefined;

const safeKind = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(value)
  ? value
  : undefined;

const normalizePlanState = (value) => {
  if (value === undefined || value === null) return undefined;
  if (!isObject(value) || typeof value.planId !== 'string' || typeof value.planDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.planDigest) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) {
    throw new Error('RUN_PLAN_STATE_INVALID');
  }
  const ids = new Set();
  const steps = value.steps.map((raw) => {
    if (!isObject(raw) || typeof raw.stepId !== 'string' || !raw.stepId || ids.has(raw.stepId)) throw new Error('RUN_PLAN_STATE_INVALID');
    ids.add(raw.stepId);
    const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : 'PENDING';
    if (!PLAN_STEP_STATUSES.has(status)) throw new Error('RUN_PLAN_STATE_INVALID');
    const step = {
      stepId: raw.stepId.slice(0, 80),
      summary: typeof raw.summary === 'string' ? raw.summary.slice(0, 600) : '',
      actionKind: typeof raw.actionKind === 'string' ? raw.actionKind.slice(0, 80) : 'EXECUTE',
      dependencies: Array.isArray(raw.dependencies) ? raw.dependencies.filter((id) => typeof id === 'string').slice(0, 32) : [],
      status
    };
    for (const key of ['attempt', 'actionDigest', 'outputDigest', 'errorCode']) {
      if (raw[key] !== undefined) step[key] = typeof raw[key] === 'number' ? Math.max(0, Math.min(100, Math.floor(raw[key]))) : String(raw[key]).slice(0, 240);
    }
    return step;
  });
  const known = new Set(steps.map((step) => step.stepId));
  if (steps.some((step) => step.dependencies.some((id) => !known.has(id) || id === step.stepId))) throw new Error('RUN_PLAN_STATE_INVALID');
  return {
    planId: value.planId.slice(0, 120),
    planDigest: value.planDigest,
    steps,
    ...(typeof value.currentStepId === 'string' && known.has(value.currentStepId) ? { currentStepId: value.currentStepId } : {}),
    ...(Number.isInteger(value.attempt) && value.attempt >= 0 && value.attempt <= 100 ? { attempt: value.attempt } : {}),
    ...(Array.isArray(value.pendingActions) ? { pendingActions: value.pendingActions.filter((item) => typeof item === 'string').map((item) => item.slice(0, 500)).slice(0, 16) } : {}),
    ...(typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs) ? { updatedAtMs: value.updatedAtMs } : {})
  };
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isRetryableFsError = (error) => ['EACCES', 'EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code);
const idempotencyConflict = () => new Error('IDEMPOTENCY_CONFLICT:RUN_COMMAND_REUSE');

async function renameWithRetry(source, target) {
  let delay = 8;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt >= 8) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 160);
    }
  }
}

async function acquireLock(lockPath) {
  const token = randomUUID();
  let delay = 8;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try { await handle.writeFile(token, 'utf8'); } finally { await handle.close(); }
      return token;
    } catch (error) {
      if (error?.code !== 'EEXIST' || attempt >= 100) throw error;
      // A process killed while writing must not permanently wedge the store.
      try {
        const metadata = await stat(lockPath);
        if (Date.now() - metadata.mtimeMs > LOCK_MAX_AGE_MS) await unlink(lockPath);
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 160);
    }
  }
}

async function releaseLock(lockPath, token) {
  try {
    const current = await readFile(lockPath, 'utf8');
    if (current === token) await unlink(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const persistedUnsigned = (snapshot) => ({
  schemaVersion: SCHEMA_VERSION,
  runId: snapshot.runId,
  state: snapshot.state,
  version: snapshot.version,
  revision: snapshot.revision,
  historyStartVersion: snapshot.historyStartVersion,
  history: snapshot.history,
  events: snapshot.events,
  receipts: snapshot.receipts,
  ...(snapshot.planState === undefined ? {} : { planState: snapshot.planState }),
  updatedAtMs: snapshot.updatedAtMs
});

const persistedPayload = (snapshot) => {
  const unsigned = persistedUnsigned(snapshot);
  return { ...unsigned, recordDigest: digest(unsigned) };
};

const validateEvent = (event, index, expectedVersion, runId) => {
  if (!isObject(event) || typeof event.eventId !== 'string' || typeof event.runId !== 'string' ||
      event.runId !== runId ||
      typeof event.kind !== 'string' || !Number.isInteger(event.version) || event.version < 0 ||
      !Number.isInteger(event.sequence) || event.sequence < 1 ||
      !Number.isFinite(event.atMs) || event.version > expectedVersion) {
    throw new Error(`RUN_STORE_INVALID_EVENT:${index + 1}`);
  }
};

const validateSnapshot = (parsed) => {
  if (!isObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.runId !== 'string' ||
      !Object.hasOwn(transitions, parsed.state) || !Number.isInteger(parsed.version) || parsed.version < 0 ||
      (parsed.revision !== undefined && (!Number.isInteger(parsed.revision) || parsed.revision < parsed.version)) ||
      !Number.isInteger(parsed.historyStartVersion ?? 0) || (parsed.historyStartVersion ?? 0) < 0 ||
      (parsed.historyStartVersion ?? 0) > parsed.version ||
      !Array.isArray(parsed.history) || parsed.history.length > MAX_HISTORY ||
      !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS ||
      !Array.isArray(parsed.receipts) || parsed.receipts.length > MAX_RECEIPTS ||
      !Number.isFinite(parsed.updatedAtMs)) throw new Error('RUN_STORE_INVALID');
  if (parsed.planState !== undefined) normalizePlanState(parsed.planState);
  const { recordDigest, ...unsigned } = parsed;
  if (typeof recordDigest !== 'string' || recordDigest !== digest(unsigned)) throw new Error('RUN_STORE_INVALID');
  const historyStartVersion = parsed.historyStartVersion ?? 0;
  if (parsed.history.length !== parsed.version - historyStartVersion) throw new Error('RUN_STORE_INVALID_HISTORY');
  let priorVersion = historyStartVersion;
  for (const [index, event] of parsed.history.entries()) {
    validateEvent(event, index, parsed.version, parsed.runId);
    if (event.version !== historyStartVersion + index + 1 || event.version !== priorVersion + 1 ||
        !Object.hasOwn(transitions, event.from) || !Object.hasOwn(transitions, event.to) ||
        !(transitions[event.from] ?? []).includes(event.to)) throw new Error('RUN_STORE_INVALID_HISTORY');
    priorVersion = event.version;
  }
  if (parsed.version > 0 && parsed.history.at(-1).to !== parsed.state) throw new Error('RUN_STORE_INVALID_HISTORY');
  let priorSequence = 0;
  for (const [index, event] of parsed.events.entries()) {
    validateEvent(event, index, parsed.version, parsed.runId);
    if (event.sequence <= priorSequence) throw new Error('RUN_STORE_INVALID_EVENTS');
    priorSequence = event.sequence;
  }
  if (parsed.events.length && priorSequence > (parsed.revision ?? parsed.version)) throw new Error('RUN_STORE_INVALID_EVENTS');
  const seenCommands = new Set();
  for (const receipt of parsed.receipts) {
    if (!isObject(receipt) || typeof receipt.commandId !== 'string' || typeof receipt.requestDigest !== 'string' ||
        !isObject(receipt.result) || seenCommands.has(receipt.commandId)) throw new Error('RUN_STORE_INVALID_RECEIPT');
    seenCommands.add(receipt.commandId);
  }
  return parsed;
};

const coordinatorEventFromHarness = (event, runId) => {
  if (!isObject(event) || event.runId !== runId || !isObject(event.payload)) return undefined;
  const payload = event.payload;
  if (payload.schemaVersion !== SCHEMA_VERSION
    || payload.runId !== runId
    || typeof payload.eventId !== 'string' || !payload.eventId
    || !Number.isInteger(payload.sequence) || payload.sequence < 1
    || !['RunStateChanged', 'RuntimeEvent'].includes(payload.type)
    || payload.kind !== event.kind
    || !Number.isInteger(payload.version) || payload.version < 0
    || !Number.isFinite(payload.atMs)) {
    return undefined;
  }
  return payload;
};

export class TaskRunCoordinator {
  #state = 'CREATED';
  #version = 0;
  #revision = 0;
  #history = [];
  #historyStartVersion = 0;
  #events = [];
  #receipts = new Map();
  #planState;
  #onTransition;
  #onEvent;
  #storagePath;
  #runId;
  #runIdProvided;
  #eventStore;
  #now;
  #idFactory;
  #loaded;
  #loadingPromise;
  #queue = Promise.resolve();
  #pendingEventCommits = [];
  #callbackQueue = Promise.resolve();
  #persistedVersion = 0;
  #lastScheduledVersion = 0;
  #lastScheduledRevision = 0;
  #updatedAtMs;

  constructor({ onTransition, onEvent, storagePath, runId, now = Date.now, idFactory = randomUUID, eventStore } = {}) {
    if (eventStore !== undefined && (!eventStore
      || typeof eventStore.append !== 'function'
      || typeof eventStore.list !== 'function')) {
      throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    }
    this.#onTransition = onTransition;
    this.#onEvent = onEvent;
    this.#storagePath = storagePath;
    this.#eventStore = eventStore;
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
    this.#runIdProvided = typeof runId === 'string' && Boolean(runId.trim());
    this.#runId = this.#runIdProvided ? runId.trim().slice(0, 200) : `run-${this.#idFactory()}`;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#updatedAtMs = this.#now();
    // A persisted instance has to be explicitly loaded before it can mutate;
    // memory-only instances retain the historical synchronous API.
    this.#loaded = !storagePath && !eventStore;
  }

  get runId() { return this.#runId; }
  get storagePath() { return this.#storagePath; }
  get state() { return this.#state; }
  get version() { return this.#version; }
  get runVersion() { return this.#version; }
  get revision() { return this.#revision; }
  get history() { return this.#history.map(clone); }
  get events() { return this.#events.map(clone); }
  get receipts() { return [...this.#receipts.values()].map(clone); }
  get planState() { return this.#planState === undefined ? undefined : clone(this.#planState); }
  get loaded() { return this.#loaded; }
  get persistedVersion() { return this.#persistedVersion; }
  get terminal() { return TERMINAL_STATES.includes(this.#state); }

  snapshot() {
    return clone({
      schemaVersion: SCHEMA_VERSION,
      runId: this.#runId,
      state: this.#state,
      version: this.#version,
      revision: this.#revision,
      historyStartVersion: this.#historyStartVersion,
      history: this.#history,
      events: this.#events,
      receipts: [...this.#receipts.values()],
      ...(this.#planState === undefined ? {} : { planState: this.#planState }),
      updatedAtMs: this.#updatedAtMs
    });
  }

  async load() {
    if (this.#loaded) return this.snapshot();
    if (this.#loadingPromise) return this.#loadingPromise;
    const operation = (async () => {
      if (this.#eventStore) return this.#loadFromEventStore();
      if (!this.#storagePath) {
        this.#loaded = true;
        return this.snapshot();
      }
      let parsed;
      try {
        parsed = await readPersistentJsonFile(this.#storagePath);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('RUN_STORE_INVALID');
        throw new Error('RUN_STORE_READ_FAILED');
      }
      if (parsed === undefined) {
        this.#persistedVersion = 0;
        this.#lastScheduledVersion = 0;
        this.#lastScheduledRevision = 0;
        this.#loaded = true;
        return this.snapshot();
      }
      try { parsed = validateSnapshot(parsed); } catch (error) {
        if (error?.message?.startsWith('RUN_STORE_')) throw error;
        throw new Error('RUN_STORE_INVALID');
      }
      if (parsed.runId !== this.#runId && !this.#runIdProvided) this.#runId = parsed.runId;
      if (parsed.runId !== this.#runId) throw new Error('RUN_STORE_RUN_ID_MISMATCH');
      this.#state = parsed.state;
      this.#version = parsed.version;
      this.#revision = parsed.revision ?? parsed.version;
      this.#historyStartVersion = parsed.historyStartVersion ?? 0;
      this.#history = parsed.history.map(clone);
      this.#events = parsed.events.map(clone);
      this.#receipts = new Map(parsed.receipts.map((receipt) => [receipt.commandId, clone(receipt)]));
      this.#planState = parsed.planState === undefined
        ? [...this.#events].reverse().find((event) => event.kind === 'PlanStateChanged')?.payload?.planState
        : normalizePlanState(parsed.planState);
      this.#updatedAtMs = parsed.updatedAtMs;
      this.#persistedVersion = parsed.version;
      this.#lastScheduledVersion = parsed.version;
      this.#lastScheduledRevision = this.#revision;
      this.#loaded = true;
      return this.snapshot();
    })();
    this.#loadingPromise = operation;
    try { return await operation; } finally { if (this.#loadingPromise === operation) this.#loadingPromise = undefined; }
  }

  async #loadFromEventStore() {
    let events;
    try {
      events = await this.#eventStore.list({ runId: this.#runId });
    } catch {
      throw new Error('RUN_STORE_READ_FAILED');
    }
    if (!Array.isArray(events)) throw new Error('RUN_STORE_INVALID');
    const coordinatorEvents = events
      .map((event) => coordinatorEventFromHarness(event, this.#runId))
      .filter(Boolean)
      .sort((left, right) => left.sequence - right.sequence);

    this.#state = 'CREATED';
    this.#version = 0;
    this.#revision = 0;
    this.#history = [];
    this.#historyStartVersion = 0;
    this.#events = [];
    this.#receipts = new Map();
    this.#planState = undefined;
    this.#pendingEventCommits = [];
    this.#updatedAtMs = this.#now();

    let expectedSequence = 1;
    for (const event of coordinatorEvents) {
      if (event.sequence !== expectedSequence) throw new Error('RUN_STORE_INVALID_EVENTS');
      expectedSequence += 1;
      if (event.type === 'RunStateChanged') {
        if (!Object.hasOwn(transitions, event.from) || !Object.hasOwn(transitions, event.to)
          || !(transitions[event.from] ?? []).includes(event.to)
          || event.from !== this.#state
          || event.version !== this.#version + 1) {
          throw new Error('RUN_STORE_INVALID_HISTORY');
        }
        this.#state = event.to;
        this.#version = event.version;
        this.#history.push(clone(event));
      } else if (event.type !== 'RuntimeEvent') {
        throw new Error('RUN_STORE_INVALID_EVENT');
      } else if (event.version !== this.#version) {
        throw new Error('RUN_STORE_INVALID_EVENTS');
      }
      this.#events.push(clone(event));
      this.#revision = event.sequence;
      this.#updatedAtMs = event.atMs;
      if (event.kind === 'PlanStateChanged' && event.payload?.planState !== undefined) {
        this.#planState = normalizePlanState(event.payload.planState);
      }
      if (typeof event.commandId === 'string' && event.commandId) {
        const durableReceipt = typeof this.#eventStore.getReceipt === 'function'
          ? this.#eventStore.getReceipt(event.commandId)
          : undefined;
        if (durableReceipt?.status === 'COMMITTED') {
          const result = {
            state: this.#state,
            version: this.#version,
            runVersion: this.#version,
            event: clone(event)
          };
          const committedAtMs = Number.isFinite(durableReceipt.committedAtMs)
            ? durableReceipt.committedAtMs
            : event.atMs;
          this.#receipts.set(event.commandId, {
            receiptId: durableReceipt.receiptId ?? `receipt-${event.eventId}`,
            commandId: event.commandId,
            runId: this.#runId,
            ...(typeof event.operationId === 'string' && event.operationId
              ? { operationId: event.operationId }
              : {}),
            status: 'COMMITTED',
            state: this.#state,
            runVersion: this.#version,
            ...(event.expectedRunVersion === undefined ? {} : { expectedRunVersion: event.expectedRunVersion }),
            requestDigest: event.requestDigest,
            version: this.#version,
            result,
            acceptedAtMs: committedAtMs,
            createdAtMs: committedAtMs
          });
        }
      }
    }
    if (this.#version > 0 && this.#history.at(-1)?.to !== this.#state) {
      throw new Error('RUN_STORE_INVALID_HISTORY');
    }
    this.#trimHistory();
    this.#trimReceipts();
    this.#persistedVersion = this.#version;
    this.#lastScheduledVersion = this.#version;
    this.#lastScheduledRevision = this.#revision;
    this.#loaded = true;
    return this.snapshot();
  }

  async reload() {
    // Explicit reload is the recovery path after a failed optimistic write;
    // discard the rejected queue and re-read the authoritative disk snapshot.
    try { await this.flush(); } catch { /* the caller requested recovery */ }
    this.#queue = Promise.resolve();
    this.#callbackQueue = Promise.resolve();
    this.#pendingEventCommits = [];
    this.#loaded = false;
    return this.load();
  }

  async flush() {
    await this.#queue;
    await this.#callbackQueue;
    return this.snapshot();
  }

  getReceipt(commandId) {
    const receipt = this.#receipts.get(commandId);
    return receipt ? clone(receipt) : undefined;
  }

  // Generic command entry point for transports that deliver durable commands.
  command(command = {}) {
    if (!isObject(command)) throw new Error('RUN_COMMAND_INVALID');
    const type = command.type ?? command.kind;
    if (type === 'transition' || type === 'state.transition') {
      return this.transition(command.nextState ?? command.state ?? command.to, command);
    }
    if (type === 'event' || type === 'runtime.event') {
      return this.recordEvent(command.eventKind ?? command.name, command.payload, command);
    }
    throw new Error('RUN_COMMAND_INVALID');
  }

  apply(command) { return this.command(command); }

  // Durable command entry points: callers that need the protocol guarantee
  // (commit before acknowledging) can await these helpers.
  async dispatch(command) {
    const result = this.command(command);
    await this.flush();
    return result;
  }

  async transitionAndFlush(nextState, options = {}) {
    const result = this.transition(nextState, options);
    await this.flush();
    return result;
  }

  async recordEventAndFlush(kind, payload = {}, options = {}) {
    const result = this.recordEvent(kind, payload, options);
    await this.flush();
    return result;
  }

  /** Persist the current planner DAG and its resumable step cursor. */
  setPlanState(planState, options = {}) {
    const normalized = normalizePlanState(planState);
    const result = this.recordEvent('PlanStateChanged', { planState: normalized }, options);
    if (!result.idempotent) {
      this.#planState = clone({ ...normalized, updatedAtMs: this.#now() });
      // The event is useful for replay, while the top-level field makes the
      // latest cursor available without scanning the full event log.
      this.#schedulePersist();
    }
    return clone({ ...result, planState: this.#planState });
  }

  async setPlanStateAndFlush(planState, options = {}) {
    const result = this.setPlanState(planState, options);
    await this.flush();
    return result;
  }

  transition(nextState, options = {}) {
    this.#assertReady();
    if (typeof nextState !== 'string' || !Object.hasOwn(transitions, nextState)) throw new Error('RUN_STATE_INVALID');
    const commandId = this.#commandId(options);
    const normalizedReason = safeReason(options.reason);
    const requestDigest = digest({
      operation: 'transition',
      nextState,
      expectedVersion: options.expectedVersion ?? options.expectedRunVersion,
      reason: normalizedReason,
      metadata: isObject(options.metadata) ? options.metadata : undefined
    });
    const existing = commandId ? this.#receipts.get(commandId) : undefined;
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw idempotencyConflict();
      return clone({ ...existing.result, idempotent: true, receipt: existing });
    }
    const expectedVersion = options.expectedVersion ?? options.expectedRunVersion;
    if (expectedVersion !== undefined && expectedVersion !== this.#version) throw new Error('RUN_STALE_VERSION');
    if (!(transitions[this.#state] ?? []).includes(nextState)) throw new Error(`RUN_INVALID_TRANSITION:${this.#state}->${nextState}`);
    const previous = this.#state;
    this.#state = nextState;
    this.#version += 1;
    this.#updatedAtMs = this.#now();
    const sequence = this.#revision + 1;
    this.#revision = sequence;
    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId: `run-event-${this.#idFactory()}`,
      runId: this.#runId,
      type: 'RunStateChanged',
      kind: 'RunStateChanged',
      aggregateType: 'TaskRun',
      aggregateId: this.#runId,
      sequence,
      aggregateVersion: this.#version,
      from: previous,
      to: nextState,
      version: this.#version,
      ...(normalizedReason !== undefined ? { reason: normalizedReason } : {}),
      ...(isObject(options.metadata) ? { metadata: clone(options.metadata) } : {}),
      ...(commandId ? { commandId } : {}),
      ...(commandId ? { requestDigest } : {}),
      ...(expectedVersion === undefined ? {} : { expectedRunVersion: expectedVersion }),
      ...(typeof options.operationId === 'string' && options.operationId.trim()
        ? { operationId: options.operationId.trim().slice(0, 240) }
        : {}),
      atMs: this.#updatedAtMs
    };
    this.#history.push(event);
    this.#events.push(event);
    if (this.#eventStore) {
      this.#pendingEventCommits.push({
        event: clone(event),
        notify: () => {
          this.#notify(this.#onTransition, event);
          this.#notify(this.#onEvent, event);
        }
      });
    }
    this.#trimHistory();
    const result = { state: this.#state, version: this.#version, runVersion: this.#version, event: clone(event) };
    const receipt = commandId ? {
      receiptId: `receipt-${this.#idFactory()}`,
      commandId,
      runId: this.#runId,
      ...(typeof options.operationId === 'string' && options.operationId.trim() ? { operationId: options.operationId.trim().slice(0, 240) } : {}),
      status: 'ACCEPTED',
      state: this.#state,
      runVersion: this.#version,
      expectedRunVersion: expectedVersion,
      requestDigest,
      version: this.#version,
      result: clone(result),
      acceptedAtMs: this.#updatedAtMs,
      createdAtMs: this.#updatedAtMs
    } : undefined;
    if (receipt) {
      this.#receipts.set(commandId, receipt);
      this.#trimReceipts();
    }
    this.#schedulePersist();
    if (!this.#eventStore) {
      this.#notify(this.#onTransition, event);
      this.#notify(this.#onEvent, event);
    }
    return clone({ ...result, ...(receipt ? { receipt } : {}) });
  }

  recordEvent(kind, payload = {}, options = {}) {
    this.#assertReady();
    const eventKind = safeKind(kind);
    if (!eventKind) throw new Error('RUN_EVENT_KIND_INVALID');
    const eventId = typeof options.eventId === 'string' && options.eventId.trim() ? options.eventId.trim().slice(0, 200) : undefined;
    const commandId = this.#commandId(options);
    const requestDigest = digest({ operation: 'event', eventKind, payload, expectedVersion: options.expectedVersion ?? options.expectedRunVersion });
    const existing = commandId ? this.#receipts.get(commandId) : undefined;
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw idempotencyConflict();
      return clone({ ...existing.result, idempotent: true, receipt: existing });
    }
    if (eventId) {
      const prior = this.#events.find((event) => event.eventId === eventId);
      if (prior) {
        const priorDigest = digest({ operation: 'event', eventKind: prior.kind, payload: prior.payload });
        if (priorDigest !== digest({ operation: 'event', eventKind, payload })) throw idempotencyConflict();
        return clone({ event: prior, version: this.#version, runVersion: this.#version, idempotent: true });
      }
    }
    const expectedVersion = options.expectedVersion ?? options.expectedRunVersion;
    if (expectedVersion !== undefined && expectedVersion !== this.#version) throw new Error('RUN_STALE_VERSION');
    const sequence = this.#revision + 1;
    this.#revision = sequence;
    const event = {
      schemaVersion: SCHEMA_VERSION,
      eventId: eventId ?? `run-event-${this.#idFactory()}`,
      runId: this.#runId,
      type: 'RuntimeEvent',
      kind: eventKind,
      aggregateType: 'TaskRun',
      aggregateId: this.#runId,
      sequence,
      aggregateVersion: this.#version,
      version: this.#version,
      payload: clone(isObject(payload) ? payload : { value: payload }),
      ...(commandId ? { commandId } : {}),
      ...(commandId ? { requestDigest } : {}),
      ...(expectedVersion === undefined ? {} : { expectedRunVersion: expectedVersion }),
      ...(typeof options.operationId === 'string' && options.operationId.trim()
        ? { operationId: options.operationId.trim().slice(0, 240) }
        : {}),
      atMs: this.#now()
    };
    this.#updatedAtMs = event.atMs;
    this.#events.push(event);
    if (this.#eventStore) {
      this.#pendingEventCommits.push({
        event: clone(event),
        notify: () => this.#notify(this.#onEvent, event)
      });
    }
    this.#trimHistory();
    const result = { state: this.#state, version: this.#version, runVersion: this.#version, event: clone(event) };
    const receipt = commandId ? {
      receiptId: `receipt-${this.#idFactory()}`,
      commandId,
      runId: this.#runId,
      ...(typeof options.operationId === 'string' && options.operationId.trim() ? { operationId: options.operationId.trim().slice(0, 240) } : {}),
      status: 'ACCEPTED',
      state: this.#state,
      runVersion: this.#version,
      expectedRunVersion: expectedVersion,
      requestDigest,
      version: this.#version,
      result: clone(result),
      acceptedAtMs: event.atMs,
      createdAtMs: event.atMs
    } : undefined;
    if (receipt) {
      this.#receipts.set(commandId, receipt);
      this.#trimReceipts();
    }
    this.#schedulePersist();
    if (!this.#eventStore) this.#notify(this.#onEvent, event);
    return clone({ ...result, ...(receipt ? { receipt } : {}) });
  }

  #notify(callback, event) {
    if (typeof callback !== 'function') return;
    const work = () => Promise.resolve(callback(clone(event)));
    const pending = this.#callbackQueue.then(work, work);
    // Direct synchronous callers cannot await the callback queue. Attach a
    // handler immediately to avoid an unhandled rejection; flush() still
    // awaits the original promise and reports the durability failure.
    pending.catch(() => {});
    this.#callbackQueue = pending;
  }

  #assertReady() {
    if (!this.#loaded || this.#loadingPromise) throw new Error('RUN_NOT_LOADED');
  }

  #commandId(options) {
    const value = options?.commandId ?? options?.idempotencyKey ?? options?.operationId ?? options?.receiptId;
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : undefined;
  }

  #trimHistory() {
    if (this.#history.length > MAX_HISTORY) {
      const removed = this.#history.length - MAX_HISTORY;
      this.#history = this.#history.slice(-MAX_HISTORY);
      this.#historyStartVersion += removed;
    }
    if (this.#events.length > MAX_EVENTS) this.#events = this.#events.slice(-MAX_EVENTS);
  }

  #trimReceipts() {
    if (this.#receipts.size <= MAX_RECEIPTS) return;
    const remove = this.#receipts.size - MAX_RECEIPTS;
    for (const commandId of this.#receipts.keys()) {
      this.#receipts.delete(commandId);
      if (this.#receipts.size <= MAX_RECEIPTS || this.#receipts.size === MAX_RECEIPTS - remove) break;
    }
  }

  #schedulePersist() {
    if (this.#eventStore) {
      const write = () => this.#flushEventCommits();
      this.#queue = this.#queue.then(write, write);
      void this.#queue.catch(() => {});
      return;
    }
    if (!this.#storagePath) return;
    const snapshot = this.snapshot();
    const expectedVersion = this.#lastScheduledVersion;
    const expectedRevision = this.#lastScheduledRevision;
    this.#lastScheduledVersion = snapshot.version;
    this.#lastScheduledRevision = snapshot.revision;
    const write = async () => {
      await this.#writeSnapshot(snapshot, expectedVersion, expectedRevision);
      this.#persistedVersion = snapshot.version;
    };
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }

  async #flushEventCommits() {
    if (!this.#eventStore) return;
    while (this.#pendingEventCommits.length > 0) {
      const entry = this.#pendingEventCommits[0];
      const event = entry.event;
      const aggregateType = event.aggregateType ?? 'TaskRun';
      const aggregateId = event.aggregateId ?? event.runId;
      let appended;
      try {
        appended = await this.#eventStore.append({
          runId: event.runId,
          eventId: event.eventId,
          ...(typeof event.commandId === 'string' && event.commandId ? { commandId: event.commandId } : {}),
          kind: event.kind,
          aggregateType,
          aggregateId,
          payload: event,
          sensitivity: 'INTERNAL',
          ...(typeof event.operationId === 'string' && event.operationId ? { operationId: event.operationId } : {})
        });
      } catch (error) {
        const failure = new Error(`RUN_EVENT_COMMIT_FAILED:${error instanceof Error ? error.message : String(error)}`);
        failure.cause = error;
        throw failure;
      }
      const receipt = appended?.receipt;
      const committedEvent = appended?.event;
      if (receipt?.status !== 'COMMITTED'
        || !committedEvent?.eventId
        || !Array.isArray(receipt.eventIds)
        || !receipt.eventIds.includes(committedEvent.eventId)
        || committedEvent.eventId !== event.eventId
        || committedEvent.runId !== event.runId
        || committedEvent.kind !== event.kind
        || committedEvent.aggregateType !== aggregateType
        || committedEvent.aggregateId !== aggregateId
        || committedEvent.payload?.eventId !== event.eventId
        || committedEvent.payload?.runId !== event.runId
        || committedEvent.payload?.kind !== event.kind
        || committedEvent.payload?.type !== event.type
        || committedEvent.payload?.sequence !== event.sequence
        || !/^sha256:[0-9a-f]{64}$/u.test(committedEvent.payloadDigest ?? '')
        || !/^sha256:[0-9a-f]{64}$/u.test(committedEvent.recordDigest ?? '')) {
        throw new Error('RUN_EVENT_COMMIT_UNVERIFIED');
      }
      if (typeof event.commandId === 'string' && event.commandId) {
        const existing = this.#receipts.get(event.commandId);
        if (existing) {
          this.#receipts.set(event.commandId, clone({
            ...existing,
            receiptId: typeof receipt.receiptId === 'string' && receipt.receiptId ? receipt.receiptId : existing.receiptId,
            eventId: committedEvent.eventId,
            status: 'COMMITTED',
            committedAtMs: Number.isFinite(receipt.committedAtMs) ? receipt.committedAtMs : existing.acceptedAtMs
          }));
        }
      }
      if (Number.isInteger(event.version)) {
        this.#persistedVersion = Math.max(this.#persistedVersion, event.version);
      }
      this.#pendingEventCommits.shift();
      if (typeof entry.notify === 'function') entry.notify();
    }
  }

  async #writeSnapshot(snapshot, expectedVersion, expectedRevision) {
    const payload = JSON.stringify(persistedPayload(snapshot));
    if (payload.length > MAX_JSON_CHARS) throw new Error('RUN_STORE_TOO_LARGE');
    await mkdir(dirname(this.#storagePath), { recursive: true });
    const lockPath = `${this.#storagePath}.lock`;
    const token = await acquireLock(lockPath);
    const tempPath = `${this.#storagePath}.${process.pid}.${this.#idFactory()}.tmp`;
    try {
      let currentVersion = 0;
      let currentRevision = 0;
      let currentRunId;
      try {
        const currentRaw = await readFile(this.#storagePath, 'utf8');
        const current = validateSnapshot(JSON.parse(currentRaw));
        currentVersion = current.version;
        currentRevision = current.revision ?? current.version;
        currentRunId = current.runId;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw new Error('RUN_STORE_INVALID');
      }
      if (currentRunId && currentRunId !== snapshot.runId) throw new Error('RUN_STORE_RUN_ID_MISMATCH');
      if (currentVersion !== expectedVersion || currentRevision !== expectedRevision) throw new Error('RUN_STORAGE_CONFLICT');
      await writeFile(tempPath, `${payload}\n`, 'utf8');
      await renameWithRetry(tempPath, this.#storagePath);
    } finally {
      try { await unlink(tempPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await releaseLock(lockPath, token);
    }
  }
}

export const createTaskRunCoordinator = (options) => new TaskRunCoordinator(options);
export const TASK_RUN_STATES = transitions;
export const taskRunDigest = digest;
