import type { TimelineItem } from './models';

const PROCESS_COMMAND_TOOLS = new Set(['shell.execute', 'test.execute']);

export const normalizeToolDisplayKey = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.toLowerCase() : '';
  return raw.startsWith('kernel.') ? raw.slice('kernel.'.length).replaceAll('_', '.') : raw;
};

export const TOOL_ACTION_LABELS: Record<string, string> = {
  'workspace.list': '查看工作区目录',
  'workspace.read': '读取工作区文件',
  'workspace.focus': '定位源码片段',
  'workspace.inspect_binary': '检查二进制文件',
  'workspace.snapshot': '记录工作区快照',
  'shell.execute': '执行命令',
  'file.read': '读取文件',
  'file.write': '写入文件',
  'file.patch': '修改文件',
  'file.diff': '查看文件差异',
  'test.execute': '运行测试',
  'network.request': '发送网络请求',
  'web.search': '搜索网页',
  'web.fetch': '读取网页',
  'browser.open': '打开网页',
  'memory.search': '搜索记忆',
  'memory.write': '保存记忆',
  'kernel.exec': '代码 cell',
  'user.clarify': '询问你'
};

export const toolActionLabel = (value: unknown): string | undefined =>
  TOOL_ACTION_LABELS[normalizeToolDisplayKey(value)];

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

/** Compact target chip text for a tool step (command line or workspace path). */
export const toolStepTargetBadge = (
  item: Pick<TimelineItem, 'toolName' | 'commandText' | 'targetPath'>,
  limit = 60
): string => {
  if (item.commandText) {
    const cmd = item.commandText.split('\n')[0].trim();
    return cmd.length > limit ? `${cmd.slice(0, limit)}...` : cmd;
  }
  if (item.targetPath) return pathBadgeText(item.targetPath, limit);
  if (normalizeToolDisplayKey(item.toolName) === 'workspace.list') return '.';
  return '';
};

/** Extract compact output size hint (e.g. `2,047 字符`) from a completed tool body. */
export const toolStepOutputMeta = (item: Pick<TimelineItem, 'status' | 'body' | 'truncated'>): string => {
  if (item.status !== 'COMPLETE') return '';
  const charsMatch = /输出\s*([\d,]+)\s*字符/u.exec(item.body ?? '');
  const parts: string[] = [];
  if (charsMatch) parts.push(`${charsMatch[1]} 字符`);
  if (item.truncated) parts.push('已截断');
  return parts.join(' · ');
};

/** Consecutive non-cell tool steps participate in Codex-style collapsible groups. */
export const isCollapsibleToolStep = (
  item: Pick<TimelineItem, 'thinking' | 'toolName'>
): boolean => !item.thinking && Boolean(item.toolName) && item.toolName !== 'kernel.exec';

export type TimelineRenderEntry =
  | { kind: 'item'; key: string; item: TimelineItem }
  | {
      kind: 'tool-group';
      key: string;
      items: TimelineItem[];
      status: TimelineItem['status'];
      autoOpen: boolean;
      summaryLabel: string;
      stepProgressLabel?: string;
      failedCount: number;
      completedCount: number;
      awaitingApproval: boolean;
      latestAtMs: number;
    };

export const sameTimelineRenderEntry = (
  left: TimelineRenderEntry | undefined,
  right: TimelineRenderEntry | undefined
): boolean => {
  if (!left || !right || left.kind !== right.kind || left.key !== right.key) return false;
  if (left.kind === 'item' && right.kind === 'item') return left.item === right.item;
  if (left.kind === 'tool-group' && right.kind === 'tool-group') {
    if (left.autoOpen !== right.autoOpen || left.status !== right.status || left.items.length !== right.items.length) {
      return false;
    }
    for (let index = 0; index < left.items.length; index += 1) {
      if (left.items[index] !== right.items[index]) return false;
    }
    return true;
  }
  return false;
};

const summarizeCompletedBreakdown = (
  items: readonly TimelineItem[],
  resolveLabel: (toolName: string) => string
): string => {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = resolveLabel(item.toolName ?? 'tool');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const head = entries.slice(0, 3).map(([label, count]) => (count > 1 ? `${label} ×${count}` : label));
  return entries.length > 3 ? `${head.join('、')} 等` : head.join('、');
};

