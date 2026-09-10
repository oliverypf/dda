import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';

const makeCoordinator = (initialState) => {
  const calls = [];
  const coordinator = {
    planState: initialState,
    async setPlanStateAndFlush(state, options) {
      this.planState = structuredClone(state);
      calls.push({ state: structuredClone(state), options: structuredClone(options) });
      return { planState: structuredClone(state) };
    }
  };
  return { coordinator, calls };
};

const plan = normalizePlannerPlan({
  planId: 'plan-order',
  steps: [
    { stepId: 'inspect', summary: 'inspect', actionKind: 'READ' },
    { stepId: 'change', summary: 'change', actionKind: 'WRITE', dependencies: ['inspect'] },
    { stepId: 'report', summary: 'report', actionKind: 'REPORT', dependencies: ['change'] }
  ]
}, { objectiveDigest: 'sha256:objective' });

test('executes ready steps in dependency order and persists every lifecycle transition', async () => {
  const { coordinator, calls } = makeCoordinator();
  const seen = [];
  const scheduler = createPlanStepCoordinator({ coordinator, plan });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ step }) => {
      seen.push(`execute:${step.stepId}`);
      return { outputDigest: `sha256:${step.stepId.padEnd(64, '0')}` };
    },
    verifyStep: async ({ step }) => {
      seen.push(`verify:${step.stepId}`);
      return { status: 'PASS', summary: `${step.stepId} passed` };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [
    'execute:inspect', 'verify:inspect',
    'execute:change', 'verify:change',
    'execute:report', 'verify:report'
  ]);
  assert.deepEqual(result.plan.steps.map((step) => step.status), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
  assert.ok(calls.length >= 7);
  assert.equal(calls.at(-1).state.steps.every((step) => step.status === 'SUCCEEDED'), true);
});

test('blocks dependent steps after a hard verification failure', async () => {
  const { coordinator } = makeCoordinator();
  const seen = [];
  const scheduler = createPlanStepCoordinator({ coordinator, plan });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ step }) => { seen.push(step.stepId); return { outputDigest: `sha256:${step.stepId}` }; },
    verifyStep: async ({ step }) => step.stepId === 'inspect'
      ? { status: 'FAIL', failureCodes: ['INSPECT_FAILED'] }
      : { status: 'PASS' }
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedStepId, 'inspect');
  assert.deepEqual(seen, ['inspect']);
  assert.equal(result.plan.steps.find((step) => step.stepId === 'inspect').status, 'FAILED');
  assert.equal(result.plan.steps.find((step) => step.stepId === 'change').status, 'BLOCKED');
  assert.equal(result.plan.steps.find((step) => step.stepId === 'report').status, 'BLOCKED');
});

test('retries recoverable verification and records attempt', async () => {
  const { coordinator } = makeCoordinator();
  let attempts = 0;
  const scheduler = createPlanStepCoordinator({
    coordinator,
    plan: normalizePlannerPlan({ steps: [{ stepId: 'retry', summary: 'retry' }] })
  });
  const result = await scheduler.run({
    maxAttempts: 3,
    executeStep: async ({ attempt }) => { attempts = attempt; return { outputDigest: `sha256:${attempt}` }; },
    verifyStep: async ({ attempt }) => attempt < 2
      ? { status: 'STALLED', failureCodes: ['NO_NEW_EVIDENCE'] }
      : { status: 'PASS' }
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(result.plan.steps[0].attempt, 2);
  assert.equal(result.results.length, 2);
});

test('reconciles an interrupted step and refuses unknown side effects', async () => {
  const interrupted = { ...plan, steps: plan.steps.map((step, index) => ({ ...step, status: index === 0 ? 'RUNNING' : 'PENDING', attempt: index === 0 ? 1 : 0 })) };
  const { coordinator } = makeCoordinator({ ...interrupted, currentStepId: 'inspect' });
  const scheduler = createPlanStepCoordinator({
    coordinator,
    plan,
    reconcileStep: async () => ({ status: 'UNKNOWN' })
  });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'BLOCKED');
  assert.equal(scheduler.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});

test('explicit resume cannot replay a step with unknown side-effect outcome', async () => {
  const interrupted = {
    ...plan,
    steps: plan.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'BLOCKED' : 'PENDING',
      attempt: index === 0 ? 1 : 0,
      ...(index === 0 ? { errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' } : {})
    }))
  };
  const { coordinator } = makeCoordinator({ ...interrupted, currentStepId: 'inspect' });
  const scheduler = createPlanStepCoordinator({ coordinator, plan: interrupted, resumeFailed: true });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'BLOCKED');
  assert.equal(scheduler.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});
