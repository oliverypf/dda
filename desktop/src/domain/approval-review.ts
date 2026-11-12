// Reason labels + command-preview text for approval review UI. Pure
// formatting — the preview is JSON argv text, never re-evaluated as shell.

export interface ApprovalReviewLike {
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
  COMMAND_INVALID: '命令语法无法解析，需要人工复核。'
};

export const approvalReasonLabel = (code: string): string => {
  if (typeof code === 'string' && code.startsWith('DANGEROUS_GIT_')) return '命令可能破坏或发布仓库历史及数据。';
  return REASON_LABELS[code] ?? '本次操作需要额外安全核对。';
};

export const approvalReasonLabels = (codes: string[] | undefined): string[] =>
  (Array.isArray(codes) ? codes.filter((c) => typeof c === 'string' && c.trim()) : []).map(approvalReasonLabel);

export const approvalMissingReviewText = '此请求未提供具体审批原因和完整参数；不能仅凭程序名或工作目录判断风险。';
export const approvalTruncatedText = '命令预览已截断，尚不能完整核对。';

// Returns the preview body for the card/dialog: the JSON argv when present,
// otherwise the explicit "nothing to review" text — never a made-up cause.
export const approvalPreviewText = (a: ApprovalReviewLike): { text: string; truncated: boolean; missing: boolean } => {
  if (typeof a.commandPreview === 'string' && a.commandPreview.trim()) {
    return { text: a.commandPreview, truncated: a.commandPreviewTruncated === true, missing: false };
  }
  return { text: approvalMissingReviewText, truncated: false, missing: true };
};
