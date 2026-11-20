import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationPlanForUncertainResume, uncertainBlockedStepIds } from '../src/uncertain-step-continuation.mjs';

test('only persisted uncertain side effects block a resume', () => {
  assert.deepEqual(uncertainBlockedStepIds({
    steps: [
      { stepId: 'read', status: 'SUCCEEDED' },
      { stepId: 'write', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: 'write', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: 'later', status: 'BLOCKED', errorCode: 'DEPENDENCY_FAILED' },
      { stepId: 'failed', status: 'FAILED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }
    ]
  }), ['write']);
  assert.deepEqual(uncertainBlockedStepIds(undefined), []);
});

test('continuation replaces the interrupted command with one step that finishes the task', () => {
  const plan = continuationPlanForUncertainResume({
    runId: 'run/1',
    stepIds: ['s2'],
    prompt: '这个界面是干什么的'
  });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].stepId, 'continue-task');
  assert.equal(plan.steps[0].status, 'PENDING');
  assert.match(plan.steps[0].summary, /s2/);
  assert.match(plan.steps[0].summary, /不要重放结果不明的写入或命令/);
  assert.match(plan.steps[0].summary, /把原任务做完/);
  assert.notEqual(plan.steps[0].stepId, 's2');
});
