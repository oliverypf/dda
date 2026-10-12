import { randomUUID } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from '../persistent-json-store.mjs';

/**
 * Host-owned crash / lifecycle journal for kernel/cell side effects (Phase-2b F5).
 *
 * This is NOT the audit JSONL and NOT SessionState. Empty / rehydratable shape
 * deliberately avoids SessionState fields (schemaVersion/sessionId/revision/entries).
 *
 * State machine:
 *   REQUESTED → GATED → APPROVED|DECLINED → LEASED → STARTED → COMPLETED|FAILED|UNKNOWN
 *
 * STARTED is fsynced as the last successful step of onLeaseStarted (after claimLease,
 * before operation()). Terminal COMPLETED/FAILED are written from the ALS-marked
 * onLeaseConsumed / onLeaseFailed after scope checks. Only an unclassified
 * STARTED-without-terminal (timeout/crash) becomes UNKNOWN and arms uncertain.
 */

export const EFFECT_JOURNAL_SCHEMA = 'dda-effect-journal-1';
export const EFFECT_JOURNAL_FLAG = 'DDA_KERNEL_EFFECT_JOURNAL';

export const JOURNAL_STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  GATED: 'GATED',
  APPROVED: 'APPROVED',
  DECLINED: 'DECLINED',
  LEASED: 'LEASED',
  STARTED: 'STARTED',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN'
});

const TERMINAL = new Set([
  JOURNAL_STATES.COMPLETED,
  JOURNAL_STATES.FAILED,
  JOURNAL_STATES.UNKNOWN,
  JOURNAL_STATES.DECLINED
]);

export const JOURNAL_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'JOURNAL_UNAVAILABLE',
  INVALID: 'JOURNAL_INVALID',
  NOT_FOUND: 'JOURNAL_EFFECT_NOT_FOUND'
});

class JournalError extends Error {
  constructor(code, message = '') {
    super(message ? `${code}:${message}` : code);
    this.name = 'JournalError';
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const emptySnapshot = () => ({
  journalSchema: EFFECT_JOURNAL_SCHEMA,
  effects: [],
  uncertainClears: []
});

const validateSnapshot = (parsed) => {
  if (parsed === undefined || parsed === null) return emptySnapshot();
  if (!isPlainObject(parsed)) throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'not an object');
  // Refuse SessionState-shaped bodies (F5 / 32nd).
  if ('schemaVersion' in parsed || 'sessionId' in parsed || 'revision' in parsed || 'entries' in parsed) {
    throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'SessionState fields are forbidden in journal empty/loaded state');
  }
  if (parsed.journalSchema !== EFFECT_JOURNAL_SCHEMA) {
    throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'journalSchema mismatch');
  }
  if (!Array.isArray(parsed.effects)) throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'effects');
  if (!Array.isArray(parsed.uncertainClears)) throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'uncertainClears');
  return {
    journalSchema: EFFECT_JOURNAL_SCHEMA,
    effects: parsed.effects.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.effectId !== 'string' || typeof entry.state !== 'string') {
        throw new JournalError(JOURNAL_ERROR_CODES.INVALID, 'effect entry');
      }
      return { ...entry };
    }),
    uncertainClears: parsed.uncertainClears.filter((item) => isPlainObject(item))
  };
};

export const isEffectJournalEnabled = (env = process.env) => {
  const raw = env?.[EFFECT_JOURNAL_FLAG];
  if (raw === undefined || raw === null || raw === '') return true; // available whenever cells/effects need it; availability still gated by storage
  const v = String(raw).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(v);
};

/**
 * Create a durable effect journal. storagePath is required for kernel/cell paths;
 * missing store + ALS bit set ⇒ JOURNAL_UNAVAILABLE before operation().
 */
