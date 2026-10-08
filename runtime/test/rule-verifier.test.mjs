import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleVerifier } from '../src/rule-verifier.mjs';
import { TaskRunCoordinator } from '../src/task-run-coordinator.mjs';

test('a later successful identical test resolves its failure without losing the trace', () => {
  const failed = { name: 'test.execute', state: 'FAILED', errorCode: 'TEST_CHECK_FAILED', argumentsDigest: 'sha256:one' };
  const passed = { name: 'test.execute', state: 'SUCCEEDED', argumentsDigest: 'sha256:one', outputDigest: 'sha256:pass' };
  const actions = [failed, { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: 'sha256:patch', outputDigest: 'sha256:changed' }, passed];
  const verify = candidate => new RuleVerifier().verify({ output: 'fixed and tested', workspace: { granted: true }, actions: candidate });
  assert.equal(verify(actions).status, 'PASS');
  assert.equal(verify([failed, { ...passed, argumentsDigest: 'sha256:other-test' }]).status, 'CONTINUE');
  assert.notEqual(verify([failed, { ...passed, outputDigest: undefined }]).status, 'PASS');
  assert.equal(verify([{ ...failed, errorCode: 'EXECUTOR_RESULT_FAILED' }, passed]).status, 'FAIL');
  assert.equal(verify([passed, failed]).status, 'STALLED');
  assert.equal(actions[0].state, 'FAILED');
});

test('host-deferred proposals do not become permanent execution failures or duplicate effects', () => {
  const deferred = { name: 'file.write', state: 'FAILED', errorCode: 'TOOL_ACTION_REQUIRES_EVIDENCE',
    gateDecision: 'REQUEST_EVIDENCE', invocationAttempted: false, argumentsDigest: 'sha256:write' };
  const succeeded = { name: 'file.write', state: 'SUCCEEDED', argumentsDigest: 'sha256:write', outputDigest: 'sha256:actual-write' };
  const read = { name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: 'sha256:read', outputDigest: 'sha256:actual-read' };
  const verify = actions => new RuleVerifier().verify({ output: 'actual repaired output', workspace: { granted: true }, actions });
  assert.equal(verify([deferred, read, { ...deferred }, succeeded]).status, 'PASS');
  assert.notEqual(verify([deferred]).status, 'PASS', 'a deferral alone proves no completed work');
  assert.equal(verify([{ ...deferred, invocationAttempted: true }, succeeded]).status, 'FAIL');
  assert.equal(verify([{ ...deferred, gateDecision: 'BLOCK' }, succeeded]).status, 'FAIL');
  assert.equal(verify([{ ...deferred, errorCode: 'LEASE_REQUIRED' }, succeeded]).status, 'FAIL');
  assert.equal(verify([{ ...deferred, errorCode: 'TOOL_ACTION_BLOCKED_BY_JEV' }, succeeded]).status, 'FAIL');
  assert.equal(verify([{ ...deferred, gateDecision: undefined, invocationAttempted: undefined }, succeeded]).status, 'FAIL', 'legacy ambiguous failures stay closed');
  assert.equal(deferred.state, 'FAILED', 'the historical refusal is preserved');
});

test('rule verifier requires bounded non-empty output', () => {
  const verifier = new RuleVerifier();
  assert.equal(verifier.verify({ output: 'ok', workspace: { granted: true }, toolRounds: 1, toolCallCount: 2 }).status, 'PASS');
  assert.equal(verifier.verify({ output: '', workspace: { granted: true } }).status, 'FAIL');
  assert.equal(verifier.verify({ output: 'ok', workspace: { granted: false } }).status, 'UNKNOWN');
});

test('task coordinator enforces transitions and optimistic version', () => {
  const coordinator = new TaskRunCoordinator();
  coordinator.transition('PLANNING');
  coordinator.transition('EXECUTING');
  assert.throws(() => coordinator.transition('SUCCEEDED'), /RUN_INVALID_TRANSITION/);
  assert.throws(() => coordinator.transition('VERIFYING', { expectedVersion: 0 }), /RUN_STALE_VERSION/);
  coordinator.transition('VERIFYING', { expectedVersion: 2 });
  coordinator.transition('SUCCEEDED');
  assert.throws(() => coordinator.transition('PLANNING'), /RUN_INVALID_TRANSITION/);
});

test('rule verifier reports partial goal progress as CONTINUE', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    prompt: 'inspect the workspace',
    output: 'found one of two requested files',
    workspace: { granted: true, snapshotDigest: `sha256:${'a'.repeat(64)}` },
    goal: { criteria: ['found one', 'found two'] }
  });

  assert.equal(report.status, 'CONTINUE');
  assert.equal(report.progress, 0.5);
  assert.equal(report.nextAction, 'CONTINUE_EXECUTION');
  assert.match(report.promptDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(report.checks.some((item) => item.id === 'goal.coverage' && item.status === 'UNKNOWN'));
});

