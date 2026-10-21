import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';
import {
  assembleToolActionReasonCodes,
  dedupePreserveOrder,
  sanitizeReasonCodeCharset
} from '../src/decision/reason-codes.mjs';
import {
  TRUST_X_REQUIRE_APPROVAL,
  trustKey
} from '../src/trust-x.mjs';

const CHARSET_OK = /^[A-Za-z0-9_.:-]+$/;

const baseInput = (overrides = {}) => ({
  runId: 'run-txk',
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
  decisionSummary: 'Trust(X) elevated action gate to REQUIRE_APPROVAL for file.patch',
  selectionCriteria: ['trust-x-action-gate'],
  reasonCodes: [TRUST_X_REQUIRE_APPROVAL],
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

test('sanitizeReasonCodeCharset maps @ | * only', () => {
  assert.equal(
    sanitizeReasonCodeCharset('executor:u@h|cap:*|tc:coding|ws:default'),
    'executor:u_h:cap:_:tc:coding:ws:default'
  );
  // space / slash untouched — still illegal under cleanCodes
  assert.equal(sanitizeReasonCodeCharset('BAD CODE'), 'BAD CODE');
  assert.equal(sanitizeReasonCodeCharset('a/b'), 'a/b');
  assert.equal(sanitizeReasonCodeCharset(null), null);
  assert.equal(sanitizeReasonCodeCharset(''), '');
});

// T-txk-1: real trustKey() with @| → assemble + propose succeeds; charset-legal; no dup
test('T-txk-1 TRUST_X_KEY + real trustKey(@|) propose/record succeeds charset-legal no dup', async () => {
  const rawKey = trustKey({
    entityId: 'agent@local',
    capabilityId: 'file.write',
    taskClass: '*',
    workspace: 'ws|main'
  });
  assert.match(rawKey, /[@|*]/, 'fixture must embed trustKey illegal chars');
  const telemKey = `TRUST_X_KEY:${rawKey}`;
  assert.ok(!CHARSET_OK.test(telemKey), 'raw TRUST_X_KEY must fail cleanCodes charset');

  const reasonCodes = assembleToolActionReasonCodes({
    gateReasonCode: TRUST_X_REQUIRE_APPROVAL,
    telemetryCodes: [
      'SAFETY_PROFILE:default',
      TRUST_X_REQUIRE_APPROVAL, // elevate self-append (dedupe)
      telemKey,
      'TRUST_X_FALLBACK:1',
      'TRUST_X_CONTROL:LIMIT',
      'CAPABILITY_PATH_EXPANDS',
      'RISK_VECTOR_SCORE:4',
      'SAFETY_STATE:WATCH'
    ],
    max: 32
  });

  assert.equal(reasonCodes[0], TRUST_X_REQUIRE_APPROVAL);
  assert.equal(new Set(reasonCodes).size, reasonCodes.length, 'no duplicates');
  assert.equal(reasonCodes.filter((c) => c === TRUST_X_REQUIRE_APPROVAL).length, 1);
  const storedKey = reasonCodes.find((c) => c.startsWith('TRUST_X_KEY:'));
  assert.ok(storedKey, 'TRUST_X_KEY telemetry preserved');
  assert.ok(CHARSET_OK.test(storedKey), `stored key must be charset-legal: ${storedKey}`);
  assert.ok(!/[@|*]/.test(storedKey), 'no residual @|*');
  // evidence shape retained (executor / cap / tc / ws markers)
  assert.match(storedKey, /executor:/);
  assert.match(storedKey, /cap:/);
  assert.match(storedKey, /tc:/);
  assert.match(storedKey, /ws:/);
  for (const code of reasonCodes) {
    assert.ok(CHARSET_OK.test(code), `illegal charset: ${code}`);
  }

  const directory = await mkdtemp(join(tmpdir(), 'dda-txk-1-'));
  const trace = new AgentDecisionTrace({
    storagePath: join(directory, 'decision-trace.json'),
    now: () => 100
  });
  const proposed = await trace.propose(baseInput({ reasonCodes }));
  assert.equal(proposed.status, 'PROPOSED');
  assert.deepEqual(proposed.reasonCodes, reasonCodes);
  const committed = await trace.commit(proposed.decisionId);
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(new Set(committed.reasonCodes).size, committed.reasonCodes.length);
  assert.ok(committed.reasonCodes.every((c) => CHARSET_OK.test(c)));
});

// T-txk-2: intentional illegal (bypass assemble) / >32 after sanitize still throws
test('T-txk-2 intentional illegal still throws DECISION_INVALID_REASON_CODES', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-txk-2-illegal-'));
  const trace = new AgentDecisionTrace({
    storagePath: join(directory, 'decision-trace.json'),
    now: () => 100
  });
  // space survives sanitize — must still fail under cleanCodes
  const stillIllegal = sanitizeReasonCodeCharset('OK_PREFIX BAD_SPACE');
  assert.equal(stillIllegal, 'OK_PREFIX BAD_SPACE');
  await assert.rejects(
    trace.propose(baseInput({ reasonCodes: ['OK_CODE', stillIllegal] })),
    /DECISION_INVALID_REASON_CODES/
  );
});

test('T-txk-2 sanitize-then-still->32 (bypass assemble) throws DECISION_INVALID_REASON_CODES', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-txk-2-over32-'));
  const trace = new AgentDecisionTrace({
    storagePath: join(directory, 'decision-trace.json'),
    now: () => 100
  });
  // Codes that sanitize but remain >32 distinct — assemble would slice; bypass it.
  const tooMany = Array.from({ length: 33 }, (_, i) => sanitizeReasonCodeCharset(`CODE_${i}@x|y*`));
  assert.equal(dedupePreserveOrder(tooMany).length, 33);
  assert.ok(tooMany.every((c) => CHARSET_OK.test(c)), 'sanitized codes are charset-legal');
  await assert.rejects(
    trace.propose(baseInput({ reasonCodes: tooMany })),
    /DECISION_INVALID_REASON_CODES/
  );
});

test('T-txk-2 assemble still slices ≤32 after charset sanitize (gate preserved)', () => {
  const rawKey = trustKey({
    entityId: 'bot@host',
    capabilityId: '*',
    taskClass: 'coding',
    workspace: 'default'
  });
  const telem = [
    `TRUST_X_KEY:${rawKey}`,
    ...Array.from({ length: 40 }, (_, i) => `TELEM_${i}`)
  ];
  const codes = assembleToolActionReasonCodes({
    gateReasonCode: TRUST_X_REQUIRE_APPROVAL,
    telemetryCodes: [TRUST_X_REQUIRE_APPROVAL, ...telem],
    max: 32
  });
  assert.equal(codes.length, 32);
  assert.equal(codes[0], TRUST_X_REQUIRE_APPROVAL);
  assert.equal(new Set(codes).size, 32);
  assert.ok(codes.every((c) => CHARSET_OK.test(c)));
  assert.ok(codes.some((c) => c.startsWith('TRUST_X_KEY:')));
  assert.ok(!codes.includes('TELEM_39'));
  assert.ok(codes.includes('TELEM_0'));
});
