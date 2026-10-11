import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, RuleRouter } from '../src/rule-router.mjs';

test('positive modify still classifies and blocks in READ_ONLY', () => {
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
  assert.equal(blocked.reason, 'READ_ONLY_MODE');
  assert.equal(router.resolve({ prompt: 'please modify the README', mode: 'CONTROLLED' }).status, 'SELECTED');
  assert.equal(router.resolve({ prompt: '请修改文件', mode: 'READ_ONLY' }).reason, 'READ_ONLY_MODE');
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
    const routed = router.resolve({ prompt, mode: 'READ_ONLY' });
    assert.notEqual(routed.taskClass, 'modify', prompt);
    assert.equal(routed.status, 'SELECTED', prompt);
    assert.notEqual(routed.reason, 'READ_ONLY_MODE', prompt);
  }
});

test('negated modify can still fall through to inspect or stay unknown', () => {
  assert.equal(classifyTask('Do not modify anything, just inspect the repo'), 'inspect');
  assert.equal(classifyTask('Do not modify anything'), 'unknown');
  assert.equal(classifyTask('不要修改任何文件，只查看 README'), 'inspect');
  assert.equal(classifyTask('不要修改任何文件'), 'unknown');
  const routed = new RuleRouter().resolve({ prompt: '不要修改任何文件，只查看 README', mode: 'READ_ONLY' });
  assert.equal(routed.taskClass, 'inspect');
  assert.equal(routed.status, 'SELECTED');
  assert.notEqual(routed.reason, 'READ_ONLY_MODE');
});

test('an unnegated modify later in the prompt still wins', () => {
  assert.equal(classifyTask('Do not break tests. Please modify the file.'), 'modify');
  assert.equal(classifyTask('不要查看，请修改文件'), 'modify');
});
