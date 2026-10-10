import { readPersistentJsonFile, persistJsonFile } from './persistent-json-store.mjs';

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 100;
const DEFAULT_FAILURE_LIMIT = 3;
const MAX_FAILURE_LIMIT = 20;
const MAX_TRACKED_RUNS = 10000;
const SCHEMA_VERSION = '1.0';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const clone = (value) => structuredClone(value);
const boundedInteger = (value, fallback, minimum, maximum, code) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};
const errorCode = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return /^[A-Z][A-Z0-9_]{1,96}/u.exec(message)?.[0] ?? 'RETENTION_PURGE_FAILED';
};

export const parseRetentionWorkerInterval = (value) => boundedInteger(
  value, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS, 'RETENTION_WORKER_INTERVAL_INVALID'
);
export const parseRetentionWorkerBatchSize = (value) => boundedInteger(
  value, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE, 'RETENTION_WORKER_BATCH_INVALID'
);
export const parseRetentionWorkerFailureLimit = (value) => boundedInteger(
  value, DEFAULT_FAILURE_LIMIT, 1, MAX_FAILURE_LIMIT, 'RETENTION_WORKER_FAILURE_LIMIT_INVALID'
);

const mergeProgress = (existing, incoming) => {
  const current = normalizeProgress(existing);
  const next = normalizeProgress(incoming);
  const completed = new Set([...current.completed, ...next.completed]);
  const failed = new Set([...current.failed, ...next.failed]);
  for (const runId of completed) failed.delete(runId);
  return {
    schemaVersion: SCHEMA_VERSION,
    completed: [...completed].slice(-MAX_TRACKED_RUNS),
    failed: [...failed].slice(-MAX_TRACKED_RUNS),
    updatedAtMs: Math.max(current.updatedAtMs, next.updatedAtMs)
  };
};

const normalizeProgress = (value) => {
  if (value === undefined) return { schemaVersion: SCHEMA_VERSION, completed: [], failed: [], updatedAtMs: 0 };
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.completed) || !Array.isArray(value.failed)) {
    throw new Error('RETENTION_PROGRESS_INVALID');
  }
  const validIds = (items) => items.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, MAX_TRACKED_RUNS);
  return {
    schemaVersion: SCHEMA_VERSION,
    completed: [...new Set(validIds(value.completed))],
    failed: [...new Set(validIds(value.failed))],
    updatedAtMs: Number.isInteger(value.updatedAtMs) && value.updatedAtMs >= 0 ? value.updatedAtMs : 0
  };
};

/**
 * Bounded, restartable retention loop. Harness purge remains authoritative;
 * progress only records operational work and can be rebuilt from the store.
 */