/**
 * Group consecutive tool/command timeline items into Codex-style execution runs:
 * - A single isolated tool step renders directly as a compact row (`kind: 'item'`).
 * - Two or more consecutive tool steps in the same run merge into a `tool-group`
 *   using the first step's `itemId` as a stable DOM key:
 *   - While any step is running/pending or the group sits at the tail of an active
 *     live run, `autoOpen` stays `true` so steps stream in one by one without flicker.
 *   - Once subsequent conversation content arrives or the run ends (and in history),
 *     `autoOpen` turns `false` so multiple steps fold into one compact summary bar.
 */
export const groupConversationTimelineEntries = (
  items: readonly TimelineItem[],
  options: { liveTaskActive?: boolean; labelForTool?: (toolName: string) => string } = {}
): TimelineRenderEntry[] => {
  const resolveLabel = (toolName: string): string =>
    options.labelForTool?.(toolName) ?? toolActionLabel(toolName) ?? toolName;
  const entries: TimelineRenderEntry[] = [];
  let index = 0;
  while (index < items.length) {
    const current = items[index];
    if (!isCollapsibleToolStep(current)) {
      entries.push({ kind: 'item', key: current.itemId, item: current });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < items.length
      && isCollapsibleToolStep(items[end])
      && (items[end].runId ?? '') === (current.runId ?? '')
    ) {
      end += 1;
    }
    const slice = items.slice(index, end);
    if (slice.length === 1) {
      entries.push({ kind: 'item', key: current.itemId, item: current });
      index = end;
      continue;
    }
    const isTrailing = end === items.length;
    let activeIndex = -1;
    for (let i = slice.length - 1; i >= 0; i -= 1) {
      if (slice[i].status === 'STREAMING' || slice[i].status === 'PENDING') {
        activeIndex = i;
        break;
      }
    }
    const activeItem = activeIndex >= 0 ? slice[activeIndex] : undefined;
    const waitingItem = slice.find(
      (step) => (step.status === 'STREAMING' || step.status === 'PENDING') && Boolean(step.awaitingApproval)
    );
    const awaitingApproval = Boolean(waitingItem);
    const failedCount = slice.filter((step) => step.status === 'ERROR').length;
    const completedCount = slice.filter((step) => step.status === 'COMPLETE').length;
    const status: TimelineItem['status'] = awaitingApproval
      ? 'PENDING'
      : activeItem
        ? 'STREAMING'
        : failedCount > 0
          ? 'ERROR'
          : 'COMPLETE';
    const autoOpen = Boolean(activeItem) || Boolean(options.liveTaskActive && isTrailing);
    let summaryLabel: string;
    let stepProgressLabel: string | undefined;
    if (waitingItem) {
      const label = resolveLabel(waitingItem.toolName ?? 'tool');
      const target = toolStepTargetBadge(waitingItem, 42);
      summaryLabel = `等待批准 · ${label}${target ? ` ${target}` : ''}`;
      stepProgressLabel = `${completedCount}/${slice.length}`;
    } else if (activeItem) {
      const label = resolveLabel(activeItem.toolName ?? 'tool');
      const target = toolStepTargetBadge(activeItem, 42);
      const runningLabel = label.startsWith('正在') ? label : `正在${label}`;
      summaryLabel = `${runningLabel}${target ? ` ${target}` : ''}`;
      stepProgressLabel = `${activeIndex + 1}/${slice.length}`;
    } else {
      const breakdown = summarizeCompletedBreakdown(slice, resolveLabel);
      summaryLabel = failedCount > 0
        ? `已执行 ${slice.length} 项操作（${failedCount} 项失败）${breakdown ? ` · ${breakdown}` : ''}`
        : `已完成 ${slice.length} 项操作${breakdown ? ` · ${breakdown}` : ''}`;
    }
    entries.push({
      kind: 'tool-group',
      key: slice[0].itemId,
      items: slice,
      status,
      autoOpen,
      summaryLabel,
      ...(stepProgressLabel ? { stepProgressLabel } : {}),
      failedCount,
      completedCount,
      awaitingApproval,
      latestAtMs: slice[slice.length - 1].createdAtMs
    });
    index = end;
  }
  return entries;
};
