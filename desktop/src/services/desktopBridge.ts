import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  RuntimeSnapshot,
  RuntimeContextSidecarStatus,
  RuntimeTaskResponse,
  RuntimeTaskOptions,
  RuntimeEvent,
  RuntimeCancellation,
  RuntimeProcessStatus,
  RuntimeRecoveryResponse,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceGrant,
  ThreadReadModel,
  RuntimeExecutionRecord,
  RuntimeExecutionStateResponse,
  RuntimeDashboardResponse,
  RuntimeMemoryRecord,
  RuntimeDreamRun,
  RuntimeDreamMaintenanceStatus,
  RuntimePluginGovernanceRecord,
  RuntimePluginVersionLifecycleSnapshot,
  RuntimeEvolutionProposal,
  RuntimeEvolutionReport,
  RuntimeTimelinePage
} from '../domain/models';
import type { ModelConfig, ModelConfigResponse } from '../domain/models';

// Tauri injects the `isTauri` marker before the page scripts run.  Checking
// the internal IPC object directly is tempting, but it is not a stable public
// runtime check (and can be absent briefly in a WebView during startup).  Use
// the official helper and retain the IPC check as a compatibility fallback for
// older Tauri runtimes and test doubles.
const isTauriRuntime = (): boolean => {
  try {
    return isTauri() || '__TAURI_INTERNALS__' in window;
  } catch {
    return false;
  }
};

const mockEntries: WorkspaceEntry[] = [
  { name: 'contracts', relativePath: 'contracts', kind: 'DIRECTORY', sizeBytes: 0 },
  { name: 'desktop', relativePath: 'desktop', kind: 'DIRECTORY', sizeBytes: 0 },
  { name: 'docs', relativePath: 'docs', kind: 'DIRECTORY', sizeBytes: 0 },
  { name: 'README.md', relativePath: 'README.md', kind: 'FILE', sizeBytes: 1810 }
];

const normalizeThread = (thread: ThreadReadModel & { turns?: unknown[] }): ThreadReadModel => ({
  ...thread,
  turnCount: Number.isInteger(thread.turnCount)
    ? thread.turnCount
    : Array.isArray(thread.turns) ? thread.turns.length : 0
});

export interface ThreadEventPage {
  threadId: string;
  thread?: ThreadReadModel;
  events: RuntimeEvent[];
  limit: number;
  hasMore: boolean;
  nextCursor?: string;
}

