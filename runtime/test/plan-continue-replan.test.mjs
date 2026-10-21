import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import {
  isPlanContinueReplanEligible,
  isSoleHardDenyFailure,
  planContinueReplanHostNote,
  JEV_EVIDENCE_REQUIRED
} from '../src/task-recovery-controller.mjs';

const makeCoordinator = (initialState) => {
  const coordinator = {
    planState: initialState,
    async setPlanStateAndFlush(state) {
      this.planState = structuredClone(state);
      return { planState: structuredClone(state) };
    }
  };
  return { coordinator };
};

const singleStepPlan = () => normalizePlannerPlan({
  planId: 'plan-pc',
  steps: [{ stepId: 'execute', summary: 'do work', actionKind: 'WRITE' }]
}, { objectiveDigest: 'sha256:objective' });

const continueReport = (extra = {}) => ({
  status: 'CONTINUE',
  nextAction: 'CONTINUE_EXECUTION',
  summary: '任务尚未完成，仍需继续执行',
  failureCodes: [],
  ...extra
});

// T-pc-1: first CONTINUE+writes → exactly 1× re-exec; second still CONTINUE → stop
test('T-pc-1: CONTINUE+writes yields exactly one plan-continue re-exec; second CONTINUE stops', async () => {
  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: [],
    alreadyReplanned: false
  }), true);

  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 2,
    alreadyReplanned: true
  }), false);

  const { coordinator } = makeCoordinator();
  const events = [];
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    continueReplan: {
      getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
      isEligible: isPlanContinueReplanEligible,
      onPlanContinueReplan: (evt) => events.push(evt)
    },
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, '0')}`, text: `e${attempt}` };
    },
    verifyStep: async () => continueReport()
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'CONTINUE');
  assert.equal(events[0].nextAction, 'CONTINUE_EXECUTION');
  assert.equal(events[0].writesApplied, 2);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.failedStepId, 'execute');
  assert.equal(result.report?.status, 'CONTINUE');
  assert.equal(result.results.length, 2);
  assert.equal(result.plan.steps[0].status, 'FAILED');
  assert.equal(result.plan.steps[0].errorCode, 'CONTINUE');
});

// T-pc-2: PASS → no bonus
test('T-pc-2: PASS does not trigger plan-continue bonus', async () => {
  assert.equal(isPlanContinueReplanEligible({
    status: 'PASS',
    nextAction: 'COMPLETE',
    writesApplied: 2,
    alreadyReplanned: false
  }), false);

  const { coordinator } = makeCoordinator();
  const events = [];
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    continueReplan: {
      getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
      isEligible: isPlanContinueReplanEligible,
      onPlanContinueReplan: (evt) => events.push(evt)
    },
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, 'a')}` };
    },
    verifyStep: async () => ({ status: 'PASS', summary: 'done', nextAction: 'COMPLETE', failureCodes: [] })
  });

  assert.equal(events.length, 0);
  assert.equal(executions, 1);
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
});

// T-pc-3: FAIL/UNCERTAIN → not this path (existing latches)
test('T-pc-3: FAIL and UNCERTAIN do not take the plan-continue path', async () => {
  assert.equal(isPlanContinueReplanEligible({
    status: 'FAIL',
    nextAction: 'STOP_AND_REPORT',
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    alreadyReplanned: false
  }), false);

  assert.equal(isPlanContinueReplanEligible({
    status: 'UNCERTAIN',
    nextAction: 'REQUEST_EVIDENCE',
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    alreadyReplanned: false
  }), false);

  for (const status of ['FAIL', 'UNCERTAIN']) {
    const { coordinator } = makeCoordinator();
    const events = [];
    let executions = 0;
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      continueReplan: {
        getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
        isEligible: isPlanContinueReplanEligible,
        onPlanContinueReplan: (evt) => events.push(evt)
      },
      executeStep: async ({ attempt }) => {
        executions += 1;
        return { outputDigest: `sha256:${String(attempt).padStart(64, 'b')}` };
      },
      verifyStep: async () => ({
        status,
        nextAction: status === 'UNCERTAIN' ? 'REQUEST_EVIDENCE' : 'STOP_AND_REPORT',
        failureCodes: status === 'UNCERTAIN' ? [JEV_EVIDENCE_REQUIRED] : ['ACTION_FAILED'],
        summary: status
      })
    });
    assert.equal(events.length, 0, status);
    assert.equal(executions, 1, status);
    assert.equal(result.ok, false, status);
    assert.equal(result.report?.status, status);
  }
});

