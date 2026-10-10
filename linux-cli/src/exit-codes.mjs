export const EXIT = Object.freeze({
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  USAGE_ERROR: 2,
  CONFIG_ERROR: 3,
  WORKSPACE_ERROR: 4,
  APPROVAL_DENIED: 5,
  SAFETY_BLOCKED: 6,
  CANCELLED: 7,
  PROTOCOL_ERROR: 8,
  STORAGE_ERROR: 9,
  DEPENDENCY_ERROR: 10,
  SIGINT: 130
});

const MESSAGES = Object.freeze({
  WORKSPACE_NOT_FOUND: '工作区不存在',
  WORKSPACE_NOT_DIRECTORY: '工作区不是目录',
  WORKSPACE_PATH_FORBIDDEN: '工作区路径被拒绝',
  WORKSPACE_UNAVAILABLE: '工作区无法读取',
  APPROVAL_UNAVAILABLE: '没有可用的审批通道',
  APPROVAL_DENIED: '审批被拒绝',
  CONFIG_ERROR: '配置不可用',
  PROMPT_REQUIRED: '需要非空的 --prompt',
  UNKNOWN_COMMAND: '未知命令',
  ARGUMENT_INVALID: '参数不完整',
  UNKNOWN_ARGUMENT: '未知参数',
  TASK_RESULT_UNKNOWN: '超时后无法确认动作是否已经执行',
  STORAGE_ERROR: '数据目录不可用',
  PROTOCOL_ERROR: 'runtime 输出不符合 JSONL 契约',
  DEPENDENCY_ERROR: 'Node、runtime 或 provider 依赖不可用。Linux CLI 需要 Node.js 24 或更新版本'
});

export function exitCodeForError(code) {
  const text = String(code ?? '');
  if (/^(USAGE_|UNKNOWN_COMMAND|UNKNOWN_ARGUMENT|ARGUMENT_|PROMPT_REQUIRED|EVENTS_TARGET_INVALID|EXECUTION_MODE_INVALID|APPROVAL_MODE_INVALID|AGENT_MODE_INVALID|FORMAT_INVALID|TIMEOUT_INVALID)/u.test(text)) return EXIT.USAGE_ERROR;
  if (/MODEL_CONFIG|CONFIG_|RELEASE_CHANNEL|PROVIDER/u.test(text)) return EXIT.CONFIG_ERROR;
  if (/WORKSPACE_/u.test(text)) return EXIT.WORKSPACE_ERROR;
  if (/APPROVAL_/u.test(text)) return EXIT.APPROVAL_DENIED;
  if (/SAFETY|LEASE_|POLICY_|FORBIDDEN|SHELL_INTERPRETED/u.test(text)) return EXIT.SAFETY_BLOCKED;
  if (/CANCEL/u.test(text)) return EXIT.CANCELLED;
  if (/PROTOCOL|SCHEMA_VERSION/u.test(text)) return EXIT.PROTOCOL_ERROR;
  if (/STORAGE|SQLITE|DATABASE|ENOSPC|EACCES|EPERM/u.test(text)) return EXIT.STORAGE_ERROR;
  if (/MODULE_NOT_FOUND|DEPENDENCY|ERR_MODULE/u.test(text)) return EXIT.DEPENDENCY_ERROR;
  return EXIT.RUNTIME_ERROR;
}

export function messageForCode(code) {
  const text = String(code ?? 'RUNTIME_ERROR');
  if (MESSAGES[text]) return MESSAGES[text];
  if (text.startsWith('MODEL_CONFIG')) return '模型配置无法解析';
  if (text.startsWith('WORKSPACE_')) return '工作区不可用';
  if (text.startsWith('APPROVAL_')) return '审批未通过';
  return '命令没有完成';
}

export function errorResult(code, extras = {}) {
  return {
    ok: false,
    ...extras,
    error: { code, message: messageForCode(code) }
  };
}
