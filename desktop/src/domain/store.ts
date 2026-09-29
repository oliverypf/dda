import type {
  HarnessReadModel,
  RunState,
  RuntimeSnapshot,
  RuntimeContextSidecarStatus,
  RuntimeDreamMaintenanceStatus,
  RuntimeEvent,
  SubAgentReadModel,
  SubAgentState,
  TimelineItem,
  WorkspaceEntry,
  WorkspaceFile
} from './models';
import { sameWorkspaceRoot } from './workspace';

const runtimeRoleLabel = (role: string): string => ({
  planner: '计划 Agent',
  executor: '执行 Agent',
  verifier: '结果验证 Agent',
  semanticVerifier: '语义验证 Agent',
  'council-planner': '计划评审 Agent',
  'council-critic': '安全评审 Agent'
}[role] ?? `${role} Agent`);

const runtimeRoleDisplayLabel = (role: string, contextId?: string): string => {
  if (role === 'council' && contextId?.includes('critic')) return '安全评审 Agent';
  if (role === 'council' && contextId?.includes('planner')) return '计划评审 Agent';
  return runtimeRoleLabel(role);
};

const runtimeRoleTask = (role: string): string => ({
  planner: '等待生成任务计划',
  executor: '等待执行已验证计划',
  verifier: '等待核对执行结果',
  semanticVerifier: '等待语义验证结果',
  'council-planner': '等待提交计划评审意见',
  'council-critic': '等待提交安全评审意见'
}[role] ?? '等待角色任务');

const runtimeRoleAgentId = (runId: string, role: string, contextId?: string): string =>
  contextId?.trim() || `${runId}-${role}`;

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createInitialReadModel = (): HarnessReadModel => ({
  schemaVersion: '1.0',
  projectionVersion: 1,
  connection: {
    state: 'CONNECTING',
    mode: 'MOCK',
    label: '正在启动本地只读运行时'
  },
  runtime: {
    platform: 'WEB_PREVIEW',
    version: '0.1.0',
    readOnly: true,
    workspaceRead: true,
    commandExecution: false,
    networkSideEffects: false
  },
  threads: [],
  subAgents: [],
  approvals: [],
  feedback: [],
  memories: [],
  dreamRuns: [],
  plugins: [],
  pluginVersions: [],
  evolutionProposals: [],
  evolutionReports: [],
  decisions: [],
  timeline: [
    {
      itemId: 'welcome',
      kind: 'AGENT',
      title: 'hmCodex',
      body: 'Windows 只读工作台已启动。你可以授权一个项目目录，然后让 hmCodex 检查结构、阅读文件或整理实现计划。',
      status: 'COMPLETE',
      createdAtMs: Date.now()
    }
  ],
  workspace: {
    granted: false,
    rootLabel: '默认工作区',
    currentPath: '',
    entries: [],
    stale: false
  },
  composer: {
    mode: 'READ_ONLY',
    enabled: true,
    placeholder: '描述需要检查或分析的任务'
  }
});

export const setThreads = (
  model: HarnessReadModel,
  threads: HarnessReadModel['threads']
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  threads: threads.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs)
});

export const setActiveThread = (
  model: HarnessReadModel,
  threadId: string | undefined,
  resume = false
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  ...(threadId ? { activeThreadId: threadId } : { activeThreadId: undefined }),
  ...(threadId && resume ? { resumeThreadId: threadId } : { resumeThreadId: undefined })
});

export const setExecutionMode = (
  model: HarnessReadModel,
  mode: HarnessReadModel['composer']['mode']
): HarnessReadModel => {
  if (model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY') mode = 'READ_ONLY';
  return ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  runtime: {
    ...model.runtime,
    commandExecution: mode === 'CONTROLLED'
  },
  composer: {
    ...model.composer,
    mode,
    placeholder: mode === 'CONTROLLED' ? '描述任务，必要的副作用会逐项请求审批' : '描述需要检查或分析的任务'
  }
  });
};

export const upsertApproval = (
  model: HarnessReadModel,
  approval: HarnessReadModel['approvals'][number]
): HarnessReadModel => {
  const index = model.approvals.findIndex((item) => item.requestId === approval.requestId);
  const approvals = model.approvals.slice();
  if (index < 0) approvals.push(approval);
  else approvals[index] = approval;
  return { ...model, projectionVersion: model.projectionVersion + 1, approvals };
};

