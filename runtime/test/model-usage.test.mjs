import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import {
  addUsageSample,
  emptyUsageSummary,
  normalizeTokenUsage,
  providerTokenUsage,
  readModelUsage,
  withModelUsage
} from '../src/model-usage.mjs';

test('normalizes OpenAI and DeepSeek cache token fields', () => {
  assert.deepEqual(providerTokenUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 80 }
  }, 'chat-completions'), { inputTokens: 20, outputTokens: 20, cacheReadTokens: 80 });
  assert.deepEqual(providerTokenUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_cache_hit_tokens: 75,
    prompt_cache_miss_tokens: 25
  }, 'chat-completions'), { inputTokens: 25, outputTokens: 20, cacheReadTokens: 75 });
  assert.deepEqual(providerTokenUsage({
    input_tokens: 120,
    output_tokens: 30,
    input_tokens_details: { cached_tokens: 90 }
  }, 'responses'), { inputTokens: 30, outputTokens: 30, cacheReadTokens: 90 });
});

test('keeps missing or inconsistent cache usage unknown', () => {
  assert.deepEqual(providerTokenUsage({ prompt_tokens: 10, completion_tokens: 2 }, 'chat-completions'), {
    inputTokens: 10,
    outputTokens: 2
  });
  assert.deepEqual(providerTokenUsage({
    prompt_tokens: 10,
    completion_tokens: 2,
    prompt_cache_hit_tokens: 11
  }, 'chat-completions'), { inputTokens: 10, outputTokens: 2 });
  assert.equal(normalizeTokenUsage({ inputTokens: 0 }).cachedInputTokens, null);
});

test('aggregates hit rate and reporting coverage without treating unknown as zero', () => {
  const summary = emptyUsageSummary();
  addUsageSample(summary, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 });
  addUsageSample(summary, { inputTokens: 50, outputTokens: 5, cachedInputTokens: null });
  assert.equal(summary.calls, 2);
  assert.equal(summary.cacheReportedCalls, 1);
  assert.equal(summary.cacheHitRate, 0.8);
  assert.equal(summary.cacheCoverage, 0.5);
  assert.equal(summary.uncachedInputTokens, 20);
});

test('records one redacted usage sample for success and failure streams', async () => {
  const samples = [];
  const base = {
    provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
    async *stream(request) {
      yield { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: request.fail ? 'error' : 'stop' } };
    }
  };
  const provider = withModelUsage(base, { scope: 'C:/private/workspace', onUsage: (sample) => samples.push(sample) });
  for await (const _chunk of provider.stream({ system: 'stable', tools: [], messages: [], cacheRole: 'executor' })) {}
  for await (const _chunk of provider.stream({ system: 'changed', tools: [], messages: [], cacheRole: 'executor', fail: true })) {}
  assert.equal(samples.length, 2);
  assert.equal(samples[0].inputTokens, 100);
  assert.equal(samples[0].cachedInputTokens, 80);
  assert.equal(samples[0].status, 'SUCCEEDED');
  assert.equal(samples[1].status, 'FAILED');
  assert.deepEqual(samples[1].prefixChangeReasons, ['systemDigest']);
  assert.equal(JSON.stringify(samples).includes('private/workspace'), false);
  assert.equal(JSON.stringify(samples).includes('stable'), false);
});

test('reads only ModelUsageRecorded events and reports historical coverage', async () => {
  const store = createHarnessEventStore();
  await store.append({ runId: 'r1', kind: 'ModelEgressRecorded', payload: { records: [{ actualTokens: 999 }] } });
  await store.append({ runId: 'r1', aggregateType: 'ModelUsage', aggregateId: 'r1', kind: 'ModelUsageRecorded', payload: {
    provider: 'fixture', protocol: 'fixture', model: 'm1', inputTokens: 100,
    outputTokens: 10, cachedInputTokens: 90, prefixChanged: false
  } });
  const result = await readModelUsage(store);
  assert.equal(result.status, 'REPORTED');
  assert.equal(result.cacheHitRate, 0.9);
  assert.equal(result.cacheCoverage, 1);
  assert.equal(result.legacyEgressRecords, 1);
  assert.equal(result.historicalCoverage, 'SINCE_USAGE_INSTRUMENTATION');
});

