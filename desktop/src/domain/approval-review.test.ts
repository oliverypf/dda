import { describe, expect, it } from 'vitest';
import { approvalReasonLabel, approvalReasonLabels, approvalPreviewText, approvalMissingReviewText } from './approval-review';

describe('approval review formatting', () => {
  it('maps reason codes to human labels', () => {
    expect(approvalReasonLabel('DANGEROUS_INLINE_INTERPRETER')).toContain('内联或编码脚本');
    expect(approvalReasonLabel('DANGEROUS_RECURSIVE_DELETE')).toContain('批量数据丢失');
    expect(approvalReasonLabel('DANGEROUS_DELETE_TARGET')).toContain('工作区外');
    expect(approvalReasonLabel('DANGEROUS_GIT_RESET')).toContain('仓库历史');
    expect(approvalReasonLabel('MANDATORY_SAFETY_REVIEW')).toContain('完全访问不能覆盖');
    expect(approvalReasonLabel('SAFETY_ASSESSMENT_UNAVAILABLE')).toContain('无法完成本次风险核对');
    expect(approvalReasonLabel('SOMETHING_NEW')).toBe('本次操作需要额外安全核对。');
  });

  it('returns JSON preview when present, truncated flag preserved', () => {
    const preview = JSON.stringify({ command: 'node', args: ['a.js'], cwd: '.' }, null, 2);
    const r = approvalPreviewText({ commandPreview: preview, commandPreviewTruncated: true });
    expect(r.missing).toBe(false);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(preview);
  });

  it('missing preview gives the explicit fallback, never a made-up cause', () => {
    const r = approvalPreviewText({ command: 'rm' });
    expect(r.missing).toBe(true);
    expect(r.text).toBe(approvalMissingReviewText);
  });

  it('reason labels pass through a bounded list', () => {
    expect(approvalReasonLabels(['DANGEROUS_INLINE_INTERPRETER', 'DANGEROUS_DELETE_TARGET'])).toHaveLength(2);
    expect(approvalReasonLabels(undefined)).toHaveLength(0);
  });
});
