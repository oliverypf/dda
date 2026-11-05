import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import { reconcileInterruptedPlanStep } from '../src/side-effect-step-reconcile.mjs';

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

const OUTPUT = `sha256:${'ab'.repeat(32)}`;

const transition = (from, to, reason) => ({
  from,
  to,
  atMs: 1,
  ...(reason ? { metadata: { reason } } : {})
});

const rejectedHistory = [
  transition('PROPOSED', 'SAFETY_EVALUATING'),
  transition('SAFETY_EVALUATING', 'WAITING_APPROVAL'),
  transition('WAITING_APPROVAL', 'REJECTED')
];

const controlledEvidence = ({ executed = false, secondRun = false } = {}) => {
  let sequence = 0;
  const ev = (runId, kind, payload) => {
    sequence += 1;
    return { eventId: `event-${sequence}`, sequence, runId, kind, payload };
  };
  const events = [
    ev('run-a', 'TaskRunCreated', { requestedMode: 'CONTROLLED' }),
    ev('run-a', 'PlanStepStateChanged', {
      currentStepId: 'inspect',
      steps: [
        { stepId: 'inspect', status: 'RUNNING', attempt: 1 },
        { stepId: 'change', status: 'PENDING', attempt: 0 },
        { stepId: 'report', status: 'PENDING', attempt: 0 }
      ]
    }),
    ev('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-1', state: 'PROPOSED', intentId: 'intent-1' }),
    ev('run-a', 'ActionRequested', { intentId: 'intent-1', capability: 'WRITE_FILE' }),
    ev('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-1', state: 'REJECTED', intentId: 'intent-1' }),
    ev('run-a', 'ToolInvocationCompleted', { name: 'file.write', ok: false, errorCode: 'APPROVAL_EXPIRED', durationMs: 5 }),
    ev('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-2', state: 'PROPOSED', intentId: 'intent-2' })
  ];
  const records = [
    { recordType: 'intent', recordId: 'intent-1', runId: 'run-a', state: 'REJECTED', transitionHistory: rejectedHistory },
    {
      recordType: 'approval', recordId: 'approval-1', intentId: 'intent-1', runId: 'run-a', state: 'EXPIRED',
      transitionHistory: [transition('REQUESTED', 'PRESENTED'), transition('PRESENTED', 'EXPIRED')]
    }
  ];
  if (executed) {
    events.push(ev('run-a', 'ExecutionStateChanged', {
      recordType: 'intent', recordId: 'intent-2', state: 'EXECUTING', intentId: 'intent-2'
    }));
    records.push({
      recordType: 'intent', recordId: 'intent-2', runId: 'run-a', state: 'EXECUTING',
      transitionHistory: [
        transition('PROPOSED', 'SAFETY_EVALUATING'),
        transition('SAFETY_EVALUATING', 'WAITING_APPROVAL'),
        transition('WAITING_APPROVAL', 'APPROVED'),
        transition('APPROVED', 'EXECUTING')
      ]
    });
  } else {
    events.push(
      ev('run-a', 'ActionRequested', { intentId: 'intent-2', capability: 'WRITE_FILE' }),
      ev('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-2', state: 'REJECTED', intentId: 'intent-2' }),
      ev('run-a', 'ToolInvocationCompleted', { name: 'file.write', ok: false, errorCode: 'APPROVAL_DENIED', durationMs: 4 })
    );
    records.push(
      { recordType: 'intent', recordId: 'intent-2', runId: 'run-a', state: 'REJECTED', transitionHistory: rejectedHistory },
      {
        recordType: 'approval', recordId: 'approval-2', intentId: 'intent-2', runId: 'run-a', state: 'DECLINED',
        transitionHistory: [transition('REQUESTED', 'PRESENTED'), transition('PRESENTED', 'DECLINED')]
      }
    );
  }
  if (secondRun) {
    events.push(
      ev('run-b', 'TaskRunCreated', { requestedMode: 'CONTROLLED', sourceRunId: 'run-a' }),
      ev('run-b', 'PlanStepStateChanged', {
        steps: [
          { stepId: 'inspect', status: 'BLOCKED', attempt: 1, errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
          { stepId: 'change', status: 'PENDING', attempt: 0 },
          { stepId: 'report', status: 'PENDING', attempt: 0 }
        ]
      })
    );
  }
  return { events, records, sourceRunId: secondRun ? 'run-b' : 'run-a', journalEffects: [] };
};

const controlledReconciler = (evidence) => async ({ step }) => reconcileInterruptedPlanStep({
  mode: 'CONTROLLED',
  step,
  events: evidence.events,
  records: evidence.records,
  sourceRunId: evidence.sourceRunId,
  journalEffects: evidence.journalEffects
});

const runningPlan = {
  ...plan,
  steps: plan.steps.map((step, index) => ({
    ...step,
    status: index === 0 ? 'RUNNING' : 'PENDING',
    attempt: index === 0 ? 1 : 0
  }))
};

const uncertainPlan = {
  ...plan,
  steps: plan.steps.map((step, index) => ({
    ...step,
    status: index === 0 ? 'BLOCKED' : 'PENDING',
    attempt: index === 0 ? 1 : 0,
    ...(index === 0 ? { errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' } : {})
  }))
};

const passVerify = async () => ({ status: 'PASS', summary: 'passed' });

test('an interrupted step without a reconciler stays blocked', async () => {
  const { coordinator } = makeCoordinator({ ...runningPlan, currentStepId: 'inspect' });
  const scheduler = createPlanStepCoordinator({ coordinator, plan });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'BLOCKED');
  assert.equal(scheduler.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});

test('controlled resume retries a running step whose intents were all rejected', async () => {
  const evidence = controlledEvidence();
  const { coordinator } = makeCoordinator({ ...runningPlan, currentStepId: 'inspect' });
  const seen = [];
  const scheduler = createPlanStepCoordinator({
    coordinator,
    plan,
    resumeFailed: true,
    reconcileStep: controlledReconciler(evidence)
  });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'READY');
  assert.equal(scheduler.plan.steps[0].errorCode, 'RECONCILED_SAFE_TO_RETRY');
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ step }) => {
      seen.push(step.stepId);
      return { outputDigest: OUTPUT };
    },
    verifyStep: passVerify
  });
  assert.equal(seen[0], 'inspect');
  assert.equal(result.ok, true);
  assert.equal(result.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(result.plan.steps[0].outputDigest, OUTPUT);
});

