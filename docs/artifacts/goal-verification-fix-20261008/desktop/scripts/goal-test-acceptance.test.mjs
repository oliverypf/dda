import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GOAL_TASKS, goalTaskFiles } from './goal-task-set.mjs';
import { ordinaryNodeRequest, executedNodeTestPassed, fixtureTestScope, observedFixtureTestPassed, observedExpectedFailure } from './goal-test-acceptance.mjs';
import { gradeGoalRun } from './goal-evidence-harness.mjs';

test('actual simple Node commands are parsed without accepting quoted examples or compound shell scripts', () => {
  assert.deepEqual(ordinaryNodeRequest('"C:\\host\\pwsh.exe" -Command \'node --test --test-isolation=none\''),
    { command: 'node', args: ['--test', '--test-isolation=none'] });
  assert.deepEqual(ordinaryNodeRequest('node --check tags.mjs'), { command: 'node', args: ['--check', 'tags.mjs'] });
  for (const command of ["Write-Output 'node --test'", "echo node --test", "node --test; echo ok", "node --test | other", "\"C:\\host\\pwsh.exe\" -Command 'Write-Output node --test'", 'node -e "console.log(1)"']) {
    const outcome = { name: 'exec_command', ok: true, exitCode: 0, command };
    assert.equal(executedNodeTestPassed(outcome), false);
  }
});

test('source repair needs an actual seeded failure and the immutable fixture test to pass', async () => {
  const task = GOAL_TASKS.find(task => task.taskId === 'code-normalize-001');
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-goal-acceptance-'));
  const files = goalTaskFiles(task, 'GOAL_EVIDENCE_test');
  for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const invoke = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    return { name: 'test.execute', ok: result.status === 0, input: { command: 'node', args },
      value: { ok: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr, action: 'test', cwd: '.',
        commandDigest: 'sha256:' + createHash('sha256').update(JSON.stringify({ command: 'node', args })).digest('hex') } };
  };
  const failed = invoke(task.initialCommand);
  assert.equal(observedExpectedFailure([failed], task), true);
  await writeFile(join(root, task.target), task.solution);
  const passed = invoke(['--test', '--test-isolation=none']);
  assert.equal(observedFixtureTestPassed(passed, fixtureTestScope(task)), true);
  const commandLine = { ...passed, input: { command: 'node --test --test-isolation=none' } };
  assert.equal(observedFixtureTestPassed(commandLine, fixtureTestScope(task)), true);
  assert.equal(observedFixtureTestPassed({ ...commandLine, value: { ...commandLine.value, commandDigest: undefined } }, fixtureTestScope(task)), false);
  assert.equal(observedFixtureTestPassed({ ...commandLine, input: { command: 'node name.mjs --test' } }, fixtureTestScope(task)), false);
  assert.equal(observedFixtureTestPassed({ ...commandLine, value: { ...commandLine.value, cwd: 'outside' } }, fixtureTestScope(task)), false);
  assert.equal(observedExpectedFailure([{ ...failed, input: { command: 'node --test --test-isolation=none' } }], task), true);
  const wrongTarget = invoke(['--test', '--test-isolation=none', task.target]);
  assert.equal(wrongTarget.ok, true);
  assert.equal(observedFixtureTestPassed(wrongTarget, fixtureTestScope(task)), false);
  const afterScript = invoke([task.target, '--test']);
  assert.equal(afterScript.ok, true);
  assert.equal(executedNodeTestPassed(afterScript), false);
  assert.equal(observedFixtureTestPassed({ ...passed, value: { ...passed.value, stdout: '' } }, fixtureTestScope(task)), false);
  assert.equal(observedExpectedFailure([{ name: 'workspace.read', ok: false, errorCode: 'WORKSPACE_NOT_FOUND' }, passed], task), false);
  assert.equal(observedExpectedFailure([{ name: 'file.write', ok: true }, failed, passed], task), false);
  const scenario = { task, result: { code: 0, timedOut: false }, agentOk: true, text: 'done', marker: 'unused',
    unchanged: false, codeVerification: { passed: true }, nativeResults: [failed, passed] };
  assert.equal(gradeGoalRun(scenario).passed, true);
  assert.equal(gradeGoalRun({ ...scenario, nativeResults: [failed, wrongTarget] }).passed, false);
  assert.equal(gradeGoalRun({ ...scenario, nativeResults: [{ name: 'workspace.read', ok: false }, passed] }).passed, false);
  const ordinary = { name: 'exec_command', ok: true, exitCode: 0, command: '"C:\\host\\pwsh.exe" -Command \'node --test --test-isolation=none\'',
    output: '✔ normalizes names (1ms)\nℹ tests 1\nℹ pass 1\n' };
  assert.equal(observedFixtureTestPassed(ordinary, fixtureTestScope(task)), true);
  assert.equal(observedExpectedFailure([{ ...ordinary, ok: false, exitCode: 1, output: 'TypeError at name.mjs' }], task), true);
});
