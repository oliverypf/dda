const PROCESS_COMMAND_TOOLS = new Set(['shell.execute', 'test.execute']);

/**
 * Display command line for process tools, e.g. `npm run build -- --watch`.
 * `commandLine` keeps the full bounded text for tooltips/details;
 * `display` is truncated for inline timeline copy.
 */
export const commandLineForToolEvent = (
  name: string,
  payload: Record<string, unknown>,
  displayLimit = 200
): { commandLine: string; display: string } => {
  if (!PROCESS_COMMAND_TOOLS.has(name)) return { commandLine: '', display: '' };
  const command = typeof payload.command === 'string' ? payload.command.trim() : '';
  if (!command) return { commandLine: '', display: '' };
  const args = Array.isArray(payload.args)
    ? payload.args.filter((part): part is string => typeof part === 'string')
    : [];
  const commandLine = [command, ...args].join(' ').trim();
  const display = commandLine.length > displayLimit
    ? `${commandLine.slice(0, displayLimit)}…`
    : commandLine;
  return { commandLine, display };
};

/** Bounded process output tail shown under the failure message. */
export const outputTailForToolEvent = (
  payload: Record<string, unknown>,
  limit = 800
): string => (typeof payload.outputTail === 'string' ? payload.outputTail.slice(0, limit) : '');

/** Exit code carried on a process tool event, or null when the process ended without one. */
export const exitCodeForToolEvent = (payload: Record<string, unknown>): number | null | undefined => {
  if (Number.isInteger(payload.exitCode)) return payload.exitCode as number;
  if (payload.exitCode === null) return null;
  return undefined;
};

/** Chinese exit-code line for a failed process. Empty when the event has no exit code field. */
export const exitCodeLabelForToolEvent = (payload: Record<string, unknown>): string => {
  const code = exitCodeForToolEvent(payload);
  if (code === undefined) return '';
  return code === null ? '退出码未知' : `退出码 ${code}`;
};

/** Structured workspace path from a tool payload (used for the card target badge). */
export const pathForToolEvent = (
  payload: Record<string, unknown>,
  limit = 512
): string => (typeof payload.path === 'string' ? payload.path.slice(0, limit) : '');

/** Truncated badge text for a structured path (middle-truncated like the command chip). */
export const pathBadgeText = (path: string, limit = 60): string =>
  path.length > limit ? `${path.slice(0, limit)}...` : path;

/**
 * Localized reasons for workspace path failures. Kept in the domain so the
 * copy is testable without importing the main entrypoint.
 */
export const WORKSPACE_REASON_LABELS: Record<string, string> = {
  WORKSPACE_NOT_FOUND: '工作区中未找到该路径，请先查看目录并使用实际相对路径。',
  WORKSPACE_PATH_FORBIDDEN: '该路径不在已授权的工作区内，请使用工作区中的相对路径。',
  WORKSPACE_INVALID_PATH: '路径无效，请使用不含 .. 或绝对地址的工作区相对路径。',
  WORKSPACE_EXCLUDED_PATH: '该路径已被工作区配置排除，请选择其他路径。',
  SAFETY_COMMAND_INVALID: '执行参数超出允许范围，请检查超时或输出大小限制。',
  TEST_CHECK_FAILED: '测试未通过，请查看输出中的失败项目。',
  EXECUTOR_RESULT_FAILED: '命令未成功完成。',
  NETWORK_HTTP_STATUS: '网站返回了失败的 HTTP 状态。'
};
