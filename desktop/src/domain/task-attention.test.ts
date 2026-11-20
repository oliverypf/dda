import { describe, expect, it } from 'vitest';
import {
  reconcileUnseenTasks,
  taskAttentionLabel,
  taskAttentionState,
  type AttentionObservation,
  type AttentionSnapshot,
} from './task-attention';

const row = (patch: Partial<AttentionObservation> & Pick<AttentionObservation, 'id'>): AttentionObservation => ({
  running: false,
  needsApproval: false,
  viewing: false,
  ...patch,
});

describe('taskAttentionState', () => {
  it('shows approval ahead of a run that is waiting on the user', () => {
    expect(taskAttentionState({ needsApproval: true, running: true, viewing: true, unseen: true })).toBe('approval');
  });

  it('shows a live run ahead of an unseen completion', () => {
    expect(taskAttentionState({ needsApproval: false, running: true, viewing: false, unseen: true })).toBe('running');
  });

  it('keeps a finished task unseen until its conversation is open', () => {
    expect(taskAttentionState({ needsApproval: false, running: false, viewing: false, unseen: true })).toBe('unseen');
    expect(taskAttentionState({ needsApproval: false, running: false, viewing: true, unseen: true })).toBe('seen');
  });

  it('leaves a task the user already looked at unmarked as unseen', () => {
    expect(taskAttentionState({ needsApproval: false, running: false, viewing: false, unseen: false })).toBe('seen');
  });
});

describe('taskAttentionLabel', () => {
  it('names each sidebar state, and a failed finish differently from a success', () => {
    expect(taskAttentionLabel('approval')).toBe('需要授权');
    expect(taskAttentionLabel('running')).toBe('正在执行');
    expect(taskAttentionLabel('unseen')).toBe('已完成，尚未查看');
    expect(taskAttentionLabel('unseen', true)).toBe('已结束，尚未查看');
    expect(taskAttentionLabel('seen')).toBe('已查看');
  });
});

describe('reconcileUnseenTasks', () => {
  const settle = (
    unseen: string[],
    prior: Array<[string, AttentionSnapshot]>,
    current: AttentionObservation[],
    initialized = true,
  ) => reconcileUnseenTasks(new Set(unseen), new Map(prior), current, initialized);

  it('does not mark tasks that were already finished on the first paint', () => {
    const result = settle([], [], [row({ id: 'done' })], false);
    expect([...result.unseen]).toEqual([]);
    expect(result.prior.get('done')).toEqual({ running: false, needsApproval: false });
  });

  it('marks a task that finishes while its conversation is closed', () => {
    const result = settle([], [['thread-1', { running: true, needsApproval: false }]], [row({ id: 'thread-1' })]);
    expect([...result.unseen]).toEqual(['thread-1']);
  });

  it('does not mark a task that finishes while the user is looking at it', () => {
    const result = settle(
      [],
      [['thread-1', { running: true, needsApproval: false }]],
      [row({ id: 'thread-1', viewing: true })],
    );
    expect([...result.unseen]).toEqual([]);
  });

  it('clears the mark once the conversation is open and keeps other unseen tasks', () => {
    const result = settle(
      ['thread-1', 'thread-2'],
      [],
      [row({ id: 'thread-1', viewing: true }), row({ id: 'thread-2' })],
    );
    expect([...result.unseen]).toEqual(['thread-2']);
  });

  it('does not treat an approval that continues running as a finished task', () => {
    const result = settle(
      [],
      [['thread-1', { running: true, needsApproval: true }]],
      [row({ id: 'thread-1', running: true })],
    );
    expect([...result.unseen]).toEqual([]);
  });

  it('marks a task when the run stops after authorization', () => {
    const result = settle(
      [],
      [['thread-1', { running: false, needsApproval: true }]],
      [row({ id: 'thread-1' })],
    );
    expect([...result.unseen]).toEqual(['thread-1']);
  });

  it('follows a session that finishes after it is bound to a thread', () => {
    const result = settle(
      [],
      [['session:ui-1', { running: true, needsApproval: false }]],
      [row({ id: 'thread-1', aliases: ['session:ui-1'] })],
    );
    expect([...result.unseen]).toEqual(['thread-1']);
  });

  it('keeps a persisted unseen id on the thread after the session alias goes away', () => {
    const result = settle(['session:ui-1'], [], [row({ id: 'thread-1', aliases: ['session:ui-1'] })]);
    expect([...result.unseen]).toEqual(['thread-1']);
  });

  it('keeps an unseen id while the task list is not ready to prune', () => {
    const result = settle(['gone'], [], [row({ id: 'thread-1' })]);
    expect([...result.unseen]).toEqual(['gone']);
  });

  it('drops an unseen id whose row is gone once pruning is requested', () => {
    const result = reconcileUnseenTasks(new Set(['gone']), new Map(), [row({ id: 'thread-1' })], true, true);
    expect([...result.unseen]).toEqual([]);
  });
});
