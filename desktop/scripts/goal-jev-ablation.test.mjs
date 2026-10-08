import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeJevAblation } from './goal-jev-ablation.mjs';

const report = () => ({ repeat: 1, model: 'actual-model', runtimeSourceSha256: 'source', taskSet: [{ taskId: 'repair' }], rows: [
  { iteration: 1, taskId: 'repair', client: 'hmcodex-runtime', condition: 'hmcodex-jev-off', model: 'actual-model', runtimeSourceSha256: 'source',
    initialDigest: 'same-input', runKey: 'off', status: 'SUCCEEDED', decisionProvider: { mode: 'OFF', calls: 0 } },
  { iteration: 1, taskId: 'repair', client: 'hmcodex-runtime', condition: 'hmcodex-jev-on', model: 'actual-model', runtimeSourceSha256: 'source',
    initialDigest: 'same-input', runKey: 'on', status: 'TIMED_OUT', decisionProvider: { mode: 'LIVE_JEV', calls: 3, succeededCalls: 2,
      wallMs: null, inputTokens: null, outputTokens: null, estimatedCost: null } }
] });

test('a failed treatment is retained, with missing latency and cost unknown', () => {
  const result = summarizeJevAblation(report());
  assert.equal(result.pairs[0].onStatus, 'TIMED_OUT');
  assert.equal(result.activatedOnRuns, 1);
  assert.equal(result.decision.calls, 3);
  assert.equal(result.decision.wallMs, null);
  assert.equal(result.decision.estimatedApiCost, null);
});

test('independent batches, changed input or source, and incomplete pairs cannot become paired evidence', () => {
  for (const [field, value, code] of [['initialDigest', 'other-input', 'INPUT'], ['model', 'other-model', 'SOURCE_OR_MODEL'],
    ['runtimeSourceSha256', 'other-source', 'SOURCE_OR_MODEL'], ['client', 'ordinary-codex', 'CLIENT']]) {
    const data = report(); data.rows[1][field] = value;
    assert.throws(() => summarizeJevAblation(data), new RegExp(`ABLATION_${code}_MISMATCH`));
  }
  const missing = report(); missing.rows.pop();
  assert.throws(() => summarizeJevAblation(missing), /ABLATION_PAIR_MISSING/u);
  const duplicate = report(); duplicate.rows.push(duplicate.rows[1]);
  assert.throws(() => summarizeJevAblation(duplicate), /ABLATION_DUPLICATE_ARM/u);
});

test('declared off/on conditions must match observed decision-provider usage', () => {
  const invalid = report(); invalid.rows[0].decisionProvider.calls = 1;
  assert.throws(() => summarizeJevAblation(invalid), /ABLATION_TREATMENT_MISMATCH/u);
  const unactivated = report(); unactivated.rows[1].decisionProvider.calls = 0;
  assert.equal(summarizeJevAblation(unactivated).activatedOnRuns, 0, 'an unactivated failed run is recorded rather than dropped');
});
