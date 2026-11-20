import { describe, expect, it } from 'vitest';
import { describeExecutionRecord, type ExecutionRecordLike } from './execution-record-copy';

const intent = (patch: Partial<ExecutionRecordLike>): ExecutionRecordLike => ({
  recordId: 'intent-1',
  recordType: 'intent',
  state: 'COMPLETED',
  capability: 'shell.execute',
  requestSummary: { command: 'node', argCount: 2, cwd: '.' },
  transitionHistory: [
    { to: 'APPROVED', metadata: { reason: 'COMPUTER_FULL_ACCESS' } },
    { to: 'COMPLETED', metadata: {} }
  ],
  ...patch
});

describe('execution record copy', () => {
  it('explains a full-access shell from the stored command, directory, and reason', () => {
    const copy = describeExecutionRecord(intent({}));
    expect(copy.action).toContain('node');
    expect(copy.action).toContain('还有 2 个参数未留原文');
    expect(copy.lines.join('\n')).toContain('工作目录是这次任务的项目根目录');
    expect(copy.lines.join('\n')).toContain('为什么同意：完全访问开着');
    expect(copy.lines.join('\n')).toContain('状态是已完成');
    expect(copy.lines.join('\n')).not.toContain('参数原文是');
  });

  it('shows a safe argv preview and the hidden remainder', () => {
    const copy = describeExecutionRecord(intent({
      requestSummary: { command: 'git', argsPreview: ['reset', '--hard'], argCount: 3, cwd: 'desktop' },
      state: 'APPROVED',
      transitionHistory: [{ to: 'APPROVED', metadata: { reason: 'USER_APPROVED' } }]
    }));
    expect(copy.action).toBe('git reset --hard（还有 1 个参数未留原文）');
    expect(copy.lines[0]).toContain('工作目录是 desktop');
    expect(copy.lines[0]).toContain('git reset --hard');
    expect(copy.lines[1]).toContain('你在审批卡上核对后点了同意');
  });

  it('names the file being written and the refusal', () => {
    const copy = describeExecutionRecord(intent({
      capability: 'file.write',
      state: 'REJECTED',
      requestSummary: { path: 'desktop/src/main.ts', contentBytes: 1200 },
      transitionHistory: [{ to: 'REJECTED', metadata: { reason: 'USER_DECLINED' } }]
    }));
    expect(copy.action).toBe('写入 desktop/src/main.ts');
    expect(copy.lines[0]).toContain('desktop/src/main.ts');
    expect(copy.lines[0]).toContain('1200');
    expect(copy.lines[1]).toContain('为什么拒绝：你在审批卡上点了拒绝');
  });

  it('reads the approval context from the linked action request', () => {
    const action = intent({ state: 'REJECTED', transitionHistory: [{ to: 'REJECTED', metadata: { reason: 'USER_DECLINED' } }] });
    const approval: ExecutionRecordLike = {
      recordId: 'approval-1',
      recordType: 'approval',
      intentId: 'intent-1',
      state: 'DECLINED',
      capability: 'shell.execute',
      transitionHistory: [{ to: 'DECLINED', metadata: { reason: 'USER_DECLINED' } }]
    };
    const copy = describeExecutionRecord(approval, [action, approval]);
    expect(copy.lines[0]).toContain('node');
    expect(copy.lines[1]).toContain('为什么拒绝');
  });

  it('explains an unmarked cancel pair as ending before a decision', () => {
    const action = intent({ state: 'REJECTED', transitionHistory: [{ to: 'REJECTED', metadata: {} }] });
    const approval: ExecutionRecordLike = {
      recordId: 'approval-1',
      recordType: 'approval',
      intentId: 'intent-1',
      state: 'CANCELLED',
      capability: 'shell.execute',
      transitionHistory: [{ to: 'CANCELLED', metadata: {} }]
    };
    const records = [action, approval];
    expect(describeExecutionRecord(action, records).lines.join('\n')).toContain('在你做出决定前结束了');
    expect(describeExecutionRecord(approval, records).lines.join('\n')).toContain('审批被取消');
  });

  it('uses the stored cell-end reason instead of the pair inference', () => {
    const copy = describeExecutionRecord(intent({
      state: 'REJECTED',
      transitionHistory: [{ to: 'REJECTED', metadata: { reason: 'CELL_ENDED_BEFORE_DECISION' } }]
    }));
    expect(copy.lines.join('\n')).toContain('代码 cell 在你做出决定前结束了');
  });

  it('keeps an unknown reason code visible', () => {
    const copy = describeExecutionRecord(intent({
      state: 'REJECTED',
      transitionHistory: [{ to: 'REJECTED', metadata: { reason: 'SOMETHING_NEW' } }]
    }));
    expect(copy.lines.join('\n')).toContain('SOMETHING_NEW');
  });

  it('explains an uncertain outcome as a refusal when the action never finished', () => {
    const copy = describeExecutionRecord(intent({
      state: 'REJECTED',
      transitionHistory: [
        { to: 'APPROVED', metadata: { reason: 'COMPUTER_FULL_ACCESS' } },
        { to: 'REJECTED', metadata: { reason: 'EXECUTION_OUTCOME_UNCERTAIN' } }
      ]
    }));
    const text = copy.lines.join('\n');
    expect(text).toContain('为什么同意：完全访问开着');
    expect(text).toContain('为什么拒绝：操作已经发出，结果无法确认');
  });

  it('says when a rejection has no reason and no paired approval', () => {
    const copy = describeExecutionRecord(intent({
      state: 'REJECTED',
      transitionHistory: [{ to: 'REJECTED', metadata: {} }]
    }), []);
    expect(copy.lines.join('\n')).toContain('没有写下拒绝原因');
  });
});
