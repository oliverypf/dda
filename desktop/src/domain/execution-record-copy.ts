// Plain-language context and decision text for one execution record.
// Sentences come from stored fields and reason codes. A missing reason stays
// missing; the only inference is the unmarked intent-rejected + approval-cancelled
// pair, which this runtime writes when a task or code cell ends before a decision.

export interface ExecutionTransitionLike {
  to?: string;
  metadata?: { reason?: unknown };
}

export interface ExecutionRecordLike {
  recordId: string;
  recordType: 'intent' | 'approval' | 'lease';
  state: string;
  capability?: string;
  intentId?: string;
  requestSummary?: Record<string, unknown>;
  commands?: string[];
  transition?: ExecutionTransitionLike;
  transitionHistory?: ExecutionTransitionLike[];
}

export interface ExecutionRecordCopy {
  action: string;
  lines: string[];
}

const CAPABILITY_LABELS: Record<string, string> = {
  'shell.execute': '执行命令',
  'file.write': '写入文件',
  'file.patch': '修改文件',
  'test.execute': '运行测试',
  'network.request': '发送网络请求',
  'web.search': '搜索网页',
  'web.fetch': '读取网页',
  'kernel.exec': '代码 cell'
};

const REASON_TEXT: Record<string, string> = {
  COMPUTER_FULL_ACCESS: '为什么同意：完全访问开着，风险核对把这次看成普通操作，所以直接同意。',
  USER_APPROVED: '为什么同意：你在审批卡上核对后点了同意。这次同意只覆盖这一条请求。',
  KERNEL_BATCH_APPROVAL: '为什么同意：同一次代码 cell 里，你已经同意过这一批，这一步沿用那次同意。',
  EXPLICIT_HOST_POLICY: '为什么同意：当时没有打开的审批界面，主机策略允许这次操作，所以直接同意。',
  USER_DECLINED: '为什么拒绝：你在审批卡上点了拒绝，这次操作没有执行。',
  APPROVAL_REQUIRED_NO_LIVE_APPROVER: '为什么拒绝：这次必须有人确认，当时没有打开的审批界面，所以拒绝，没有执行。',
  APPROVAL_EXPIRED: '为什么失效：审批时限过了还没有人处理，这次请求作废，没有执行。',
  CELL_ENDED_BEFORE_DECISION: '为什么取消：代码 cell 在你做出决定前结束了。审批被取消，动作记为拒绝，没有执行。',
  APPROVAL_INTERRUPTED: '为什么取消：审批还在准备时代码 cell 已关闭。审批被取消，动作记为拒绝，没有执行。',
  OWNER_PROCESS_LOST: '为什么取消：发起这次操作的进程已经退出。未完成的审批被取消，动作记为拒绝，没有补执行。',
  TTL_EXPIRED: '为什么失效：一次性授权过了有效期，之后不能再使用。',
  RECOVERY_CANCELLED: '为什么取消：你在恢复检查里取消了这条还没处理的审批，所以没有执行。',
  RECOVERY_REVOKED: '为什么撤销：你在恢复检查里撤销了这条一次性授权，之后不能再使用。',
  REVOKED: '为什么撤销：这条一次性授权已被撤销，之后不能再使用。',
  SCOPE_VIOLATION: '为什么失败：执行时发现命令或写入超出了这次授权的范围，所以记为失败。',
  OUTCOME_UNCERTAIN_AFTER_CRASH: '为什么失败：执行过程中进程退出，结果无法确认。',
  EXECUTOR_RESULT_FAILED: '为什么失败：命令已经执行，返回了失败结果。',
  EXECUTION_TIMED_OUT: '为什么失败：命令执行超时，记为失败。',
  EXECUTION_ABORTED: '为什么失败：命令执行被中止，记为失败。',
  EXECUTION_SUCCEEDED: '结果：命令已经执行，返回成功。'
};

const OUTCOME_CODES = new Set([
  'SCOPE_VIOLATION', 'EXECUTION_OUTCOME_UNCERTAIN', 'OUTCOME_UNCERTAIN_AFTER_CRASH',
  'EXECUTOR_RESULT_FAILED', 'EXECUTION_TIMED_OUT', 'EXECUTION_ABORTED', 'EXECUTION_SUCCEEDED'
]);

