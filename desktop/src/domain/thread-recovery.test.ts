import { describe, expect, it } from 'vitest';
import { isUncertainSideEffectFailure, threadRecoveryBlock, uncertainOutcomeRecoveryPrompt } from './thread-recovery';
import type { ThreadReadModel } from './models';

const thread = (over: Partial<ThreadReadModel> = {}): ThreadReadModel => ({
  id: 'thread-1',
  title: 't',
  cwd: 'c',
  turnCount: 0,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...over
});

const block = { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' as const, stepIds: ['inspect'] };

describe('threadRecoveryBlock', () => {
  it('trusts an explicit summary block even without checkpoint details', () => {
    expect(threadRecoveryBlock(thread({ recoveryBlock: block }))).toEqual(block);
  });

  it('falls back to the checkpoint plan steps and the plan alias', () => {
    const checkpointSteps = { runId: 'r', phase: 'EXECUTING', plan: { steps: [
      { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: 'build', status: 'PENDING' }
    ] } };
    expect(threadRecoveryBlock(thread({ checkpoint: checkpointSteps }))).toEqual(block);
    const checkpointAlias = { runId: 'r', phase: 'EXECUTING', plan: { plan: [
      { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }
    ] } };
    expect(threadRecoveryBlock(thread({ checkpoint: checkpointAlias }))).toEqual(block);
  });

  it('prefers the summary field over checkpoint fallback', () => {
    const summary = { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' as const, stepIds: ['a', 'b'] };
    const t = thread({ recoveryBlock: summary, checkpoint: { plan: { steps: [
      { stepId: 'z', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }
    ] } } });
    expect(threadRecoveryBlock(t)).toEqual(summary);
  });

  it('does not infer a block from ordinary failures or missing data', () => {
    expect(threadRecoveryBlock(undefined)).toBeUndefined();
    expect(threadRecoveryBlock(thread())).toBeUndefined();
    expect(threadRecoveryBlock(thread({ state: 'FAILED', resumeMode: 'PLAN', resumable: false }))).toBeUndefined();
    expect(threadRecoveryBlock(thread({ checkpoint: { plan: { steps: [
      { stepId: 'build', status: 'BLOCKED', errorCode: 'EXECUTOR_SPAWN_FAILED' }
    ] } } }))).toBeUndefined();
    expect(threadRecoveryBlock(thread({ checkpoint: { plan: { steps: [
      { stepId: 'build', status: 'FAILED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }
    ] } } }))).toBeUndefined();
    expect(threadRecoveryBlock(thread({ recoveryBlock: { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', stepIds: [] } as never }))).toBeUndefined();
    expect(threadRecoveryBlock(thread({ checkpoint: { plan: 'not-a-plan' } }))).toBeUndefined();
  });

  it('collects unique affected step ids only', () => {
    const t = thread({ checkpoint: { plan: { steps: [
      { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: 'inspect', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: '', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
      { stepId: 'build', status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }
    ] } } });
    expect(threadRecoveryBlock(t)).toEqual({ reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', stepIds: ['inspect', 'build'] });
  });
});

describe('uncertainOutcomeRecoveryPrompt', () => {
  const blocked = thread({
    title: '编译exe',
    recoveryBlock: { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', stepIds: ['inspect-build-config'] }
  });

  it('tells the agent to inspect the interrupted step and finish the saved task', () => {
    const prompt = uncertainOutcomeRecoveryPrompt(blocked, '继续');
    expect(prompt).toContain('继续完成这个任务：编译exe');
    expect(prompt).toContain('inspect-build-config');
    expect(prompt).toContain('不要重放结果不明的写入或命令');
    expect(prompt).not.toContain('请先核对');
  });

  it('keeps a substantive follow-up as the task to finish', () => {
    const prompt = uncertainOutcomeRecoveryPrompt(blocked, '改成发布版再编译');
    expect(prompt).toContain('继续完成这个任务：改成发布版再编译');
    expect(prompt).not.toContain('编译exe');
  });

  it('does not wrap a prompt that is already a recovery instruction', () => {
    const once = uncertainOutcomeRecoveryPrompt(blocked, '继续');
    expect(uncertainOutcomeRecoveryPrompt(blocked, once)).toBe(once);
  });

  it('does not invent a recovery prompt when the thread is not blocked', () => {
    expect(uncertainOutcomeRecoveryPrompt(thread({ title: '编译exe' }), '继续')).toBeUndefined();
  });
});

describe('isUncertainSideEffectFailure', () => {
  it('recognizes the uncertain outcome on any of the runtime failure fields', () => {
    expect(isUncertainSideEffectFailure({ stepErrorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' })).toBe(true);
    expect(isUncertainSideEffectFailure({ failureCodes: ['PLAN_STEP_FAILED', 'SIDE_EFFECT_OUTCOME_UNCERTAIN'] })).toBe(true);
    expect(isUncertainSideEffectFailure({ code: 'PLAN_STEP_FAILED', errorCode: 'EXECUTOR_SPAWN_FAILED' })).toBe(false);
    expect(isUncertainSideEffectFailure(undefined)).toBe(false);
  });
});
