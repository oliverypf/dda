import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, RuleRouter } from '../src/rule-router.mjs';
import { createTaskSafetyPrecheck } from '../src/task-safety-precheck.mjs';

test('modify tasks use the controlled route and retired execution modes are rejected', () => {
  const router = new RuleRouter();
  assert.equal(classifyTask('please modify the README'), 'modify');
  assert.equal(classifyTask('edit the config and write a patch'), 'modify');
  assert.equal(classifyTask('请修改文件'), 'modify');
  assert.equal(classifyTask('编辑配置'), 'modify');
  assert.equal(classifyTask('改动代码'), 'modify');
  assert.equal(classifyTask('改 README'), 'modify');
  const blocked = router.resolve({ prompt: 'please modify the README', mode: 'READ_ONLY' });
  assert.equal(blocked.taskClass, 'modify');
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reason, 'INVALID_EXECUTION_MODE');
  assert.equal(router.resolve({ prompt: 'please modify the README', mode: 'CONTROLLED' }).status, 'SELECTED');
  assert.equal(router.resolve({ prompt: '请修改文件' }).status, 'SELECTED');
});

test('negated modify verbs are not classified as modify', () => {
  const router = new RuleRouter();
  const negated = [
    'Do not modify anything',
    "don't modify the files",
    'never modify production',
    'no modify',
    'without modify',
    '不要修改任何文件',
    '别修改',
    '别改',
    '不可以修改',
    '不可以编辑',
    '勿修改',
    '勿改动',
    '没有需要修改'
  ];
  for (const prompt of negated) {
    assert.notEqual(classifyTask(prompt), 'modify', prompt);
    const routed = router.resolve({ prompt });
    assert.notEqual(routed.taskClass, 'modify', prompt);
    assert.equal(routed.status, 'SELECTED', prompt);
    assert.equal(routed.reason, 'STATIC_RULE', prompt);
  }
});

test('negated modify can still fall through to inspect or stay unknown', () => {
  assert.equal(classifyTask('Do not modify anything, just inspect the repo'), 'inspect');
  assert.equal(classifyTask('Do not modify anything'), 'unknown');
  assert.equal(classifyTask('不要修改任何文件，只查看 README'), 'inspect');
  assert.equal(classifyTask('不要修改任何文件'), 'unknown');
  const routed = new RuleRouter().resolve({ prompt: '不要修改任何文件，只查看 README' });
  assert.equal(routed.taskClass, 'inspect');
  assert.equal(routed.status, 'SELECTED');
  assert.equal(routed.reason, 'STATIC_RULE');
});

test('a lookup is a query and keeps only the executor', () => {
  const router = new RuleRouter();
  for (const prompt of [
    '腾讯的hy 4是什么价格',
    'hy4 多少钱',
    'what is the price of hy4',
    '查一下腾讯 Hy4 的报价'
  ]) {
    assert.equal(classifyTask(prompt), 'query', prompt);
    const routed = router.resolve({ prompt });
    assert.equal(routed.status, 'SELECTED', prompt);
    assert.deepEqual(routed.roles, { executor: 'default' }, prompt);
  }
  assert.equal(classifyTask('请修改价格显示'), 'modify');
  assert.equal(classifyTask('查看 README'), 'inspect');
  assert.equal(classifyTask('分析这段代码'), 'inspect');
  assert.equal(classifyTask('不要查询，请修改文件'), 'modify');
  const precheck = createTaskSafetyPrecheck().evaluate({
    prompt: '腾讯的hy 4是什么价格',
    taskClass: 'query',
    mode: 'CONTROLLED',
    workspaceRoot: 'C:\\work'
  });
  assert.equal(precheck.status, 'ALLOWED');
});

test('an unnegated modify later in the prompt still wins', () => {
  assert.equal(classifyTask('Do not break tests. Please modify the file.'), 'modify');
  assert.equal(classifyTask('不要查看，请修改文件'), 'modify');
});
