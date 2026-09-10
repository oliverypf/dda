const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 30 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FAILURE_LIMIT = 3;
const MIN_FAILURE_LIMIT = 1;
const MAX_FAILURE_LIMIT = 20;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const boundedInteger = (value, fallback, minimum, maximum, code) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};

export const parseDreamMaintenanceInterval = (value) => boundedInteger(
  value,
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  'DREAM_MAINTENANCE_INTERVAL_INVALID'
);

export const parseDreamMaintenanceFailureLimit = (value) => boundedInteger(
  value,
  DEFAULT_FAILURE_LIMIT,
  MIN_FAILURE_LIMIT,
  MAX_FAILURE_LIMIT,
  'DREAM_MAINTENANCE_FAILURE_LIMIT_INVALID'
);

export const parseDreamActiveRuns = (value) => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1024 ? parsed : undefined;
};

const errorCode = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^[A-Z][A-Z0-9_]{1,96}/u.exec(message);
  return match?.[0] ?? 'DREAM_MAINTENANCE_RUN_FAILED';
};

/**
 * Bounded long-lived maintenance loop for Dreaming.
 *
 * The supervisor never widens DreamScheduler gates and never activates a
 * memory or evolution proposal. It only invokes the caller-provided, already
 * gated one-cycle function at a bounded cadence and reports redacted status.
 */
export class DreamMaintenanceSupervisor {
  #delay;
  #failureLimit;
  #intervalMs;
  #now;
  #runOnce;
  #emit;
  #running = false;
  #stopping = false;
  #consecutiveFailures = 0;
  #cycleCount = 0;
  #lastResult;

  constructor({
    intervalMs = DEFAULT_INTERVAL_MS,
    failureLimit = DEFAULT_FAILURE_LIMIT,
    runOnce,
    delayImpl = delay,
    now = Date.now,
    emit = () => {}
  } = {}) {
    this.#intervalMs = parseDreamMaintenanceInterval(intervalMs);
    this.#failureLimit = parseDreamMaintenanceFailureLimit(failureLimit);
    if (typeof runOnce !== 'function') throw new Error('DREAM_MAINTENANCE_RUNNER_REQUIRED');
    if (typeof delayImpl !== 'function' || typeof now !== 'function' || typeof emit !== 'function') {
      throw new Error('DREAM_MAINTENANCE_DEPENDENCY_INVALID');
    }
    this.#runOnce = runOnce;
    this.#delay = delayImpl;
    this.#now = now;
    this.#emit = emit;
  }

  get running() { return this.#running; }
  get stopping() { return this.#stopping; }
  get cycleCount() { return this.#cycleCount; }
  get consecutiveFailures() { return this.#consecutiveFailures; }
  get lastResult() { return this.#lastResult; }

  stop() { this.#stopping = true; }

  async start({ signal } = {}) {
    if (this.#running) throw new Error('DREAM_MAINTENANCE_ALREADY_RUNNING');
    if (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function')) {
      throw new Error('DREAM_MAINTENANCE_SIGNAL_INVALID');
    }
    this.#running = true;
    this.#stopping = false;
    this.#consecutiveFailures = 0;
    this.#cycleCount = 0;
    this.#lastResult = undefined;
    const abortHandler = () => this.stop();
    signal?.addEventListener('abort', abortHandler, { once: true });
    try {
      while (!this.#stopping && signal?.aborted !== true) {
        const cycle = this.#cycleCount + 1;
        const startedAtMs = this.#now();
        this.#cycleCount = cycle;
        this.#emit({ state: 'RUNNING', cycle, startedAtMs });
        try {
          const result = await this.#runOnce({ cycle, startedAtMs, signal });
          this.#lastResult = result;
          this.#consecutiveFailures = 0;
          this.#emit({ state: 'COMPLETED', cycle, startedAtMs, finishedAtMs: this.#now() });
        } catch (error) {
          this.#consecutiveFailures += 1;
          this.#lastResult = undefined;
          this.#emit({
            state: 'FAILED',
            cycle,
            startedAtMs,
            finishedAtMs: this.#now(),
            errorCode: errorCode(error),
            consecutiveFailures: this.#consecutiveFailures
          });
          if (this.#consecutiveFailures >= this.#failureLimit) {
            throw new Error('DREAM_MAINTENANCE_FAILURE_LIMIT');
          }
        }
        if (this.#stopping || signal?.aborted === true) break;
        await this.#delay(this.#intervalMs);
      }
      return {
        state: 'STOPPED',
        cycleCount: this.#cycleCount,
        consecutiveFailures: this.#consecutiveFailures,
        lastResult: this.#lastResult
      };
    } finally {
      signal?.removeEventListener?.('abort', abortHandler);
      this.#running = false;
      this.#emit({ state: 'STOPPED', cycleCount: this.#cycleCount, consecutiveFailures: this.#consecutiveFailures });
    }
  }
}

export const createDreamMaintenanceSupervisor = (options) => new DreamMaintenanceSupervisor(options);
