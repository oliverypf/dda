import { describe, expect, it } from 'vitest';
import { approvalFailureCode, approvalFailureHint } from './approval-failure';

describe('approvalFailureCode', () => {
  it('detects direct codes in known fields with precedence', () => {
    expect(approvalFailureCode({ code: 'APPROVAL_EXPIRED' })).toBe('APPROVAL_EXPIRED');
    expect(approvalFailureCode({ code: 'APPROVAL_EXPIRED', errorCode: 'APPROVAL_DENIED' })).toBe('APPROVAL_EXPIRED');
    expect(approvalFailureCode({ stepErrorCode: 'APPROVAL_DENIED' })).toBe('APPROVAL_DENIED');
    expect(approvalFailureCode({ reasonCode: 'APPROVAL_DENIED' })).toBe('APPROVAL_DENIED');
    expect(approvalFailureCode({ failureCodes: ['OTHER', 'APPROVAL_EXPIRED'] })).toBe('APPROVAL_EXPIRED');
  });

  it('reads the historical PLAN_STEP_FAILED shape from failed checks only', () => {
    expect(approvalFailureCode({
      code: 'PLAN_STEP_FAILED',
      checks: [
        { status: 'PASS', errorCode: 'APPROVAL_DENIED' },
        { status: 'FAIL', errorCode: 'APPROVAL_EXPIRED' }
      ]
    })).toBe('APPROVAL_EXPIRED');
    expect(approvalFailureCode({
      checks: [{ status: 'FAIL', message: 'step wait ended with APPROVAL_DENIED outcome' }]
    })).toBe('APPROVAL_DENIED');
    expect(approvalFailureCode({ checks: [{ status: 'PASS', errorCode: 'APPROVAL_DENIED' }] })).toBeUndefined();
  });

  it('ignores unknown codes, free text, and missing checks', () => {
    expect(approvalFailureCode(undefined)).toBeUndefined();
    expect(approvalFailureCode({})).toBeUndefined();
    expect(approvalFailureCode({ code: 'EXECUTOR_SPAWN_FAILED' })).toBeUndefined();
    expect(approvalFailureCode({ responseText: 'the request hit APPROVAL_EXPIRED earlier' })).toBeUndefined();
    expect(approvalFailureCode({ summary: 'APPROVAL_DENIED maybe' })).toBeUndefined();
    expect(approvalFailureCode({ checks: 'not-an-array' })).toBeUndefined();
  });

  it('yields to an explicit uncertain marker instead of misleading hints', () => {
    expect(approvalFailureCode({ code: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', errorCode: 'APPROVAL_EXPIRED' })).toBeUndefined();
    expect(approvalFailureCode({ failureCodes: ['SIDE_EFFECT_OUTCOME_UNCERTAIN', 'APPROVAL_DENIED'] })).toBeUndefined();
    expect(approvalFailureCode({ stepErrorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', checks: [{ status: 'FAIL', errorCode: 'APPROVAL_EXPIRED' }] })).toBeUndefined();
  });
});

describe('approvalFailureHint', () => {
  it('returns the authored hint per code and nothing otherwise', () => {
    expect(approvalFailureHint({ code: 'APPROVAL_EXPIRED' })).toBe('本次审批已过期，该项操作未获授权。自动重试已停止；请先核对工作区当前状态，再手动继续或重试并重新审批。');
    expect(approvalFailureHint({ code: 'APPROVAL_DENIED' })).toBe('本次审批已被拒绝，该项操作未执行。自动重试已停止；如仍需执行，请由用户重新发起并审批。');
    expect(approvalFailureHint({ code: 'OTHER' })).toBeUndefined();
  });
});
