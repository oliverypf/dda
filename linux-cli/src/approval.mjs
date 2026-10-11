/**
 * Turn a terminal decision into the runtime approval_response JSONL message.
 * A mismatched digest never becomes an approval; it becomes an explicit denial
 * that still echoes the digest the runtime is waiting on.
 */
export function approvalResponse({ request, mode, tty = false, input }) {
  const requestId = request?.payload?.requestId ?? request?.requestId;
  const requestDigest = request?.payload?.requestDigest ?? request?.requestDigest;
  if (typeof requestId !== 'string' || typeof requestDigest !== 'string') {
    return { approved: false, reason: 'APPROVAL_UNAVAILABLE' };
  }
  if (mode === 'deny') {
    return {
      approved: false,
      reason: 'APPROVAL_DENIED',
      message: { type: 'approval_response', requestId, approved: false, displayedDigest: requestDigest }
    };
  }
  if (mode === 'prompt' && !tty) return { approved: false, reason: 'APPROVAL_UNAVAILABLE' };
  if (mode !== 'prompt' && mode !== 'jsonl') return { approved: false, reason: 'APPROVAL_UNAVAILABLE' };
  let parsed = input;
  if (typeof input === 'string') {
    if (mode === 'prompt') {
      const answer = input.trim().toLowerCase();
      parsed = { type: 'approval_response', requestId, approved: answer === 'y' || answer === 'yes', displayedDigest: requestDigest };
    } else {
      try { parsed = JSON.parse(input); } catch { return { approved: false, reason: 'APPROVAL_DENIED' }; }
    }
  }
  if (!parsed || parsed.type !== 'approval_response' || parsed.requestId !== requestId || typeof parsed.displayedDigest !== 'string') {
    return { approved: false, reason: 'APPROVAL_DENIED' };
  }
  if (parsed.displayedDigest !== requestDigest || parsed.approved !== true) {
    return {
      approved: false,
      reason: 'APPROVAL_DENIED',
      message: { type: 'approval_response', requestId, approved: false, displayedDigest: requestDigest }
    };
  }
  return {
    approved: true,
    reason: 'APPROVAL_GRANTED',
    message: { type: 'approval_response', requestId, approved: true, displayedDigest: requestDigest }
  };
}

export function describeApproval(event) {
  const payload = event?.payload ?? {};
  const lines = [
    '需要审批',
    `requestId=${payload.requestId ?? ''}`,
    `digest=${payload.requestDigest ?? ''}`
  ];
  if (payload.risk) lines.push(`风险 ${payload.risk}`);
  if (payload.command) lines.push(`命令 ${payload.command}`);
  if (payload.path) lines.push(`路径 ${payload.path}`);
  if (payload.expiresAtMs) lines.push(`过期 ${payload.expiresAtMs}`);
  lines.push('批准请输入 y，其他输入都会拒绝');
  return lines.join('\n');
}