const text = (value: unknown, max = 180): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => text(item, 160)) : [];

const reasonCodes = (record: ExecutionRecordLike): string[] => {
  const transitions = [...(record.transitionHistory ?? [])];
  if (record.transition) transitions.push(record.transition);
  const codes: string[] = [];
  for (const transition of transitions) {
    const reason = transition?.metadata?.reason;
    if (typeof reason === 'string' && reason.trim() && !codes.includes(reason)) codes.push(reason.trim());
  }
  return codes;
};

const capabilityLabel = (capability?: string): string =>
  (capability && CAPABILITY_LABELS[capability]) || (capability ? capability : '受控操作');

const summaryOf = (record: ExecutionRecordLike, records: ExecutionRecordLike[]): Record<string, unknown> => {
  const own = record.requestSummary ?? {};
  const ownUseful = text(own.command) || text(own.path) || text(own.host) || strings(own.argsPreview).length > 0;
  if (ownUseful) return own;
  const intentId = record.recordType === 'intent' ? record.recordId : record.intentId;
  const intent = intentId ? records.find((item) => item.recordType === 'intent' && item.recordId === intentId) : undefined;
  if (intent?.requestSummary) return intent.requestSummary;
  return own;
};

const cwdText = (cwd: string): string =>
  !cwd || cwd === '.' ? '工作目录是这次任务的项目根目录' : `工作目录是 ${cwd}`;

const actionText = (summary: Record<string, unknown>, capability?: string): string => {
  const command = text(summary.command, 240);
  const preview = strings(summary.argsPreview);
  const argCount = typeof summary.argCount === 'number' && summary.argCount > 0 ? summary.argCount : 0;
  const hidden = Math.max(0, argCount - preview.length);
  if (command) {
    const shown = [command, ...preview].join(' ');
    return hidden > 0 ? `${shown}（还有 ${hidden} 个参数未留原文）` : shown;
  }
  const path = text(summary.path, 240);
  if (path) {
    if (capability === 'file.write') return `写入 ${path}`;
    if (capability === 'file.patch') return `修改 ${path}`;
    return path;
  }
  const host = text(summary.host, 253);
  if (host) {
    const method = text(summary.method, 10) || 'GET';
    const scheme = summary.scheme === 'http' || summary.scheme === 'https' ? summary.scheme : 'https';
    const port = typeof summary.port === 'number' ? `:${summary.port}` : '';
    return `${method} ${scheme}://${host}${port}`;
  }
  return capabilityLabel(capability);
};

const contextLine = (record: ExecutionRecordLike, summary: Record<string, unknown>, action: string): string => {
  const command = text(summary.command);
  const path = text(summary.path, 240);
  const host = text(summary.host, 253);
  const cwd = text(summary.cwd, 240);
  const preview = strings(summary.argsPreview);
  const argCount = typeof summary.argCount === 'number' && summary.argCount > 0 ? summary.argCount : 0;
  const hidden = Math.max(0, argCount - preview.length);
  const bytes = typeof summary.contentBytes === 'number' && summary.contentBytes >= 0 ? summary.contentBytes : undefined;
  let sentence: string;
  if (command) {
    const args = hidden > 0
      ? (preview.length
        ? `另外 ${hidden} 个参数没有留下原文。`
        : `参数共 ${argCount} 个，原文没有写入审批记录。`)
      : '';
    sentence = `${cwdText(cwd)}，要执行的命令是 ${action.replace(/（还有 \d+ 个参数未留原文）$/, '')}。${args}`;
  } else if (path) {
    const verb = record.capability === 'file.patch' ? '要修改的文件是' : '要写入的文件是';
    const size = bytes !== undefined ? `内容约 ${bytes} 字节，原文没有写入审批记录。` : '';
    sentence = `${verb} ${path}。${size}`;
  } else if (host) {
    sentence = `要访问 ${action}。`;
  } else {
    sentence = `这次是${capabilityLabel(record.capability)}，记录里没有命令、路径或地址。`;
  }
  return `上下文：${sentence}`;
};