test('controlled resume stays blocked when one intent reached execution', async () => {
  const evidence = controlledEvidence({ executed: true });
  const { coordinator } = makeCoordinator({ ...runningPlan, currentStepId: 'inspect' });
  let executed = false;
  const scheduler = createPlanStepCoordinator({
    coordinator,
    plan,
    resumeFailed: true,
    reconcileStep: controlledReconciler(evidence)
  });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async () => {
      executed = true;
      return { outputDigest: OUTPUT };
    },
    verifyStep: passVerify
  });
  assert.equal(executed, false);
  assert.equal(result.ok, false);
  assert.equal(result.plan.steps[0].status, 'BLOCKED');
  assert.equal(result.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});

test('explicit resume re-reconciles a persisted uncertain step when no side effect ran', async () => {
  const evidence = controlledEvidence({ secondRun: true });
  const seen = [];
  const runStuck = async (coordinator) => {
    const scheduler = createPlanStepCoordinator({
      coordinator,
      plan: uncertainPlan,
      resumeFailed: true,
      reconcileStep: controlledReconciler(evidence)
    });
    await scheduler.initialize();
    assert.equal(scheduler.plan.steps[0].status, 'READY');
    assert.equal(scheduler.plan.steps[0].errorCode, 'RECONCILED_SAFE_TO_RETRY');
    const result = await scheduler.run({
      maxAttempts: 1,
      executeStep: async ({ step }) => {
        seen.push(step.stepId);
        return { outputDigest: OUTPUT };
      },
      verifyStep: passVerify
    });
    assert.equal(result.ok, true);
    assert.equal(result.plan.steps[0].outputDigest, OUTPUT);
  };
  await runStuck(makeCoordinator().coordinator);
  await runStuck(makeCoordinator({ ...uncertainPlan, currentStepId: 'inspect' }).coordinator);
  assert.deepEqual(seen, ['inspect', 'change', 'report', 'inspect', 'change', 'report']);
});

test('explicit resume keeps a persisted uncertain step blocked when execution was reached', async () => {
  const evidence = controlledEvidence({ executed: true, secondRun: true });
  let executed = false;
  const scheduler = createPlanStepCoordinator({
    coordinator: makeCoordinator().coordinator,
    plan: uncertainPlan,
    resumeFailed: true,
    reconcileStep: controlledReconciler(evidence)
  });
  const result = await scheduler.run({
    maxAttempts: 1,
    executeStep: async () => {
      executed = true;
      return { outputDigest: OUTPUT };
    },
    verifyStep: passVerify
  });
  assert.equal(executed, false);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
  assert.equal(result.plan.steps[0].status, 'BLOCKED');
});

test('a failed reconciliation cannot turn a persisted uncertain step into an ordinary resume retry', async () => {
  const { coordinator } = makeCoordinator();
  const scheduler = createPlanStepCoordinator({
    coordinator,
    plan: uncertainPlan,
    resumeFailed: true,
    reconcileStep: async () => ({ status: 'FAILED', errorCode: 'RECONCILED_FAILED' })
  });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'BLOCKED');
  assert.equal(scheduler.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});

test('explicit resume still retries an ordinary failed step', async () => {
  const failed = {
    ...plan,
    steps: plan.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? 'FAILED' : 'PENDING',
      attempt: index === 0 ? 1 : 0,
      ...(index === 0 ? { errorCode: 'INSPECT_FAILED' } : {})
    }))
  };
  const { coordinator } = makeCoordinator();
  const scheduler = createPlanStepCoordinator({ coordinator, plan: failed, resumeFailed: true });
  await scheduler.initialize();
  assert.equal(scheduler.plan.steps[0].status, 'READY');
  assert.equal(scheduler.plan.steps[0].errorCode, 'EXPLICIT_RESUME_RETRY');
});

test('read-only observation retry still readies a running step and leaves a persisted uncertain step blocked', async () => {
  const evidence = controlledEvidence({ executed: true });
  const readOnly = async ({ step }) => reconcileInterruptedPlanStep({
    mode: 'READ_ONLY',
    readOnlyObservationRetry: true,
    step,
    events: evidence.events,
    records: evidence.records,
    sourceRunId: evidence.sourceRunId
  });
  const running = createPlanStepCoordinator({
    coordinator: makeCoordinator({ ...runningPlan, currentStepId: 'inspect' }).coordinator,
    plan,
    resumeFailed: true,
    reconcileStep: readOnly
  });
  await running.initialize();
  assert.equal(running.plan.steps[0].status, 'READY');
  assert.equal(running.plan.steps[0].errorCode, 'RECONCILED_SAFE_TO_RETRY');

  const stuck = createPlanStepCoordinator({
    coordinator: makeCoordinator().coordinator,
    plan: uncertainPlan,
    resumeFailed: true,
    reconcileStep: readOnly
  });
  await stuck.initialize();
  assert.equal(stuck.plan.steps[0].status, 'BLOCKED');
  assert.equal(stuck.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});