test('rule verifier detects repeated actions and stops with STALLED', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    output: 'still investigating',
    workspace: { granted: true },
    actions: [
      { tool: 'workspace.read', path: 'src/main.ts', ok: true },
      { tool: 'workspace.read', path: 'src/main.ts', ok: true }
    ]
  });

  assert.equal(report.status, 'STALLED');
  assert.ok(report.failureCodes.includes('REPEATED_ACTION'));
  assert.equal(report.nextAction, 'DIAGNOSE_OR_REQUEST_NEW_EVIDENCE');
  assert.equal(report.checks.find((item) => item.id === 'actions.duplicates').status, 'FAIL');
});

test('fresh reads and preservation checks after an observed write are not a stalled loop', () => {
  const digest = char => `sha256:${char.repeat(64)}`;
  const read = { name: 'workspace.read', path: 'name.mjs', state: 'SUCCEEDED', argumentsDigest: digest('a'), outputDigest: digest('b') };
  const testRead = { ...read, path: 'name.test.mjs', argumentsDigest: digest('c'), outputDigest: digest('d') };
  const write = { name: 'file.write', path: 'name.mjs', state: 'SUCCEEDED', argumentsDigest: digest('e'), outputDigest: digest('f') };
  const verify = actions => new RuleVerifier().verify({ output: 'changed source and verified preservation', workspace: { granted: true }, actions });
  assert.equal(verify([read, { ...read, outputDigest: digest('1') }]).status, 'PASS', 'changed actual read output is new evidence');
  assert.equal(verify([read, testRead, write, { ...read, outputDigest: digest('1') }, testRead]).status, 'PASS', 'unchanged tests may be rechecked after the actual source write');
  assert.equal(verify([read, { ...read, newEvidence: true }]).status, 'STALLED', 'a flag cannot make identical actual output fresh');
  assert.equal(verify([read, { ...write, outputDigest: undefined }, read]).status, 'STALLED', 'an unproven write does not refresh the read epoch');
  assert.equal(verify([read, write, read, read]).status, 'STALLED', 'an additional unchanged read within the same epoch still repeats');
  assert.equal(verify([write, { ...write, outputDigest: digest('1'), newEvidence: true }]).status, 'STALLED', 'repeated side effects keep the same fingerprint regardless of their output');
});

test('one repeated syntax diagnosis can recover only through a later actual full test', () => {
  const digest = char => `sha256:${char.repeat(64)}`;
  const actual = (kind, fingerprint, output) => ({ name: 'test.execute', state: 'SUCCEEDED', argumentsDigest: fingerprint,
    outputDigest: output, verifiedResult: { outputDigest: output, executionOk: true, exitCode: 0, processIntent: { kind },
      decisionClaim: '{"name":"test.execute","ok":true,"exitCode":0}' } });
  const syntax = actual('NODE_SYNTAX_CHECK', digest('a'), digest('b'));
  const full = actual('NODE_TEST', digest('c'), digest('d'));
  const write = { name: 'file.write', state: 'SUCCEEDED', argumentsDigest: digest('e'), outputDigest: digest('f') };
  const verify = actions => new RuleVerifier().verify({ output: 'repaired and actually tested', workspace: { granted: true }, actions });
  const recovered = verify([syntax, { ...syntax, outputDigest: digest('1'), verifiedResult: { ...syntax.verifiedResult, outputDigest: digest('1') } }, full]);
  assert.equal(recovered.status, 'PASS', 'a later fresh full test proves the bounded diagnostic loop has ended');
  assert.equal(recovered.checks.find(item => item.id === 'actions.recovered_diagnostics')?.status, 'PASS');
  assert.equal(verify([syntax, syntax]).status, 'STALLED');
  assert.equal(verify([full, syntax, syntax]).status, 'STALLED', 'an earlier test cannot resolve a later loop');
  assert.equal(verify([syntax, syntax, syntax, full]).status, 'STALLED', 'unbounded diagnostic repetitions are retained');
  assert.equal(verify([syntax, syntax, { ...full, verifiedResult: undefined, newEvidence: true }]).status, 'STALLED', 'model flags are not actual completion proof');
  assert.equal(verify([syntax, syntax, { ...full, invocationAttempted: false }]).status, 'STALLED');
  assert.equal(verify([syntax, syntax, { ...full, verifiedResult: { ...full.verifiedResult, exitCode: 1, executionOk: false } }]).status, 'STALLED');
  assert.equal(verify([syntax, syntax, { ...full, outputDigest: digest('2') }]).status, 'STALLED', 'mismatched actual output digest stays closed');
  assert.equal(verify([syntax, { ...syntax, verifiedResult: undefined }, full]).status, 'STALLED', 'ambiguous command histories stay closed');
  assert.equal(verify([write, write, full]).status, 'STALLED', 'actual repeated writes retain their failure');
  assert.equal(verify([{ ...syntax, verifiedResult: { ...syntax.verifiedResult, processIntent: { kind: 'UNKNOWN' } } },
    { ...syntax, verifiedResult: { ...syntax.verifiedResult, processIntent: { kind: 'UNKNOWN' } } }, full]).status, 'STALLED', 'arbitrary commands remain side effects');
});

