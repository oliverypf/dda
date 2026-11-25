import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adviseReportClaimChecks,
  formatAdvisoryNotes,
  hostExecutionCheck,
  isAdvisoryCheck,
  runFailureReport,
  settleBehaviorDecision,
  settleStepVerification
} from '../src/verdict-policy.mjs';
import {
  buildTestProcessReceipt,
  prepareBuildTestVerification,
  recordBuildTestReceipt
} from '../src/decision/build-test-verification.mjs';

test('adviseReportClaimChecks downgrades non-PASS claim checks to advisory UNKNOWN', () => {
  const pass = { id: 'build-test-claim-1', status: 'PASS', message: 'ok' };
  const fail = { id: 'build-test-claim-2', status: 'FAIL', code: 'BUILD_TEST_CONCLUSION_CONFLICT', message: 'bad', evidence: ['r1'] };
  const unknown = { id: 'build-test-claim-3', status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING', message: 'missing' };
  const advised = adviseReportClaimChecks([pass, fail, unknown]);
  assert.equal(advised[0], pass, 'PASS checks are returned unchanged');
  assert.equal(advised[1].status, 'UNKNOWN');
  assert.equal(advised[1].advisory, true);
  assert.equal(advised[1].reportedStatus, 'FAIL');
  assert.equal(advised[1].code, 'BUILD_TEST_CONCLUSION_CONFLICT');
  assert.equal(advised[1].message, 'bad');
  assert.deepEqual(advised[1].evidence, ['r1']);
  assert.equal(advised[2].status, 'UNKNOWN');
  assert.equal(advised[2].advisory, true);
  assert.equal(advised[2].reportedStatus, 'UNKNOWN');
  assert.equal(advised.every(isAdvisoryCheck) || advised[0] === pass, true);
  assert.equal(isAdvisoryCheck(advised[0]), false);
  assert.equal(isAdvisoryCheck(advised[1]), true);
});

test('settleBehaviorDecision withholds unexplained jev FAIL vetoes', () => {
  for (const reasonCode of ['JEV_CHOICE', 'EXECUTION_EVIDENCE_MISSING', 'EXTERNAL_EVIDENCE_MISSING']) {
    const decision = settleBehaviorDecision({ decision: 'FAIL', source: 'jev', reasonCode });
    assert.equal(decision.decision, 'UNCERTAIN', reasonCode);
    assert.equal(decision.vetoWithheld, true);
    assert.equal(decision.reasonCode, reasonCode);
  }
  for (const reasonCode of ['RESULT_CONTRADICTS_EVIDENCE', 'GOAL_CONFLICT', 'UNSAFE_BEHAVIOR', 'JEV_WORKSPACE_READ_REJECTED']) {
    const decision = settleBehaviorDecision({ decision: 'FAIL', source: 'jev', reasonCode });
    assert.equal(decision.decision, 'FAIL', reasonCode);
    assert.equal(decision.vetoWithheld, undefined);
  }
  const rule = { decision: 'FAIL', source: 'rule', reasonCode: 'BUILD_TEST_EXECUTION_FAILED' };
  assert.equal(settleBehaviorDecision(rule), rule);
  const pass = { decision: 'PASS', source: 'jev', reasonCode: 'JEV_CHOICE' };
  assert.equal(settleBehaviorDecision(pass), pass);
});

test('formatAdvisoryNotes renders claim and jev notes, deduped and bounded', () => {
  assert.equal(formatAdvisoryNotes([]), '');
  assert.equal(formatAdvisoryNotes([
    { id: 'host.execution', status: 'PASS', message: 'fine' },
    { id: 'jev-behavior-judge', status: 'FAIL', message: 'rejected' }
  ]), '');
  const notes = formatAdvisoryNotes([
    { id: 'host.execution', status: 'PASS' },
    { id: 'build-test-claim-1', status: 'UNKNOWN', advisory: true, message: '标准错误为空实际记录为 false' },
    { id: 'build-test-claim-2', status: 'UNKNOWN', advisory: true, message: '标准错误为空实际记录为 false' },
    { id: 's1.jev-behavior-judge', status: 'UNKNOWN', message: 'JEV_REJECTION_UNEXPLAINED' }
  ]);
  assert.match(notes, /^\*\*未经核对的内容\*\*\n/u);
  assert.equal(notes.includes('报告中的表述未能与执行记录对上，以运行时核验为准：标准错误为空实际记录为 false'), true);
  assert.equal(notes.includes('语义校验未能确认本步骤（JEV_REJECTION_UNEXPLAINED）'), true);
  assert.equal(notes.split('\n').length, 3, 'duplicate messages are deduped');
});

test('regression: prose-vs-receipt conflict becomes advisory instead of a blocking FAIL', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const process = buildTestProcessReceipt({
    tool: 'shell.execute',
    request: { command: 'cargo build --release' },
    output: {
      ok: true, exitCode: 0, cwd: '.',
      stdout: 'Compiling dda v0.1.0\n Finished `release` profile',
      stderr: 'warning: unused `runtime_process_is_active`\nwarning: linker emitted non UTF-8 output'
    },
    startedAtMs: 100, endedAtMs: 200, outputDigest: digest
  });
  const receipt = await recordBuildTestReceipt(process, 'build-1', async () => undefined);
  assert.equal(receipt.kind, 'BUILD');
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.stderrEmpty, false);
  const report = prepareBuildTestVerification('Cargo `release` 编译完成，标准错误为空。', [receipt]);
  const raw = report.checks.find(check => check.status === 'FAIL');
  assert.ok(raw, 'the raw claim check reproduces the incident FAIL');
  assert.equal(raw.code, 'BUILD_TEST_CONCLUSION_CONFLICT');
  const advised = adviseReportClaimChecks(report.checks);
  assert.equal(advised.some(check => check.status === 'FAIL'), false);
  assert.ok(advised.filter(check => check.status !== 'PASS').every(check => check.advisory === true));
});

