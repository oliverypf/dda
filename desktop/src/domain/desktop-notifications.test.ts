import { describe, expect, it } from 'vitest';
import {
  DesktopNoticePolicy,
  deliverDesktopNotice,
  desktopNoticeActivation,
  type DesktopNotice
} from './desktop-notifications';

describe('DesktopNoticePolicy', () => {
  it('notifies once per (run, requestId), independent of sequence', () => {
    const policy = new DesktopNoticePolicy();
    expect(policy.approvalRequested('run-1', 'req-1')).toEqual({ kind: 'APPROVAL_REQUIRED', runId: 'run-1', requestId: 'req-1' });
    expect(policy.clarificationRequested('run-1', 'clarify-1')).toEqual({ kind: 'CLARIFICATION_REQUIRED', runId: 'run-1', requestId: 'clarify-1' });
    expect(policy.clarificationRequested('run-1', 'clarify-1')).toBeUndefined();
    expect(policy.approvalRequested('run-1', 'req-1')).toBeUndefined();
  });

  it('scopes approval dedup by run and keeps distinct ids distinct', () => {
    const policy = new DesktopNoticePolicy();
    expect(policy.approvalRequested('run-1', 'req-1')).toBeDefined();
    expect(policy.approvalRequested('run-1', 'req-2')).toBeDefined();
    expect(policy.approvalRequested('run-2', 'req-1')).toEqual({ kind: 'APPROVAL_REQUIRED', runId: 'run-2', requestId: 'req-1' });
    expect(policy.approvalRequested('run-2', 'req-1')).toBeUndefined();
  });

  it('notifies terminal events once per run', () => {
    const policy = new DesktopNoticePolicy();
    expect(policy.runFinished('run-1', false)).toEqual({ kind: 'TASK_COMPLETED', runId: 'run-1' });
    expect(policy.runFinished('run-1', true)).toBeUndefined();
    expect(policy.runFinished('run-2', true)).toEqual({ kind: 'TASK_FAILED', runId: 'run-2' });
  });

  it('rejects empty identifiers and stays bounded', () => {
    const policy = new DesktopNoticePolicy(8);
    expect(policy.approvalRequested('', 'req')).toBeUndefined();
    expect(policy.approvalRequested('run', '')).toBeUndefined();
    expect(policy.runFinished('', false)).toBeUndefined();
    for (let i = 0; i < 40; i += 1) policy.runFinished(`run-${i}`, false);
    expect(policy.runFinished('run-39', false)).toBeUndefined();
    expect(policy.runFinished('run-0', false)).toBeDefined();
  });
});

describe('deliverDesktopNotice', () => {
  const notice: DesktopNotice = { kind: 'TASK_COMPLETED', runId: 'run-1' };
  it('maps acks to outcomes without throwing', async () => {
    await expect(deliverDesktopNotice(notice, async () => ({ accepted: true }))).resolves.toBe('sent');
    await expect(deliverDesktopNotice(notice, async () => ({ accepted: false, reason: 'duplicate' }))).resolves.toBe('ignored');
    await expect(deliverDesktopNotice(notice, async () => ({ accepted: false, reason: 'unsupported' }))).resolves.toBe('ignored');
    await expect(deliverDesktopNotice(notice, async () => ({ accepted: false, reason: 'unavailable' }))).resolves.toBe('failed');
    await expect(deliverDesktopNotice(notice, async () => ({ accepted: false }))).resolves.toBe('failed');
    await expect(deliverDesktopNotice(notice, async () => { throw new Error('NIM_ADD failed'); })).resolves.toBe('failed');
  });
});

describe('desktopNoticeActivation', () => {
  const base = { activeRunId: 'run-1', running: false, approvals: [] as Array<{ requestId: string; state: string; approvalExpiresAt?: number }>, nowMs: 1000 };
  const pending = { requestId: 'req-1', state: 'REQUESTED', approvalExpiresAt: 2000 };

  it('opens a still-pending approval only for the active run', () => {
    const ctx = { ...base, approvals: [pending] };
    expect(desktopNoticeActivation({ kind: 'APPROVAL_REQUIRED', runId: 'run-1', requestId: 'req-1' }, ctx))
      .toEqual({ type: 'approval', requestId: 'req-1' });
    expect(desktopNoticeActivation({ kind: 'APPROVAL_REQUIRED', runId: 'run-2', requestId: 'req-1' }, ctx))
      .toEqual({ type: 'none' });
  });

  it('never resurrects resolved, expired, or unknown approvals', () => {
    const resolved = { ...base, approvals: [{ ...pending, state: 'APPROVED' }] };
    const expired = { ...base, approvals: [{ ...pending, approvalExpiresAt: 500 }] };
    const missing = { ...base, approvals: [] };
    for (const ctx of [resolved, expired, missing]) {
      expect(desktopNoticeActivation({ kind: 'APPROVAL_REQUIRED', runId: 'run-1', requestId: 'req-1' }, ctx))
        .toEqual({ type: 'none' });
    }
  });

  it('navigates terminal clicks only when idle and mapped', () => {
    expect(desktopNoticeActivation({ kind: 'TASK_COMPLETED', runId: 'run-1' }, { ...base, threadId: 'thread-9' }))
      .toEqual({ type: 'thread', threadId: 'thread-9' });
    expect(desktopNoticeActivation({ kind: 'TASK_FAILED', runId: 'run-1' }, { ...base, threadId: 'thread-9', running: true }))
      .toEqual({ type: 'changed' });
    expect(desktopNoticeActivation({ kind: 'TASK_COMPLETED', runId: 'run-9' }, base))
      .toEqual({ type: 'none' });
  });

  it('opens a still-pending clarification for the active run', () => {
    expect(desktopNoticeActivation(
      { kind: 'CLARIFICATION_REQUIRED', runId: 'run-1', requestId: 'clarify-1' },
      { ...base, clarificationRequestIds: ['clarify-1'] }
    )).toEqual({ type: 'clarification', requestId: 'clarify-1' });
    expect(desktopNoticeActivation(
      { kind: 'CLARIFICATION_REQUIRED', runId: 'run-1', requestId: 'clarify-1' },
      base
    )).toEqual({ type: 'none' });
  });

  it('ignores unknown kinds entirely', () => {
    expect(desktopNoticeActivation({ kind: 'LEASE_ISSUED', runId: 'run-1' }, base)).toEqual({ type: 'none' });
    expect(desktopNoticeActivation(undefined, base)).toEqual({ type: 'none' });
    expect(desktopNoticeActivation({}, base)).toEqual({ type: 'none' });
  });
});
