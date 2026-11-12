import { describe, expect, it } from 'vitest';
import { threadRecoveryBlock } from './thread-recovery';
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
