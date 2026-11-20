import { describe, expect, it } from 'vitest';
import { approvalReasonLabel, approvalReasonLabels, approvalPreviewText, approvalMissingReviewText, presentsCommandAuthorization, approvalReviewTitle, approvalRiskLabel, approvalPreviewTitle, approvalPreviewTruncation, approvalReviewBlock } from './approval-review';

describe('approval review formatting', () => {
  it('maps reason codes to human labels', () => {
    expect(approvalReasonLabel('DANGEROUS_INLINE_INTERPRETER')).toContain('内联或编码脚本');
    expect(approvalReasonLabel('DANGEROUS_RECURSIVE_DELETE')).toContain('批量数据丢失');
    expect(approvalReasonLabel('DANGEROUS_DELETE_TARGET')).toContain('工作区外');
    expect(approvalReasonLabel('DANGEROUS_GIT_RESET')).toContain('仓库历史');
    expect(approvalReasonLabel('MANDATORY_SAFETY_REVIEW')).toContain('完全访问不能覆盖');
    expect(approvalReasonLabel('SAFETY_ASSESSMENT_UNAVAILABLE')).toContain('无法完成本次风险核对');
    expect(approvalReasonLabel('COMMAND_OUTSIDE_SESSION_LEASE')).toContain('授权');
    expect(approvalReasonLabel('SOMETHING_NEW')).toBe('本次操作需要额外安全核对。');
    expect(presentsCommandAuthorization(['COMMAND_OUTSIDE_SESSION_LEASE'])).toBe(true);
    expect(presentsCommandAuthorization(['MANDATORY_SAFETY_REVIEW'])).toBe(false);
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
    expect(r.text).toContain('命令摘要：rm');
    expect(r.text).toContain('未提供完整命令和参数');
    expect(approvalPreviewText({}).text).toBe(approvalMissingReviewText);
  });

  it('reason labels pass through a bounded list', () => {
    expect(approvalReasonLabels(['DANGEROUS_INLINE_INTERPRETER', 'DANGEROUS_DELETE_TARGET'])).toHaveLength(2);
    expect(approvalReasonLabels(undefined)).toHaveLength(0);
  });

  it('deduplicates identical rendered reasons while preserving their order', () => {
    expect(approvalReasonLabels(['NEW_CODE', 'DANGEROUS_DELETE_TARGET', 'OTHER_CODE', 'DANGEROUS_DELETE_TARGET'])).toEqual([
      approvalReasonLabel('NEW_CODE'), approvalReasonLabel('DANGEROUS_DELETE_TARGET')
    ]);
  });

  it('requires the target and a complete host preview for file changes and commands', () => {
    expect(approvalReviewBlock({ capability: 'file.write' })).toContain('缺少文件路径');
    expect(approvalReviewBlock({ capability: 'file.write', filePreview: '+change' })).toContain('缺少文件路径');
    expect(approvalReviewBlock({ capability: 'file.patch', path: 'notes.md' })).toContain('修改内容');
    expect(approvalReviewBlock({ capability: 'file.write', path: 'empty.txt', filePreview: '' })).toBe('');
    expect(approvalReviewBlock({ capability: 'file.write', path: 'notes.md', filePreview: '+partial', filePreviewTruncated: true })).toContain('预览已截断');
    expect(approvalReviewBlock({ capability: 'shell.execute', command: 'node', codePreview: 'node -e ...' })).toContain('缺少完整的命令和参数');
    expect(approvalReviewBlock({ capability: 'test.execute', commandPreview: '{', commandPreviewTruncated: true })).toContain('预览已截断');
    expect(approvalReviewBlock({ capability: 'shell.execute', commandPreview: '{"command":"node","args":["--version"],"cwd":"."}' })).toBe('');
  });

  it('shows the file target and actual diff in cards and confirmations', () => {
    const review = { capability: 'file.write', path: 'desktop/BUILD-EXE-RECORD.md', reviewKind: 'REVIEW' as const,
      filePreviewKind: 'DIFF' as const, filePreview: '--- a/build\n+++ b/build\n-old\n+new', contentBytes: 4,
      reasonCodes: ['SAFETY_PROFILE_REQUIRE_APPROVAL', 'SAFETY_BELOW_THRESHOLD', 'FAILURE_OBSERVED'] };
    expect(approvalPreviewText(review)).toMatchObject({ missing: false, truncated: false });
    expect(approvalPreviewText(review).text).toContain(review.path);
    expect(approvalPreviewText(review).text).toContain('-old\n+new');
    expect(approvalPreviewTitle(review)).toBe('文件与修改内容');
    expect(approvalReviewTitle(review)).toBe('确认本次操作');
    expect(approvalRiskLabel(review)).toBe('需要人工复核');
    expect(approvalReasonLabels(review.reasonCodes).join('\n')).toContain('历史安全评分');
    expect(approvalReasonLabel('SAFETY_PROFILE:profile-123')).toContain('profile-123');
  });

  it('legacy mandatory-review events never invent a dangerous command', () => {
    const review = { path: 'notes.md', reasonCodes: ['MANDATORY_SAFETY_REVIEW'] };
    expect(approvalReviewTitle(review)).toBe('确认本次操作');
    expect(approvalPreviewText(review).text).toContain('notes.md');
    expect(approvalPreviewText(review).text).toContain('未提供修改内容');
    expect(approvalPreviewText(review).text).not.toContain('程序名');
    expect(approvalPreviewText(review).missing).toBe(true);
  });

  it('preserves concrete danger warnings, including older events without reviewKind', () => {
    expect(approvalRiskLabel({ reasonCodes: ['EXTREME_DISK_OPERATION'] })).toBe('检测到风险');
    expect(approvalReviewTitle({ reasonCodes: ['DANGEROUS_RECURSIVE_DELETE'] })).toBe('确认本次风险操作');
    expect(approvalReviewTitle({ reviewKind: 'UNKNOWN' })).toBe('确认本次操作');
  });

  it('distinguishes truncated changes, empty content, and unavailable original text', () => {
    const review = { capability: 'file.write', path: 'empty.txt', filePreview: '', filePreviewKind: 'CONTENT' as const };
    expect(approvalPreviewText(review)).toMatchObject({ missing: false, truncated: false });
    expect(approvalPreviewText(review).text).toContain('空文件');
    expect(approvalPreviewText(review).text).toContain('未提供原文对比');
    expect(approvalPreviewText({ ...review, filePreview: '+partial', filePreviewTruncated: true }).truncated).toBe(true);
    expect(approvalPreviewTruncation(review)).toContain('修改内容预览已截断');
  });
});
