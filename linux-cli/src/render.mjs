const PHASE_LABELS = Object.freeze({
  'run.started': '任务开始',
  'runtime.phase': '阶段',
  'runtime.heartbeat': '活动',
  'approval.requested': '等待审批',
  'approval.resolved': '审批结果',
  'action_intent.created': '受控动作',
  'tool.started': '工具开始',
  'tool.completed': '工具完成',
  'runtime.error': '错误',
  'run.completed': '完成',
  'run.failed': '失败',
  'run.cancelled': '取消'
});

export function humanEventLine(event) {
  const kind = event?.kind ?? 'event';
  const label = PHASE_LABELS[kind] ?? kind;
  const payload = event?.payload ?? {};
  if (kind === 'run.started') return `${label}  ${event.runId ?? ''}  mode=${payload.executionMode ?? ''}`;
  if (kind === 'runtime.phase') return `${label}  ${payload.phase ?? ''}`;
  if (kind === 'runtime.heartbeat') return `${label}  ${payload.state ?? ''}`;
  if (kind === 'approval.resolved') return `${label}  ${payload.approved === true ? '批准' : '拒绝'}`;
  if (kind === 'runtime.error' || kind === 'run.failed') return `${label}  ${payload.code ?? payload.message ?? ''}`.trim();
  if (kind === 'run.completed') return `完成  SUCCEEDED`;
  if (kind === 'tool.started' || kind === 'tool.completed') return `${label}  ${payload.tool ?? payload.name ?? ''}`.trim();
  return `${label}  ${event.runId ?? ''}`.trim();
}

export function isRuntimeEvent(value) {
  return Boolean(value && value.type === 'runtime_event' && typeof value.kind === 'string');
}
