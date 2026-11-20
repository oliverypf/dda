import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleVerifier } from '../src/rule-verifier.mjs';
import { TaskRunCoordinator } from '../src/task-run-coordinator.mjs';

test('the rule verifier does not decide the run', () => {
  const verifier = new RuleVerifier();
  const cases = [
    { output: '' },
    { output: 'ok', workspace: { granted: false } },
    { output: 'attempted change', workspace: { granted: true, rootPath: 'C:\\workspace' }, actions: [{ tool: 'file.write', path: '..\\secrets.txt', ok: true }] },
    { output: 'searched', workspace: { granted: true, rootPath: 'C:\\workspace' }, actions: [{ name: 'network.request', host: 'cn.bing.com', scheme: 'https', path: '/search?q=hy4', state: 'FAILED', errorCode: 'SAFETY_NETWORK_INVALID' }] },
    { output: 'build failed', workspace: { granted: true }, build: { ok: false, exitCode: 1, stderr: 'compiler error' } },
    { output: 'again', workspace: { granted: true }, actions: [
      { name: 'file.write', state: 'SUCCEEDED', argumentsDigest: 'sha256:same', outputDigest: 'sha256:a' },
      { name: 'file.write', state: 'SUCCEEDED', argumentsDigest: 'sha256:same', outputDigest: 'sha256:a' }
    ] }
  ];
  for (const input of cases) {
    const report = verifier.verify(input);
    assert.equal(report.status, 'PASS');
    assert.deepEqual(report.failureCodes, []);
    assert.deepEqual(report.checks, []);
  }
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
