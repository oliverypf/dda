import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleVerifier } from '../src/rule-verifier.mjs';
import { TaskRunCoordinator } from '../src/task-run-coordinator.mjs';

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
