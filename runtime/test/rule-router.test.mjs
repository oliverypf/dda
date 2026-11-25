import test from 'node:test';
import assert from 'node:assert/strict';
import { RuleRouter, requestsRepair } from '../src/rule-router.mjs';
import { createTaskSafetyPrecheck } from '../src/task-safety-precheck.mjs';

test('router uses the generic route when no task class is supplied', () => {
  const router = new RuleRouter();
  const routed = router.resolve({ prompt: '请修改文件', mode: 'CONTROLLED' });
  assert.equal(routed.taskClass, 'unknown');
  assert.equal(routed.status, 'SELECTED');
  assert.deepEqual(routed.roles, { planner: 'default', executor: 'default', verifier: 'rule' });
});

test('router accepts an explicit compatibility class without inferring one', () => {
  const router = new RuleRouter();
  const routed = router.resolve({ prompt: '查一下价格', taskClass: 'query', mode: 'CONTROLLED' });
  assert.equal(routed.taskClass, 'query');
  assert.deepEqual(routed.roles, { executor: 'default' });
  assert.equal(router.resolve({ prompt: '请修改文件', mode: 'READ_ONLY' }).status, 'BLOCKED');
});

test('repair detection remains local to repair-specific planning', () => {
  assert.equal(requestsRepair('please fix the failing test'), true);
  assert.equal(requestsRepair('如何修复这个问题'), false);
  assert.equal(requestsRepair('请修复这个问题'), true);
});

test('unknown remains valid for the safety precheck', () => {
  const precheck = createTaskSafetyPrecheck().evaluate({
    prompt: '请处理这个任务',
    taskClass: 'unknown',
    mode: 'CONTROLLED',
    workspaceRoot: 'C:\\work'
  });
  assert.equal(precheck.status, 'ALLOWED');
});
