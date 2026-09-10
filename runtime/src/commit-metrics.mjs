import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const emptyMetrics = () => ({
  schemaVersion: '1.0',
  attempts: 0,
  successes: 0,
  failures: 0
});

export const readCommitMetrics = async (storagePath) => {
  if (typeof storagePath !== 'string' || !storagePath.trim()) return emptyMetrics();
  const parsed = await readPersistentJsonFile(storagePath);
  return parsed ? { ...emptyMetrics(), ...parsed } : emptyMetrics();
};

export const recordCommitMetric = async (storagePath, delta = {}) => {
  if (typeof storagePath !== 'string' || !storagePath.trim()) return;
  await persistJsonFile(storagePath, delta, {
    merge: (existing) => {
      const current = existing ? { ...emptyMetrics(), ...existing } : emptyMetrics();
      const failures = current.failures + (Number(delta.failures) || 0);
      return {
        schemaVersion: '1.0',
        attempts: current.attempts + (Number(delta.attempts) || 0),
        successes: current.successes + (Number(delta.successes) || 0),
        failures,
        ...(failures > 0
          ? {
              lastFailureAtMs: Number.isFinite(delta.failedAtMs) ? delta.failedAtMs : Date.now(),
              lastErrorCode: String(delta.errorCode ?? current.lastErrorCode ?? 'COMMIT_FAILED').slice(0, 120)
            }
          : current.lastFailureAtMs === undefined
            ? {}
            : { lastFailureAtMs: current.lastFailureAtMs, ...(current.lastErrorCode ? { lastErrorCode: current.lastErrorCode } : {}) })
      };
    }
  });
};

export const createMeteredHarnessEventStore = ({ store, metricsPath, now = Date.now } = {}) => {
  if (!store || typeof store.append !== 'function') throw new Error('METRICS_EVENT_STORE_REQUIRED');
  const meter = async (operation, attempts) => {
    try {
      const result = await operation();
      await recordCommitMetric(metricsPath, { attempts, successes: attempts }).catch(() => {});
      return result;
    } catch (error) {
      await recordCommitMetric(metricsPath, {
        attempts,
        failures: attempts,
        failedAtMs: now(),
        errorCode: error instanceof Error ? error.message : String(error)
      }).catch(() => {});
      throw error;
    }
  };
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'append') return (input) => meter(() => target.append(input), 1);
      if (property === 'appendBatch') {
        return (inputs = []) => meter(() => target.appendBatch(inputs), Array.isArray(inputs) ? inputs.length : 1);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
};