const reasonSentence = (code: string, state: string): string => {
  if (code === 'EXECUTION_OUTCOME_UNCERTAIN') {
    return state === 'FAILED'
      ? '为什么失败：操作已经发出，结果无法确认，没有补执行。'
      : '为什么拒绝：操作已经发出，结果无法确认，所以没有把它记成成功，也没有补执行。';
  }
  return REASON_TEXT[code] ?? `记录里的原因代码是 ${code}，当前说明里还没有对应句子。`;
};

const related = (record: ExecutionRecordLike, records: ExecutionRecordLike[]): ExecutionRecordLike[] => {
  const intentId = record.recordType === 'intent' ? record.recordId : record.intentId;
  if (!intentId) return [record];
  const found = records.filter((item) => item.recordId === intentId || item.intentId === intentId);
  return found.length ? found : [record];
};

const closedBeforeDecision = (record: ExecutionRecordLike, records: ExecutionRecordLike[], codes: string[]): boolean => {
  if (codes.length) return false;
  const group = related(record, records);
  const intent = group.find((item) => item.recordType === 'intent');
  const approval = group.find((item) => item.recordType === 'approval');
  if (!intent || !approval) return false;
  if (intent.state !== 'REJECTED' || approval.state !== 'CANCELLED') return false;
  return reasonCodes(intent).length === 0 && reasonCodes(approval).length === 0;
};

const missingSentence = (record: ExecutionRecordLike): string | undefined => {
  const state = record.state;
  if (state === 'DECLINED' || state === 'REJECTED') return '为什么拒绝：记录里没有写下拒绝原因。';
  if (state === 'CANCELLED' || state === 'SUPERSEDED') return '为什么取消：记录里没有写下取消原因。';
  if (state === 'EXPIRED') return '为什么失效：记录里没有写下失效原因。';
  if (state === 'REVOKED') return '为什么撤销：记录里没有写下撤销原因。';
  if (state === 'FAILED') return '为什么失败：记录里没有写下失败原因。';
  if (state === 'APPROVED' || (record.recordType === 'intent' && (state === 'COMPLETED' || state === 'EXECUTING'))) {
    return '为什么同意：记录里没有写下同意原因。';
  }
  if (['REQUESTED', 'PRESENTED', 'PROPOSED', 'SAFETY_EVALUATING', 'WAITING_APPROVAL', 'ACTIVE', 'CONSUMING'].includes(state)) {
    return '这次请求还没有最终决定。';
  }
  return undefined;
};

const outcomeSentence = (record: ExecutionRecordLike, codes: string[]): string | undefined => {
  if (codes.some((code) => OUTCOME_CODES.has(code))) return undefined;
  if (record.recordType === 'approval') return undefined;
  if (record.recordType === 'lease' && record.state === 'CONSUMED') return '结果：这条一次性授权已经使用。';
  if (record.state === 'COMPLETED') return '结果：这条动作后来执行完了，状态是已完成。';
  if (record.state === 'FAILED' && codes.length > 0) return '结果：这条动作记成了失败，记录里没有写下更具体的失败原因。';
  return undefined;
};

export const describeExecutionRecord = (record: ExecutionRecordLike, records: ExecutionRecordLike[] = []): ExecutionRecordCopy => {
  const summary = summaryOf(record, records);
  const action = actionText(summary, record.capability);
  const lines = [contextLine(record, summary, action)];
  const codes = reasonCodes(record);
  if (closedBeforeDecision(record, records, codes)) {
    lines.push(record.recordType === 'approval'
      ? '为什么取消：任务或代码 cell 在你做出决定前结束了。审批被取消，这次没有执行。对应的动作记为拒绝。'
      : '为什么拒绝：任务或代码 cell 在你做出决定前结束了。动作记为拒绝，这次没有执行。对应的审批被取消。');
  } else if (codes.length) {
    for (const code of codes) lines.push(reasonSentence(code, record.state));
  } else {
    const missing = missingSentence(record);
    if (missing) lines.push(missing);
  }
  const outcome = outcomeSentence(record, codes);
  if (outcome) lines.push(outcome);
  return { action, lines };
};
