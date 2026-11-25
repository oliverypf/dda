import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import {
  JEV_EVIDENCE_REQUIRED,
  isDeterministicGreenJevEvidenceUncertain,
  promoteDeterministicGreenJevUncertain,
  countDeterministicGreenJevUncertainReports
} from '../src/task-recovery-controller.mjs';
import { assertVerificationGate } from '../src/acceptance-match.mjs';
import {
  TOPOLOGY_PLAN_THEN_EXECUTE,
  isEvidenceOnlyFailureEvidence,
  isProbeBudgetOnlyFailureEvidence,
  shouldSuppressPostDprDiagnoseUpgrade
} from '../src/execution-topology.mjs';

const JEV_BEHAVIOR_REJECTED = 'JEV_BEHAVIOR_REJECTED';

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

const makeCoordinator = () => {
  const coordinator = {
    planState: undefined,
    async setPlanStateAndFlush(state) {
      this.planState = structuredClone(state);
      return { planState: structuredClone(state) };
    }
  };
  return coordinator;
};

const singleStepPlan = () => normalizePlannerPlan({
  planId: 'plan-dgr',
  steps: [{ stepId: 'execute', summary: 'do work', actionKind: 'WRITE' }]
}, { objectiveDigest: 'sha256:objective' });

// ——— T-dgr-3 ———

test('T-dgr-3: #85 DGU/tip-path + sticky-reject-miss-fire + VRP still green', async () => {
  // DGU evidence UNCERTAIN still promotes via old path
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain()), true);
  assert.equal(countDeterministicGreenJevUncertainReports([greenUncertain(), greenUncertain()]), 2);
  assert.equal(promoteDeterministicGreenJevUncertain(greenUncertain()).status, 'PASS');

  // UNCERTAIN + REJECTED still does NOT take DGU evidence path
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    failureCodes: [JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  // tip-path DGU still works
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain()
    });
    assert.equal(result.ok, true);
    assert.equal(result.results.at(-1).report.status, 'PASS');
    const ids = (result.results.at(-1).report.checks ?? []).map((c) => c.id);
    assert.ok(ids.includes('deterministic-green-jev-uncertain-tip-path'), ids);
  }

  // sticky-reject-miss-fire: REJECTED must not suppress
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
    actionErrorCodes: ['TOPOLOGY_BUDGET_PROBES'],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
    actionErrorCodes: ['TOPOLOGY_BUDGET_PROBES'],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), false);

  // evidence-only sticky still works for EVIDENCE_REQUIRED
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    actionErrorCodes: [],
    checkMessages: []
  }), true);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: [JEV_BEHAVIOR_REJECTED],
    actionErrorCodes: [],
    checkMessages: []
  }), false);

  // VRP (#83)
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [{ name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: 'a', outputDigest: 'b' }],
      acceptanceCommands: ['npm test'],
      verification: { status: 'PASS', nextAction: 'COMPLETE' }
    }),
    undefined
  );
});