export const createEffectJournal = ({ storagePath } = {}) => {
  let snapshot = emptySnapshot();
  let loaded = false;
  let queue = Promise.resolve();

  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  const persist = async () => {
    if (!storagePath) throw new JournalError(JOURNAL_ERROR_CODES.UNAVAILABLE, 'no storagePath');
    await persistJsonFile(storagePath, snapshot);
  };

  const loadUnlocked = async () => {
    if (loaded) return snapshot;
    if (!storagePath) {
      loaded = true;
      return snapshot;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(storagePath);
    } catch (error) {
      throw new JournalError(JOURNAL_ERROR_CODES.INVALID, error?.message ?? 'read failed');
    }
    snapshot = validateSnapshot(parsed);
    loaded = true;
    return snapshot;
  };

  const load = async () => enqueue(() => loadUnlocked());

  /** Scan STARTED-without-terminal → UNKNOWN; returns armed uncertain reasons. */
  const rehydrate = async () => enqueue(async () => {
    await loadUnlocked();
    const armed = [];
    let dirty = false;
    const now = Date.now();
    for (const effect of snapshot.effects) {
      if (effect.state === JOURNAL_STATES.STARTED) {
        effect.state = JOURNAL_STATES.UNKNOWN;
        effect.unknownAtMs = now;
        effect.unknownReason = 'RESTART_STARTED_WITHOUT_TERMINAL';
        armed.push({ effectId: effect.effectId, reasonCode: 'KERNEL_OUTCOME_UNCERTAIN' });
        dirty = true;
      }
    }
    if (dirty) await persist();
    return { armed, uncertainClears: [...snapshot.uncertainClears] };
  });

  const find = (effectId) => snapshot.effects.find((entry) => entry.effectId === effectId);

  const transition = async (effectId, state, patch = {}) => enqueue(async () => {
    await loadUnlocked();
    if (!storagePath) throw new JournalError(JOURNAL_ERROR_CODES.UNAVAILABLE, 'no storagePath');
    let effect = find(effectId);
    if (!effect) {
      effect = { effectId, state: JOURNAL_STATES.REQUESTED, createdAtMs: Date.now() };
      snapshot.effects.push(effect);
    }
    // Idempotent terminal: never rewrite COMPLETED/FAILED/UNKNOWN to UNKNOWN via onLeaseFailed.
    if (TERMINAL.has(effect.state) && state === JOURNAL_STATES.UNKNOWN) {
      return { ...effect };
    }
    if (TERMINAL.has(effect.state) && state !== effect.state && state !== JOURNAL_STATES.FAILED) {
      // Allow COMPLETED/FAILED already set: return as-is (idempotent cleanup).
      if (TERMINAL.has(state)) return { ...effect };
    }
    effect.state = state;
    Object.assign(effect, patch);
    effect.updatedAtMs = Date.now();
    await persist();
    return { ...effect };
  });

  const recordRequested = async ({ effectId = `effect-${randomUUID()}`, kind, bit, cellId, digest, toolCallId, runId } = {}) =>
    transition(effectId, JOURNAL_STATES.REQUESTED, {
      kind, bit, ...(cellId ? { cellId } : {}), ...(digest ? { digest } : {}),
      ...(toolCallId ? { toolCallId } : {}), ...(runId ? { runId } : {})
    });

  const recordGated = (effectId, patch) => transition(effectId, JOURNAL_STATES.GATED, patch);
  const recordApproved = (effectId, patch) => transition(effectId, JOURNAL_STATES.APPROVED, patch);
  const recordDeclined = (effectId, patch) => transition(effectId, JOURNAL_STATES.DECLINED, patch);
  const recordLeased = (effectId, patch) => transition(effectId, JOURNAL_STATES.LEASED, patch);

  /** Last successful step of ALS-marked onLeaseStarted. Fsync throw ⇒ skip operation. */
  const recordStarted = (effectId, patch) => transition(effectId, JOURNAL_STATES.STARTED, {
    startedAtMs: Date.now(),
    ...patch
  });

  const recordCompleted = (effectId, patch) => transition(effectId, JOURNAL_STATES.COMPLETED, {
    completedAtMs: Date.now(),
    ...patch
  });

  const recordFailed = (effectId, patch) => transition(effectId, JOURNAL_STATES.FAILED, {
    failedAtMs: Date.now(),
    ...patch
  });

  const recordUnknown = (effectId, patch) => transition(effectId, JOURNAL_STATES.UNKNOWN, {
    unknownAtMs: Date.now(),
    ...patch
  });

  /** Live-approved discharge of outcomeUncertain must leave a journal clear fact. */
  const recordUncertainClear = async ({ effectId, reason = 'LIVE_APPROVED_DISCHARGE' } = {}) => enqueue(async () => {
    await loadUnlocked();
    if (!storagePath) throw new JournalError(JOURNAL_ERROR_CODES.UNAVAILABLE, 'no storagePath');
    snapshot.uncertainClears.push({ effectId, reason, atMs: Date.now() });
    await persist();
  });

  const list = async () => enqueue(async () => {
    await loadUnlocked();
    return snapshot.effects.map((entry) => ({ ...entry }));
  });

  const get = async (effectId) => enqueue(async () => {
    await loadUnlocked();
    const effect = find(effectId);
    return effect ? { ...effect } : null;
  });

  return {
    storagePath: storagePath ?? null,
    available: Boolean(storagePath),
    load,
    rehydrate,
    recordRequested,
    recordGated,
    recordApproved,
    recordDeclined,
    recordLeased,
    recordStarted,
    recordCompleted,
    recordFailed,
    recordUnknown,
    recordUncertainClear,
    list,
    get,
    /** Plant-safe empty body (F5): journal-store rehydratable, no SessionState fields. */
    emptyBody: () => emptySnapshot()
  };
};

export { JournalError };
