// Measurement for the Jev speed MVP. Pure bookkeeping: recording never
// changes a decision, and summaries are additive output only.

const SAMPLE_LIMIT = 512;

const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const latencyStats = (samples, total, max) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { totalMs: total, maxMs: max, p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
};

const cleanKind = (kind) => (typeof kind === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/u.test(kind) ? kind : 'UNKNOWN');

/**
 * Per-kind Jev counters:
 * - decisions: decisions produced by the engine for this kind
 * - requests / requestErrors: actual Jev HTTP requests and failed ones
 * - fallbacks: decisions that fell back to a rule/conservative result
 * - shortCircuits: decisions answered by a deterministic rule without a
 *   Jev request (hard BLOCK, READONLY_FAST_PATH, ...), keyed by reason
 */
export const createJevMetrics = () => {
  const kinds = new Map();
  const entry = (kind) => {
    const key = cleanKind(kind);
    if (!kinds.has(key)) {
      kinds.set(key, { decisions: 0, requests: 0, requestErrors: 0, fallbacks: 0, shortCircuits: 0,
        shortCircuitReasons: {}, latencyTotalMs: 0, latencyMaxMs: 0, samples: [] });
    }
    return kinds.get(key);
  };
  return {
    recordRequest(kind, { latencyMs = 0, ok = true } = {}) {
      const item = entry(kind);
      const latency = Math.max(0, Number(latencyMs) || 0);
      item.requests += 1;
      if (!ok) item.requestErrors += 1;
      item.latencyTotalMs += latency;
      item.latencyMaxMs = Math.max(item.latencyMaxMs, latency);
      if (item.samples.length < SAMPLE_LIMIT) item.samples.push(latency);
    },
    recordDecision(kind, { fallbackUsed = false, shortCircuitReason } = {}) {
      const item = entry(kind);
      item.decisions += 1;
      if (fallbackUsed === true) item.fallbacks += 1;
      if (shortCircuitReason) {
        item.shortCircuits += 1;
        const reason = cleanKind(shortCircuitReason);
        item.shortCircuitReasons[reason] = (item.shortCircuitReasons[reason] ?? 0) + 1;
      }
    },
    summary() {
      const byKind = {};
      const totals = { decisions: 0, requests: 0, requestErrors: 0, fallbacks: 0, shortCircuits: 0, latencyTotalMs: 0 };
      for (const [kind, item] of [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        byKind[kind] = {
          decisions: item.decisions,
          requests: item.requests,
          requestErrors: item.requestErrors,
          fallbacks: item.fallbacks,
          shortCircuits: item.shortCircuits,
          ...(item.shortCircuits ? { shortCircuitReasons: { ...item.shortCircuitReasons } } : {}),
          latency: latencyStats(item.samples, item.latencyTotalMs, item.latencyMaxMs)
        };
        totals.decisions += item.decisions;
        totals.requests += item.requests;
        totals.requestErrors += item.requestErrors;
        totals.fallbacks += item.fallbacks;
        totals.shortCircuits += item.shortCircuits;
        totals.latencyTotalMs += item.latencyTotalMs;
      }
      return { byKind, totals };
    }
  };
};

/** Accumulate wall-clock time per runtime stage (planner, council, ...). */
export const createStageTimer = ({ now = Date.now } = {}) => {
  const stages = new Map();
  const add = (name, ms) => {
    const item = stages.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    const value = Math.max(0, Number(ms) || 0);
    item.count += 1;
    item.totalMs += value;
    item.maxMs = Math.max(item.maxMs, value);
    stages.set(name, item);
  };
  return {
    add,
    async time(name, fn) {
      const startedAtMs = now();
      try { return await fn(); } finally { add(name, now() - startedAtMs); }
    },
    wrap(name, fn) {
      return async (...args) => {
        const startedAtMs = now();
        try { return await fn(...args); } finally { add(name, now() - startedAtMs); }
      };
    },
    summary() {
      return Object.fromEntries([...stages.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, { ...item }]));
    }
  };
};
