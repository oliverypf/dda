import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeGoalRun } from './goal-evidence-harness.mjs';

const scenario = (changes = {}) => ({ task: { acceptance: 'marker', recoverable: true },
  result: { code: 0, timedOut: false }, agentOk: true, text: 'GOAL_EVIDENCE_abc123', marker: 'GOAL_EVIDENCE_abc123',
  nativeResults: [{ ok: false }, { ok: true }], unchanged: true, ...changes });

test('a successful agent status and correct sentence without real tool execution cannot pass', () => {
  assert.equal(gradeGoalRun(scenario({ nativeResults: [] })).passed, false);
});
test('recovery requires a real failure followed by a successful tool result', () => {
  assert.equal(gradeGoalRun(scenario({ nativeResults: [{ ok: true }] })).passed, false);
  assert.equal(gradeGoalRun(scenario({ nativeResults: [{ ok: true }, { ok: false }] })).passed, false);
  assert.equal(gradeGoalRun(scenario()).passed, true);
});
test('incorrect answers, changed read-only workspaces and timeouts fail external acceptance', () => {
  for (const changes of [{ text: 'done' }, { unchanged: false }, { result: { code: 0, timedOut: true } }, { agentOk: false }]) {
    assert.equal(gradeGoalRun(scenario(changes)).passed, false);
  }
});
