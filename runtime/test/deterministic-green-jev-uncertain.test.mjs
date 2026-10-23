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

test('T-dgu-2: BEHAVIOR_REJECTED / tests red / empty checks / single same-shape → no promote', async () => {
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

  // Single same-shape at maxAttempts=1 → still fail (need ≥2).
  {
    const coordinator = makeCoordinator();
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
      verifyStep: async () => greenUncertain()
    });
    assert.equal(result.ok, false);
    assert.equal(result.report?.status, 'UNCERTAIN');
    assert.equal(result.plan.steps[0].status, 'FAILED');
  }

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
