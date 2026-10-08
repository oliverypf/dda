import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGoalReport } from './goal-reconcile-report.mjs';

test('later billing derives a report without changing raw measurements or claiming missing charges', () => {
  const source = { mode: 'live', conditions: { 'hmcodex-runtime': {} }, rows: [{
    runKey: 'a', model: 'm', condition: 'hmcodex-runtime', status: 'SUCCEEDED', modelCalls: 2,
    actualCost: null, manualInterventionMinutes: 0, manualMeasurement: 'NO_HUMAN_CHANNEL'
  }] };
  const entry = { schemaVersion: '1.0', runKey: 'a', model: 'm', currency: 'USD', amount: 0.01,
    chargeId: 'invoice-row', source: 'test invoice fixture', coverage: 'FULL_RUN' };
  const derived = reconcileGoalReport(source, { billingEntries: [entry] });
  assert.equal(derived.conditions['hmcodex-runtime'].actualCost, 0.01);
  assert.equal(derived.rows[0].originalMeasurements.actualCost, null);
  assert.equal(source.rows[0].actualCost, null);
  assert.equal(reconcileGoalReport(source, { billingEntries: [] }).rows[0].actualCost, null);
  assert.throws(() => reconcileGoalReport(source, { interventionEvents: [{ runKey: 'a', eventId: '1', actor: 'HUMAN', phase: 'START', activityId: 'x', atMs: 1 }] }), /INTERVENTION_WINDOW_INVALID/u);
});

test('observed activity stays unknown with a missing endpoint; headless runs cannot gain human time', () => {
  const source = { mode: 'live', conditions: { 'hmcodex-runtime': {} }, rows: [{ runKey: 'a', model: 'm', condition: 'hmcodex-runtime', modelCalls: 1,
    manualMeasurement: 'INCOMPLETE_ACTIVITY_LEDGER', startedAtMs: 0, endedAtMs: 120000 }] };
  const start = { runKey: 'a', eventId: '1', actor: 'HUMAN', phase: 'START', activityId: 'x', atMs: 10000 };
  const end = { ...start, eventId: '2', phase: 'END', atMs: 70000 };
  assert.equal(reconcileGoalReport(source, { interventionEvents: [start] }).rows[0].manualInterventionMinutes, null);
  assert.equal(reconcileGoalReport(source, { interventionEvents: [start, end] }).rows[0].manualInterventionMinutes, 1);
  source.rows[0].manualMeasurement = 'NO_HUMAN_CHANNEL';
  assert.throws(() => reconcileGoalReport(source, { interventionEvents: [start, end] }), /HUMAN_EVENT_IN_HEADLESS_RUN/u);
});

test('real decision-provider bills are required before language-only charges become total cash cost', () => {
  const source = { mode: 'live', conditions: { 'hmcodex-runtime': {} }, rows: [{
    runKey: 'combined', model: 'm', condition: 'hmcodex-runtime', status: 'SUCCEEDED', modelCalls: 2,
    actualCost: null, decisionProvider: { mode: 'LIVE_JEV', calls: 3, actualCost: null },
    manualInterventionMinutes: 0, manualMeasurement: 'NO_HUMAN_CHANNEL'
  }] };
  const language = { schemaVersion: '1.0', runKey: 'combined', model: 'm', currency: 'USD', amount: 0.02,
    chargeId: 'language-fixture-receipt', source: 'test fixture; not actual billing', coverage: 'FULL_RUN' };
  const decision = { ...language, model: 'jev-latest', amount: 0.003, chargeId: 'decision-fixture-receipt' };
  const partial = reconcileGoalReport(source, { billingEntries: [language] });
  assert.equal(partial.rows[0].languageModelActualCost, 0.02);
  assert.equal(partial.rows[0].actualCost, null);
  const complete = reconcileGoalReport(source, { billingEntries: [language], decisionBillingEntries: [decision] });
  assert.equal(complete.rows[0].actualCost, 0.023);
  assert.equal(complete.rows[0].decisionProvider.actualCost, 0.003);
  assert.equal(complete.conditions['hmcodex-runtime'].actualCost, 0.023);
  assert.equal(source.rows[0].actualCost, null);
  assert.equal(source.rows[0].decisionProvider.actualCost, null);
  assert.equal(complete.rows[0].originalMeasurements.decisionProvider.actualCost, null);
  assert.throws(() => reconcileGoalReport(source, { decisionBillingEntries: [{ ...decision, model: 'wrong-decision-model' }] }), /BILLING_IMPORT_INVALID/u);
});