// T-pc-4: 0 writes / sole SAFETY → no trigger
test('T-pc-4: zero writes or sole SAFETY/lease DENY does not trigger', async () => {
  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 0,
    successfulWrites: 0,
    failureCodes: [],
    alreadyReplanned: false
  }), false);

  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 2,
    failureCodes: ['SAFETY_DENIED'],
    alreadyReplanned: false
  }), false);

  assert.equal(isSoleHardDenyFailure(['HARD_DECISION_DENY']), true);
  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 2,
    failureCodes: ['HARD_DECISION_DENY'],
    alreadyReplanned: false
  }), false);

  // 0 writes live
  {
    const { coordinator } = makeCoordinator();
    const events = [];
    let executions = 0;
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      continueReplan: {
        getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
        isEligible: isPlanContinueReplanEligible,
        onPlanContinueReplan: (evt) => events.push(evt)
      },
      executeStep: async ({ attempt }) => {
        executions += 1;
        return { outputDigest: `sha256:${String(attempt).padStart(64, 'c')}` };
      },
      verifyStep: async () => continueReport()
    });
    assert.equal(events.length, 0);
    assert.equal(executions, 1);
    assert.equal(result.ok, false);
  }

  // sole SAFETY live
  {
    const { coordinator } = makeCoordinator();
    const events = [];
    let executions = 0;
    const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
    const result = await scheduler.run({
      maxAttempts: 1,
      continueReplan: {
        getWriteCounts: () => ({ writesApplied: 3, successfulWrites: 3 }),
        isEligible: isPlanContinueReplanEligible,
        onPlanContinueReplan: (evt) => events.push(evt)
      },
      executeStep: async ({ attempt }) => {
        executions += 1;
        return { outputDigest: `sha256:${String(attempt).padStart(64, 'd')}` };
      },
      verifyStep: async () => continueReport({ failureCodes: ['SAFETY_POLICY_DENY'] })
    });
    assert.equal(events.length, 0);
    assert.equal(executions, 1);
    assert.equal(result.ok, false);
  }
});

// T-pc-5: telemetry/HOST + lease/hardDecision unchanged
test('T-pc-5: HOST note names CONTINUE_EXECUTION; lease/hardDecision stay fail-closed', async () => {
  const note = planContinueReplanHostNote();
  assert.match(note, /HOST_PLAN_CONTINUE_REPLAN/);
  assert.match(note, /CONTINUE_EXECUTION/);
  assert.match(note, /Do not claim PASS without new tool evidence|without new tool evidence|without fresh tool evidence/i);
  assert.match(note, /SAFETY \/ lease/);

  assert.equal(isSoleHardDenyFailure(['LEASE_EXPIRED']), true);
  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 1,
    failureCodes: ['LEASE_EXPIRED'],
    alreadyReplanned: false
  }), false);

  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'CONTINUE_EXECUTION',
    writesApplied: 1,
    failureCodes: ['HARD_DECISION_DENY'],
    alreadyReplanned: false
  }), false);

  // Bonus then PASS on second attempt — telemetry once
  const { coordinator } = makeCoordinator();
  const events = [];
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const result = await scheduler.run({
    maxAttempts: 1,
    continueReplan: {
      getWriteCounts: () => ({ writesApplied: 1, successfulWrites: 1 }),
      isEligible: isPlanContinueReplanEligible,
      onPlanContinueReplan: (evt) => events.push(evt)
    },
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, 'e')}` };
    },
    verifyStep: async ({ attempt }) => (attempt === 1
      ? continueReport()
      : { status: 'PASS', nextAction: 'COMPLETE', failureCodes: [], summary: 'done' })
  });
  assert.equal(events.length, 1);
  assert.equal(executions, 2);
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
});

// Extra: wrong nextAction does not fire
test('T-pc-extra: CONTINUE without CONTINUE_EXECUTION does not trigger', async () => {
  assert.equal(isPlanContinueReplanEligible({
    status: 'CONTINUE',
    nextAction: 'REPLAN_STEP',
    writesApplied: 2,
    alreadyReplanned: false
  }), false);

  const { coordinator } = makeCoordinator();
  const events = [];
  let executions = 0;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  await scheduler.run({
    maxAttempts: 1,
    continueReplan: {
      getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
      isEligible: isPlanContinueReplanEligible,
      onPlanContinueReplan: (evt) => events.push(evt)
    },
    executeStep: async ({ attempt }) => {
      executions += 1;
      return { outputDigest: `sha256:${String(attempt).padStart(64, 'f')}` };
    },
    verifyStep: async () => continueReport({ nextAction: 'REPLAN_STEP' })
  });
  assert.equal(events.length, 0);
  assert.equal(executions, 1);
});
