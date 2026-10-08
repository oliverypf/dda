import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOAL_TASKS, goalTaskFiles, verifyCodeTask } from './goal-task-set.mjs';
import { runEvidenceProcess } from './goal-evidence-process.mjs';

for (const task of GOAL_TASKS.filter(task => task.acceptance === 'code')) {
  test(`${task.taskId} starts with a real failure and validates the fixed code independently`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-code-grader-'));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const initialFiles = goalTaskFiles(task, 'GOAL_EVIDENCE_grader');
    for (const [path, content] of Object.entries(initialFiles)) await writeFile(join(workspace, path), content);
    const baseline = await runEvidenceProcess(process.execPath, task.initialCommand, { cwd: workspace });
    assert.notEqual(baseline.code, 0, 'the seeded diagnostic must actually fail');
    await writeFile(join(workspace, task.target), task.solution);
    const success = await verifyCodeTask({ task, workspace, initialFiles });
    assert.equal(success.passed, true, JSON.stringify(success));
    assert.equal(success.independentAssertions, task.checks);
    const testPath = Object.keys(initialFiles).find(path => path.endsWith('.test.mjs'));
    await writeFile(join(workspace, testPath), '// deleting the tests cannot satisfy acceptance\n');
    assert.equal((await verifyCodeTask({ task, workspace, initialFiles })).passed, false);
  });
}

test('syntax-valid code that passes the visible example can still fail independent acceptance', async t => {
  const task = GOAL_TASKS.find(task => task.taskId === 'code-feature-001');
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-code-bad-answer-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const initialFiles = goalTaskFiles(task, 'GOAL_EVIDENCE_grader');
  for (const [path, content] of Object.entries(initialFiles)) await writeFile(join(workspace, path), content);
  await writeFile(join(workspace, task.target), `${task.initial} export const uniqueNames = () => ['alice','bob'];\n`);
  const result = await verifyCodeTask({ task, workspace, initialFiles });
  assert.equal(result.visibleTests.code, 0);
  assert.notEqual(result.assertions.code, 0);
  assert.equal(result.passed, false);
});
