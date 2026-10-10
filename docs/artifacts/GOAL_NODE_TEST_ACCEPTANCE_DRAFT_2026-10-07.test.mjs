import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { successfulNativeTest } from '../../desktop/scripts/goal-evidence-audit.mjs';
import { orderedNodeTestRequest, observedFixtureTestPassed } from './GOAL_NODE_TEST_ACCEPTANCE_DRAFT_2026-10-07.mjs';

test('options after a script and incomplete fixture scopes cannot supply full test proof', () => {
  const scope = ['name.test.mjs'];
  for (const args of [['name.mjs', '--test'], ['--test', 'name.mjs', '--test-isolation=none'], ['--check', 'name.mjs'],
    ['--test', 'name.mjs'], ['--test', 'other.test.mjs'], ['--test', 'name.test.mjs', 'unrelated.mjs']]) {
    assert.equal(orderedNodeTestRequest({ command: 'node', args }, scope), false);
  }
  assert.equal(orderedNodeTestRequest({ command: 'node', args: ['--test', '--test-isolation=none'] }, scope), true);
  assert.equal(orderedNodeTestRequest({ command: 'node', args: ['--test', '--test-isolation=none', 'name.test.mjs'], cwd: '.' }, scope), true);
  assert.equal(orderedNodeTestRequest({ command: 'node', args: ['--test-isolation=none', '--test', 'name.test.mjs'] }, scope), true);
  assert.equal(orderedNodeTestRequest({ command: 'node', args: ['--test'], cwd: 'other' }, scope), false);
});

test('native suite acceptance observes the immutable fixture test, not a successful unrelated Node script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-native-test-proof-'));
  await writeFile(join(root, 'name.mjs'), "export const value = 1; if(process.argv.includes('--test'))console.log('ok 1 - accepts sample\\n# tests 1\\n# pass 1');\n");
  await writeFile(join(root, 'name.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './name.mjs'; test('accepts sample',()=>assert.equal(value,1));\n");
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const outcome = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', windowsHide: true });
    return { name: 'test.execute', ok: result.status === 0, input: { command: 'node', args },
      value: { ok: result.status === 0, exitCode: result.status, stdout: result.stdout, stderr: result.stderr } };
  };
  const scope = { expectedTestFiles: ['name.test.mjs'], expectedTestNames: ['accepts sample'] };
  const passed = outcome(['--test', '--test-isolation=none']);
  assert.equal(observedFixtureTestPassed(passed, scope), true, passed.value.stdout + passed.value.stderr);
  const afterScript = outcome(['name.mjs', '--test']);
  assert.equal(afterScript.value.exitCode, 0);
  assert.equal(successfulNativeTest(afterScript), true, 'the old grader exposes the acceptance bug');
  assert.equal(observedFixtureTestPassed(afterScript, scope), false);
  assert.equal(observedFixtureTestPassed(outcome(['--test', '--test-isolation=none', 'name.mjs']), scope), false);
  assert.equal(observedFixtureTestPassed({ ...passed, value: { ...passed.value, stdout: '' } }, scope), false);
  assert.equal(observedFixtureTestPassed({ ...passed, value: { ...passed.value, exitCode: 1, ok: false } }, scope), false);
});
