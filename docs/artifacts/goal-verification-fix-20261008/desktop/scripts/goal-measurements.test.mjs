import test from 'node:test';
import assert from 'node:assert/strict';
import { priceGoalUsage, measureInterventions, reconcileGoalBilling } from './goal-measurements.mjs';

const pricing = { schemaVersion: '1.0', model: 'mimo-v2.6-pro', source: 'https://opencode.ai/docs/go/',
  checkedAt: '2026-10-07T06:30:00Z', currency: 'USD', basis: 'SUBSCRIPTION_QUOTA',
  inputPerMillion: 0.435, cachedInputPerMillion: 0.003625, outputPerMillion: 0.87 };
test('cost uses separate cached and uncached rates and keeps unknown usage unknown', () => {
  const value = priceGoalUsage({ inputTokens: 1000000, cachedInputTokens: 900000, outputTokens: 10000 }, pricing);
  assert.equal(value.basis, 'SUBSCRIPTION_QUOTA');
  assert.ok(Math.abs(value.value - (0.0435 + 0.0032625 + 0.0087)) < 1e-12);
  assert.equal(priceGoalUsage({ inputTokens: 100, cachedInputTokens: null, outputTokens: 10 }, pricing).value, null);
  assert.equal(priceGoalUsage({ inputTokens: 100, cachedInputTokens: 101, outputTokens: 10 }, pricing).value, null);
  assert.equal(priceGoalUsage({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 }).value, null);
  assert.throws(() => priceGoalUsage({}, { ...pricing, inputPerMillion: -1 }));
});
const event = (activityId, phase, atMs, actor = 'HUMAN') => ({ eventId: `${activityId}-${phase}`, runKey: 'case', activityId, phase, atMs, actor });
test('human active time unions overlapping activities, deduplicates events and excludes automation', () => {
  const events = [event('a', 'START', 1000), event('a', 'END', 61000), event('b', 'START', 31000), event('b', 'END', 91000),
    event('a', 'END', 61000), event('auto', 'START', 1000, 'AUTOMATION'), event('auto', 'END', 121000, 'AUTOMATION')];
  const result = measureInterventions(events, { mode: 'OPERATOR', runKey: 'case', startedAtMs: 0, endedAtMs: 121000 });
  assert.equal(result.minutes, 1.5);
  assert.equal(result.automationEvents, 2);
});
test('incomplete activities remain unknown; headless zeros cannot hide human events', () => {
  const options = { runKey: 'case', startedAtMs: 0, endedAtMs: 121000 };
  assert.equal(measureInterventions([event('a', 'START', 1000)], { ...options, mode: 'OPERATOR' }).minutes, null);
  assert.equal(measureInterventions([], { ...options, mode: 'HEADLESS' }).minutes, 0);
  assert.equal(measureInterventions([], { ...options, mode: 'OPERATOR' }).minutes, null);
  assert.throws(() => measureInterventions([event('a', 'START', 1000)], { ...options, mode: 'HEADLESS' }));
  assert.throws(() => measureInterventions([event('a', 'START', -1)], { ...options, mode: 'OPERATOR' }));
});

test('billing imports require full coverage and never turn missing charges into zero', () => {
  const entry = { schemaVersion: '1.0', runKey: 'case', model: 'model', currency: 'USD', chargeId: 'charge-1',
    source: 'fixture invoice row 1', amount: 0.02, coverage: 'PER_CALL', sequence: 1 };
  const options = { runKey: 'case', model: 'model', modelCalls: 2 };
  assert.equal(reconcileGoalBilling([], options).amount, null);
  assert.equal(reconcileGoalBilling([entry], options).amount, null);
  assert.equal(reconcileGoalBilling([entry], options).partialAmount, 0.02);
  assert.equal(reconcileGoalBilling([entry, entry, { ...entry, chargeId: 'charge-2', sequence: 2, amount: 0.03 }], options).amount, 0.05);
  assert.throws(() => reconcileGoalBilling([entry, { ...entry, amount: 0.04 }], options));
  assert.throws(() => reconcileGoalBilling([{ ...entry, model: 'other-model' }], options));
  assert.equal(reconcileGoalBilling([{ ...entry, coverage: 'FULL_RUN', amount: 0 }], options).amount, 0);
});
