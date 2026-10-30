import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverableThreadGoal } from '../src/thread-store.mjs';

test('a saved thread title is the original user task', () => {
  assert.equal(recoverableThreadGoal({ title: '编译exe' }), '编译exe');
  assert.equal(recoverableThreadGoal({ title: 'Thread abcd1234' }), '');
  assert.equal(recoverableThreadGoal({ title: 'dda task' }), '');
  assert.equal(recoverableThreadGoal({ title: '' }), '');
});
