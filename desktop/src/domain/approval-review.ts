// Reason labels + command-preview text for approval review UI. Pure
// formatting — the preview is JSON argv text, never re-evaluated as shell.

export interface ApprovalReviewLike {
  capability?: string;
  reviewKind?: 'DANGER' | 'REVIEW' | 'UNKNOWN';
  filePreview?: string;
  filePreviewKind?: 'DIFF' | 'CONTENT';
  filePreviewTruncated?: boolean;
  contentBytes?: number;
  codePreview?: string;
  reasonCodes?: string[];
  commandPreview?: string;
  commandPreviewTruncated?: boolean;
  command?: string;
  cwd?: string;
  path?: string;
  host?: string;
}

const REASON_LABELS: Record<string, string> = {
  DANGEROUS_INLINE_INTERPRETER: '命令包含内联或编码脚本，无法仅凭工作目录确认其作用范围。',
  DANGEROUS_RECURSIVE_DELETE: '递归或强制删除可能造成批量数据丢失。',
  DANGEROUS_DELETE_TARGET: '删除目标位于工作区外、工作区根目录，或无法明确解析。',
  DANGEROUS_PRIVILEGE_ESCALATION: '命令尝试提升权限。',
  EXTREME_DISK_OPERATION: '命令可能格式化磁盘或破坏卷数据。',
  DANGEROUS_PIPE_TO_SHELL: '命令下载内容后交给解释器执行。',
  DANGEROUS_SECRET_FILE_PATH: '目标涉及敏感文件。',
  DANGEROUS_WRITE_OUTSIDE_WORKSPACE: '未启用完全访问，目标超出工作区。',
  SAFETY_ASSESSMENT_UNAVAILABLE: '无法完成本次风险核对，需要人工复核。',
  MANDATORY_SAFETY_REVIEW: '安全策略要求本次单独确认，完全访问不能覆盖此限制。',
  SAFETY_PROFILE_REQUIRE_APPROVAL: '执行器的安全评估要求人工复核。',
  SAFETY_BELOW_THRESHOLD: '历史安全评分低于自动放行阈值。',
  FAILURE_OBSERVED: '安全评估记录过执行失败；这不等于本次操作已被发现有危险。',
  SAFETY_STATE_REQUIRE_APPROVAL: '当前安全状态要求人工确认。',
  VERIFIER_UNCERTAIN: '上一步的执行结果尚未核实，后续修改需要确认。',
  VERIFIER_STALLED: '上一步未取得可验证的进展，后续修改需要确认。',
  KERNEL_EFFECT_REVIEW_REQUIRED: '宿主要求核对这次操作的作用范围。',
  HOST_SAFETY_REVIEW_REQUIRED: '本次操作需要人工复核。',
  JEV_ACTION_GATE_REQUIRE_APPROVAL: '本次操作的安全评估要求人工确认。',
  DANGEROUS_RECURSIVE_REMOVE: '递归或强制删除可能造成批量数据丢失。',
  COMMAND_OUTSIDE_SESSION_LEASE: 'Jev 没有放行这个会话名单外的命令，需要你授权后才会执行这一次。',
  COMMAND_INVALID: '命令语法无法解析，需要人工复核。'
};

export const COMMAND_OUTSIDE_SESSION_LEASE = 'COMMAND_OUTSIDE_SESSION_LEASE';

export const presentsCommandAuthorization = (codes: string[] | undefined): boolean =>
  Array.isArray(codes) && codes.includes(COMMAND_OUTSIDE_SESSION_LEASE);

export const approvalReasonLabel = (code: string): string => {
  if (typeof code === 'string' && code.startsWith('SAFETY_PROFILE:')) return `关联安全评估记录：${code.slice('SAFETY_PROFILE:'.length)}`;
  if (typeof code === 'string' && code.startsWith('DANGEROUS_GIT_')) return '命令可能破坏或发布仓库历史及数据。';
  return REASON_LABELS[code] ?? '本次操作需要额外安全核对。';
};

export const approvalReasonLabels = (codes: string[] | undefined): string[] =>
  [...new Set((Array.isArray(codes) ? codes.filter((c) => typeof c === 'string' && c.trim()) : []).map(approvalReasonLabel))];