export class RetentionWorker {
  #intervalMs;
  #batchSize;
  #failureLimit;
  #delay;
  #now;
  #listExpired;
  #purgeRun;
  #progressStore;
  #emit;
  #running = false;
  #stopping = false;
  #cycleCount = 0;
  #consecutiveFailures = 0;
  #progress;

  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    failureLimit = DEFAULT_FAILURE_LIMIT,
    delayImpl = delay,
    now = Date.now,
    listExpired,
    purgeRun,
    progressStore = { load: async () => undefined, save: async () => {} },
    emit = () => {}
  } = {}) {
    this.#intervalMs = parseRetentionWorkerInterval(intervalMs);
    this.#batchSize = parseRetentionWorkerBatchSize(batchSize);
    this.#failureLimit = parseRetentionWorkerFailureLimit(failureLimit);
    if (typeof listExpired !== 'function' || typeof purgeRun !== 'function') throw new Error('RETENTION_WORKER_DEPENDENCY_REQUIRED');
    if (typeof delayImpl !== 'function' || typeof now !== 'function' || typeof emit !== 'function') throw new Error('RETENTION_WORKER_DEPENDENCY_INVALID');
    if (progressStore !== undefined && (typeof progressStore !== 'object' || typeof progressStore.load !== 'function' || typeof progressStore.save !== 'function')) {
      throw new Error('RETENTION_PROGRESS_STORE_INVALID');
    }
    this.#delay = delayImpl;
    this.#now = now;
    this.#listExpired = listExpired;
    this.#purgeRun = purgeRun;
    this.#progressStore = progressStore;
    this.#emit = emit;
    this.#progress = normalizeProgress(undefined);
  }

  get running() { return this.#running; }
  get cycleCount() { return this.#cycleCount; }
  get consecutiveFailures() { return this.#consecutiveFailures; }
  get progress() { return clone(this.#progress); }
  stop() { this.#stopping = true; }

  async #loadProgress() {
    const value = await this.#progressStore.load?.();
    this.#progress = normalizeProgress(value);
  }

  async #saveProgress() {
    this.#progress.updatedAtMs = this.#now();
    await this.#progressStore.save?.(clone(this.#progress));
  }

  async #cycle() {
    const candidates = await this.#listExpired({ progress: clone(this.#progress) });
    if (!Array.isArray(candidates)) throw new Error('RETENTION_EXPIRED_RUNS_INVALID');
    const completed = new Set(this.#progress.completed);
    const failed = new Set(this.#progress.failed);
    const runs = candidates
      .map((item) => typeof item === 'string' ? item : item?.runId)
      .filter((runId) => typeof runId === 'string' && runId.trim())
      .map((runId) => runId.trim())
      .filter((runId) => !completed.has(runId))
      .slice(0, this.#batchSize);
    const results = [];
    for (const runId of runs) {
      try {
        const result = await this.#purgeRun(runId);
        completed.add(runId);
        failed.delete(runId);
        this.#progress.completed = [...completed].slice(-MAX_TRACKED_RUNS);
        this.#progress.failed = [...failed].filter((item) => !completed.has(item)).slice(-MAX_TRACKED_RUNS);
        results.push({ runId, status: result?.status ?? 'COMMITTED', idempotent: result?.idempotent === true });
        await this.#saveProgress();
      } catch (error) {
        failed.add(runId);
        this.#progress.completed = [...completed].slice(-MAX_TRACKED_RUNS);
        this.#progress.failed = [...failed].filter((item) => !completed.has(item)).slice(-MAX_TRACKED_RUNS);
        results.push({ runId, status: 'FAILED', errorCode: errorCode(error) });
        await this.#saveProgress();
      }
    }
    this.#progress.completed = [...completed].slice(-MAX_TRACKED_RUNS);
    this.#progress.failed = [...failed].filter((runId) => !completed.has(runId)).slice(-MAX_TRACKED_RUNS);
    await this.#saveProgress();
    const remainingCount = [...new Set(candidates
      .map((item) => typeof item === 'string' ? item : item?.runId)
      .filter((runId) => typeof runId === 'string' && runId.trim())
      .map((runId) => runId.trim()))]
      .filter((runId) => !completed.has(runId)).length;
    return { candidateCount: candidates.length, processedCount: runs.length, results, remainingCount };
  }

  async start({ signal } = {}) {
    if (this.#running) throw new Error('RETENTION_WORKER_ALREADY_RUNNING');
    if (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) throw new Error('RETENTION_WORKER_SIGNAL_INVALID');
    this.#running = true;
    this.#stopping = false;
    this.#cycleCount = 0;
    this.#consecutiveFailures = 0;
    await this.#loadProgress();
    const abortHandler = () => this.stop();
    signal?.addEventListener('abort', abortHandler, { once: true });
    try {
      while (!this.#stopping && signal?.aborted !== true) {
        this.#cycleCount += 1;
        this.#emit({ state: 'RUNNING', cycle: this.#cycleCount });
        const result = await this.#cycle();
        const failedCount = result.results.filter((item) => item.status === 'FAILED').length;
        this.#consecutiveFailures = failedCount > 0 ? this.#consecutiveFailures + 1 : 0;
        this.#emit({ state: 'COMPLETED', cycle: this.#cycleCount, consecutiveFailures: this.#consecutiveFailures, ...result });
        if (this.#consecutiveFailures >= this.#failureLimit) throw new Error('RETENTION_WORKER_FAILURE_LIMIT');
        if (result.processedCount === 0 || result.remainingCount === 0) break;
        if (this.#stopping || signal?.aborted === true) break;
        await this.#delay(this.#intervalMs);
      }
      return { state: 'STOPPED', cycleCount: this.#cycleCount, consecutiveFailures: this.#consecutiveFailures, progress: this.progress };
    } finally {
      signal?.removeEventListener?.('abort', abortHandler);
      this.#running = false;
      this.#emit({ state: 'STOPPED', cycleCount: this.#cycleCount });
    }
  }
}

export const createRetentionWorker = (options) => new RetentionWorker(options);

export const createFileRetentionProgressStore = (storagePath) => ({
  async load() {
    if (!storagePath) return undefined;
    return readPersistentJsonFile(storagePath);
  },
  async save(value) {
    if (!storagePath) return;
    await persistJsonFile(storagePath, value, { merge: mergeProgress });
  }
});