// A delayed runtime event must not keep a locally expired request actionable.
// This is a UI projection only; the runtime still validates every decision.
export const expireRequestedApprovals = (model: HarnessReadModel, now = Date.now()): HarnessReadModel => {
  let changed = false;
  const approvals = model.approvals.map((approval) => {
    if (approval.state !== 'REQUESTED' || approval.approvalExpiresAt === undefined || approval.approvalExpiresAt > now) return approval;
    changed = true;
    return { ...approval, state: 'EXPIRED' as const };
  });
  return changed ? { ...model, approvals, projectionVersion: model.projectionVersion + 1 } : model;
};

export const cancelPendingApprovals = (model: HarnessReadModel): HarnessReadModel => {
  const approvals = model.approvals.map((approval) => approval.state === 'REQUESTED'
    ? { ...approval, state: 'CANCELLED' as const }
    : approval);
  if (approvals.every((approval, index) => approval === model.approvals[index])) return model;
  return { ...model, projectionVersion: model.projectionVersion + 1, approvals };
};

export const setRuntimeReady = (
  model: HarnessReadModel,
  snapshot?: RuntimeSnapshot
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  connection: {
    state: 'READY',
    mode: snapshot ? 'LOCAL_RUNTIME' : 'MOCK',
    label: snapshot ? 'Windows 本地运行时已就绪' : 'Web 预览使用只读 Mock 运行时'
  },
  runtime: snapshot ?? model.runtime,
  composer: snapshot?.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY'
    ? { ...model.composer, mode: 'READ_ONLY', placeholder: '描述需要检查或分析的任务' }
    : model.composer
});

export const setContextSidecarStatus = (
  model: HarnessReadModel,
  status?: RuntimeContextSidecarStatus
): HarnessReadModel => status
  ? {
      ...model,
      projectionVersion: model.projectionVersion + 1,
      runtime: { ...model.runtime, contextSidecar: status }
    }
  : model;

export const setDreamMaintenanceStatus = (
  model: HarnessReadModel,
  status?: RuntimeDreamMaintenanceStatus
): HarnessReadModel => status
  ? {
      ...model,
      projectionVersion: model.projectionVersion + 1,
      runtime: { ...model.runtime, dreamMaintenance: status }
    }
  : model;

export const appendTimelineItem = (
  model: HarnessReadModel,
  item: Omit<TimelineItem, 'itemId' | 'createdAtMs'> & Partial<Pick<TimelineItem, 'itemId' | 'createdAtMs'>>
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  timeline: model.timeline.concat({
    ...item,
    itemId: item.itemId ?? makeId('item'),
    createdAtMs: item.createdAtMs ?? Date.now()
  })
});

export const beginRun = (model: HarnessReadModel, prompt: string): HarnessReadModel => {
  const runId = makeId('run');
  const withUser = appendTimelineItem(model, {
    kind: 'USER',
    title: '你',
    body: prompt,
    status: 'COMPLETE'
  });
  return {
    ...withUser,
    projectionVersion: withUser.projectionVersion + 1,
    activeRun: {
      runId,
      title: prompt.length > 52 ? `${prompt.slice(0, 52)}...` : prompt,
      state: 'PLANNING',
      startedAtMs: Date.now()
    },
    subAgents: [],
    composer: { ...withUser.composer, enabled: false }
  };
};

const isSubAgentActive = (state: SubAgentState): boolean => state === 'STARTING' || state === 'RUNNING';

export const setRunState = (model: HarnessReadModel, state: RunState): HarnessReadModel => {
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state)) model = cancelPendingApprovals(model);
  const terminalAgentState: SubAgentState | undefined = state === 'CANCELLED'
    ? 'CANCELLED'
    : state === 'FAILED'
      ? 'FAILED'
      : state === 'SUCCEEDED'
        ? 'SUCCEEDED'
        : undefined;
  const now = Date.now();
  return {
    ...model,
    projectionVersion: model.projectionVersion + 1,
    activeRun: model.activeRun ? { ...model.activeRun, state } : undefined,
    subAgents: terminalAgentState
      ? model.subAgents.map((agent) => isSubAgentActive(agent.state)
        ? { ...agent, state: terminalAgentState, updatedAtMs: now }
        : agent)
      : model.subAgents,
    composer: {
      ...model.composer,
      enabled: state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED'
    }
  };
};

export const upsertSubAgent = (
  model: HarnessReadModel,
  patch: Pick<SubAgentReadModel, 'agentId'> & Partial<Omit<SubAgentReadModel, 'agentId' | 'startedAtMs' | 'updatedAtMs'>>
): HarnessReadModel => {
  const now = Date.now();
  const index = model.subAgents.findIndex((agent) => agent.agentId === patch.agentId);
  const nextSubAgents = model.subAgents.slice();
  if (index < 0) {
    nextSubAgents.push({
      agentId: patch.agentId,
      name: patch.name ?? '子 Agent',
      task: patch.task ?? '等待任务',
      state: patch.state ?? 'STARTING',
      startedAtMs: now,
      updatedAtMs: now
    });
  } else {
    nextSubAgents[index] = {
      ...nextSubAgents[index],
      ...patch,
      updatedAtMs: now
    };
  }
  return {
    ...model,
    projectionVersion: model.projectionVersion + 1,
    subAgents: nextSubAgents
  };
};

