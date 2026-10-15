import { describe, expect, it } from 'vitest';
import mainSource from '../main.ts?raw';
import { VERIFICATION_FAILURE_REASON, isConversationTimelineItem } from './timeline-visibility';

describe('conversation timeline visibility (live and history share one filter)', () => {
  it('hides lifecycle/audit STATUS rows (任务已创建, 任务进度, 角色上下文, verification summaries)', () => {
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'COMPLETE' })).toBe(false);
    expect(isConversationTimelineItem({ kind: 'WORKSPACE', status: 'COMPLETE' })).toBe(false);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'COMPLETE', evidenceKind: 'rule-verification-summary' })).toBe(false);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'PENDING', evidenceKind: 'rule-verification-check' })).toBe(false);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'COMPLETE', evidenceKind: 'rule-verification-check' })).toBe(false);
  });
  it('keeps conversation, errors, tool steps', () => {
    expect(isConversationTimelineItem({ kind: 'AGENT', status: 'COMPLETE' })).toBe(true);
    expect(isConversationTimelineItem({ kind: 'ERROR', status: 'ERROR' })).toBe(true);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'COMPLETE', toolName: 'read_file' })).toBe(true);
  });
  it('a failed run always shows a reason line', () => {
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'ERROR', evidenceKind: VERIFICATION_FAILURE_REASON })).toBe(true);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'PENDING', evidenceKind: VERIFICATION_FAILURE_REASON })).toBe(true);
    expect(isConversationTimelineItem({ kind: 'STATUS', status: 'ERROR', evidenceKind: 'rule-verification-check' })).toBe(true);
    // the 未达到验收条件 item is tagged with the reason evidenceKind
    expect(mainSource).toMatch(/title: '未达到验收条件',\s*evidenceKind: VERIFICATION_FAILURE_REASON/);
  });
  it('history and live both use the filter', () => {
    expect(mainSource).toContain('timelineItems.filter(isConversationTimelineItem)');
    expect(mainSource).toContain('lists.human.update(all.filter(isConversationTimelineItem))');
  });
});

describe('audit panels removed from the UI', () => {
  it('no 完成报告 / 确定性验收检查 sections or 查看完成报告 entry', () => {
    for (const gone of ['<h2>完成报告</h2>', '确定性验收检查', 'data-task-verification', 'data-history-verification',
      'data-live-region="verification"', "'view-verification'", '查看完成报告']) {
      expect(mainSource).not.toContain(gone);
    }
  });
  it('keeps export and underlying verification data', () => {
    expect(mainSource).toContain("'export-task-result'");
    expect(mainSource).toContain('appendVerificationChecks');
    expect(mainSource).toContain("evidenceKind: 'rule-verification-summary'");
  });
});