test('rule verifier fails closed for paths outside the canonical workspace', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    output: 'attempted change',
    workspace: { granted: true, rootPath: 'C:\\workspace' },
    actions: [{ tool: 'file.write', path: '..\\secrets.txt', ok: true }]
  });

  assert.equal(report.status, 'FAIL');
  assert.ok(report.failureCodes.includes('PATH_OUT_OF_SCOPE'));
  assert.equal(report.safety, 0);
  assert.equal(report.checks.find((item) => item.id === 'paths.scope').status, 'FAIL');
});

test('rule verifier aggregates optional diff, build, test and result evidence', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    output: 'implemented and verified',
    workspace: { granted: true, rootPath: 'C:\\workspace', snapshotDigest: `sha256:${'b'.repeat(64)}` },
    actions: [{ tool: 'file.write', path: 'src/main.ts', ok: true, outputDigest: `sha256:${'c'.repeat(64)}` }],
    result: { ok: true, outputDigest: `sha256:${'d'.repeat(64)}` },
    diff: { withinScope: true, changedFiles: ['src/main.ts'] },
    build: { ok: true, exitCode: 0, outputDigest: `sha256:${'e'.repeat(64)}` },
    tests: [{ passed: true, name: 'unit' }, { status: 'PASSED', name: 'integration' }]
  });

  assert.equal(report.status, 'PASS');
  assert.equal(report.progress, 1);
  for (const id of ['paths.scope', 'evidence.execution_result', 'evidence.diff', 'evidence.build', 'evidence.tests']) {
    assert.equal(report.checks.find((item) => item.id === id).status, 'PASS', id);
  }
  assert.ok(report.evidence.some((ref) => ref.startsWith('output:sha256:')));
  assert.equal(report.failureCodes.length, 0);
});

test('rule verifier treats explicitly failed build evidence as FAIL', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    output: 'build failed',
    workspace: { granted: true },
    build: { ok: false, exitCode: 1, stderr: 'compiler error' }
  });

  assert.equal(report.status, 'FAIL');
  assert.ok(report.failureCodes.includes('BUILD_FAILED'));
  assert.equal(report.nextAction, 'STOP_AND_REPORT');
});

test('rule verifier does not treat empty evidence containers as proof', () => {
  const verifier = new RuleVerifier();
  const report = verifier.verify({
    output: 'claimed complete',
    workspace: { granted: true },
    build: { output: '', logs: [], files: [] }
  });

  const buildCheck = report.checks.find((item) => item.id === 'evidence.build');
  assert.equal(buildCheck.status, 'UNKNOWN');
  assert.equal(report.status, 'UNCERTAIN');
  assert.equal(report.failureCodes.includes('BUILD_FAILED'), false);
});

test('binary workspace reads request recovery while keeping the unsuccessful action visible', () => {
  const report = new RuleVerifier().verify({
    output: 'The binary file could not be read; use another source.',
    workspace: { granted: true },
    actions: [{ name: 'workspace.read', path: 'image.bin', state: 'FAILED', errorCode: 'WORKSPACE_BINARY_FILE' }]
  });
  assert.equal(report.status, 'CONTINUE');
  assert.equal(report.nextAction, 'CONTINUE_EXECUTION');
  assert.equal(report.progress, 0);
  assert.equal(report.failureCodes.includes('ACTION_FAILED'), false);
  assert.equal(report.checks.find((item) => item.id === 'actions.progress').status, 'UNKNOWN');
});

test('hard action failures report their error codes and reference the failed action after many successes', () => {
  const actions = Array.from({ length: 20 }, (_, index) => ({ name: 'workspace.read', path: 'file-' + index, state: 'SUCCEEDED' }));
  actions.push({ name: 'workspace.read', path: '.env', state: 'FAILED', errorCode: 'WORKSPACE_SENSITIVE_PATH' });
  actions.push({ name: 'workspace.read', path: 'image.bin', state: 'FAILED', errorCode: 'WORKSPACE_BINARY_FILE' });
  const report = new RuleVerifier().verify({ output: 'inspection stopped', workspace: { granted: true }, actions });
  const check = report.checks.find((item) => item.id === 'actions.progress');
  assert.equal(report.status, 'FAIL');
  assert.equal(report.nextAction, 'STOP_AND_REPORT');
  assert.ok(report.failureCodes.includes('ACTION_FAILED'));
  assert.match(check.message, /WORKSPACE_SENSITIVE_PATH/);
  assert.ok(check.evidence.some((ref) => ref.startsWith('action:20:')));
  assert.equal(check.evidence.some((ref) => ref.startsWith('action:21:')), false);
});