/**
 * Project role lifecycle events emitted by the Cordis runtime into the
 * user-facing sub-agent read model.  The runtime is authoritative here: the
 * desktop can still show its host/plugin pipeline rows, but actual planner,
 * executor, verifier and council rows are created and advanced only when a
 * corresponding runtime event is observed.
 */
export const applyRuntimeSubAgentEvent = (
  model: HarnessReadModel,
  event: RuntimeEvent
): HarnessReadModel => {
  if (!event || typeof event.runId !== 'string' || !event.payload || typeof event.payload !== 'object') return model;
  const payload = event.payload as Record<string, unknown>;
  const role = typeof payload.role === 'string' ? payload.role : '';
  const contextId = typeof payload.contextId === 'string' ? payload.contextId : undefined;

  if (event.kind === 'RoleContextAllocated') {
    const contextKey = typeof payload.contextId === 'string' ? payload.contextId : undefined;
    if (!role || !contextKey) return model;
    return upsertSubAgent(model, {
      agentId: contextKey,
      name: runtimeRoleDisplayLabel(role, contextKey),
      task: runtimeRoleTask(role),
      state: 'STARTING'
    });
  }

  if (event.kind === 'RoleContextStateChanged') {
    const contextKey = typeof payload.contextId === 'string' ? payload.contextId : undefined;
    const nextState = typeof payload.to === 'string' ? payload.to.toUpperCase() : '';
    const state: SubAgentState = nextState === 'BUSY' || nextState === 'INTERRUPTING' ? 'RUNNING'
      : nextState === 'CLOSED' ? 'SUCCEEDED'
        : nextState === 'FAILED' ? 'FAILED' : 'STARTING';
    if (!contextKey) return model;
    return upsertSubAgent(model, {
      agentId: contextKey,
      ...(role ? { name: runtimeRoleDisplayLabel(role, contextKey), task: runtimeRoleTask(role) } : {}),
      state
    });
  }

  if (event.kind === 'role.contexts_allocated') {
    const contexts = Array.isArray(payload.contexts) ? payload.contexts : [];
    let next = model;
    for (const value of contexts) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const context = value as Record<string, unknown>;
      const contextRole = typeof context.role === 'string' ? context.role : '';
      if (!contextRole) continue;
      const contextKey = typeof context.contextId === 'string' ? context.contextId : undefined;
      const agentId = runtimeRoleAgentId(event.runId, contextRole, contextKey);
      // Runtime emits the individual allocation/state frames before this
      // aggregate summary.  The summary is descriptive and must not move an
      // already BUSY or completed role back to STARTING (the exact ordering
      // seen by the desktop is Allocated -> BUSY -> contexts_allocated).
      const existing = next.subAgents.find((agent) => agent.agentId === agentId);
      next = existing
        ? upsertSubAgent(next, {
            agentId,
            name: runtimeRoleDisplayLabel(contextRole, contextKey)
          })
        : upsertSubAgent(next, {
            agentId,
            name: runtimeRoleDisplayLabel(contextRole, contextKey),
            task: runtimeRoleTask(contextRole),
            state: 'STARTING'
          });
    }
    return next;
  }

  if (event.kind === 'role.contexts_reconciled') {
    const contexts = Array.isArray(payload.contexts) ? payload.contexts : [];
    let next = model;
    for (const value of contexts) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const context = value as Record<string, unknown>;
      const contextRole = typeof context.role === 'string' ? context.role : '';
      const contextKey = typeof context.contextId === 'string' ? context.contextId : undefined;
      if (!contextRole || !contextKey) continue;
      next = upsertSubAgent(next, {
        agentId: contextKey,
        name: runtimeRoleDisplayLabel(contextRole, contextKey),
        task: typeof context.reason === 'string' && context.reason === 'OWNER_PROCESS_LOST'
          ? '上次运行进程已退出，角色上下文已标记失败'
          : '上次运行未完成，角色上下文已标记失败',
        state: 'FAILED'
      });
    }
    return next;
  }

  if (!role && event.kind !== 'planner.restored') return model;
  // planner.restored predates the current role context and therefore carries
  // no contextId. Reuse the allocated planner row when available instead of
  // creating a duplicate row for the same runtime role.
  const restoredPlanner = event.kind === 'planner.restored' && !role && !contextId
    ? model.subAgents.find((agent) => agent.name === runtimeRoleLabel('planner'))
    : undefined;
  const agentId = restoredPlanner?.agentId ?? runtimeRoleAgentId(event.runId, role || 'planner', contextId);
  const existingName = model.subAgents.find((agent) => agent.agentId === agentId)?.name;
  const displayName = existingName ?? runtimeRoleDisplayLabel(role || 'planner', contextId);
  if (event.kind === 'role.text_delta') {
    const chars = typeof payload.chars === 'number' && Number.isFinite(payload.chars) ? payload.chars : 0;
    return upsertSubAgent(model, {
      agentId,
      name: displayName,
      task: chars > 0 ? `正在生成角色响应（已接收 ${chars} 字符）` : '正在生成角色响应',
      state: 'RUNNING'
    });
  }
  if (event.kind === 'role.turn_completed') {
    const outputChars = typeof payload.outputChars === 'number' && Number.isFinite(payload.outputChars)
      ? payload.outputChars
      : undefined;
    return upsertSubAgent(model, {
      agentId,
      name: displayName,
      task: outputChars === undefined ? '角色回合已完成' : `角色回合已完成（${outputChars} 字符）`,
      state: 'SUCCEEDED'
    });
  }
  if (event.kind === 'planner.restored') {
    const stepCount = typeof payload.stepCount === 'number' && Number.isFinite(payload.stepCount)
      ? payload.stepCount
      : undefined;
    return upsertSubAgent(model, {
      agentId,
      name: runtimeRoleLabel('planner'),
      task: stepCount === undefined ? '已从 Thread checkpoint 恢复计划' : `已从 Thread checkpoint 恢复计划（${stepCount} 步）`,
      state: 'SUCCEEDED'
    });
  }
  return model;
};

