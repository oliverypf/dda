import { describe, expect, it } from 'vitest';
import type { TimelineItem } from './models';
import {
  commandLineForToolEvent,
  exitCodeLabelForToolEvent,
  groupConversationTimelineEntries,
  outputTailForToolEvent,
  pathBadgeText,
  pathForToolEvent,
  sameTimelineRenderEntry,
  toolStepOutputMeta,
  toolStepTargetBadge,
  WORKSPACE_REASON_LABELS
} from './tool-command';

describe('commandLineForToolEvent', () => {
  it('joins command and args for shell.execute and test.execute', () => {
    expect(commandLineForToolEvent('shell.execute', { command: 'npm', args: ['run', 'build'] }))
      .toEqual({ commandLine: 'npm run build', display: 'npm run build' });
    expect(commandLineForToolEvent('test.execute', { command: 'npx', args: ['vitest', '--run'], cwd: 'C:/app' }).commandLine)
      .toBe('npx vitest --run');
  });

  it('keeps the full commandLine while truncating display at the limit', () => {
    const command = `node ${'x'.repeat(300)}`;
    const { commandLine, display } = commandLineForToolEvent('shell.execute', { command });
    expect(commandLine).toBe(command);
    expect(display.length).toBe(201);
    expect(display.endsWith('…')).toBe(true);
  });

  it('returns empty for other tools and missing command', () => {
    expect(commandLineForToolEvent('workspace.read', { command: 'rm', args: [] })).toEqual({ commandLine: '', display: '' });
    expect(commandLineForToolEvent('shell.execute', { args: ['x'] })).toEqual({ commandLine: '', display: '' });
    expect(commandLineForToolEvent('shell.execute', {})).toEqual({ commandLine: '', display: '' });
  });
});

describe('outputTailForToolEvent', () => {
  it('returns bounded outputTail or empty', () => {
    expect(outputTailForToolEvent({ outputTail: 'error tail' })).toBe('error tail');
    expect(outputTailForToolEvent({ outputTail: 'x'.repeat(1000) }).length).toBe(800);
    expect(outputTailForToolEvent({})).toBe('');
    expect(outputTailForToolEvent({ outputTail: 42 })).toBe('');
  });
});

describe('exitCodeLabelForToolEvent', () => {
  it('prints an integer exit code and a missing code', () => {
    expect(exitCodeLabelForToolEvent({ exitCode: 1 })).toBe('退出码 1');
    expect(exitCodeLabelForToolEvent({ exitCode: 0 })).toBe('退出码 0');
    expect(exitCodeLabelForToolEvent({ exitCode: null })).toBe('退出码未知');
    expect(exitCodeLabelForToolEvent({})).toBe('');
    expect(exitCodeLabelForToolEvent({ exitCode: 1.5 })).toBe('');
    expect(exitCodeLabelForToolEvent({ exitCode: '1' })).toBe('');
  });
});

describe('pathForToolEvent', () => {
  it('returns the bounded structured path or empty', () => {
    expect(pathForToolEvent({ path: 'desktop/src/main.ts' })).toBe('desktop/src/main.ts');
    expect(pathForToolEvent({ path: 'x'.repeat(600) }).length).toBe(512);
    expect(pathForToolEvent({})).toBe('');
    expect(pathForToolEvent({ path: 42 })).toBe('');
  });
});

describe('pathBadgeText', () => {
  it('truncates long paths for the badge chip', () => {
    expect(pathBadgeText('a/b/c.ts')).toBe('a/b/c.ts');
    expect(pathBadgeText('x'.repeat(80)).endsWith('...')).toBe(true);
    expect(pathBadgeText('x'.repeat(80)).length).toBe(63);
  });
});

describe('WORKSPACE_REASON_LABELS', () => {
  it('localizes the path failure codes', () => {
    expect(WORKSPACE_REASON_LABELS.WORKSPACE_NOT_FOUND).toBe('工作区中未找到该路径，请先查看目录并使用实际相对路径。');
    expect(WORKSPACE_REASON_LABELS.WORKSPACE_PATH_FORBIDDEN).toContain('相对路径');
    expect(WORKSPACE_REASON_LABELS.WORKSPACE_INVALID_PATH).toContain('..');
    expect(WORKSPACE_REASON_LABELS.WORKSPACE_EXCLUDED_PATH).toContain('排除');
  });
});

describe('limit/failure reason labels', () => {
  it('localizes SAFETY_COMMAND_INVALID, TEST_CHECK_FAILED and EXECUTOR_RESULT_FAILED', () => {
    expect(WORKSPACE_REASON_LABELS.SAFETY_COMMAND_INVALID).toBe('执行参数超出允许范围，请检查超时或输出大小限制。');
    expect(WORKSPACE_REASON_LABELS.TEST_CHECK_FAILED).toBe('测试未通过，请查看输出中的失败项目。');
    expect(WORKSPACE_REASON_LABELS.EXECUTOR_RESULT_FAILED).toBe('命令未成功完成。');
    expect(WORKSPACE_REASON_LABELS.NETWORK_HTTP_STATUS).toBe('网站返回了失败的 HTTP 状态。');
  });
});

const toolItem = (patch: Partial<TimelineItem> & Pick<TimelineItem, 'itemId' | 'toolName'>): TimelineItem => ({
  kind: 'STATUS',
  title: '工具执行完成',
  body: '已完成：查看工作区目录 · 输出 2,047 字符',
  status: 'COMPLETE',
  createdAtMs: 1_000,
  runId: 'run-1',
  ...patch
});

