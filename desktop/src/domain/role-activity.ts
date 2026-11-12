import type { HarnessReadModel, RuntimeEvent, SubAgentReadModel, SubAgentState } from './models';

type Patch = Pick<SubAgentReadModel, 'agentId'> & Partial<Omit<SubAgentReadModel, 'agentId' | 'startedAtMs' | 'updatedAtMs'>>;
type Upsert = (model: HarnessReadModel, patch: Patch) => HarnessReadModel;
const labels: Record<string, string> = {
  planner: '计划 Agent', executor: '执行 Agent', verifier: '结果验证 Agent',
  semanticVerifier: '语义验证 Agent', 'council-planner': '计划评审 Agent', 'council-critic': '安全评审 Agent'
};
const tasks: Record<string, string> = {
  planner: '等待生成任务计划', executor: '等待执行已验证计划', verifier: '等待核对执行结果',
  semanticVerifier: '等待语义验证结果', 'council-planner': '等待提交计划评审意见', 'council-critic': '等待提交安全评审意见'
};
const active = (state: SubAgentState) => ['STARTING', 'RUNNING', 'WAITING'].includes(state);
const terminalRun = (model: HarnessReadModel) =>
  Boolean(model.activeRun && ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun.state));
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// Ownership (BUSY) is not work evidence. Actual activity updates the allocated
// context, scoped to its runtime run and role, rather than a placeholder row.
export const projectRoleActivity = (model: HarnessReadModel, event: RuntimeEvent, upsert: Upsert): HarnessReadModel => {
  const payload = object(event?.payload);
  if (!payload || !event.runId) return model;
  const role = typeof payload.role === 'string' ? payload.role : '';
  const contextId = typeof payload.contextId === 'string' ? payload.contextId : undefined;
  const findRole = (target: string) => model.subAgents.find(row =>
    row.runtimeRunId === event.runId && row.runtimeRole === target);
  const name = (target: string, id: string, kind?: SubAgentReadModel['executionKind']) =>
    target === 'verifier' && kind === 'RULE' ? '结果验证（规则）'
      : target === 'council' && id.includes('critic') ? labels['council-critic']
        : target === 'council' && id.includes('planner') ? labels['council-planner'] : labels[target] ?? `${target} Agent`;
  const allocate = (source: Record<string, unknown>, next: HarnessReadModel): HarnessReadModel => {
    const target = typeof source.role === 'string' ? source.role : '';
    if (!target || typeof source.contextId !== 'string') return next;
    const id = source.contextId;
    const existing = next.subAgents.find(row => row.agentId === id);
    if (existing?.runtimeRunId && existing.runtimeRunId !== event.runId) return next;
    const kind = typeof source.model === 'string' && source.model
      ? source.model === 'rule' ? 'RULE' : 'MODEL' : existing?.executionKind;
    return upsert(next, {
      agentId: id, name: name(target, id, kind), runtimeRole: target, runtimeRunId: event.runId,
      ...(kind ? { executionKind: kind } : {}),
      ...(!existing ? { state: 'STARTING', task: tasks[target] ?? '等待角色任务', workStarted: false } : {})
    });
  };
  const update = (target: string, patch: Partial<SubAgentReadModel>): HarnessReadModel => {
    const row = findRole(target);
    if (!row || row.activityStopped || row.state === 'CLOSED' || terminalRun(model)) return model;
    return upsert(model, { agentId: row.agentId, ...patch });
  };

  if (event.kind === 'RoleContextAllocated') return allocate(payload, model);
  if (event.kind === 'role.contexts_allocated') {
    let next = model;
    for (const value of Array.isArray(payload.contexts) ? payload.contexts : []) {
      const context = object(value);
      if (context) next = allocate(context, next);
    }
    return next;
  }
  if (event.kind === 'RoleContextStateChanged') {
    if (!contextId) return model;
    const existing = model.subAgents.find(row => row.agentId === contextId);
    const next = existing ? model : allocate(payload, model);
    const row = next.subAgents.find(item => item.agentId === contextId);
    if (!row || row.runtimeRunId !== event.runId) return model;
    if (payload.to === 'FAILED') return upsert(next, { agentId: row.agentId, state: 'FAILED', task: '角色上下文异常，工作已停止' });
    if (payload.to === 'CLOSED' && active(row.state)) {
      return upsert(next, { agentId: row.agentId, state: row.workStarted ? 'CLOSED' : 'SKIPPED',
        task: row.workStarted ? '上下文已关闭，未收到角色完成结果' : '本轮未调用' });
    }
    return next;
  }
  if (event.kind === 'role.contexts_reconciled') {
    let next = model;
    for (const value of Array.isArray(payload.contexts) ? payload.contexts : []) {
      const context = object(value);
      if (!context || typeof context.contextId !== 'string' || typeof context.role !== 'string') continue;
      next = upsert(next, {
        agentId: context.contextId, name: name(context.role, context.contextId),
        runtimeRole: context.role, runtimeRunId: typeof context.runId === 'string' ? context.runId : event.runId,
        state: 'FAILED', task: context.reason === 'OWNER_PROCESS_LOST'
          ? '上次运行进程已退出，角色上下文已标记失败' : '上次运行未完成，角色上下文已标记失败'
      });
    }
    return next;
  }
  if (['role.text_delta', 'role.turn_completed', 'planner.restored'].includes(event.kind)) {
    const target = role || (event.kind === 'planner.restored' ? 'planner' : '');
    if (!target || terminalRun(model)) return model;
    const row = contextId ? model.subAgents.find(item => item.agentId === contextId) : findRole(target);
    if (row?.activityStopped || row?.state === 'CLOSED' || (row?.runtimeRunId && row.runtimeRunId !== event.runId)) return model;
    const id = row?.agentId ?? contextId ?? `${event.runId}-${target}`;
    const count = event.kind === 'planner.restored' ? payload.stepCount : event.kind === 'role.text_delta' ? payload.chars : payload.outputChars;
    const suffix = typeof count === 'number' && Number.isFinite(count) && count >= 0
      ? event.kind === 'planner.restored' ? `（${count} 步）`
        : event.kind === 'role.text_delta' ? `（已接收 ${count} 字符）` : `（${count} 字符）` : '';
    return upsert(model, {
      agentId: id, name: row?.name ?? name(target, id), runtimeRole: row?.runtimeRole ?? target,
      runtimeRunId: event.runId, workStarted: true, state: event.kind === 'role.text_delta' ? 'RUNNING' : 'SUCCEEDED',
      task: `${event.kind === 'planner.restored' ? '已从 Thread checkpoint 恢复计划'
        : event.kind === 'role.text_delta' ? '正在生成角色响应' : '角色回合已完成'}${suffix}`
    });
  }
  if (event.kind === 'run.state_changed' && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(String(payload.to))) {
    let next = model;
    for (const row of model.subAgents) {
      if (row.runtimeRunId !== event.runId || !row.runtimeRole || !active(row.state)) continue;
      next = upsert(next, {
        agentId: row.agentId, state: row.workStarted ? payload.to as SubAgentState : 'SKIPPED',
        task: !row.workStarted ? '本轮未调用' : payload.to === 'SUCCEEDED'
          ? '本轮执行已完成' : payload.to === 'CANCELLED' ? '任务已取消，角色工作已停止' : '任务未完成，角色工作已停止'
      });
    }
    return next;
  }
  if (event.kind === 'model.request_started' || event.kind === 'model.text_delta'
    || (event.kind === 'run.state_changed' && payload.to === 'EXECUTING')) {
    return update('executor', { state: 'RUNNING', workStarted: true,
      task: event.kind === 'model.text_delta' ? '正在生成执行响应' : '正在处理执行计划与模型请求' });
  }
  if (event.kind === 'tool.call_requested' || event.kind === 'tool.result') {
    const tool = typeof payload.name === 'string' ? payload.name.slice(0, 80) : '受控工具';
    return update('executor', { state: event.kind === 'tool.call_requested' ? 'RUNNING' : 'WAITING', workStarted: true,
      task: event.kind === 'tool.call_requested' ? `正在请求工具：${tool}`
        : `${tool}${payload.ok === true ? '已完成' : '未成功'}，等待下一步决策` });
  }
  if (event.kind === 'model.stream_retry') return update('executor', { state: 'WAITING', task: '模型连接重试中' });
  if (event.kind === 'approval.requested' && findRole('executor')?.workStarted) return update('executor', { state: 'WAITING', task: '等待你的授权确认' });
  if ((event.kind === 'approval.resolved' || event.kind === 'approval.expired') && findRole('executor')?.workStarted) {
    if (payload.state === 'APPROVED') return update('executor', { state: 'RUNNING', task: '授权已确认，继续执行' });
    if (payload.state === 'DECLINED' || payload.state === 'EXPIRED' || event.kind === 'approval.expired') {
      return update('executor', { state: 'FAILED', activityStopped: true,
        task: payload.state === 'DECLINED' ? '授权被拒绝，已停止' : '授权已过期，已停止' });
    }
  }
  if (event.kind === 'verification.started' || event.kind === 'verification.retrying'
    || (event.kind === 'run.state_changed' && payload.to === 'VERIFYING')) {
    let next = update('verifier', { state: 'RUNNING', workStarted: true,
      task: event.kind === 'verification.retrying' ? '仅重试结果验证，不重跑执行操作' : '正在核对执行结果' });
    const executor = findRole('executor');
    if (executor?.workStarted && !executor.activityStopped && active(executor.state) && !terminalRun(model)) {
      next = upsert(next, { agentId: executor.agentId, state: 'WAITING', task: '执行结果已提交，等待验证' });
    }
    return next;
  }
  if (event.kind === 'verification.completed') {
    const state: SubAgentState = payload.status === 'PASS' ? 'SUCCEEDED'
      : payload.status === 'FAIL' ? 'FAILED' : payload.status === 'SKIPPED' ? 'SKIPPED' : 'WAITING';
    const summary = typeof payload.summary === 'string' ? payload.summary.slice(0, 180) : '';
    return update('verifier', { state, workStarted: true,
      task: `${payload.status === 'PASS' ? '本轮验证通过' : payload.status === 'FAIL' ? '本轮验证未通过'
        : payload.status === 'SKIPPED' ? '本轮未运行验证' : '验证结果尚未确定'}${summary ? `：${summary}` : ''}` });
  }
  return model;
};