export const upsertStreamingAgent = (
  model: HarnessReadModel,
  itemId: string,
  delta: string,
  complete = false,
  runId?: string
): HarnessReadModel => {
  const index = model.timeline.findIndex((item) => item.itemId === itemId);
  const nextTimeline = model.timeline.slice();
  if (index < 0) {
    nextTimeline.push({
      itemId,
      ...(runId ? { runId } : {}),
      kind: 'AGENT',
      title: 'hmCodex',
      body: delta,
      status: complete ? 'COMPLETE' : 'STREAMING',
      createdAtMs: Date.now()
    });
  } else {
    const current = nextTimeline[index];
    nextTimeline[index] = {
      ...current,
      body: current.body + delta,
      status: complete ? 'COMPLETE' : 'STREAMING'
    };
  }
  return {
    ...model,
    projectionVersion: model.projectionVersion + 1,
    timeline: nextTimeline
  };
};

/**
 * Mark an existing streamed response complete without creating a placeholder
 * row when the provider finished without sending any deltas.
 */
export const completeStreamingAgent = (
  model: HarnessReadModel,
  itemId: string
): HarnessReadModel => model.timeline.some((item) => item.itemId === itemId)
  ? upsertStreamingAgent(model, itemId, '', true)
  : model;

export const setWorkspace = (
  model: HarnessReadModel,
  rootLabel: string,
  currentPath: string,
  entries: WorkspaceEntry[],
  rootPath?: string
): HarnessReadModel => {
  const nextRoot = rootPath ?? model.workspace.rootPath;
  const threadRoot = model.threads.find((thread) => thread.id === model.activeThreadId)?.cwd;
  const rootChanged = Boolean(rootPath && [model.workspace.rootPath, threadRoot]
    .some((previous) => previous && !sameWorkspaceRoot(previous, rootPath)));
  return {
    ...model,
    ...(rootChanged ? {
      activeThreadId: undefined,
      resumeThreadId: undefined,
      activeRun: undefined,
      timeline: [],
      subAgents: [],
      approvals: [],
      decisions: [],
      continuousVerification: [],
      processVerification: undefined,
      composer: { ...model.composer, enabled: true }
    } : {}),
    projectionVersion: model.projectionVersion + 1,
    workspace: {
      granted: true,
      rootLabel,
      ...(nextRoot ? { rootPath: nextRoot } : {}),
      currentPath,
      entries,
      stale: false
    }
  };
};

export const clearWorkspace = (model: HarnessReadModel): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  workspace: {
    granted: false,
    rootLabel: '未绑定项目',
    rootPath: undefined,
    currentPath: '',
    entries: [],
    stale: false,
    selectedFile: undefined
  }
});

export const setWorkspaceFile = (
  model: HarnessReadModel,
  selectedFile: WorkspaceFile
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  workspace: { ...model.workspace, selectedFile }
});
