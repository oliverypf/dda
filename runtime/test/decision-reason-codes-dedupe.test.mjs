import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';
import {
  assembleToolActionReasonCodes,
  dedupePreserveOrder,
  telemetryElevateReason
} from '../src/decision/reason-codes.mjs';
import {
  CAPABILITY_PATH_REQUIRE_APPROVAL
} from '../src/capability-path.mjs';
import {
  TRUST_X_REQUIRE_APPROVAL
} from '../src/trust-x.mjs';
import {
  RISK_VECTOR_REQUIRE_APPROVAL
} from '../src/risk-vector.mjs';
import {
  SAFETY_STATE_REQUIRE_APPROVAL
} from '../src/safety-state.mjs';

const baseInput = (overrides = {}) => ({
  runId: 'run-dd',
  stepId: 'step-tool-1',
  agentInstanceId: 'agent-executor',
  role: 'executor',
  roleContextId: 'role-executor',
  bindingSnapshotId: 'binding-1',
  decisionType: 'SELECT_TOOL_ACTION',
  objectiveRef: 'objective-1',
  constraintSnapshotId: 'constraints-1',
  featureSnapshotId: 'features-1',
  evidenceRefs: [{
    evidenceId: 'event-1',
    eventId: 'event-1',
    evidenceType: 'tool',
    stance: 'SUPPORTS',
    freshnessAtMs: 10
  }],
  assumptions: [],
  options: [
    {
      optionId: 'tool-selected',
      actionKind: 'file.patch',
      summary: 'Apply a bounded patch',
      evidenceRefs: ['event-1'],
      requiredCapabilityIds: [],
      riskCodes: [],
      rejectionReasonCodes: []
    },
    {
      optionId: 'tool-no-tool',
      actionKind: 'NO_TOOL',
      summary: 'Skip tool',
      evidenceRefs: [],
      requiredCapabilityIds: [],
      riskCodes: ['UNVERIFIED_CLAIM'],
      rejectionReasonCodes: ['EVIDENCE_GAP_REMAINS']
    }
  ],
  selectedOptionId: 'tool-no-tool',
  decisionSummary: 'Capability Path elevated action gate to REQUIRE_APPROVAL for file.patch',
  selectionCriteria: ['capability-path-action-gate'],
  reasonCodes: ['CAPABILITY_PATH_REQUIRE_APPROVAL'],
  uncertaintyCodes: [],
  expectedOutcome: {
    successCriteriaRefs: ['criterion-1'],
    predictedOutcomeCode: 'PIPELINE_STEP_ACCEPTED',
    predictedProgress: 0.1,
    predictedRiskCodes: []
  },
  outputRefs: ['tool-1'],
  sensitivity: 'SECURITY_AUDIT',
  ...overrides
});

test('dedupePreserveOrder keeps first occurrence', () => {
  assert.deepEqual(
    dedupePreserveOrder(['A', 'B', 'A', 'C', 'B', null, '', 'A']),
    ['A', 'B', 'C']
  );
});

test('telemetryElevateReason skips when gate already holds elevate code', () => {
  assert.deepEqual(
    telemetryElevateReason(
      { elevated: true, reasonCode: CAPABILITY_PATH_REQUIRE_APPROVAL },
      CAPABILITY_PATH_REQUIRE_APPROVAL
    ),
    []
  );
  assert.deepEqual(
    telemetryElevateReason(
      { elevated: true, reasonCode: CAPABILITY_PATH_REQUIRE_APPROVAL },
      'JEV_CHOICE'
    ),
    [CAPABILITY_PATH_REQUIRE_APPROVAL]
  );
  assert.deepEqual(
    telemetryElevateReason({ elevated: false, reasonCode: CAPABILITY_PATH_REQUIRE_APPROVAL }, 'X'),
    []
  );
});