export const approvalMissingReviewText = '此请求未提供具体审批原因和完整参数；不能仅凭程序名或工作目录判断风险。';
export const approvalTruncatedText = '命令预览已截断，尚不能完整核对。';

const isFileReview = (a: ApprovalReviewLike): boolean =>
  a.capability === 'file.write' || a.capability === 'file.patch' || Boolean(a.path);

const isCommandReview = (a: ApprovalReviewLike): boolean =>
  a.capability === 'shell.execute' || a.capability === 'test.execute' || Boolean(a.command || a.commandPreview);

export const approvalReviewBlock = (a: ApprovalReviewLike): string => {
  const truncated = '预览已截断，无法批准。请拒绝并让任务缩小本次操作的范围。';
  if (isFileReview(a)) {
    if (!a.path?.trim() || typeof a.filePreview !== 'string') return '缺少文件路径或修改内容，无法批准。请拒绝并让任务重新提交可核对的文件修改。';
    if (a.filePreviewTruncated === true) return truncated;
  } else if (isCommandReview(a)) {
    if (!a.commandPreview?.trim()) return '缺少完整的命令和参数，无法批准。请拒绝并让任务重新提交命令。';
    if (a.commandPreviewTruncated === true) return truncated;
  }
  return '';
};

export const approvalHasDetectedRisk = (a: ApprovalReviewLike): boolean =>
  a.reviewKind === 'DANGER' || (a.reasonCodes ?? []).some((code) => /^(DANGEROUS_|EXTREME_)/.test(code));

export const approvalReviewTitle = (a: ApprovalReviewLike): string =>
  approvalHasDetectedRisk(a) ? '确认本次风险操作' : '确认本次操作';

export const approvalRiskLabel = (a: ApprovalReviewLike): string =>
  approvalHasDetectedRisk(a) ? '检测到风险' : '需要人工复核';

export const approvalPreviewTitle = (a: ApprovalReviewLike): string =>
  isFileReview(a) ? '文件与修改内容' : isCommandReview(a) ? '命令和参数' : '操作详情';

export const approvalPreviewTruncation = (a: ApprovalReviewLike): string =>
  isFileReview(a) ? '修改内容预览已截断，尚不能完整核对。' : approvalTruncatedText;

// Returns the preview body for the card/dialog: the JSON argv when present,
// otherwise the explicit "nothing to review" text — never a made-up cause.
export const approvalPreviewText = (a: ApprovalReviewLike): { text: string; truncated: boolean; missing: boolean } => {
  if (isFileReview(a)) {
    const target = `写入文件：${a.path || '未提供路径'}`;
    const size = typeof a.contentBytes === 'number' ? `\n写入后大小：${a.contentBytes} 字节` : '';
    if (typeof a.filePreview === 'string') {
      const label = a.filePreviewKind === 'DIFF' ? '修改差异（- 删除，+ 新增）' : '拟写入内容（未提供原文对比）';
      return { text: `${target}${size}\n${label}\n${a.filePreview || (a.filePreviewKind === 'DIFF' ? '内容无变化' : '（空文件）')}`,
        truncated: a.filePreviewTruncated === true, missing: false };
    }
    return { text: `${target}${size}\n未提供修改内容，无法核对具体变更。`, truncated: false, missing: true };
  }
  if (typeof a.commandPreview === 'string' && a.commandPreview.trim()) {
    return { text: a.commandPreview, truncated: a.commandPreviewTruncated === true, missing: false };
  }
  if (isCommandReview(a)) {
    const summary = [a.command && `命令摘要：${a.command}`, a.cwd && `工作目录：${a.cwd}`].filter(Boolean);
    return { text: [...summary, '未提供完整命令和参数。'].join('\n'), truncated: false, missing: true };
  }
  if (a.codePreview) return { text: a.codePreview, truncated: false, missing: false };
  if (a.host) return { text: `网络目标：${a.host}\n未提供完整请求详情。`, truncated: false, missing: true };
  return { text: approvalMissingReviewText, truncated: false, missing: true };
};
