import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileInterruptedPlanStep } from '../src/side-effect-step-reconcile.mjs';

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

const intentRecord = (recordId, patch = {}) => ({
  recordType: 'intent',
  recordId,
  runId: 'run-a',
  state: 'REJECTED',
  transitionHistory: rejectedHistory,
  ...patch
});

const approvalRecord = (recordId, intentId, state = 'EXPIRED', history) => ({
  recordType: 'approval',
  recordId,
  intentId,
  runId: 'run-a',
  state,
  transitionHistory: history ?? [
    transition('REQUESTED', 'PRESENTED'),
    transition('PRESENTED', state)
  ]
});

const createRecorder = () => {
  let sequence = 0;
  return (runId, kind, payload, { nested = false } = {}) => {
    sequence += 1;
    return {
      eventId: `event-${sequence}`,
      sequence,
      runId,
      kind,
      payload: nested ? { payload } : payload
    };
  };
};

const runningSteps = (runningStepId) => ['inspect', 'change', 'report'].map((stepId) => ({
  stepId,
  status: stepId === runningStepId ? 'RUNNING' : 'PENDING',
  attempt: stepId === 'inspect' ? 1 : 0
}));

// The observed failure: inspect was left RUNNING, every write intent was
// rejected because its approval card expired or was declined, and the tool
// invocation completed as APPROVAL_EXPIRED before any lease existed.
const expiredInspectEvidence = ({
  nested = false,
  secondRun = false,
  extraEvents = [],
  extraRecords = [],
  journalEffects = [],
  includeToolFailure = true
} = {}) => {
  const record = createRecorder();
  const events = [
    record('run-a', 'TaskRunCreated', { requestedMode: 'CONTROLLED' }, { nested }),
    record('run-a', 'PlanStepStateChanged', {
      currentStepId: 'inspect',
      steps: runningSteps('inspect')
    }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'intent', recordId: 'intent-1', state: 'PROPOSED', intentId: 'intent-1'
    }, { nested }),
    record('run-a', 'ActionRequested', { intentId: 'intent-1', capability: 'WRITE_FILE' }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'approval', recordId: 'approval-1', state: 'EXPIRED', intentId: 'intent-1'
    }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'intent', recordId: 'intent-1', state: 'REJECTED', intentId: 'intent-1'
    }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'intent', recordId: 'intent-2', state: 'PROPOSED', intentId: 'intent-2'
    }, { nested }),
    record('run-a', 'ActionRequested', { intentId: 'intent-2', capability: 'WRITE_FILE' }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'approval', recordId: 'approval-2', state: 'DECLINED', intentId: 'intent-2'
    }, { nested }),
    record('run-a', 'ExecutionStateChanged', {
      recordType: 'intent', recordId: 'intent-2', state: 'REJECTED', intentId: 'intent-2'
    }, { nested })
  ];
  if (includeToolFailure) {
    events.push(record('run-a', 'ToolInvocationCompleted', {
      name: 'file.write', ok: false, errorCode: 'APPROVAL_EXPIRED', durationMs: 5
    }, { nested }));
    events.push(record('run-a', 'ToolInvocationCompleted', {
      name: 'file.write', ok: false, errorCode: 'APPROVAL_DENIED', durationMs: 4
    }, { nested }));
  }
  events.push(...extraEvents.map((event) => record(event.runId, event.kind, event.payload, { nested })));
  if (secondRun) {
    events.push(record('run-b', 'TaskRunCreated', { requestedMode: 'CONTROLLED', sourceRunId: 'run-a' }, { nested }));
    events.push(record('run-b', 'PlanStepStateChanged', {
      steps: [
        { stepId: 'inspect', status: 'BLOCKED', attempt: 1, errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
        { stepId: 'change', status: 'PENDING', attempt: 0 },
        { stepId: 'report', status: 'PENDING', attempt: 0 }
      ]
    }, { nested }));
  }
  return {
    events,
    records: [
      intentRecord('intent-1'),
      approvalRecord('approval-1', 'intent-1', 'EXPIRED'),
      intentRecord('intent-2'),
      approvalRecord('approval-2', 'intent-2', 'DECLINED'),
      ...extraRecords
    ],
    journalEffects,
    sourceRunId: secondRun ? 'run-b' : 'run-a'
  };
};

const classify = ({
  mode = 'CONTROLLED',
  readOnlyObservationRetry = false,
  step = { stepId: 'inspect', status: 'RUNNING', attempt: 1 },
  ...evidence
} = {}) => reconcileInterruptedPlanStep({ mode, readOnlyObservationRetry, step, ...evidence });

test('retries a controlled step when every intent was rejected before execution', () => {
  const evidence = expiredInspectEvidence();
  const result = classify(evidence);
  assert.deepEqual(result, { status: 'RETRY', reason: 'ALL_INTENTS_REJECTED_BEFORE_EXECUTION' });
});

