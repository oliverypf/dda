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

describe('timeline technical details hidden from the UI', () => {
  it('no 技术详情 collapsible under timeline items', () => {
    for (const gone of ['技术详情', 'timeline-technical-details', 'timelineTechnicalDetails', 'timeline-details']) {
      expect(mainSource).not.toContain(gone);
    }
  });
  it('keeps eventId / sequence / digest on timeline items for export and audit', () => {
    expect(mainSource).toContain('eventId: event.eventId');
    expect(mainSource).toContain('eventSequence: event.sequence');
    expect(mainSource).toMatch(/digest:\s*typeof payload\.digest/);
  });
  it('empty filtered history shows a placeholder line', () => {
    expect(mainSource).toContain('此会话没有对话内容');
    expect(mainSource).toContain('data-history-empty');
  });
  it('export copy mentions 审计记录 instead of 完成报告', () => {
    expect(mainSource).toContain('回答和审计记录');
    expect(mainSource).not.toContain('回答和完成报告');
  });
  it('history incremental sync also filters conversation items', () => {
    expect(mainSource).toContain('pageModel.timeline.filter(isConversationTimelineItem)');
    expect(mainSource).toContain('mergedTimeline.filter(isConversationTimelineItem)');
  });
});
