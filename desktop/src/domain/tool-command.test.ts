import { describe, expect, it } from 'vitest';
import { commandLineForToolEvent, exitCodeLabelForToolEvent, outputTailForToolEvent, pathBadgeText, pathForToolEvent, WORKSPACE_REASON_LABELS } from './tool-command';

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
