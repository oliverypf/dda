// Surface a deterministic human hint when a failure carries a terminal
// approval outcome. Approval expiry/denial means the action was NOT executed
// and automation stopped — it must never be misread as an uncertain side
// effect (which takes precedence) or scanned out of free-form model text.

export type ApprovalFailureCode = 'APPROVAL_EXPIRED' | 'APPROVAL_DENIED';

const CODE_FIELDS = ['code', 'errorCode', 'stepErrorCode', 'reasonCode'] as const;
const UNCERTAIN_CODE = 'SIDE_EFFECT_OUTCOME_UNCERTAIN';
const APPROVAL_TOKEN = /\b(APPROVAL_EXPIRED|APPROVAL_DENIED)\b/;

const asApprovalCode = (value: unknown): ApprovalFailureCode | undefined =>
  value === 'APPROVAL_EXPIRED' || value === 'APPROVAL_DENIED' ? value : undefined;

const payloadObject = (payload: Record<string, unknown> | undefined | null): Record<string, unknown> =>
  payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};

export const approvalFailureCode = (
  payload: Record<string, unknown> | undefined | null
): ApprovalFailureCode | undefined => {
  const source = payloadObject(payload);
  // An explicit uncertain marker anywhere in the known code fields wins:
  // claiming 'not executed / stopped' would be dishonest about side effects.
  const hasUncertain = CODE_FIELDS.some((field) => source[field] === UNCERTAIN_CODE)
    || (Array.isArray(source.failureCodes) && source.failureCodes.includes(UNCERTAIN_CODE));
  if (hasUncertain) return undefined;
  for (const field of CODE_FIELDS) {
    const hit = asApprovalCode(source[field]);
    if (hit) return hit;
  }
  if (Array.isArray(source.failureCodes)) {
    for (const value of source.failureCodes) {
      const hit = asApprovalCode(value);
      if (hit) return hit;
    }
  }
  // Historical plan-step failures carry the real cause inside failed checks.
  if (Array.isArray(source.checks)) {
    for (const check of source.checks) {
      if (!check || typeof check !== 'object' || Array.isArray(check)) continue;
      const item = check as Record<string, unknown>;
      if (item.status !== 'FAIL') continue;
      const direct = asApprovalCode(item.errorCode) ?? asApprovalCode(item.code);
      if (direct) return direct;
      if (typeof item.message === 'string') {
        const token = item.message.match(APPROVAL_TOKEN)?.[1];
        const hit = asApprovalCode(token);
        if (hit) return hit;
      }
    }
  }
  return undefined;
};

export const approvalFailureHint = (
  payload: Record<string, unknown> | undefined | null
): string | undefined => {
  const code = approvalFailureCode(payload);
  if (code === 'APPROVAL_EXPIRED') {
    return '本次审批已过期，该项操作未获授权。自动重试已停止；请先核对工作区当前状态，再手动继续或重试并重新审批。';
  }
  if (code === 'APPROVAL_DENIED') {
    return '本次审批已被拒绝，该项操作未执行。自动重试已停止；如仍需执行，请由用户重新发起并审批。';
  }
  return undefined;
};
