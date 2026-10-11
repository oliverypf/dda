import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, RuleRouter } from '../src/rule-router.mjs';

test('positive modify still classifies and blocks in READ_ONLY', () => {
  const router = new RuleRouter();
  assert.equal(classifyTask('please modify the README'), 'modify');
  assert.equal(classifyTask('edit the config and write a patch'), 'modify');
  const blocked = router.resolve({ prompt: 'please modify the README', mode: 'READ_ONLY' });
  assert.equal(blocked.taskClass, 'modify');
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reason, 'READ_ONLY_MODE');
  assert.equal(router.resolve({ prompt: 'please modify the README', mode: 'CONTROLLED' }).status, 'SELECTED');
});

test('negated modify verbs are not classified as modify', () => {
  const router = new RuleRouter();
  const negated = [
    'Do not modify anything',
    "don't modify the files",
    'never modify production',
    'no modify',
    'without modify'
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
});

test('an unnegated modify later in the prompt still wins', () => {
  assert.equal(classifyTask('Do not break tests. Please modify the file.'), 'modify');
});
