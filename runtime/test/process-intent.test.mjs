import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeProcessIntent, requestedProcessDecisionClaim } from '../src/decision/process-intent.mjs';

test('Node process scope distinguishes default discovery, targeted tests and syntax diagnosis without implying execution', () => {
  const automatic = nodeProcessIntent({ command: 'node', args: ['--test', '--test-isolation=none'] });
  assert.equal(automatic.kind, 'NODE_TEST');
  assert.equal(automatic.automaticDiscovery, true);
  assert.equal(automatic.workingDirectory, '.');
  assert.equal(automatic.workingDirectorySource, 'DEFAULT_AUTHORIZED_WORKSPACE');
  const targeted = nodeProcessIntent({ command: 'node', args: ['--test', 'name.test.mjs'], cwd: 'src' });
  assert.deepEqual(targeted.targets, ['name.test.mjs']);
  assert.equal(targeted.automaticDiscovery, false);
  assert.equal(nodeProcessIntent({ command: 'node', args: ['--check', 'name.mjs'] }).kind, 'NODE_SYNTAX_CHECK');
  for (const request of [
    { command: 'node', args: ['--check', 'name.mjs', '--require=preload.mjs'] },
    { command: 'node', args: ['--test', '--import=preload.mjs'] },
    { command: 'node', args: ['name.mjs', '--test'] },
    { command: 'node', args: ['--test', 'name.test.mjs', '--test-isolation=none'] },
    { command: 'node', args: ['--test', 42] },
    { command: 'node', args: ['--test'], env: { NODE_OPTIONS: '--require preload.mjs' } },
    { command: 'node', args: ['--check', 'name.mjs'], input: 'unexpected input' },
    { command: 'node', args: ['--check', '../private.mjs'] },
    { command: 'node', args: ['--test'], cwd: 'C:/private' },
    { command: 'node', args: ['--test'], cwd: '../private' },
    { command: 'node', args: ['-e', 'process.exit(0)'] },
    { command: 'opaque.exe', args: ['--check', 'name.mjs'] }
  ]) assert.equal(nodeProcessIntent(request), undefined);
  const claim = requestedProcessDecisionClaim(automatic);
  assert.ok(claim.length <= 500);
  const facts = JSON.parse(claim).hostRequestedProcess;
  assert.equal(facts.actualExecution, 'NOT_YET_EXECUTED');
  assert.equal(facts.executionPolicy, 'HOST_ONE_SHOT_LEASE_REQUIRED');
  assert.match(facts.discovery, /recursively/u);
  const spaced = requestedProcessDecisionClaim(nodeProcessIntent({ command: 'node', args: ['--test'], cwd: 'folder  two' }));
  assert.equal(JSON.parse(spaced.replace(/\s+/gu, ' ')).hostRequestedProcess.workingDirectory, 'folder  two');
  const large = requestedProcessDecisionClaim(nodeProcessIntent({ command: 'node', args: ['--test', `${'a'.repeat(82)}.test.mjs`], cwd: 'x'.repeat(96) }));
  assert.ok(large.length <= 500);
  assert.doesNotThrow(() => JSON.parse(large));
});