// T-dd-1 / T-dd-2: Path / Trust / RV / SAFETY_STATE elevate self-injury → propose OK, no dup
for (const { name, elevateCode } of [
  { name: 'Path', elevateCode: CAPABILITY_PATH_REQUIRE_APPROVAL },
  { name: 'Trust(X)', elevateCode: TRUST_X_REQUIRE_APPROVAL },
  { name: 'Risk Vector', elevateCode: RISK_VECTOR_REQUIRE_APPROVAL },
  { name: 'SAFETY_STATE', elevateCode: SAFETY_STATE_REQUIRE_APPROVAL }
]) {
  test(`T-dd elevate self-injury (${name}): assemble + propose succeeds without dup`, async () => {
    // Simulate pre-fix bug: gate reason === elevate reason, telemetry also appends it
    const telemetry = [
      'SAFETY_PROFILE:default',
      elevateCode, // would have been the double-write
      'TRUST_X_KEY:source.example',
      'CAPABILITY_PATH_EXPANDS',
      'CAPABILITY_PATH_LEN:3',
      'CAPABILITY_SINK:file.patch',
      'RISK_VECTOR_SCORE:4',
      'RISK_VECTOR_STEPS:2',
      'SAFETY_STATE:WATCH'
    ];
    const reasonCodes = assembleToolActionReasonCodes({
      gateReasonCode: elevateCode,
      telemetryCodes: telemetry,
      max: 32
    });
    assert.equal(reasonCodes[0], elevateCode);
    assert.equal(new Set(reasonCodes).size, reasonCodes.length, 'no duplicates');
    assert.ok(reasonCodes.includes('CAPABILITY_PATH_EXPANDS'));
    assert.ok(reasonCodes.includes('RISK_VECTOR_SCORE:4'));
    assert.ok(reasonCodes.includes('SAFETY_STATE:WATCH'));
    // elevate code appears exactly once (gate), not again from telemetry
    assert.equal(reasonCodes.filter((c) => c === elevateCode).length, 1);

    const directory = await mkdtemp(join(tmpdir(), 'dda-dd-elevate-'));
    const trace = new AgentDecisionTrace({
      storagePath: join(directory, 'decision-trace.json'),
      now: () => 100
    });
    const proposed = await trace.propose(baseInput({
      reasonCodes,
      decisionSummary: `${name} elevated action gate to REQUIRE_APPROVAL for file.patch`
    }));
    assert.equal(proposed.status, 'PROPOSED');
    assert.deepEqual(proposed.reasonCodes, reasonCodes);
    const committed = await trace.commit(proposed.decisionId);
    assert.equal(committed.status, 'COMMITTED');
    assert.equal(new Set(committed.reasonCodes).size, committed.reasonCodes.length);
  });
}

// T-dd-3: illegal chars / >32 after dedupe still fail under cleanCodes
test('T-dd-3 illegal character still throws DECISION_INVALID_REASON_CODES', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-dd-illegal-'));
  const trace = new AgentDecisionTrace({
    storagePath: join(directory, 'decision-trace.json'),
    now: () => 100
  });
  await assert.rejects(
    trace.propose(baseInput({ reasonCodes: ['OK_CODE', 'BAD CODE WITH SPACE'] })),
    /DECISION_INVALID_REASON_CODES/
  );
});

test('T-dd-3 true >32 after dedupe still throws DECISION_INVALID_REASON_CODES', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-dd-over32-'));
  const trace = new AgentDecisionTrace({
    storagePath: join(directory, 'decision-trace.json'),
    now: () => 100
  });
  const tooMany = Array.from({ length: 33 }, (_, i) => `CODE_${i}`);
  assert.equal(dedupePreserveOrder(tooMany).length, 33);
  await assert.rejects(
    trace.propose(baseInput({ reasonCodes: tooMany })),
    /DECISION_INVALID_REASON_CODES/
  );
});

test('T-dd-3 assemble slices telemetry so final ≤32 (gate preserved)', () => {
  const telem = Array.from({ length: 40 }, (_, i) => `TELEM_${i}`);
  const codes = assembleToolActionReasonCodes({
    gateReasonCode: CAPABILITY_PATH_REQUIRE_APPROVAL,
    telemetryCodes: [CAPABILITY_PATH_REQUIRE_APPROVAL, ...telem],
    max: 32
  });
  assert.equal(codes.length, 32);
  assert.equal(codes[0], CAPABILITY_PATH_REQUIRE_APPROVAL);
  assert.equal(new Set(codes).size, 32);
  assert.ok(!codes.includes('TELEM_39')); // sliced from tail of telem list (kept head)
  assert.ok(codes.includes('TELEM_0'));
});

test('uncertaintyCodes dedupePreserveOrder is symmetric for recordDecision callers', () => {
  assert.deepEqual(
    dedupePreserveOrder(['U1', 'U2', 'U1', 'U3']),
    ['U1', 'U2', 'U3']
  );
});