test('retries the same rejected step when a later resume already marked it uncertain', () => {
  const evidence = expiredInspectEvidence({ secondRun: true, nested: true });
  const result = classify({
    ...evidence,
    step: { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', attempt: 1 }
  });
  assert.deepEqual(result, { status: 'RETRY', reason: 'ALL_INTENTS_REJECTED_BEFORE_EXECUTION' });
});

test('retries a cancelled approval and a rejection that never reached approval', () => {
  const record = createRecorder();
  const events = [
    record('run-a', 'TaskRunCreated', { requestedMode: 'CONTROLLED' }),
    record('run-a', 'PlanStepStateChanged', { steps: runningSteps('inspect') }),
    record('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-cancel', state: 'PROPOSED' }),
    record('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-orphan', state: 'PROPOSED' })
  ];
  const records = [
    intentRecord('intent-cancel'),
    approvalRecord('approval-cancel', 'intent-cancel', 'CANCELLED', [
      transition('REQUESTED', 'CANCELLED', 'OWNER_PROCESS_LOST')
    ]),
    intentRecord('intent-orphan', {
      transitionHistory: [transition('PROPOSED', 'REJECTED', 'OWNER_PROCESS_LOST')]
    })
  ];
  assert.equal(classify({ events, records, sourceRunId: 'run-a' }).status, 'RETRY');
});

test('blocks a controlled step when any intent reached execution', () => {
  const evidence = expiredInspectEvidence({
    extraEvents: [{
      runId: 'run-a',
      kind: 'ExecutionStateChanged',
      payload: { recordType: 'intent', recordId: 'intent-2', state: 'EXECUTING', intentId: 'intent-2' }
    }],
    extraRecords: []
  });
  evidence.records[2] = intentRecord('intent-2', {
    state: 'EXECUTING',
    transitionHistory: [
      transition('PROPOSED', 'SAFETY_EVALUATING'),
      transition('SAFETY_EVALUATING', 'WAITING_APPROVAL'),
      transition('WAITING_APPROVAL', 'APPROVED'),
      transition('APPROVED', 'EXECUTING')
    ]
  });
  const result = classify(evidence);
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.reason, 'STEP_EXECUTION_RECORDED');
});

test('blocks when the record shows execution even without an execution event', () => {
  const evidence = expiredInspectEvidence();
  evidence.records[0] = intentRecord('intent-1', { state: 'APPROVED', transitionHistory: [
    transition('PROPOSED', 'SAFETY_EVALUATING'),
    transition('SAFETY_EVALUATING', 'APPROVED')
  ] });
  assert.equal(classify(evidence).status, 'UNCERTAIN');
});

test('blocks when a lease, granted approval, or uncertain rejection reason exists', () => {
  const leased = expiredInspectEvidence({
    extraRecords: [{ recordType: 'lease', recordId: 'lease-1', intentId: 'intent-1', runId: 'run-a', state: 'PROPOSED' }]
  });
  assert.equal(classify(leased).reason, 'EXECUTION_OR_UNKNOWN');

  const granted = expiredInspectEvidence();
  granted.records[1] = approvalRecord('approval-1', 'intent-1', 'APPROVED', [
    transition('REQUESTED', 'PRESENTED'),
    transition('PRESENTED', 'APPROVED')
  ]);
  assert.equal(classify(granted).status, 'UNCERTAIN');

  const uncertainReason = expiredInspectEvidence();
  uncertainReason.records[0] = intentRecord('intent-1', {
    transitionHistory: [
      transition('PROPOSED', 'SAFETY_EVALUATING'),
      transition('SAFETY_EVALUATING', 'WAITING_APPROVAL'),
      transition('WAITING_APPROVAL', 'REJECTED', 'EXECUTION_OUTCOME_UNCERTAIN')
    ]
  });
  assert.equal(classify(uncertainReason).status, 'UNCERTAIN');
});

test('blocks when an action or successful side-effect tool event was recorded', () => {
  const action = expiredInspectEvidence({
    extraEvents: [{ runId: 'run-a', kind: 'ActionExecuted', payload: { intentId: 'intent-1' } }]
  });
  assert.equal(classify(action).reason, 'STEP_EXECUTION_RECORDED');

  const wrote = expiredInspectEvidence({
    extraEvents: [{
      runId: 'run-a',
      kind: 'ToolInvocationCompleted',
      payload: { name: 'file.write', ok: true, outputDigest: 'sha256:ab', durationMs: 3 }
    }]
  });
  assert.equal(classify(wrote).reason, 'STEP_EXECUTION_RECORDED');

  const afterEffect = expiredInspectEvidence({
    extraEvents: [{
      runId: 'run-a',
      kind: 'ToolInvocationCompleted',
      payload: { name: 'file.patch', ok: false, errorCode: 'TOOL_OUTPUT_AFTER_EFFECT' }
    }]
  });
  assert.equal(classify(afterEffect).status, 'UNCERTAIN');
});