test('hostExecutionCheck records the host observation as PASS', () => {
  const check = hostExecutionCheck();
  assert.equal(check.id, 'host.execution');
  assert.equal(check.status, 'PASS');
});

const baseVerification = () => ({
  status: 'PASS', summary: 'ok', nextAction: 'COMPLETE', failureCodes: [], checks: []
});
const settleArgs = (overrides = {}) => ({
  verification: baseVerification(),
  failedDeliverable: undefined,
  deliveryGap: undefined,
  buildTestFailure: undefined,
  buildTestRepairContinuation: false,
  buildTestFailureCodes: [],
  missingExternalEvidence: false,
  externalEvidence: [],
  workspaceReadVerified: false,
  semanticStatus: 'PASS',
  behaviorReason: 'JEV_CHOICE',
  behaviorDecision: { decision: 'PASS', source: 'jev', reasonCode: 'JEV_CHOICE' },
  stopForBehaviorConflict: false,
  providerFailure: false,
  behaviorEvidenceRefs: ['ev-1'],
  ...overrides
});

test('settleStepVerification returns the verification unchanged when no branch applies', () => {
  const verification = baseVerification();
  assert.equal(settleStepVerification(settleArgs({ verification })), verification);
});

test('settleStepVerification fails with REPAIR_DELIVERABLE for a failed deliverable', () => {
  const result = settleStepVerification(settleArgs({ failedDeliverable: { message: 'missing file' } }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.nextAction, 'REPAIR_DELIVERABLE');
  assert.equal(result.summary, 'missing file');
  assert.deepEqual(result.failureCodes, ['DELIVERABLE_UNVERIFIED']);
});

test('settleStepVerification marks a delivery gap UNCERTAIN with stopRecovery', () => {
  const result = settleStepVerification(settleArgs({ deliveryGap: 'install evidence missing' }));
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.stopRecovery, true);
  assert.equal(result.nextAction, 'REVIEW_INSTALLATION');
  assert.equal(result.summary, 'install evidence missing');
  assert.deepEqual(result.failureCodes, ['INSTALLATION_UNVERIFIED']);
});

test('settleStepVerification continues on a first host execution failure', () => {
  const result = settleStepVerification(settleArgs({
    buildTestFailure: { message: '构建执行失败' },
    buildTestRepairContinuation: true,
    buildTestFailureCodes: ['BUILD_TEST_EXECUTION_FAILED'],
    semanticStatus: 'UNCERTAIN'
  }));
  assert.equal(result.status, 'CONTINUE');
  assert.equal(result.stopRecovery, false);
  assert.equal(result.nextAction, 'CONTINUE_EXECUTION');
  assert.deepEqual(result.failureCodes, ['BUILD_TEST_EXECUTION_FAILED']);
});

test('settleStepVerification stops on a non-continuation build test failure', () => {
  const result = settleStepVerification(settleArgs({
    buildTestFailure: { message: 'claim mismatch' },
    buildTestRepairContinuation: false,
    buildTestFailureCodes: ['BUILD_TEST_CONCLUSION_CONFLICT'],
    semanticStatus: 'UNCERTAIN'
  }));
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.stopRecovery, true);
  assert.equal(result.nextAction, 'REVIEW_BUILD_TEST_CONCLUSIONS');
  assert.equal(result.summary, 'claim mismatch');
});

