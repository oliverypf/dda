import { randomUUID } from 'node:crypto';
import { cacheDigest, prefixShape, comparePrefixShapes } from './prompt-cache.mjs';

const count = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;
const sum = (a, b) => a === null || b === null ? null : count(a + b);
const pick = (...values) => values.find((v) => v !== undefined && v !== null);

// dsh-llm uses DISJOINT input/cache-read/cache-write counts. Our stored input is
// the inclusive total, matching OpenAI/DeepSeek prompt_tokens and the ratio.
export const normalizeTokenUsage = (usage) => {
  const input = count(usage?.inputTokens), output = count(usage?.outputTokens);
  const read = count(usage?.cacheReadTokens), write = count(usage?.cacheWriteTokens);
  const inputTokens = input === null ? null : sum(sum(input, read ?? 0), write ?? 0);
  const cachedInputTokens = read !== null && inputTokens !== null && read <= inputTokens ? read : null;
  return {
    inputTokens, outputTokens: output,
    totalTokens: sum(inputTokens, output), cachedInputTokens,
    uncachedInputTokens: cachedInputTokens === null ? null : inputTokens - cachedInputTokens,
    cacheReported: cachedInputTokens !== null,
    usageReported: inputTokens !== null || output !== null
  };
};

// Return standard dsh counters. Missing cache data stays absent, never zero.
export const providerTokenUsage = (raw, protocol) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  let input = count(protocol === 'responses' ? raw.input_tokens : raw.prompt_tokens);
  let cached = count(protocol === 'responses' ? raw.input_tokens_details?.cached_tokens
    : pick(raw.prompt_tokens_details?.cached_tokens, raw.prompt_cache_hit_tokens));
  const miss = count(raw.prompt_cache_miss_tokens);
  if (input === null && protocol !== 'responses' && cached !== null && miss !== null) input = sum(cached, miss);
  if (input === null || (cached !== null && cached > input) || (cached !== null && miss !== null && cached + miss !== input)) cached = null;
  const output = count(protocol === 'responses' ? raw.output_tokens : raw.completion_tokens);
  if (input === null && output === null) return undefined;
  return {
    ...(input === null ? {} : { inputTokens: input - (cached ?? 0) }),
    ...(output === null ? {} : { outputTokens: output }),
    ...(cached === null ? {} : { cacheReadTokens: cached })
  };
};

export const emptyUsageSummary = () => ({
  schemaVersion: '1.0', calls: 0, usageReportedCalls: 0, cacheReportedCalls: 0,
  inputTokens: 0, outputTokens: 0, cacheEligibleInputTokens: 0, cachedInputTokens: 0,
  uncachedInputTokens: 0, cacheHitRate: null, cacheCoverage: null,
  estimated: false, source: 'PROVIDER_USAGE', prefixChangedCalls: 0
});
export const addUsageSample = (summary, sample) => {
  const input = count(sample?.inputTokens), output = count(sample?.outputTokens), cached = count(sample?.cachedInputTokens);
  summary.calls += 1;
  if (input !== null || output !== null) summary.usageReportedCalls += 1;
  summary.inputTokens += input ?? 0;
  summary.outputTokens += output ?? 0;
  if (input !== null && cached !== null && cached <= input) {
    summary.cacheReportedCalls += 1;
    summary.cacheEligibleInputTokens += input;
    summary.cachedInputTokens += cached;
    summary.uncachedInputTokens += input - cached;
  }
  if (sample?.prefixChanged === true) summary.prefixChangedCalls += 1;
  summary.cacheHitRate = summary.cacheEligibleInputTokens > 0 ? summary.cachedInputTokens / summary.cacheEligibleInputTokens : null;
  summary.cacheCoverage = summary.calls ? summary.cacheReportedCalls / summary.calls : null;
  return summary;
};

// Wrap every role/provider invocation, including tool rounds and failures.
// State is per task/provider; only digests and numeric usage are persisted.
export const withModelUsage = (provider, { scope, onUsage, onRecordingError = () => {} } = {}) => {
  const shapes = new Map();
  return {
    ...provider,
    async *stream(request) {
      const role = request.cacheRole ?? request.messages?.[0]?.source?.role ?? 'executor';
      const roleKey = ['planner', 'executor', 'verifier', 'semanticVerifier', 'council', 'candidate', 'candidate-judge'].includes(role) ? role : 'other';
      const shape = prefixShape(request);
      const reasons = comparePrefixShapes(shapes.get(roleKey), shape);
      shapes.set(roleKey, shape);
      let usage, status = 'UNKNOWN';
      const start = Date.now();
      try {
        for await (const chunk of provider.stream({ ...request, cacheScope: cacheDigest(scope ?? ''), cacheRole: roleKey })) {
          if (chunk?.type === 'usage') usage = chunk.usage;
          if (chunk?.type === 'finish') status = ['error', 'aborted'].includes(chunk.reason?.kind) ? 'FAILED' : 'SUCCEEDED';
          yield chunk;
        }
      } catch (error) {
        status = request.signal?.aborted ? 'CANCELLED' : 'FAILED';
        throw error;
      } finally {
        if (request.signal?.aborted) status = 'CANCELLED';
        const sample = {
          schemaVersion: '1.0', invocationId: randomUUID(), role: roleKey,
          provider: String(provider.provider ?? 'unknown').slice(0, 80),
          model: String(provider.model ?? 'unknown').slice(0, 240),
          protocol: String(provider.protocol ?? 'unknown').slice(0, 40),
          ...normalizeTokenUsage(usage), status,
          latencyMs: Math.max(0, Date.now() - start),
          prefixChanged: reasons.length > 0, prefixChangeReasons: reasons, ...shape
        };
        // Usage is observational: never retry a model/tool or change its result
        // when telemetry persistence fails. A recording gap is explicitly reported.
        try { await onUsage?.(sample); } catch { onRecordingError('MODEL_USAGE_RECORD_FAILED'); }
      }
    }
  };
};

export const readModelUsage = async (eventStore, { runId } = {}) => {
  const totals = emptyUsageSummary();
  const byModel = Object.create(null);
  let legacyEgressRecords = 0;
  for await (const event of eventStore.iterate({ ...(runId ? { runId } : {}) })) {
    if (event.kind === 'ModelEgressRecorded') legacyEgressRecords += Array.isArray(event.payload?.records) ? event.payload.records.length : 0;
    if (event.kind !== 'ModelUsageRecorded') continue;
    addUsageSample(totals, event.payload);
    const sample = event.payload;
    const key = [sample.provider, sample.protocol, sample.model].map(v => String(v ?? '').slice(0, 240)).join('/');
    if (!byModel[key] && Object.keys(byModel).length < 256) byModel[key] = emptyUsageSummary();
    if (byModel[key]) addUsageSample(byModel[key], sample);
  }
  return { ...totals, byModel, legacyEgressRecords, historicalCoverage: 'SINCE_USAGE_INSTRUMENTATION',
    status: totals.cacheReportedCalls ? 'REPORTED' : 'UNKNOWN',
    reason: totals.cacheReportedCalls ? undefined : totals.calls ? 'PROVIDER_CACHE_USAGE_NOT_REPORTED' : 'NO_RECORDED_PROVIDER_USAGE' };
};