test('blocks when no intent was recorded or the evidence cannot be attributed', () => {
  const record = createRecorder();
  const events = [
    record('run-a', 'TaskRunCreated', { requestedMode: 'CONTROLLED' }),
    record('run-a', 'PlanStepStateChanged', { steps: runningSteps('inspect') })
  ];
  assert.equal(classify({ events, records: [], sourceRunId: 'run-a' }).reason, 'NO_STEP_INTENTS');

  const unattributed = classify({
    events,
    records: [intentRecord('intent-hidden')],
    sourceRunId: 'run-a'
  });
  assert.equal(unattributed.reason, 'UNATTRIBUTED_INTENT');

  const emptyHistory = expiredInspectEvidence();
  emptyHistory.records[0] = intentRecord('intent-1', { transitionHistory: [] });
  assert.equal(classify(emptyHistory).reason, 'EXECUTION_OR_UNKNOWN');

  const waiting = expiredInspectEvidence();
  waiting.records[0] = intentRecord('intent-1', { state: 'WAITING_APPROVAL' });
  assert.equal(classify(waiting).status, 'UNCERTAIN');

  assert.equal(classify({ events, records: [], sourceRunId: 'missing-run' }).reason, 'LINEAGE_UNKNOWN');
  assert.equal(classify({ events: null, records: [], sourceRunId: 'run-a' }).reason, 'EVIDENCE_INVALID');
});

test('a completed write on a later step does not make the rejected step uncertain', () => {
  const record = createRecorder();
  const events = [
    record('run-a', 'TaskRunCreated', { requestedMode: 'CONTROLLED' }),
    record('run-a', 'PlanStepStateChanged', { steps: runningSteps('inspect') }),
    record('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-inspect', state: 'PROPOSED' }),
    record('run-a', 'PlanStepStateChanged', {
      steps: [
        { stepId: 'inspect', status: 'READY', attempt: 1 },
        { stepId: 'change', status: 'RUNNING', attempt: 1 },
        { stepId: 'report', status: 'PENDING', attempt: 0 }
      ]
    }),
    record('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-change', state: 'PROPOSED' }),
    record('run-a', 'ExecutionStateChanged', { recordType: 'intent', recordId: 'intent-change', state: 'COMPLETED' }),
    record('run-a', 'TaskFileWritten', { intentId: 'intent-change' })
  ];
  const records = [
    intentRecord('intent-inspect'),
    approvalRecord('approval-inspect', 'intent-inspect', 'EXPIRED'),
    intentRecord('intent-change', {
      state: 'COMPLETED',
      transitionHistory: [
        transition('PROPOSED', 'SAFETY_EVALUATING'),
        transition('SAFETY_EVALUATING', 'APPROVED'),
        transition('APPROVED', 'EXECUTING'),
        transition('EXECUTING', 'COMPLETED')
      ]
    })
  ];
  const journalEffects = [{ effectId: 'effect-change', state: 'COMPLETED', runId: 'run-a' }];
  assert.equal(classify({ events, records, sourceRunId: 'run-a', journalEffects }).status, 'RETRY');
  assert.equal(classify({
    events, records, sourceRunId: 'run-a', journalEffects,
    step: { stepId: 'change', status: 'RUNNING' }
  }).status, 'UNCERTAIN');
});

test('blocks when the effect journal shows execution the intent records do not explain', () => {
  const safe = expiredInspectEvidence();
  assert.equal(classify({
    ...safe,
    journalEffects: [{ effectId: 'effect-other', state: 'COMPLETED', runId: 'run-other' }]
  }).status, 'RETRY');
  assert.equal(classify({
    ...safe,
    journalEffects: [{ effectId: 'effect-approved', state: 'APPROVED', runId: 'run-a' }]
  }).status, 'RETRY');
  const hidden = classify({
    ...safe,
    journalEffects: [{ effectId: 'effect-started', state: 'STARTED', runId: 'run-a' }]
  });
  assert.deepEqual(hidden, { status: 'UNCERTAIN', reason: 'JOURNAL_EXECUTION_UNACCOUNTED' });
});

test('read-only observation retry is unchanged and does not clear a persisted uncertain step', () => {
  const executed = expiredInspectEvidence({
    extraEvents: [{ runId: 'run-a', kind: 'ActionExecuted', payload: { intentId: 'intent-1' } }]
  });
  const running = classify({
    mode: 'READ_ONLY',
    readOnlyObservationRetry: true,
    ...executed
  });
  assert.deepEqual(running, { status: 'RETRY', reason: 'READ_ONLY_OBSERVATION' });

  const stuck = classify({
    mode: 'READ_ONLY',
    readOnlyObservationRetry: true,
    step: { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
    ...expiredInspectEvidence()
  });
  assert.deepEqual(stuck, { status: 'UNCERTAIN', reason: 'READ_ONLY_UNCHANGED' });

  const disabled = classify({
    mode: 'READ_ONLY',
    readOnlyObservationRetry: false,
    step: { stepId: 'inspect', status: 'RUNNING' },
    events: [],
    records: [],
    sourceRunId: 'run-a'
  });
  assert.deepEqual(disabled, { status: 'UNCERTAIN', reason: 'READ_ONLY_UNCHANGED' });
});