test('settleStepVerification reports missing external evidence', () => {
  const result = settleStepVerification(settleArgs({
    missingExternalEvidence: true,
    externalEvidence: [{ claim: 'claim-a', id: 'ev-x' }]
  }));
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.stopRecovery, true);
  assert.equal(result.nextAction, 'PROVIDE_EXTERNAL_EVIDENCE');
  assert.deepEqual(result.failureCodes, ['EXTERNAL_EVIDENCE_MISSING']);
  const check = result.checks.find((item) => item.id === 'external-evidence');
  assert.equal(check.status, 'UNKNOWN');
  assert.match(check.message, /EXTERNAL_EVIDENCE_MISSING/u);
  assert.ok(check.evidence.includes('ev-x'));
});

test('settleStepVerification confirms a verified workspace read', () => {
  const result = settleStepVerification(settleArgs({ workspaceReadVerified: true }));
  assert.equal(result.status, 'PASS');
  const check = result.checks.find((item) => item.id === 'workspace-read-scope');
  assert.equal(check.status, 'PASS');
  assert.deepEqual(check.evidence, ['ev-1']);
});

test('settleStepVerification keeps a stated jev FAIL rejection', () => {
  const result = settleStepVerification(settleArgs({
    semanticStatus: 'FAIL', behaviorReason: 'GOAL_CONFLICT', stopForBehaviorConflict: true
  }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.nextAction, 'REVIEW_BEHAVIOR');
  assert.equal(result.stopRecovery, true);
  assert.deepEqual(result.failureCodes, ['JEV_BEHAVIOR_REJECTED', 'GOAL_CONFLICT']);
  const check = result.checks.find((item) => item.id === 'jev-behavior-judge');
  assert.equal(check.status, 'FAIL');
  assert.equal(check.message, 'GOAL_CONFLICT');
});

test('settleStepVerification keeps a provider failure UNCERTAIN without evidence stamping', () => {
  const result = settleStepVerification(settleArgs({
    semanticStatus: 'UNCERTAIN', providerFailure: true, behaviorReason: 'JEV_UNAVAILABLE'
  }));
  assert.equal(result.status, 'UNCERTAIN');
  assert.equal(result.failureCodes.includes('JEV_EVIDENCE_REQUIRED'), false);
  const checks = result.checks.filter((item) => item.id === 'jev-behavior-judge');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'UNKNOWN');
  assert.equal(checks[0].message, 'JEV_UNAVAILABLE');
  assert.equal(result.checks.some((item) => item.id === 'host.execution'), false);
});

test('settleStepVerification stamps evidence-required with the withheld reason and host check', () => {
  const result = settleStepVerification(settleArgs({
    semanticStatus: 'UNCERTAIN',
    behaviorDecision: { decision: 'UNCERTAIN', source: 'jev', reasonCode: 'JEV_CHOICE', vetoWithheld: true }
  }));
  assert.equal(result.status, 'UNCERTAIN');
  assert.deepEqual(result.failureCodes, ['JEV_EVIDENCE_REQUIRED']);
  const check = result.checks.find((item) => item.id === 'jev-behavior-judge');
  assert.equal(check.status, 'UNKNOWN');
  assert.equal(check.message, 'JEV_REJECTION_UNEXPLAINED');
  assert.ok(result.checks.some((item) => item.id === 'host.execution' && item.status === 'PASS'));
});

test('runFailureReport selects plan report, deliverable, install and pending build failures in order', () => {
  const planReport = { status: 'FAIL', summary: 'plan failed' };
  assert.equal(runFailureReport({ planFailed: true, planReport }), planReport);
  assert.deepEqual(runFailureReport({ planFailed: true, planReport: undefined }), { status: 'FAIL' });
  assert.deepEqual(
    runFailureReport({
      planFailed: false,
      missingDeliverable: { message: 'report.pptx missing' },
      finalDeliverables: [{ id: 'd1', status: 'FAIL' }]
    }),
    { status: 'FAIL', nextAction: 'REPAIR_DELIVERABLE', summary: 'report.pptx missing',
      failureCodes: ['DELIVERABLE_UNVERIFIED'], checks: [{ id: 'd1', status: 'FAIL' }] }
  );
  assert.deepEqual(
    runFailureReport({ planFailed: false, installGap: 'install evidence missing' }),
    { status: 'UNCERTAIN', nextAction: 'REVIEW_INSTALLATION',
      summary: 'install evidence missing', failureCodes: ['INSTALLATION_UNVERIFIED'] }
  );
  assert.deepEqual(
    runFailureReport({ planFailed: false, pendingBuildTest: [{ label: '构建', detail: '未执行', code: 'BUILD_MISSING' }] }),
    { status: 'UNCERTAIN', nextAction: 'REVIEW_BUILD_TEST_CONCLUSIONS',
      summary: '构建 未执行', failureCodes: ['BUILD_MISSING'] }
  );
});
