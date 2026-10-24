import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import {
  JEV_EVIDENCE_REQUIRED,
  isDeterministicGreenJevEvidenceUncertain,
  isDeterministicGreenJevBehaviorReject,
  promoteDeterministicGreenJevBehaviorReject,
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

// ——— T-dgr-1 ———

test('T-dgr-1: final FAIL + only REJECTED/(±ACTION_FAILED) + tests PASS → promote', async () => {
  const v = greenRejectFail();
  assert.equal(isDeterministicGreenJevBehaviorReject(v), true);
  const promoted = promoteDeterministicGreenJevBehaviorReject(v);
  assert.equal(promoted.status, 'PASS');
  assert.equal(promoted.nextAction, 'COMPLETE');
  assert.equal(promoted.failureCodes?.length ?? 0, 0);
  assert.ok((promoted.checks ?? []).some((c) => c.id === 'deterministic-green-jev-behavior-reject-promote'));

  // with ACTION_FAILED companion
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED]
  })), true);

  // live residual shape (run76/run77): actions.progress FAIL + tests PASS + REJECTED
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
      { id: 'actions.progress', status: 'FAIL', message: '1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）' },
      { id: 'output.non_empty', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
    ]
  })), true, 'live residual actions.progress FAIL must still promote');

  // actions.progress FAIL without ACTION_FAILED in codes → still no promote
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'actions.progress', status: 'FAIL', message: '1 个动作执行失败' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  // other deterministic FAIL (e.g. paths.scope) still blocks
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'paths.scope', status: 'FAIL', message: 'out of scope' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  // tip maxAttempts:1
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenRejectFail()
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
    assert.equal(result.results.at(-1).report.status, 'PASS');
    assert.ok(
      (result.results.at(-1).report.checks ?? []).some((c) => c.id === 'deterministic-green-jev-behavior-reject-promote')
    );
  }

  // maxAttempts:2 — FAIL is not recoverable so first FAIL still promotes
  {
    const coordinator = makeCoordinator();
    let executions = 0;
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 2,
      executeStep: async ({ attempt }) => {
        executions += 1;
        return { outputDigest: `sha256:${String(attempt).padStart(64, '0')}` };
      },
      verifyStep: async () => greenRejectFail({
        failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED]
      })
    });
    assert.equal(executions, 1);
    assert.equal(result.ok, true);
    assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
    assert.equal(result.results.at(-1).report.status, 'PASS');
  }
});

// ——— T-mrf-1 ———

test('T-mrf-1: REJECTED + REPEATED_ACTION (+ ACTION_FAILED) + tests PASS → DGR promote', async () => {
  const repeated = greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION']
  });
  assert.equal(isDeterministicGreenJevBehaviorReject(repeated), true);
  const promoted = promoteDeterministicGreenJevBehaviorReject(repeated);
  assert.equal(promoted.status, 'PASS');
  assert.equal(promoted.nextAction, 'COMPLETE');
  assert.equal(promoted.failureCodes?.length ?? 0, 0);
  assert.ok(
    (promoted.checks ?? []).some((check) => check.id === 'deterministic-green-jev-behavior-reject-promote')
  );

  // REPEATED_ACTION may accompany the existing ACTION_FAILED residual shape.
  const repeatedWithActionFailure = greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'ACTION_FAILED', 'REPEATED_ACTION']
  });
  assert.equal(isDeterministicGreenJevBehaviorReject(repeatedWithActionFailure), true);
  assert.equal(promoteDeterministicGreenJevBehaviorReject(repeatedWithActionFailure).status, 'PASS');

  // The coordinator must use the existing DGR branch and callback reason.
  const coordinator = makeCoordinator();
  let promotion;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
    verifyStep: async () => repeated,
    onVerificationPromoted: (event) => {
      promotion = event;
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(result.results.at(-1).report.status, 'PASS');
  assert.equal(promotion?.reason, 'dgr');
  assert.equal(promotion?.priorStatus, 'FAIL');
  assert.equal(promotion?.report?.status, 'PASS');
  assert.ok(
    (result.results.at(-1).report.checks ?? [])
      .some((check) => check.id === 'deterministic-green-jev-behavior-reject-promote')
  );
});

// ——— T-mrf-2 ———

test('T-mrf-2: deterministic red or missing REJECTED still blocks REPEATED_ACTION promote', async () => {
  // A hard deterministic code remains ineligible even with tests green.
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION', 'TESTS_FAILED']
  })), false);

  // Red evidence.tests remains ineligible even when the codes are otherwise allowed.
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION'],
    checks: [
      { id: 'evidence.tests', status: 'FAIL', message: 'red' },
      { id: 'output.non_empty', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  // REPEATED_ACTION does not widen the actions.progress FAIL exception.
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION'],
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'actions.progress', status: 'FAIL', message: 'action failed' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  // REPEATED_ACTION alone cannot open the behavior-reject gate.
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: ['REPEATED_ACTION']
  })), false);

  // The coordinator must leave a rejected/tests-failed report as FAIL.
  const coordinator = makeCoordinator();
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
    verifyStep: async () => greenRejectFail({
      failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION', 'TESTS_FAILED']
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.plan.steps[0].status, 'FAILED');
  assert.equal(result.results.at(-1).report.status, 'FAIL');
  assert.equal(
    (result.results.at(-1).report.checks ?? [])
      .some((check) => check.id === 'deterministic-green-jev-behavior-reject-promote'),
    false
  );
});

// ——— T-dgr-2 ———

test('T-dgr-2: tests FAIL / no tests green / hard codes / pure ACTION_FAILED → still fail', async () => {
  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    checks: [
      { id: 'evidence.tests', status: 'FAIL', message: 'red' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    checks: [
      { id: 'output.non_empty', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false, 'missing evidence.tests');

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'other.det', status: 'UNKNOWN' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false, 'UNKNOWN deterministic');

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    checks: []
  })), false);

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'TESTS_FAILED']
  })), false);

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'SHELL_FAILED']
  })), false);

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    failureCodes: ['ACTION_FAILED']
  })), false, 'pure ACTION_FAILED without REJECTED');

  assert.equal(isDeterministicGreenJevBehaviorReject(greenRejectFail({
    status: 'UNCERTAIN'
  })), false, 'UNCERTAIN is not this path');

  // plan-step still fails when tests red
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenRejectFail({
        checks: [
          { id: 'evidence.tests', status: 'FAIL', message: 'red' },
          { id: 'jev-behavior-judge', status: 'FAIL' }
        ]
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }

  // hard code still fails
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenRejectFail({
        failureCodes: [JEV_BEHAVIOR_REJECTED, 'TESTS_FAILED']
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }
});

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
