import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import {
  JEV_EVIDENCE_REQUIRED,
  isDeterministicGreenJevEvidenceUncertain,
  countDeterministicGreenJevUncertainReports,
  promoteDeterministicGreenJevUncertain
} from '../src/task-recovery-controller.mjs';
import { assertVerificationGate } from '../src/acceptance-match.mjs';
import {
  TOPOLOGY_PLAN_THEN_EXECUTE,
  isEvidenceOnlyFailureEvidence,
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
  planId: 'plan-dgu',
  steps: [{ stepId: 'execute', summary: 'do work', actionKind: 'WRITE' }]
}, { objectiveDigest: 'sha256:objective' });

// ——— T-dgu-1 ———

test('T-dgu-1: evidence-only UNCERTAIN + tests PASS + ≥2 same-shape → promote; plan-step ok', async () => {
  const v = greenUncertain();
  assert.equal(isDeterministicGreenJevEvidenceUncertain(v), true);
  assert.equal(countDeterministicGreenJevUncertainReports([v, v]), 2);
  const promoted = promoteDeterministicGreenJevUncertain(v);
  assert.equal(promoted.status, 'PASS');
  assert.equal(promoted.nextAction, 'COMPLETE');
  assert.ok((promoted.checks ?? []).some((c) => c.id === 'deterministic-green-jev-uncertain-promote'));

  const coordinator = makeCoordinator();
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 2,
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, '0')}`, text: `e${attempt}` };
    },
    verifyStep: async () => greenUncertain()
  });
  assert.equal(executions, 2);
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(result.results.at(-1).report.status, 'PASS');
  assert.equal(result.results.at(-1).report.failureCodes?.length ?? 0, 0);
});

// ——— T-dgu-2 ———

test('T-dgu-2: BEHAVIOR_REJECTED / tests red / empty checks → no promote (predicate + ≥2 path)', async () => {
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    failureCodes: [JEV_BEHAVIOR_REJECTED]
  })), false);
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    failureCodes: [JEV_EVIDENCE_REQUIRED, JEV_BEHAVIOR_REJECTED]
  })), false);
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    checks: [
      { id: 'evidence.tests', status: 'FAIL', message: 'red' },
      { id: 'jev-behavior-judge', status: 'UNKNOWN' }
    ]
  })), false);
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    checks: []
  })), false);
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    checks: [
      { id: 'output.non_empty', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'UNKNOWN' }
    ]
  })), false, 'missing evidence.tests must not promote');
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'other.det', status: 'UNKNOWN' },
      { id: 'jev-behavior-judge', status: 'UNKNOWN' }
    ]
  })), false, 'UNKNOWN deterministic check must not promote');
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL', message: 'rejected' }
    ]
  })), false);
  assert.equal(countDeterministicGreenJevUncertainReports([greenUncertain()]), 1);

  // BEHAVIOR_REJECTED stays failed even with ≥2 attempts.
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 2,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain({
        failureCodes: [JEV_BEHAVIOR_REJECTED],
        checks: [
          { id: 'evidence.tests', status: 'PASS' },
          { id: 'jev-behavior-judge', status: 'FAIL' }
        ]
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }

  // evidence.tests FAIL stays failed with ≥2 attempts.
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 2,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain({
        checks: [
          { id: 'evidence.tests', status: 'FAIL' },
          { id: 'jev-behavior-judge', status: 'UNKNOWN' }
        ]
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }
});

// ——— T-dgu-3 regression: #83 VRP + #84 sticky ———

test('T-dgu-3: VRP PASS short-circuit + sticky-evidence #84 still green', () => {
  // VRP (#83): final PASS wins over acceptance gate.
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [{ name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: 'a', outputDigest: 'b' }],
      acceptanceCommands: ['npm test'],
      verification: { status: 'PASS', nextAction: 'COMPLETE' }
    }),
    undefined
  );
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [{ name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: 'a', outputDigest: 'b' }],
      acceptanceCommands: ['npm test'],
      verification: { status: 'UNCERTAIN', failureCodes: [JEV_EVIDENCE_REQUIRED] }
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );

  // Sticky-evidence (#84): JEV_EVIDENCE_REQUIRED-only still suppresses post-dpr upgrade.
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    actionErrorCodes: [],
    checkMessages: []
  }), true);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    actionErrorCodes: [],
    checkMessages: []
  }), true);
  // Behavior rejected must NOT be evidence-only.
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: [JEV_BEHAVIOR_REJECTED],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
});


// ——— T-dgu-tp-1: tip path maxAttempts:1 terminal DGU → promote ———

test('T-dgu-tp-1: maxAttempts:1 + terminal evidence-only UNCERTAIN + tests PASS → promote (tip-path)', async () => {
  const coordinator = makeCoordinator();
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, '0')}`, text: `e${attempt}` };
    },
    verifyStep: async () => greenUncertain()
  });
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(result.results.at(-1).report.status, 'PASS');
  assert.equal(result.results.at(-1).report.failureCodes?.length ?? 0, 0);
  assert.ok(
    (result.results.at(-1).report.checks ?? []).some((c) => c.id === 'deterministic-green-jev-uncertain-tip-path'),
    'tip-path audit check id'
  );
});

// ——— T-dgu-tp-2: tip path still fails REJECTED / tests red ———

test('T-dgu-tp-2: maxAttempts:1 BEHAVIOR_REJECTED / tests red → still fail', async () => {
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain({
        failureCodes: [JEV_BEHAVIOR_REJECTED],
        checks: [
          { id: 'evidence.tests', status: 'PASS' },
          { id: 'jev-behavior-judge', status: 'FAIL' }
        ]
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain({
        checks: [
          { id: 'evidence.tests', status: 'FAIL' },
          { id: 'jev-behavior-judge', status: 'UNKNOWN' }
        ]
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }
});

// ——— T-dgu-tp-3: #85 ≥2 path + VRP/sticky still green (covered by T-dgu-1/3; explicit tip-path note) ———

test('T-dgu-tp-3: maxAttempts:2 ≥2 same-shape still uses promote (not tip-path) audit id', async () => {
  const coordinator = makeCoordinator();
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 2,
    executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
    verifyStep: async () => greenUncertain()
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.at(-1).report.status, 'PASS');
  const ids = (result.results.at(-1).report.checks ?? []).map((c) => c.id);
  assert.ok(ids.includes('deterministic-green-jev-uncertain-promote'), ids);
  assert.equal(ids.includes('deterministic-green-jev-uncertain-tip-path'), false);
});


// ——— T-srm-3: #85 DGU tip-path / ≥2 promote still green after reject-miss-fire ———

test('T-srm-3: DGU tip-path maxAttempts:1 + ≥2 promote still green; REJECTED not promoted', async () => {
  // tip-path promote still works
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
  }
  // ≥2 path still promote (not tip-path id when count≥2)
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 2,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain()
    });
    assert.equal(result.ok, true);
    const ids = (result.results.at(-1).report.checks ?? []).map((c) => c.id);
    assert.ok(ids.includes('deterministic-green-jev-uncertain-promote'));
  }
  // REJECTED must not be DGU-promoted
  assert.equal(isDeterministicGreenJevEvidenceUncertain(greenUncertain({
    failureCodes: [JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'PASS' },
      { id: 'jev-behavior-judge', status: 'FAIL' }
    ]
  })), false);
  // sticky: REJECTED must not suppress (align T-srm-1)
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
    actionErrorCodes: ['TOPOLOGY_BUDGET_PROBES'],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), false);
});