export const desktopBridge = {
  isNative: isTauriRuntime,

  async runtimeSnapshot(): Promise<RuntimeSnapshot | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<RuntimeSnapshot>('runtime_snapshot');
  },

  async modelConfig(): Promise<ModelConfigResponse | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<ModelConfigResponse>('model_config');
  },

  async saveModelConfig(config: ModelConfig): Promise<ModelConfigResponse> {
    if (!isTauriRuntime()) throw new Error('Web 预览不支持保存模型配置');
    return invoke<ModelConfigResponse>('save_model_config', { config });
  },

  async contextSidecarStatus(): Promise<RuntimeContextSidecarStatus | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<RuntimeContextSidecarStatus>('context_sidecar_status');
  },

  async runtimeProcessStatus(): Promise<RuntimeProcessStatus> {
    if (!isTauriRuntime()) return {
      running: false,
      pid: null,
      startedAtMs: null,
      lastHeartbeatAtMs: null,
      healthy: false
    };
    return invoke<RuntimeProcessStatus>('runtime_process_status');
  },

  async exportData(scope: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    if (!isTauriRuntime()) return { ok: false, error: 'Web 预览不支持导出数据' };
    return invoke<{ ok: boolean; output?: string; error?: string }>('export_data', { scope });
  },

  async saveTaskResult(fileName: string, content: string): Promise<{ ok: boolean; cancelled?: boolean; output?: string; error?: string }> {
    if (!isTauriRuntime()) return { ok: false, error: '请在桌面客户端中保存任务结果' };
    return invoke<{ ok: boolean; cancelled?: boolean; output?: string; error?: string }>('save_task_result', { fileName, content });
  },

  async reconcileRuntimeState(): Promise<RuntimeRecoveryResponse> {
    if (!isTauriRuntime()) return {
      ok: true,
      reconciled: 0,
      execution: { reconciled: 0, records: [] },
      roles: { reconciled: 0, contexts: [] }
    };
    return invoke<RuntimeRecoveryResponse>('reconcile_runtime_state');
  },

  async chooseWorkspace(): Promise<WorkspaceGrant> {
    if (!isTauriRuntime()) return { rootLabel: 'dda 演示工作区', rootPath: '/demo/dda' };
    return invoke<WorkspaceGrant>('choose_workspace');
  },

  async setWorkspace(path: string): Promise<WorkspaceGrant> {
    if (!isTauriRuntime()) {
      const normalized = path.trim();
      return { rootLabel: normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized, rootPath: normalized };
    }
    return invoke<WorkspaceGrant>('set_workspace', { path });
  },

  async defaultWorkspace(): Promise<WorkspaceGrant | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<WorkspaceGrant>('default_workspace');
  },

  async listWorkspace(relativePath = ''): Promise<WorkspaceEntry[]> {
    if (!isTauriRuntime()) {
      if (relativePath === '') return mockEntries;
      if (relativePath === 'desktop') {
        return [
          { name: 'src', relativePath: 'desktop/src', kind: 'DIRECTORY', sizeBytes: 0 },
          { name: 'package.json', relativePath: 'desktop/package.json', kind: 'FILE', sizeBytes: 642 }
        ];
      }
      return [];
    }
    return invoke<WorkspaceEntry[]>('list_workspace', { relativePath });
  },

  async readWorkspaceFile(relativePath: string): Promise<WorkspaceFile> {
    if (!isTauriRuntime()) {
      return {
        relativePath,
        content: `# ${relativePath}\n\n这是 Web 预览中的只读文件示例。原生 Tauri 模式会从用户明确授权的目录读取内容。`,
        contentDigest: 'sha256:19f6eb548592afc03e8c68cb4f4927e53f48c4f851465df67ec61ec16b634f6e',
        totalBytes: 132,
        truncated: false,
        binary: false
      };
    }
    return invoke<WorkspaceFile>('read_workspace_file', {
      relativePath,
      maxBytes: 262144
    });
  },

  async listThreads(): Promise<ThreadReadModel[]> {
    if (!isTauriRuntime()) return [];
    const response = await invoke<{ threads?: ThreadReadModel[] }>('list_threads');
    return Array.isArray(response.threads) ? response.threads.map(normalizeThread) : [];
  },

  async getThread(threadId: string): Promise<(ThreadReadModel & { turns: Array<{ id: string; summary: string; state: string; atMs: number }> }) | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ thread?: ThreadReadModel & { turns: Array<{ id: string; summary: string; state: string; atMs: number }> } }>('get_thread', { threadId });
    return response.thread
      ? normalizeThread(response.thread) as ThreadReadModel & { turns: Array<{ id: string; summary: string; state: string; atMs: number }> }
      : undefined;
  },

  async listThreadEvents(threadId: string, { limit = 100, before }: { limit?: number; before?: string } = {}): Promise<ThreadEventPage> {
    if (!isTauriRuntime()) return { threadId, events: [], limit, hasMore: false };
    const response = await invoke<ThreadEventPage>('list_thread_events', { threadId, limit, before });
    if (response.threadId !== threadId || !Array.isArray(response.events) || response.events.length > limit
      || (response.hasMore && !response.nextCursor)) throw new Error('THREAD_HISTORY_PAGE_INVALID');
    return { ...response, thread: response.thread ? normalizeThread(response.thread) : undefined };
  },

  async forkThread(threadId: string, title?: string): Promise<ThreadReadModel | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ thread?: ThreadReadModel }>('fork_thread', { threadId, title });
    return response.thread;
  },

  async listExecutionState(recordType?: RuntimeExecutionRecord['recordType']): Promise<RuntimeExecutionRecord[]> {
    if (!isTauriRuntime()) return [];
    const response = await invoke<RuntimeExecutionStateResponse>('list_execution_state', { recordType });
    return Array.isArray(response.records) ? response.records : [];
  },

  async runtimeDashboard({ details = false }: { details?: boolean } = {}): Promise<RuntimeDashboardResponse | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<RuntimeDashboardResponse>('runtime_dashboard', { details });
    return {
      ...response,
      threads: Array.isArray(response.threads) ? response.threads.map(normalizeThread) : [],
      execution: {
        ...response.execution,
        records: Array.isArray(response.execution?.records) ? response.execution.records : []
      },
      feedback: Array.isArray(response.feedback) ? response.feedback : [],
      memories: Array.isArray(response.memories) ? response.memories : [],
      dreams: Array.isArray(response.dreams) ? response.dreams : [],
      plugins: Array.isArray(response.plugins) ? response.plugins : [],
      evolution: {
        proposals: Array.isArray(response.evolution?.proposals) ? response.evolution.proposals : [],
        reports: Array.isArray(response.evolution?.reports) ? response.evolution.reports : [],
        control: response.evolution?.control ?? { enabled: true, changedAtMs: 0 }
      }
    };
  },

  async runtimeTimelinePage(cursor: number, limit = 200): Promise<RuntimeTimelinePage | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ timelinePage?: RuntimeTimelinePage }>('runtime_timeline_page', { cursor, limit });
    return response.timelinePage;
  },

  async getExecutionState(recordId: string): Promise<RuntimeExecutionRecord | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ record?: RuntimeExecutionRecord }>('get_execution_state', { recordId });
    return response.record;
  },

  async reconcileExecutionState(): Promise<{ reconciled: number }> {
    if (!isTauriRuntime()) return { reconciled: 0 };
    return invoke<{ reconciled: number }>('reconcile_execution_state');
  },

  async cancelExecutionApproval(recordId: string, expectedDigest?: string): Promise<RuntimeExecutionRecord | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ record?: RuntimeExecutionRecord }>('cancel_execution_approval', { recordId, expectedDigest });
    return response.record;
  },

  async revokeExecutionLease(recordId: string, expectedDigest?: string): Promise<RuntimeExecutionRecord | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ record?: RuntimeExecutionRecord }>('revoke_execution_lease', { recordId, expectedDigest });
    return response.record;
  },

  async listMemories(status?: string): Promise<RuntimeMemoryRecord[]> {
    if (!isTauriRuntime()) return [];
    const response = await invoke<{ memories?: RuntimeMemoryRecord[] }>('list_memories', { status });
    return Array.isArray(response.memories) ? response.memories : [];
  },

  async memoryAction(operation: 'propose' | 'edit' | 'resolve-conflict' | 'verify' | 'activate' | 'retract' | 'delete', options: {
    memoryId?: string;
    statement?: string;
    scope?: string;
    confidence?: number;
    sourceEventIds?: string[];
    sensitivity?: string;
    conflictsWithMemoryIds?: string[];
    accepted?: boolean;
    reason?: string;
  } = {}): Promise<RuntimeMemoryRecord | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ memory?: RuntimeMemoryRecord }>('memory_action', {
      operation,
      memoryId: options.memoryId,
      statement: options.statement,
      scope: options.scope,
      confidence: options.confidence,
      sourceEventIds: options.sourceEventIds,
      sensitivity: options.sensitivity,
      conflictsWithMemoryIds: options.conflictsWithMemoryIds,
      accepted: options.accepted,
      reason: options.reason
    });
    return response.memory;
  },

  async listDreamRuns(projectId?: string): Promise<RuntimeDreamRun[]> {
    if (!isTauriRuntime()) return [];
    const response = await invoke<{ runs?: RuntimeDreamRun[] }>('list_dream_runs', { projectId });
    return Array.isArray(response.runs) ? response.runs : [];
  },

  async runDream(options: { projectId?: string; idle?: boolean; safetyAllowed?: boolean; activeRuns?: number } = {}): Promise<{ dream?: RuntimeDreamRun; proposedMemories?: RuntimeMemoryRecord[] }> {
    if (!isTauriRuntime()) return {};
    return invoke<{ dream?: RuntimeDreamRun; proposedMemories?: RuntimeMemoryRecord[] }>('run_dream', options);
  },

  async dreamMaintenanceStatus(): Promise<RuntimeDreamMaintenanceStatus | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<RuntimeDreamMaintenanceStatus>('dream_maintenance_status');
  },

  async startDreamMaintenance(options: { projectId?: string; intervalMs?: number; failureLimit?: number } = {}): Promise<RuntimeDreamMaintenanceStatus | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<RuntimeDreamMaintenanceStatus>('start_dream_maintenance', options);
  },

  async stopDreamMaintenance(): Promise<RuntimeDreamMaintenanceStatus | undefined> {
    if (!isTauriRuntime()) return undefined;
    return invoke<RuntimeDreamMaintenanceStatus>('stop_dream_maintenance');
  },

  async listPluginGovernance(): Promise<{ plugins: RuntimePluginGovernanceRecord[]; versionLifecycle?: RuntimePluginVersionLifecycleSnapshot }> {
    if (!isTauriRuntime()) return { plugins: [] };
    const response = await invoke<{ plugins?: RuntimePluginGovernanceRecord[]; versionLifecycle?: RuntimePluginVersionLifecycleSnapshot }>('list_plugin_governance');
    return {
      plugins: Array.isArray(response.plugins) ? response.plugins : [],
      ...(response.versionLifecycle ? { versionLifecycle: response.versionLifecycle } : {})
    };
  },

  async pluginAction(pluginId: string, operation: 'validate' | 'transition', state?: string): Promise<RuntimePluginGovernanceRecord | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ plugin?: RuntimePluginGovernanceRecord }>('plugin_action', { pluginId, operation, state });
    return response.plugin;
  },

  async listEvolution(): Promise<{ proposals: RuntimeEvolutionProposal[]; reports: RuntimeEvolutionReport[] }> {
    if (!isTauriRuntime()) return { proposals: [], reports: [] };
    const response = await invoke<{ proposals?: RuntimeEvolutionProposal[]; reports?: RuntimeEvolutionReport[] }>('list_evolution');
    return {
      proposals: Array.isArray(response.proposals) ? response.proposals : [],
      reports: Array.isArray(response.reports) ? response.reports : []
    };
  },

  async evolutionAction(proposalId: string, operation: 'transition' | 'rollback' | 'monitor', state?: string, reason?: string, minSamples?: number): Promise<RuntimeEvolutionProposal | undefined> {
    if (!isTauriRuntime()) return undefined;
    const response = await invoke<{ proposal?: RuntimeEvolutionProposal }>('evolution_action', { proposalId, operation, state, reason, minSamples });
    return response.proposal;
  },

  async runModelTask(prompt: string, model?: string, options: RuntimeTaskOptions = {}): Promise<RuntimeTaskResponse> {
    if (!isTauriRuntime()) {
      return {
        ok: false,
        error: 'Web 预览没有连接 Cordis runtime',
        plugins: []
      };
    }
    return invoke<RuntimeTaskResponse>('run_model_task', { prompt, model, ...options });
  },

  async listenRuntimeEvents(handler: (event: RuntimeEvent) => void): Promise<UnlistenFn | undefined> {
    if (!isTauriRuntime()) return undefined;
    return listen<RuntimeEvent>('runtime-event', (event) => handler(event.payload));
  },

  async listenContextSidecarStatus(handler: (status: RuntimeContextSidecarStatus) => void): Promise<UnlistenFn | undefined> {
    if (!isTauriRuntime()) return undefined;
    return listen<RuntimeContextSidecarStatus>('context-sidecar-status', (event) => handler(event.payload));
  },

  async listenDreamMaintenanceStatus(handler: (status: RuntimeDreamMaintenanceStatus) => void): Promise<UnlistenFn | undefined> {
    if (!isTauriRuntime()) return undefined;
    return listen<RuntimeDreamMaintenanceStatus>('dream-maintenance-status', (event) => handler(event.payload));
  },

  async resolveRuntimeApproval(requestId: string, approved: boolean, displayedDigest: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke('resolve_runtime_approval', { requestId, approved, displayedDigest });
  },

  async cancelModelTask(): Promise<RuntimeCancellation> {
    if (!isTauriRuntime()) return { cancelled: false };
    return invoke<RuntimeCancellation>('cancel_model_task');
  }
};
