import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import { JEV_EVIDENCE_REQUIRED } from '../src/task-recovery-controller.mjs';

const JEV_BEHAVIOR_REJECTED = 'JEV_BEHAVIOR_REJECTED';
const DGU_PROMOTE_IDS = new Set([
  'deterministic-green-jev-uncertain-promote',
  'deterministic-green-jev-uncertain-tip-path'
]);
const DGR_PROMOTE_ID = 'deterministic-green-jev-behavior-reject-promote';

const greenUncertain = (extra = {}) => ({
  status: 'UNCERTAIN',
  summary: 'Deterministic checks passed but Jev requires more evidence',
  nextAction: 'COMPLETE',
  failureCodes: [JEV_EVIDENCE_REQUIRED],
  checks: [
    { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
    { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
    { id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'evidence-gap' }
  ],
  ...extra
});

const greenRejectFail = (extra = {}) => ({
  status: 'FAIL',
  summary: 'RULE_VERIFIER_FAILED: behavior rejected',
  nextAction: 'COMPLETE',
  failureCodes: [JEV_BEHAVIOR_REJECTED],
  checks: [
    { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
    { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
    { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
  ],
  ...extra
});

const makeCoordinator = () => ({
  planState: undefined,
  async setPlanStateAndFlush(state) {
    this.planState = structuredClone(state);
    return { planState: structuredClone(state) };
  }
});

const singleStepPlan = () => normalizePlannerPlan({
  planId: 'plan-promote-verification-align',
  steps: [{ stepId: 'execute', summary: 'do work', actionKind: 'WRITE' }]
}, { objectiveDigest: 'sha256:objective' });

// Keep the verifier payload in the same shape as runPlanStep: the coordinator
// record's result contains a nested verification report that was emitted before
// the terminal promote decision.
const executePayload = (verification) => ({
  stepId: 'execute',
  ok: false,
  result: { text: 'done', actions: [] },
  verification: structuredClone(verification)
});

const runCoordinator = async ({ report, maxAttempts = 1 }) => {
  const coordinator = makeCoordinator();
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  return scheduler.run({
    maxAttempts,
    executeStep: async () => executePayload(report),
    verifyStep: async ({ result }) => result.verification
  });
};

const checkIds = (report) => new Set((report?.checks ?? []).map((check) => check.id));

// ——— T-pva-1 ———

test('T-pva-1: DGU tip-path and ≥2 promote align report and nested verification to PASS', async () => {
  // maxAttempts:1 takes the terminal tip-path promote branch.
  const tipPath = await runCoordinator({ report: greenUncertain(), maxAttempts: 1 });
  const tipEntry = tipPath.results.at(-1);
  assert.equal(tipPath.ok, true);
  assert.equal(tipPath.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(tipEntry.report.status, 'PASS');
  assert.equal(tipEntry.result.verification.status, 'PASS');
  assert.equal(tipEntry.result.ok, true);
  assert.ok(
    checkIds(tipEntry.report).has('deterministic-green-jev-uncertain-tip-path'),
    'tip-path promote audit check is present on report'
  );
  assert.ok(
    checkIds(tipEntry.result.verification).has('deterministic-green-jev-uncertain-tip-path'),
    'tip-path promote audit check is present on nested verification'
  );

  // maxAttempts:2 accumulates two same-shape reports and takes the ≥2 promote branch.
  const repeated = await runCoordinator({ report: greenUncertain(), maxAttempts: 2 });
  const repeatedEntry = repeated.results.at(-1);
  assert.equal(repeated.ok, true);
  assert.equal(repeated.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(repeated.results.length, 2);
  assert.equal(repeatedEntry.report.status, 'PASS');
  assert.equal(repeatedEntry.result.verification.status, 'PASS');
  assert.equal(repeatedEntry.result.ok, true);
  assert.ok(
    checkIds(repeatedEntry.report).has('deterministic-green-jev-uncertain-promote'),
    '≥2 promote audit check is present on report'
  );
  assert.ok(
    checkIds(repeatedEntry.result.verification).has('deterministic-green-jev-uncertain-promote'),
    '≥2 promote audit check is present on nested verification'
  );
  assert.equal(
    [...DGU_PROMOTE_IDS].some((id) => checkIds(repeatedEntry.result.verification).has(id)),
    true
  );
});

// ——— T-pva-2 ———

test('T-pva-2: DGR behavior-reject promote aligns report and nested verification to PASS', async () => {
  const execution = await runCoordinator({ report: greenRejectFail(), maxAttempts: 1 });
  const entry = execution.results.at(-1);
  assert.equal(execution.ok, true);
  assert.equal(execution.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(entry.report.status, 'PASS');
  assert.equal(entry.result.verification.status, 'PASS');
  assert.equal(entry.result.ok, true);
  assert.ok(checkIds(entry.report).has(DGR_PROMOTE_ID), 'DGR promote audit check is present on report');
  assert.ok(checkIds(entry.result.verification).has(DGR_PROMOTE_ID), 'DGR promote audit check is present on nested verification');
});

// ——— T-pva-3 ———

test('T-pva-3: reports that fail promote eligibility remain UNCERTAIN/FAIL', async () => {
  const dguIneligible = await runCoordinator({
    maxAttempts: 1,
    report: greenUncertain({
      checks: [
        { id: 'evidence.tests', status: 'FAIL', message: 'tests red' },
        { id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'evidence-gap' }
      ]
    })
  });
  const dguEntry = dguIneligible.results.at(-1);
  assert.equal(dguIneligible.ok, false);
  assert.equal(dguEntry.report.status, 'UNCERTAIN');
  assert.equal(dguEntry.result.verification.status, 'UNCERTAIN');
  assert.notEqual(dguEntry.result.verification.status, 'PASS');
  assert.equal([...checkIds(dguEntry.report)].some((id) => DGU_PROMOTE_IDS.has(id)), false);

  const dgrIneligible = await runCoordinator({
    maxAttempts: 1,
    report: greenRejectFail({
      checks: [
        { id: 'evidence.tests', status: 'FAIL', message: 'tests red' },
        { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
      ]
    })
  });
  const dgrEntry = dgrIneligible.results.at(-1);
  assert.equal(dgrIneligible.ok, false);
  assert.equal(dgrEntry.report.status, 'FAIL');
  assert.equal(dgrEntry.result.verification.status, 'FAIL');
  assert.notEqual(dgrEntry.result.verification.status, 'PASS');
  assert.equal(checkIds(dgrEntry.report).has(DGR_PROMOTE_ID), false);
});
