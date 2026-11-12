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
import { projectRoleActivity } from './role-activity';

const makeId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

export const createInitialReadModel = (): HarnessReadModel => ({
  schemaVersion: '1.0',
  projectionVersion: 1,
  connection: {
    state: 'CONNECTING',
    mode: 'MOCK',
    label: '正在启动本地运行时'
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
      title: 'dda',
      body: 'Windows 工作台已启动。你可以授权一个项目目录，然后让 dda 直接完成任务。',
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
    mode: 'CONTROLLED',
    enabled: true,
    placeholder: '描述任务，必要的副作用会逐项请求审批'
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
    label: snapshot ? 'Windows 本地运行时已就绪' : 'Web 预览使用模拟运行时'
  },
  // Fresh health replaces runtime, including cellsAvailability. cellsSession
  // stays on the model so a per-invoke health check cannot erase a live session.
  runtime: snapshot ?? model.runtime,
  // Historical snapshots may still carry the old mode. Never use it to grant
  // capabilities or select a different execution path for the next task.
  composer: { ...model.composer, mode: 'CONTROLLED', placeholder: '描述任务，必要的副作用会逐项请求审批' }
});

export const setCellsSession = (
  model: HarnessReadModel,
  session: HarnessReadModel['cellsSession']
): HarnessReadModel => ({
  ...model,
  projectionVersion: model.projectionVersion + 1,
  cellsSession: session
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

const isSubAgentActive = (state: SubAgentState): boolean => state === 'STARTING' || state === 'RUNNING' || state === 'WAITING';

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
        ? { ...agent,
            state: agent.runtimeRole && !agent.workStarted ? 'SKIPPED' : terminalAgentState,
            ...(agent.runtimeRole ? { task: !agent.workStarted ? '本轮未调用'
              : state === 'SUCCEEDED' ? '本轮执行已完成'
                : state === 'CANCELLED' ? '任务已取消，角色工作已停止' : '任务未完成，角色工作已停止' } : {}),
            updatedAtMs: now }
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
      ...patch,
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
): HarnessReadModel => projectRoleActivity(model, event, upsertSubAgent);

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
      title: 'dda',
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

/** Trim only the failed stream attempt's tail from a still-STREAMING bubble (Fix 2 desktop). */
export const discardStreamingTail = (
  model: HarnessReadModel,
  itemId: string,
  chars: number
): HarnessReadModel => {
  if (!Number.isFinite(chars) || chars <= 0) return model;
  const index = model.timeline.findIndex((item) => item.itemId === itemId);
  if (index < 0) return model;
  const current = model.timeline[index];
  if (current.status !== 'STREAMING') return model;
  const nextTimeline = model.timeline.slice();
  nextTimeline[index] = {
    ...current,
    body: current.body.slice(0, Math.max(0, current.body.length - chars))
  };
  return {
    ...model,
    projectionVersion: model.projectionVersion + 1,
    timeline: nextTimeline
  };
};

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