describe('Codex-style consecutive tool-step grouping', () => {
  it('keeps a single isolated tool step ungrouped with the same stable key', () => {
    const first = toolItem({ itemId: 'tool-1', toolName: 'workspace.list', status: 'STREAMING', body: '正在工作区目录' });
    const entries = groupConversationTimelineEntries([first], { liveTaskActive: true });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ kind: 'item', key: 'tool-1', item: first });
    expect(toolStepTargetBadge(first)).toBe('.');
  });

  it('streams multiple steps open during live execution and keeps the first itemId as group key', () => {
    const s1 = toolItem({ itemId: 'tool-1', toolName: 'workspace.list', status: 'COMPLETE', createdAtMs: 1000 });
    const s2 = toolItem({ itemId: 'tool-2', toolName: 'workspace.read', targetPath: 'README.md', status: 'STREAMING', createdAtMs: 1200 });
    const entries = groupConversationTimelineEntries([s1, s2], { liveTaskActive: true });
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('tool-group');
    if (entries[0].kind !== 'tool-group') throw new Error('expected tool-group');
    expect(entries[0].key).toBe('tool-1');
    expect(entries[0].autoOpen).toBe(true);
    expect(entries[0].status).toBe('STREAMING');
    expect(entries[0].summaryLabel).toBe('正在读取工作区文件 README.md');
    expect(entries[0].stepProgressLabel).toBe('2/2');

    // Between tool rounds (all completed so far, still at live tail before reply starts): stays open without flicker
    const s2Done = { ...s2, status: 'COMPLETE' as const };
    const betweenRounds = groupConversationTimelineEntries([s1, s2Done], { liveTaskActive: true });
    expect(betweenRounds[0].kind === 'tool-group' && betweenRounds[0].autoOpen).toBe(true);
  });

  it('auto-collapses multiple completed tool steps once the assistant reply starts or the run ends', () => {
    const steps: TimelineItem[] = [
      toolItem({ itemId: 't1', toolName: 'workspace.list' }),
      toolItem({ itemId: 't2', toolName: 'workspace.list', targetPath: 'docs' }),
      toolItem({ itemId: 't3', toolName: 'workspace.read', targetPath: 'README.md' }),
      toolItem({ itemId: 't4', toolName: 'workspace.read', targetPath: 'oh-package.json5' }),
      toolItem({ itemId: 't5', toolName: 'workspace.list', targetPath: 'desktop' }),
      toolItem({ itemId: 't6', toolName: 'workspace.list', targetPath: 'packages' }),
      toolItem({ itemId: 't7', toolName: 'workspace.read', targetPath: 'desktop/README.md', createdAtMs: 5000 })
    ];
    const reply: TimelineItem = {
      itemId: 'agent-1',
      runId: 'run-1',
      kind: 'AGENT',
      title: 'dda',
      body: '项目结构如下…',
      status: 'STREAMING',
      createdAtMs: 5100
    };
    const duringReply = groupConversationTimelineEntries([...steps, reply], { liveTaskActive: true });
    expect(duringReply).toHaveLength(2);
    expect(duringReply[0].kind).toBe('tool-group');
    if (duringReply[0].kind !== 'tool-group') throw new Error('expected tool-group');
    expect(duringReply[0].autoOpen).toBe(false);
    expect(duringReply[0].status).toBe('COMPLETE');
    expect(duringReply[0].summaryLabel).toBe('已完成 7 项操作 · 查看工作区目录 ×4、读取工作区文件 ×3');
    expect(duringReply[0].latestAtMs).toBe(5000);

    const endedRun = groupConversationTimelineEntries(steps, { liveTaskActive: false });
    expect(endedRun[0].kind === 'tool-group' && endedRun[0].autoOpen).toBe(false);
  });

  it('surfaces awaiting-approval and error counts without merging across different runIds or kernel.exec', () => {
    const s1 = toolItem({ itemId: 't1', toolName: 'workspace.read', targetPath: 'package.json', runId: 'run-a' });
    const s2 = toolItem({ itemId: 't2', toolName: 'shell.execute', commandText: 'npm test', status: 'PENDING', awaitingApproval: true, runId: 'run-a' });
    const cell = toolItem({ itemId: 'cell-1', toolName: 'kernel.exec', runId: 'run-a' });
    const nextRun1 = toolItem({ itemId: 't3', toolName: 'shell.execute', commandText: 'npm run lint', status: 'ERROR', kind: 'ERROR', runId: 'run-b' });
    const nextRun2 = toolItem({ itemId: 't4', toolName: 'workspace.read', targetPath: 'tsconfig.json', runId: 'run-b' });
    const entries = groupConversationTimelineEntries([s1, s2, cell, nextRun1, nextRun2], { liveTaskActive: false });
    expect(entries.map((e) => `${e.kind}:${e.key}`)).toEqual(['tool-group:t1', 'item:cell-1', 'tool-group:t3']);
    if (entries[0].kind === 'tool-group') {
      expect(entries[0].awaitingApproval).toBe(true);
      expect(entries[0].autoOpen).toBe(true);
      expect(entries[0].status).toBe('PENDING');
      expect(entries[0].summaryLabel).toBe('等待批准 · 执行命令 npm test');
    }
    if (entries[2].kind === 'tool-group') {
      expect(entries[2].failedCount).toBe(1);
      expect(entries[2].status).toBe('ERROR');
      expect(entries[2].summaryLabel).toContain('1 项失败');
    }
    expect(sameTimelineRenderEntry(entries[0], entries[0])).toBe(true);
    expect(sameTimelineRenderEntry(entries[0], entries[2])).toBe(false);
    expect(toolStepOutputMeta(s1)).toBe('2,047 字符');
  });
});
