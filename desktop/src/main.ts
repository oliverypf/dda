import ArrowLeft from 'lucide/dist/esm/icons/arrow-left.mjs';
import Bot from 'lucide/dist/esm/icons/bot.mjs';
import CheckCircle2 from 'lucide/dist/esm/icons/circle-check.mjs';
import ChevronDown from 'lucide/dist/esm/icons/chevron-down.mjs';
import ChevronRight from 'lucide/dist/esm/icons/chevron-right.mjs';
import CircleAlert from 'lucide/dist/esm/icons/circle-alert.mjs';
import Cpu from 'lucide/dist/esm/icons/cpu.mjs';
import Database from 'lucide/dist/esm/icons/database.mjs';
import File from 'lucide/dist/esm/icons/file.mjs';
import FileCog from 'lucide/dist/esm/icons/file-cog.mjs';
import Folder from 'lucide/dist/esm/icons/folder.mjs';
import FolderOpen from 'lucide/dist/esm/icons/folder-open.mjs';
import Gauge from 'lucide/dist/esm/icons/gauge.mjs';
import HeartPulse from 'lucide/dist/esm/icons/heart-pulse.mjs';
import History from 'lucide/dist/esm/icons/rotate-ccw-clock.mjs';
import LayoutDashboard from 'lucide/dist/esm/icons/layout-dashboard.mjs';
import ListTree from 'lucide/dist/esm/icons/list-tree.mjs';
import LoaderCircle from 'lucide/dist/esm/icons/loader-circle.mjs';
import PanelRight from 'lucide/dist/esm/icons/panel-right.mjs';
import Plus from 'lucide/dist/esm/icons/plus.mjs';
import Search from 'lucide/dist/esm/icons/search.mjs';
import Send from 'lucide/dist/esm/icons/send.mjs';
import Settings from 'lucide/dist/esm/icons/settings.mjs';
import ShieldCheck from 'lucide/dist/esm/icons/shield-check.mjs';
import Square from 'lucide/dist/esm/icons/square.mjs';
import TerminalSquare from 'lucide/dist/esm/icons/square-terminal.mjs';
import UserRound from 'lucide/dist/esm/icons/user-round.mjs';
import XCircle from 'lucide/dist/esm/icons/circle-x.mjs';
import replaceElement from 'lucide/dist/esm/replaceElement.mjs';
import './styles.css';
import { removeDeletedRunTimeline } from './domain/projection-status';
import { parseNetworkTargetsText } from './domain/network-targets';
import { resolveRuntimeResultIdentity } from './domain/runtime-result-identity';
import { sameWorkspaceRoot, workspaceThreadOptions } from './domain/workspace';
import type { ContinuousVerificationRecord, HarnessReadModel, ModelConfig, ApprovalReadModel,
  ProcessVerificationReadModel, NetworkTargetOption, RunState, RuntimeContextSidecarStatus, RuntimeRecoveryResponse, RuntimeRemoteRecoveryStatus, RuntimeDecisionNode, RuntimeDecisionOption, RuntimeExecutionRecord, RuntimePluginGovernanceRecord, RuntimePluginVersionLifecycleSnapshot, RuntimePluginVersionSummary, RuntimeTaskOptions, SubAgentReadModel, TimelineItem, WorkspaceEntry } from './domain/models';
import {
  appendTimelineItem,
  applyRuntimeSubAgentEvent,
  beginRun,
  cancelPendingApprovals,
  clearWorkspace,
  completeStreamingAgent,
  expireRequestedApprovals,
  createInitialReadModel,
  setRunState,
  setRuntimeReady,
  setContextSidecarStatus,
  setDreamMaintenanceStatus,
  setExecutionMode,
  setActiveThread,
  setThreads,
  setWorkspace,
  setWorkspaceFile,
  upsertApproval,
  upsertStreamingAgent,
  upsertSubAgent
} from './domain/store';
import { desktopBridge, type ThreadEventPage } from './services/desktopBridge';
import type { RuntimeEvent, WorkspaceGrant } from './domain/models';
import { formatVerifierFormValues, parseVerifierFormValues } from './domain/verifier-config';
import { syncKeyedList, syncKeyedListIncrementally } from './ui/keyed-list';
import { LiveTimeline } from './ui/live-timeline';

type IconNode = [tag: string, attrs: Record<string, string>][];

const createIcons = ({ icons }: { icons: Record<string, IconNode> }, root: ParentNode = document): void => {
  root.querySelectorAll<HTMLElement>('[data-lucide]').forEach((element) => {
    replaceElement(element, { nameAttr: 'data-lucide', icons, attrs: {} });
  });
};

const app = document.querySelector<HTMLDivElement>('#app');

// Transcript 滚动状态：sticky 表示"跟随到底"。由 scroll 事件维护，
// innerHTML 全量重绘不会丢失用户的阅读位置。
let transcriptStick = true;
let transcriptScrollTop = 0;
let contextScrollTop = 0;
// Preserve the user's choice while live runtime events trigger rerenders.
let executionGroupExpanded = false;
// Prevent overlapping history reads/replays when the user clicks rows rapidly.
interface HistoryView {
  threadId: string;
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  cursor?: string;
  error?: string;
}
let historyView: HistoryView | undefined;
let historyRenderSerial = 0;
const savedNavigation = localStorage.getItem('hmcodex.nav');
let navigationTouched = false;

// A thread switch should not pay the Node process/SQLite cost again when the
// user returns to a task that has not changed. Keep only the first window in
// memory; older pages remain explicitly paged from the runtime.
const HISTORY_PAGE_CACHE_LIMIT = 8;
const historyPageCache = new Map<string, {
  page?: ThreadEventPage;
  request: Promise<ThreadEventPage>;
  summaryKey?: string;
}>();
const historySummaryKey = (thread: ThreadEventPage['thread']): string | undefined => {
  if (!thread) return undefined;
  return JSON.stringify([thread.id, thread.updatedAtMs, thread.turnCount,
    thread.state, thread.resumable, thread.checkpoint?.runId ?? null]);
};
const reconcileHistoryPageCache = (threads: ThreadEventPage['thread'][]): void => {
  const summaries = new Map(threads.filter((thread): thread is NonNullable<typeof thread> => Boolean(thread))
    .map((thread) => [thread.id, historySummaryKey(thread)] as const));
  for (const [threadId, entry] of historyPageCache) {
    const summaryKey = summaries.get(threadId);
    if (entry.page && summaryKey !== undefined && entry.summaryKey !== summaryKey) historyPageCache.delete(threadId);
  }
};
const loadInitialHistoryPage = (threadId: string): Promise<ThreadEventPage> => {
  const cached = historyPageCache.get(threadId);
  if (cached) {
    // Map insertion order is the LRU order for this small bounded cache.
    historyPageCache.delete(threadId);
    historyPageCache.set(threadId, cached);
    return cached.page ? Promise.resolve(cached.page) : cached.request;
  }
  const request = desktopBridge.listThreadEvents(threadId).then((page) => {
    const entry = historyPageCache.get(threadId);
    if (entry?.request === request) {
      entry.page = page;
      entry.summaryKey = historySummaryKey(page.thread);
    }
    return page;
  }).catch((error) => {
    const entry = historyPageCache.get(threadId);
    if (entry?.request === request) historyPageCache.delete(threadId);
    throw error;
  });
  historyPageCache.set(threadId, { request });
  while (historyPageCache.size > HISTORY_PAGE_CACHE_LIMIT) {
    const oldest = historyPageCache.keys().next().value;
    if (oldest === undefined) break;
    historyPageCache.delete(oldest);
  }
  return request;
};
const savedNavigationThreadId = (): string | undefined => {
  try {
    const saved = JSON.parse(savedNavigation ?? '') as { threadId?: unknown };
    return typeof saved.threadId === 'string' && saved.threadId ? saved.threadId : undefined;
  } catch {
    return undefined;
  }
};
document.addEventListener('scroll', (event) => {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (target.classList?.contains('transcript')) {
    transcriptScrollTop = target.scrollTop;
    transcriptStick = target.scrollTop + target.clientHeight >= target.scrollHeight - 64;
  } else if (target.classList?.contains('context-panel')) {
    contextScrollTop = target.scrollTop;
  }
}, { capture: true, passive: true });
document.addEventListener('toggle', (event) => {
  const group = event.target instanceof HTMLDetailsElement
    ? event.target.closest<HTMLDetailsElement>('[data-execution-group]')
    : null;
  // Rendering restores disclosure state and also queues a native toggle event.
  // Only user changes should schedule another render (especially on idle tasks).
  if (group?.isConnected && event.target === group && group.open !== executionGroupExpanded) {
    executionGroupExpanded = group.open;
    if (group.closest('[data-live-workbench]')) scheduleRender();
  }
}, true);
document.addEventListener('click', (event) => {
  const target = event.target as Element | null;
  const summary = target?.closest('[data-execution-group] > summary');
  if (!summary) return;
  const group = summary.closest<HTMLDetailsElement>('[data-execution-group]');
  if (!group) return;
  // The native details toggle runs after the click event. Read the final
  // state on the next task so a background render cannot race it.
  window.setTimeout(() => {
    executionGroupExpanded = group.open;
    scheduleRender();
  }, 0);
}, true);
if (!app) throw new Error('Missing #app root');

let model: HarnessReadModel = createInitialReadModel();
let contextVisible = window.matchMedia('(min-width: 1121px)').matches;
let running = false;
let pendingCancellationRunId: string | undefined;
let workspaceChanging = false;
let workspaceReady: Promise<void> = Promise.resolve();
// Submitting still waits for recovery; read-only history can render independently.
let runtimeHydrationReady: Promise<void> = Promise.resolve();
let dashboardRefreshInFlight: Promise<void> | undefined;
let historyStartupReady: Promise<void> = Promise.resolve();
let dashboardDetailsLoaded = false;
let executionRefreshQueued = false;
let governanceRefreshQueued = false;
let runtimeStreamObserved = false;
// The desktop creates a local display run id, while Cordis creates its own
// process-scoped run id. Bind the event stream after the runtime's first
// run.started event instead of comparing those unrelated identifiers.
let activeRuntimeRunId: string | undefined;
const deletedRuntimeRunIds = new Set<string>();
const runtimeFailureEvents = new Set<string>();
let runtimeEventFloorMs = 0;
let lastRuntimeEventSequence = 0;
let executionRecords: RuntimeExecutionRecord[] = [];
let pluginVersionSnapshot: RuntimePluginVersionLifecycleSnapshot | undefined;
let projectionRuns: Array<{ runId: string; title: string; state: string; startedAtMs: number; lastEventSequence: number; terminal: boolean }> = [];
// Keep an approval visually pending until the runtime acknowledges it. The
// stdin write only means that the response reached the runtime; it does not
// mean that the persisted Approval/ActionIntent transition succeeded.
const pendingApprovalResolutions = new Set<string>();
const pendingRecoveryActions = new Set<string>();
// Tauri events are delivered globally. Include the run and sequence when
// de-duplicating so reconnects/re-renders cannot append the same event twice.
const observedRuntimeEvents = new Set<string>();
// Network is a separately approved capability. The target allowlist remains
// empty until the user supplies it in Settings, so adding the capability to
// the controlled lease does not open a network path by itself.
const controlledCapabilities = ['shell.execute', 'file.write', 'test.execute', 'network.request'];
const controlledCommands = ['node', 'npm', 'npx', 'cargo', 'rustc', 'git'];
// Network stays disabled until the user types an explicit allowlist. The
// runtime re-validates every request and every lease regardless of this text.
const controlledNetworkTargets = {
  text: '',
  error: '' as string,
  parsed: [] as NetworkTargetOption[]
};
let activePage = localStorage.getItem('hmcodex.activePage') ?? 'workbench';
type SubmitReceiptStatus = 'pending' | 'accepted' | 'rejected' | 'unconfirmed';
interface SubmitReceipt { id: string; prompt: string; status: SubmitReceiptStatus; atMs: number; }
let lastSubmitReceipt: SubmitReceipt | undefined;
let memoryActionError = '';
let governanceReadFailed = false;
const pendingMemoryActions = new Set<string>();
const memoryActionsAwaitingRefresh = new Set<string>();
const syncMemoryActionControls = (): void => {
  app.querySelectorAll<HTMLButtonElement>('[data-action="memory-action"]').forEach((button) => {
    const pending = pendingMemoryActions.has(button.dataset.memoryId ?? '') || memoryActionsAwaitingRefresh.has(button.dataset.memoryId ?? '');
    if (pending) {
      button.dataset.idleLabel ??= button.textContent ?? '';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = pendingMemoryActions.has(button.dataset.memoryId ?? '') ? '处理中…' : '等待刷新';
    } else if (button.dataset.idleLabel !== undefined) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
};
let lastRecovery: { reconciled: number; atMs: number; execution: number; roles: number; dream: number; pendingApprovals: number; pendingApprovalRecords: Array<Record<string, unknown>>; leaseRecords: RuntimeExecutionRecord[]; revokedLeases: number; revokedLeaseRecords: Array<Record<string, unknown>>; executionRecords: RuntimeExecutionRecord[]; workspace?: { status?: string; head?: string | null; observationDigest?: string | null; changedFiles?: number; staged?: number; unstaged?: number; untracked?: number; conflicted?: number; statusCodes?: string[]; pathDigests?: string[]; pathDigestTruncated?: boolean }; remote?: RuntimeRemoteRecoveryStatus } | undefined;
let exportNotice: string | undefined;
let focusedRunId: string | null = null;
let runsPage = 1;
let memoryPage = 1;
interface MemoryEditState {
  memoryId: string;
  statement: string;
  scope: string;
  confidence: string;
  sourceEventIds: string;
  sensitivity: string;
}
let memoryEditState: MemoryEditState | undefined;
let memoryEditError = '';
let pinnedModel: string | null = localStorage.getItem('hmcodex.pinnedModel') || null;
const primaryPages: Record<string, { title: string; description: string }> = {
  workbench: { title: '工作台', description: '' },
  runs: { title: '运行记录', description: '历史运行、状态和证据将在此处集中查看。' },
  workspace: { title: '工作区', description: '授权工作区、快照和文件证据将在此处集中查看。' },
  memory: { title: '记忆', description: '已激活记忆和后台整理状态将在此处集中查看。' },
  safety: { title: '能力与安全', description: '能力边界、审批、安全与治理快照将在此处集中查看。' },
  diagnostics: { title: '设置与诊断', description: '模型、存储、支持包和故障诊断将在此处集中查看。' }
};
let settingsVisible = false;
let settingsLoading = false;
let settingsSaving = false;
let settingsError = '';
let settingsSaved = false;
let settingsConfigPath = '';
let settingsConfig: ModelConfig | undefined;
const settingsSections = {
  connection: { title: '连接与身份', description: '查看当前平台、runtime 健康和配置来源。敏感值只显示状态。', icon: 'heart-pulse' },
  model: { title: '角色与模型', description: '选择模型服务与连接方式。保存后从下一次任务开始生效。', icon: 'cpu' },
  jev: { title: 'Jev 决策平面', description: '配置真实 Jev endpoint、端口、模型和认证环境变量。', icon: 'waypoints' },
  workspace: { title: '工作区授权', description: '查看只读工作区授权目录、快照和项目来源。', icon: 'folder-open' },
  plugins: { title: '插件', description: '查看插件治理、版本和当前发布渠道。', icon: 'file-cog' },
  verifier: { title: '安全、审批与连续验证', description: '调整验证预算，并查看审批与安全策略的当前状态。', icon: 'shield-check' },
  memory: { title: '记忆与后台整理', description: '查看记忆状态、后台整理和治理数量。', icon: 'heart-pulse' },
  personalization: { title: '隐私/保留与个性化', description: '设置回复习惯，并查看敏感数据与保留策略状态。', icon: 'user-round' },
  storage: { title: '存储', description: '查看配置路径、投影版本和持久化状态。', icon: 'file-cog' },
  accessibility: { title: '无障碍', description: '查看键盘、字体、对比度和减少动画支持状态。', icon: 'settings' },
  diagnostics: { title: '开发诊断', description: '查看支持包、错误恢复和诊断入口。', icon: 'gauge' },
};
type SettingsSection = keyof typeof settingsSections;
let settingsSection: SettingsSection = 'model';
let settingsSearch = '';
let settingsDraft: Record<string, string> | undefined;

interface ProjectBookmark {
  id: string;
  name: string;
  path: string;
  paths: string[];
  lastUsedAtMs: number;
}

interface ProjectGroup {
  id: string;
  name: string;
  path?: string;
  threads: HarnessReadModel['threads'];
  discovered: boolean;
}

const PROJECTS_STORAGE_KEY = 'hmcodex.projects.v1';
const LAST_PROJECT_STORAGE_KEY = 'hmcodex.lastProjectId';
const PROJECTLESS_ID = '__projectless__';
let projectCatalog: ProjectBookmark[] = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ProjectBookmark => Boolean(item) && typeof item === 'object'
      && typeof (item as ProjectBookmark).id === 'string'
      && typeof (item as ProjectBookmark).name === 'string'
      && typeof (item as ProjectBookmark).path === 'string')
      .map((item) => ({ ...item, paths: Array.isArray(item.paths) && item.paths.length ? [...new Set([item.path, ...item.paths].filter(Boolean))] : [item.path], lastUsedAtMs: Number(item.lastUsedAtMs) || 0 }));
  } catch { return []; }
})();
let lastProjectId = localStorage.getItem(LAST_PROJECT_STORAGE_KEY) ?? '';
let projectPickerVisible = false;
let projectPickerMode: 'new-task' | 'select-thread' = 'new-task';
let projectPickerThreadId = '';
let projectPickerBusy = false;
let projectNameDialog: { path: string; suggestedName: string; draftName: string; followUp?: { mode: 'new-task' | 'select-thread'; threadId: string } } | undefined;
let projectNameError = '';
let projectEditDialog: { projectId: string; draftName: string; paths: string[]; busy: boolean; error?: string } | undefined;
let projectsSectionCollapsed = localStorage.getItem('hmcodex.projectsSectionCollapsed') === 'true';
const expandedProjectIds = new Set<string>([lastProjectId, PROJECTLESS_ID].filter(Boolean));
const collapsedProjectIds = new Set<string>();

const projectIdForPath = (path: string): string => {
  const withoutDevicePrefix = path.trim().replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//iu, '//').replace(/^\/\/\?\//u, '');
  const normalized = withoutDevicePrefix.replace(/[\\/]+/gu, '\\').replace(/\\$/u, '').toLocaleLowerCase();
  return normalized ? `project:${normalized}` : PROJECTLESS_ID;
};
const projectNameForPath = (path: string): string => path.trim().split(/[\\/]/).filter(Boolean).pop() || '未命名项目';
const projectTargetPaths = (project: ProjectBookmark): string[] => [...new Set([project.path, ...project.paths].filter(Boolean))];
const persistProjectCatalog = (): void => {
  try { localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projectCatalog)); } catch { /* storage may be unavailable */ }
};
const rememberProject = (path: string, name?: string): ProjectBookmark | undefined => {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  const id = projectIdForPath(trimmed);
  const existing = projectCatalog.find((project) => project.id === id || projectTargetPaths(project).some((target) => sameWorkspaceRoot(target, trimmed)));
  const project = { id: existing?.id ?? id, name: name?.trim() || existing?.name || projectNameForPath(trimmed), path: trimmed, paths: existing ? projectTargetPaths(existing) : [trimmed], lastUsedAtMs: Date.now() };
  projectCatalog = existing
    ? projectCatalog.map((item) => item.id === existing.id ? { ...item, ...project } : item)
    : [project, ...projectCatalog];
  lastProjectId = project.id;
  expandedProjectIds.add(project.id);
  try { localStorage.setItem(LAST_PROJECT_STORAGE_KEY, project.id); } catch { /* storage may be unavailable */ }
  persistProjectCatalog();
  return project;
};
const projectForThread = (thread: HarnessReadModel['threads'][number]): ProjectBookmark | undefined => {
  const path = thread.cwd?.trim();
  if (!path) return undefined;
  return projectCatalog.find((project) => projectTargetPaths(project).some((target) => sameWorkspaceRoot(target, path)));
};
const hasPersistedTurn = (thread: HarnessReadModel['threads'][number]): boolean => thread.turnCount > 0;
const projectGroups = (): ProjectGroup[] => {
  const visibleThreads = model.threads.filter(hasPersistedTurn);
  const groups: ProjectGroup[] = projectCatalog.map((project) => ({
    id: project.id, name: project.name, path: project.path,
    threads: visibleThreads.filter((thread) => Boolean(thread.cwd && projectTargetPaths(project).some((target) => sameWorkspaceRoot(thread.cwd!, target)))),
    discovered: false
  }));
  const discovered = new Map<string, ProjectGroup>();
  const projectIds = new Set(groups.map((group) => group.id));
  const projectless: ProjectGroup = { id: PROJECTLESS_ID, name: '未绑定项目', threads: [], discovered: false };
  for (const thread of visibleThreads) {
    const path = thread.cwd?.trim();
    if (!path) { projectless.threads.push(thread); continue; }
    if (projectForThread(thread)) continue;
    const id = projectIdForPath(path);
    if (projectIds.has(id)) continue;
    const existing = discovered.get(id);
    if (existing) existing.threads.push(thread);
    else discovered.set(id, { id, name: projectNameForPath(path), path, threads: [thread], discovered: true });
  }
  groups.push(...discovered.values());
  groups.push(projectless);
  return groups;
};
const currentProjectId = (): string => {
  const active = model.threads.find((thread) => thread.id === model.activeThreadId);
  if (active?.cwd) return projectForThread(active)?.id ?? projectIdForPath(active.cwd);
  if (!model.workspace.rootPath) return PROJECTLESS_ID;
  return projectCatalog.find((project) => projectTargetPaths(project).some((target) => sameWorkspaceRoot(target, model.workspace.rootPath!)))?.id
    ?? projectIdForPath(model.workspace.rootPath);
};
const renderProjectPicker = (): string => {
  if (!projectPickerVisible) return '';
  const groups = projectGroups();
  const preferred = projectCatalog.find((project) => project.id === lastProjectId);
  return `<div class="project-picker-backdrop" role="presentation">
    <section class="project-picker-card" role="dialog" aria-modal="true" aria-labelledby="project-picker-title">
      <header class="project-picker-header">
        <div><span class="eyebrow">${projectPickerMode === 'new-task' ? '新建会话' : '打开历史会话'}</span><h2 id="project-picker-title">选择项目</h2><p>${projectPickerMode === 'new-task' ? '会话会归入所选项目，下一次新建会自动记住这个选择。' : '先切换到会话所属目录，再打开历史记录。'}</p></div>
        <button class="icon-button" type="button" data-action="close-project-picker" aria-label="关闭"><i data-lucide="x-circle"></i></button>
      </header>
      <div class="project-picker-body">
        ${preferred ? `<button class="project-picker-option project-picker-last-used" type="button" data-action="select-new-task-project" data-project-id="${escapeHtml(preferred.id)}"><i data-lucide="history"></i><span><strong>继续使用 ${escapeHtml(preferred.name)}</strong><small>${escapeHtml(preferred.path)}</small></span><em>上次使用</em></button>` : ''}
        <div class="project-picker-label">已保存项目</div>
        <div class="project-picker-list">
          ${groups.filter((group) => !group.discovered && group.id !== PROJECTLESS_ID && group.id !== preferred?.id).map((group) => `<button class="project-picker-option" type="button" data-action="select-new-task-project" data-project-id="${escapeHtml(group.id)}"><i data-lucide="folder"></i><span><strong>${escapeHtml(group.name)}</strong><small>${escapeHtml(group.path ?? '')}</small></span><span class="project-picker-count">${group.threads.length} 个会话</span></button>`).join('') || (!preferred ? '<div class="project-empty">还没有保存的项目</div>' : '')}
          <button class="project-picker-option project-picker-add" type="button" data-action="add-project"><i data-lucide="plus"></i><span><strong>添加项目</strong><small>选择一个目录并保存到项目列表</small></span></button>
          <button class="project-picker-option project-picker-none" type="button" data-action="select-new-task-project" data-project-id="${PROJECTLESS_ID}"><i data-lucide="circle-alert"></i><span><strong>不选择项目</strong><small>创建未绑定项目的会话</small></span></button>
        </div>
      </div>
      ${projectPickerBusy ? '<div class="project-picker-busy" role="status">正在切换项目…</div>' : ''}
    </section>
  </div>`;
};

const closeProjectPicker = (): void => {
  projectPickerVisible = false;
  projectPickerBusy = false;
  projectPickerThreadId = '';
  render();
};

const renderProjectNameDialog = (): string => {
  const flow = projectNameDialog;
  if (!flow) return '';
  return `<div class="project-picker-backdrop" role="presentation">
    <section class="project-name-card" role="dialog" aria-modal="true" aria-labelledby="project-name-title" aria-describedby="project-name-description">
      <header class="project-name-header"><div><span class="eyebrow">新建项目</span><h2 id="project-name-title">给项目起个名字</h2></div><button class="icon-button" type="button" data-action="cancel-project-name" aria-label="取消"><i data-lucide="x-circle"></i></button></header>
      <p id="project-name-description">这个名称只用于 dda 中识别项目，不会修改文件夹名称。</p>
      <label class="project-name-field"><span>项目名称</span><input data-role="project-name" type="text" maxlength="80" value="${escapeHtml(flow.draftName)}" placeholder="例如：我的 Agent 项目" autocomplete="off"></label>
      ${projectNameError ? `<p class="project-name-error" role="alert">${escapeHtml(projectNameError)}</p>` : ''}
      <div class="project-name-path" title="${escapeHtml(flow.path)}"><i data-lucide="folder-open"></i><span>${escapeHtml(flow.path)}</span></div>
      <footer class="project-name-actions">
        <button class="secondary-button" type="button" data-action="cancel-project-name">取消</button>
        <button class="secondary-button" type="button" data-action="skip-project-name">使用文件夹名</button>
        <button class="primary-action project-name-save" type="button" data-action="save-project-name">保存项目名称</button>
      </footer>
    </section>
  </div>`;
};

const renderProjectEditDialog = (): string => {
  const flow = projectEditDialog;
  if (!flow) return '';
  const project = projectCatalog.find((item) => item.id === flow.projectId);
  if (!project) return '';
  return `<div class="project-picker-backdrop" role="presentation">
    <section class="project-edit-card" role="dialog" aria-modal="true" aria-labelledby="project-edit-title">
      <header class="project-name-header"><div><span class="eyebrow">项目设置</span><h2 id="project-edit-title">编辑项目</h2></div><button class="icon-button" type="button" data-action="cancel-project-edit" aria-label="关闭"><i data-lucide="x-circle"></i></button></header>
      <label class="project-name-field"><span>项目名称</span><input data-role="project-edit-name" type="text" maxlength="80" value="${escapeHtml(flow.draftName)}" autocomplete="off"></label>
      <h3 class="project-target-heading">源文件夹</h3>
      <div class="project-target-list">
        ${flow.paths.map((path, index) => `<div class="project-target-row"><i data-lucide="folder"></i><span title="${escapeHtml(path)}">${escapeHtml(path)}</span><button class="icon-button small" type="button" data-action="remove-project-target" data-project-id="${escapeHtml(flow.projectId)}" data-target-index="${index}" aria-label="移除 ${escapeHtml(path)}" title="${index === 0 ? '主目录不能移除' : '移除'}" ${index === 0 || flow.paths.length <= 1 ? 'disabled' : ''}><i data-lucide="x-circle"></i></button></div>`).join('')}
        <button class="project-target-add" type="button" data-action="add-project-target" data-project-id="${escapeHtml(flow.projectId)}" ${flow.busy ? 'disabled' : ''}><i data-lucide="plus"></i><span>添加文件夹</span></button>
      </div>
      ${flow.error ? `<p class="project-name-error" role="alert">${escapeHtml(flow.error)}</p>` : ''}
      <footer class="project-name-actions"><button class="secondary-button" type="button" data-action="cancel-project-edit">取消</button><button class="primary-action project-name-save" type="button" data-action="save-project-edit" ${flow.busy ? 'disabled' : ''}>保存</button></footer>
      ${flow.busy ? '<div class="project-picker-busy" role="status">正在选择文件夹…</div>' : ''}
    </section>
  </div>`;
};

const captureSettingsDraft = (): void => {
  const form = app?.querySelector<HTMLFormElement>('[data-form="model-settings"]');
  if (form) settingsDraft = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
};

const syncSettingsView = (): void => {
  const dialog = app?.querySelector<HTMLElement>('[data-settings-dialog]');
  if (!dialog) return;
  const query = settingsSearch.trim().toLocaleLowerCase();
  const title = dialog.querySelector('#settings-title');
  const subtitle = dialog.querySelector('[data-settings-description]');
  if (title) title.textContent = query ? '搜索结果' : settingsSections[settingsSection].title;
  if (subtitle) subtitle.textContent = query ? `与“${settingsSearch.trim()}”相关的设置` : settingsSections[settingsSection].description;
  let matches = 0;
  dialog.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => {
    const section = panel.dataset.settingsPanel as SettingsSection;
    const sectionMatches = settingsSections[section].title.toLocaleLowerCase().includes(query);
    let fieldMatches = 0;
    panel.querySelectorAll<HTMLElement>('.settings-field').forEach((field) => {
      const input = field.querySelector<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
      const match = !query || sectionMatches || `${field.textContent} ${input?.placeholder ?? ''}`.toLocaleLowerCase().includes(query);
      field.hidden = !match;
      if (match) fieldMatches++;
    });
    panel.querySelectorAll<HTMLElement>('.settings-grid').forEach((grid) => {
      grid.hidden = ![...grid.children].some((field) => !(field as HTMLElement).hidden);
    });
    panel.hidden = query ? fieldMatches === 0 : section !== settingsSection;
    if (!panel.hidden) matches++;
  });
  dialog.querySelectorAll<HTMLElement>('[data-action="settings-section"]').forEach((button) => {
    const active = !query && button.dataset.section === settingsSection;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const empty = dialog.querySelector<HTMLElement>('[data-settings-empty]');
  if (empty) empty.hidden = !query || matches > 0;
};


const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
const readOnlySettingsValue = (value: unknown, fallback = '未提供'): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

function renderSettingsReadOnlyPanel(section: SettingsSection): string {
  let rows: Array<[string, string]> = [];
  switch (section) {
    case 'connection':
      rows = [
        ['平台', readOnlySettingsValue(model.runtime.platform)],
        ['连接状态', readOnlySettingsValue(model.connection.label || model.connection.state)],
        ['Runtime', readOnlySettingsValue(model.runtime.runtimeReady === true ? '健康检查通过' : '等待健康检查')],
        ['配置来源', readOnlySettingsValue(settingsConfigPath)]
      ];
      break;
    case 'workspace':
      rows = [
        ['授权状态', model.workspace.granted ? '已授权（只读）' : '尚未授权'],
        ['授权 root', readOnlySettingsValue(model.workspace.rootPath ?? model.workspace.rootLabel)],
        ['快照状态', model.workspace.stale ? '快照已过期，需要刷新' : '当前快照'],
        ['当前目录', readOnlySettingsValue(model.workspace.currentPath || '.')]
      ];
      break;
    case 'plugins':
      rows = [
        ['治理记录', `${model.plugins.length} 条`],
        ['版本记录', `${model.pluginVersions.length} 条`],
        ['发布渠道', readOnlySettingsValue(model.runtime.releaseChannel)],
        ['写入策略', '插件变更仍需独立审批']
      ];
      break;
    case 'memory': {
      const active = model.memories.filter((item) => item.status === 'ACTIVE').length;
      const proposed = model.memories.filter((item) => item.status === 'PROPOSED').length;
      const revoked = model.memories.filter((item) => item.status === 'REVOKED').length;
      rows = [
        ['记忆状态', `已启用 ${active} · 待确认 ${proposed} · 已撤回 ${revoked}`],
        ['Dream 记录', `${model.dreamRuns.length} 次`],
        ['后台维护', readOnlySettingsValue(model.runtime.dreamMaintenance?.state, '未托管')],
        ['敏感事实', '普通清理不会隐式放权']
      ];
      break;
    }
    case 'storage':
      rows = [
        ['模型配置路径', readOnlySettingsValue(settingsConfigPath)],
        ['运行投影版本', `v${model.projectionVersion}`],
        ['时间线', `${model.timeline.length} 条当前窗口记录`],
        ['保留策略', '未提供时保持运行时默认值']
      ];
      break;
    case 'accessibility':
      rows = [
        ['键盘操作', '导航、弹窗焦点循环和 Escape 已支持'],
        ['字体与布局', '支持根字体放大和移动端无横向溢出'],
        ['动效/对比度', '支持 prefers-reduced-motion 与 prefers-contrast'],
        ['真实设备', '屏幕阅读器、系统主题和触控仍需实机复核']
      ];
      break;
    case 'diagnostics':
      rows = [
        ['支持包', model.supportBundle ? '已生成状态' : '尚未生成'],
        ['恢复检查', lastRecovery ? `${lastRecovery.reconciled} 条记录 · ${formatTime(lastRecovery.atMs)}` : '尚未运行'],
        ['错误保护', '错误进入时间线并保留当前工作区'],
        ['运行投影版本', `v${model.projectionVersion}`]
      ];
      break;
    default:
      return '';
  }
  return `<section class="settings-group" id="settings-panel-${section}" data-settings-panel="${section}" aria-label="${escapeHtml(settingsSections[section].title)}">
    <h3>${escapeHtml(settingsSections[section].title)}</h3>
    <div class="settings-card">${rows.map(([label, value]) => `<div class="settings-field settings-field-readonly"><span>${escapeHtml(label)}</span><output>${escapeHtml(value)}</output></div>`).join('')}</div>
    <p class="settings-hint">${escapeHtml(settingsSections[section].description)} 当前页面只展示状态；需要副作用的变更仍从对应流程进入并保留审计记录。</p>
  </section>`;
}
const workspaceDisplayPath = (rootPath: string | undefined, rootLabel: string, currentPath: string): string => {
  const root = rootPath?.trim() || rootLabel;
  if (!currentPath) return root;
  const separator = root.includes('\\') ? '\\' : '/';
  const cleanRoot = root.replace(/[\\/]+$/u, '');
  const cleanCurrent = currentPath.replace(/[\\/]+/gu, separator).replace(/^[\\/]+/u, '');
  return `${cleanRoot}${separator}${cleanCurrent}`;
};

const renderSettingsModal = (): string => {
  if (!settingsVisible) return '';
  const config = settingsConfig;
  const verifierValues = formatVerifierFormValues(config?.verifier);
  const customInstructions = config?.customInstructions ?? '';
  const decision = config?.decision ?? {};
  const providerOptions: Array<[ModelConfig['provider'], string]> = [
    ['openai', 'OpenAI Responses'],
    ['openai-responses', 'OpenAI Responses（显式）'],
    ['openai-chat', 'OpenAI Chat Completions'],
    ['compatible', 'OpenAI 兼容接口'],
    ['deepseek', 'DeepSeek Harness']
  ];
  const protocolOptions: Array<[ModelConfig['protocol'], string]> = [
    ['responses', 'Responses API'],
    ['chat-completions', 'Chat Completions'],
    ['deepseek-harness', 'DeepSeek Harness']
  ];
  return `
    <div class="settings-backdrop">
      <section class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-settings-dialog>
        <nav class="settings-sidebar" aria-label="设置分类">
          <button type="button" class="settings-back" data-action="close-settings"><i data-lucide="arrow-left"></i><span>返回应用</span></button>
          <label class="settings-search-wrap"><i data-lucide="search"></i><input name="settingsSearch" class="settings-search" type="search" value="${escapeHtml(settingsSearch)}" placeholder="搜索设置…" aria-label="搜索设置"></label>
          <span class="settings-sidebar-heading">个人</span>
          <div class="settings-nav-list">${(Object.entries(settingsSections) as [SettingsSection, typeof settingsSections[SettingsSection]][]).map(([key, section]) => `<button type="button" class="settings-nav ${settingsSection === key ? 'active' : ''}" data-action="settings-section" data-section="${key}" aria-controls="settings-panel-${key}"><i data-lucide="${section.icon}"></i><span>${section.title}</span></button>`).join('')}</div>
          <p class="settings-sidebar-note">dda · 设置</p>
        </nav>
        <div class="settings-main"><header class="settings-header">
          <div><h2 id="settings-title">${settingsSections[settingsSection].title}</h2><p data-settings-description>${settingsSections[settingsSection].description}</p></div>
          <button class="icon-button" type="button" data-action="close-settings" title="关闭" aria-label="关闭设置"><i data-lucide="x-circle"></i></button>
        </header>
        ${settingsLoading || !config
          ? settingsError
            ? `<div class="settings-form"><div class="settings-message settings-message-error" role="alert">${escapeHtml(settingsError)}</div><button class="secondary-button" data-action="open-settings">重试读取</button></div>`
            : '<div class="settings-loading"><i data-lucide="loader-circle" class="spin"></i><span>正在读取模型配置…</span></div>'
          : `<form class="settings-form" data-form="model-settings" novalidate>
              <div class="settings-panels">\r\n              ${renderSettingsReadOnlyPanel('connection')}\r\n              ${renderSettingsReadOnlyPanel('workspace')}\r\n              ${renderSettingsReadOnlyPanel('plugins')}\r\n              ${renderSettingsReadOnlyPanel('memory')}\r\n              ${renderSettingsReadOnlyPanel('storage')}\r\n              ${renderSettingsReadOnlyPanel('accessibility')}\r\n              ${renderSettingsReadOnlyPanel('diagnostics')}
              <section class="settings-group" id="settings-panel-model" data-settings-panel="model" aria-label="模型配置">
              <h3>模型连接</h3><div class="settings-card">
              <div class="settings-grid">
                <label class="settings-field"><span>Provider</span><select name="provider" data-role="model-provider">${providerOptions.map(([value, label]) => `<option value="${value}" ${config.provider === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
                <label class="settings-field"><span>协议</span><select name="protocol" data-role="model-protocol">${protocolOptions.map(([value, label]) => `<option value="${value}" ${config.protocol === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
              </div>
              <label class="settings-field"><span>模型</span><input name="model" value="${escapeHtml(config.model)}" required maxlength="200" placeholder="例如 gpt-5.2-codex"></label>
              <label class="settings-field"><span>Base URL</span><input name="baseURL" value="${escapeHtml(config.baseURL ?? '')}" maxlength="2000" placeholder="例如 https://api.openai.com/v1"></label>
              <label class="settings-field"><span>完整 Endpoint（可选）</span><input name="endpoint" value="${escapeHtml(config.endpoint ?? '')}" maxlength="2000" placeholder="留空时由 Base URL 和协议生成"></label>
              <div class="settings-grid">
                <label class="settings-field"><span>API Key 环境变量</span><input name="apiKeyEnv" value="${escapeHtml(config.apiKeyEnv)}" required maxlength="120" spellcheck="false"></label>
                <label class="settings-field"><span>会话 Header（可选）</span><input name="sessionHeader" value="${escapeHtml(config.sessionHeader ?? '')}" maxlength="120" spellcheck="false"></label>
              </div>
              </div><p class="settings-hint">API Key 从环境变量读取。已有的高级模型列表和角色绑定保持不变。</p></section>
              <section class="settings-group" id="settings-panel-jev" data-settings-panel="jev" aria-label="Jev 决策平面">
                <h3>Jev 决策平面</h3><div class="settings-card">
                <div class="settings-grid">
                  <label class="settings-field"><span>启用 Jev</span><select name="decisionEnabled"><option value="true" ${decision.enabled !== false ? 'selected' : ''}>启用</option><option value="false" ${decision.enabled === false ? 'selected' : ''}>停用</option></select></label>
                  <label class="settings-field"><span>Jev 模型</span><input name="decisionModel" value="${escapeHtml(decision.model ?? 'jev-latest')}" required maxlength="200" spellcheck="false"></label>
                </div>
                <label class="settings-field"><span>Jev Endpoint（含端口）</span><input name="decisionEndpoint" value="${escapeHtml(decision.endpoint ?? 'https://api.typesafe.ai/v1/system_one')}" required maxlength="2000" placeholder="例如 http://127.0.0.1:8787/decide"></label>
                <div class="settings-grid">
                  <label class="settings-field"><span>Jev API Key 环境变量</span><input name="decisionApiKeyEnv" value="${escapeHtml(decision.apiKeyEnv ?? 'JEV_API_KEY')}" required maxlength="120" spellcheck="false"></label>
                  <label class="settings-field"><span>请求超时（毫秒）</span><input name="decisionTimeoutMs" type="number" min="100" max="10000" step="100" value="${escapeHtml(String(decision.timeoutMs ?? 1200))}"></label>
                </div>
                </div><p class="settings-hint">Endpoint 支持域名、IP 和自定义端口。API Key 只从环境变量读取，不会写入配置文件。</p></section>
              <section class="settings-group" id="settings-panel-personalization" data-settings-panel="personalization" data-role="custom-instructions" aria-label="个性化">
                <h3>自定义指令</h3>
                <div class="settings-card"><label class="settings-field settings-field-multiline"><span>希望助手如何回复？<small>例如：每次回复都使用中文；先给结论，再解释原因。</small></span><textarea name="customInstructions" rows="8" maxlength="8000" aria-describedby="custom-instructions-hint" placeholder="每次回复都使用中文，保持简洁。">${escapeHtml(customInstructions)}</textarea></label></div>
                <p class="settings-hint" id="custom-instructions-hint">适用于所有任务，作为系统级提示随模型请求发送。最多 8000 字符，可分多行。保存后从下一次任务开始生效；清空并保存即可停用。</p>
              </section>
              <section class="settings-group" id="settings-panel-verifier" data-settings-panel="verifier" data-role="verifier-settings" aria-label="连续验证">
                <h3>判定标准与预算</h3><div class="settings-card">
                <label class="settings-field"><span>判定标准（每行一条，最多 8 条）</span><textarea name="verifierCriteria" rows="3" maxlength="8000" spellcheck="false" placeholder="留空使用运行时内置的三条标准">${escapeHtml(verifierValues.verifierCriteria)}</textarea></label>
                <div class="settings-grid">
                  <label class="settings-field"><span>重复次数（1-16）</span><input name="verifierRepetitions" type="number" min="1" max="16" step="1" value="${escapeHtml(verifierValues.verifierRepetitions)}"></label>
                  <label class="settings-field"><span>最大比较数（1-512）</span><input name="verifierMaxComparisons" type="number" min="1" max="512" step="1" value="${escapeHtml(verifierValues.verifierMaxComparisons)}"></label>
                </div>
                <div class="settings-grid">
                  <label class="settings-field"><span>支点数（1-8）</span><input name="verifierPivots" type="number" min="1" max="8" step="1" value="${escapeHtml(verifierValues.verifierPivots)}"></label>
                  <label class="settings-field"><span>提示长度上限（1024-200000）</span><input name="verifierMaxPromptChars" type="number" min="1024" max="200000" step="1" value="${escapeHtml(verifierValues.verifierMaxPromptChars)}"></label>
                </div>
                <label class="settings-field"><span>随机种子（可留空）</span><input name="verifierSeed" maxlength="200" spellcheck="false" value="${escapeHtml(verifierValues.verifierSeed)}"></label>
                <div class="settings-grid">
                  <label class="settings-field"><span>PASS 阈值（0-1）</span><input name="verifierPassThreshold" type="number" min="0" max="1" step="0.01" value="${escapeHtml(verifierValues.verifierPassThreshold)}"></label>
                  <label class="settings-field"><span>FAIL 阈值（0-1）</span><input name="verifierFailThreshold" type="number" min="0" max="1" step="0.01" value="${escapeHtml(verifierValues.verifierFailThreshold)}"></label>
                </div>
                </div><p class="settings-hint">留空即使用运行时默认值（重复 2 次、最大比较 32、支点 2、上限 60000 字符、PASS 0.9 / FAIL 0.5）。清空全部项会从配置文件移除该段。</p>
              </section><p class="settings-empty" data-settings-empty hidden>没有找到匹配的设置，请尝试“中文”“模型”或“验证”。</p>
              </div>
              <div class="settings-save-area" aria-live="polite">
              ${settingsConfigPath ? `<p class="settings-path" title="${escapeHtml(settingsConfigPath)}">${escapeHtml(settingsConfigPath)}</p>` : ''}
              ${settingsError ? `<div class="settings-message settings-message-error" role="alert">${escapeHtml(settingsError)}</div>` : ''}
              ${settingsSaved ? '<div class="settings-message settings-message-success">配置已保存，下一次任务会使用新配置。</div>' : ''}
              <footer class="settings-actions">
                <button class="secondary-button" type="button" data-action="close-settings">取消</button>
                <button class="send-button" type="submit" ${settingsSaving || !desktopBridge.isNative() ? 'disabled' : ''}>${settingsSaving ? '保存中…' : '保存配置'}</button>
              </footer></div>
            </form>`}
      </div></section>
    </div>`;
};

const openSettings = async (): Promise<void> => {
  if (settingsLoading || settingsSaving) return;
  settingsConfig = undefined;
  settingsDraft = undefined;
  settingsSearch = '';
  settingsVisible = true;
  settingsLoading = true;
  settingsError = '';
  settingsSaved = false;
  render();
  try {
    const response = await desktopBridge.modelConfig();
    if (!response) {
      settingsError = 'Web 预览不支持保存模型配置，请在桌面应用中使用此功能。';
      settingsConfig = {
        schemaVersion: '1.0', provider: 'openai-chat', protocol: 'chat-completions', model: 'mimo-v2.5-pro',
        baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY', sessionHeader: 'x-opencode-session'
      };
    } else {
      settingsConfig = response.config;
      settingsConfigPath = response.configPath;
    }
  } catch (error) {
    settingsError = compactError(error);
  } finally {
    settingsLoading = false;
    render();
  }
};

const compactError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
};

const appendErrorTimelineItem = (
  current: HarnessReadModel,
  title: string,
  error: unknown
): HarnessReadModel => {
  const body = compactError(error);
  if (current.timeline.some((item) => item.kind === 'ERROR' && item.title === title && item.body === body)) {
    return current;
  }
  return appendTimelineItem(current, { kind: 'ERROR', title, body, status: 'ERROR' });
};

const formatTime = (timestamp: number): string =>
  new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(timestamp);

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const runStateLabel = (state?: string): string => {
  const labels: Record<string, string> = {
    CREATED: '任务已创建',
    CLASSIFYING: '正在分类任务',
    PRECHECKING: '正在执行安全预检',
    ROUTING: '正在选择执行路线',
    ALLOCATING_CONTEXTS: '正在分配角色上下文',
    PLANNING: '正在整理任务',
    EXECUTING_READ: '正在读取工作区',
    SAFETY_EVALUATING: '正在评估动作安全性',
    WAITING_APPROVAL: '正在等待批准',
    EXECUTING: '正在执行任务',
    VERIFYING: '正在核对结果',
    DIAGNOSING: '正在诊断问题',
    RECOVERING: '正在恢复任务',
    PAUSING: '正在暂停任务',
    PAUSED: '任务已暂停',
    SUCCEEDED: '只读检查完成',
    FAILED: '任务未完成',
    CANCELLED: '任务已取消',
    QUARANTINED: '已隔离',
    PAUSED_UNSUPPORTED: '因不兼容暂停'
  };
  return state ? labels[state] ?? statusDisplayLabel(state) : '等待任务';
};

const runStateNextStep = (state?: string): string => {
  const steps: Record<string, string> = {
    CREATED: '等待运行时开始处理，可随时取消或等待状态推进。',
    CLASSIFYING: '正在识别任务类别，通常在数秒内推进。',
    PRECHECKING: '正在执行安全预检，请等待运行时就绪。',
    ROUTING: '正在选择执行路线，完成后会展示候选与模型摘要。',
    ALLOCATING_CONTEXTS: '正在分配角色上下文，等待模型快照就绪。',
    PLANNING: '正在整理任务计划，可在完成前查看时间线。',
    EXECUTING_READ: '正在读取工作区，任务进展将出现在下方时间线。',
    SAFETY_EVALUATING: '正在评估动作安全性，重要操作会请求批准。',
    WAITING_APPROVAL: '请在上下文面板批准或拒绝；期限过后该次请求会失效。',
    EXECUTING: '任务正在执行，必要时可取消或等待完成。',
    VERIFYING: '正在核对验证结果，终态会显示证据和风险。',
    DIAGNOSING: '正在诊断问题，完成后会给出失败原因与建议。',
    RECOVERING: '正在恢复任务，请勿重复提交同一命令。',
    PAUSING: '正在暂停任务，稍后可在暂停态恢复或取消。',
    PAUSED: '任务已暂停，可取消或在新提交时继续上下文。',
    SUCCEEDED: '检查完成，可查看时间线证据或发起新任务。',
    FAILED: '可查看失败原因与保护措施，修改后重试或创建新任务。',
    CANCELLED: '任务已终态，未执行的动作不会补发，可发起新任务。',
    QUARANTINED: '已隔离，需查看原因并处理治理状态后再发起新任务。',
    PAUSED_UNSUPPORTED: '因版本或能力不兼容暂停，请查看设置与诊断。'
  };
  return state ? steps[state] ?? '等待运行时更新。' : '等待任务输入。';
};

// Runtime contracts intentionally use stable identifiers.  Those identifiers
// are useful in technical details, but they are poor primary copy for people
// reading a task as it runs.  Keep one small presentation vocabulary here so
// live events, historical replay and side panels do not drift apart.
const humanizeCode = (value: unknown, fallback = '未提供'): string => {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const source = value.trim();
  const words = source
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[._:/-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.map((word) => {
    const upper = word.toUpperCase();
    const common: Record<string, string> = {
      API: '接口', APP: '应用', CLI: '命令行', CPU: '处理器', CWD: '工作目录',
      DAG: '决策图', ID: '编号', JEV: 'Jev', PID: '进程号', READ: '读取', WRITE: '写入',
      UNKNOWN: '未知', PASS: '通过', FAIL: '失败', ERROR: '错误', SUCCESS: '成功',
      SUCCEEDED: '已完成', FAILED: '失败', COMPLETE: '已完成', COMPLETED: '已完成',
      PENDING: '等待中', STREAMING: '生成中', ACTIVE: '生效中', PROPOSED: '待评估',
      REJECTED: '已拒绝', DECLINED: '已拒绝', EXPIRED: '已过期', ABSTAIN: '暂不判断',
      ALLOW: '允许', BLOCK: '阻止', REQUEST: '请求', EVIDENCE: '证据',
      LOCAL: '本地', WINDOWS: 'Windows', WEB: '网页预览', NATIVE: '原生',
      SHELL: '命令', FILE: '文件', WORKSPACE: '工作区', NETWORK: '网络', TOOL: '工具',
      MODEL: '模型', ROUTE: '路线', ROLE: '角色', CONTEXT: '上下文', SAFETY: '安全',
      VERIFICATION: '验证', EXECUTION: '执行', LEASE: '授权租约', APPROVAL: '审批',
      POLICY: '策略', OUTPUT: '输出', DIGEST: '摘要', SNAPSHOT: '快照',
      NOT: '不', ALLOWED: '允许', MODE: '模式', DUPLICATE: '重复', REQUESTED: '请求中',
      RETRY: '重试', WITH: '使用', COUNCIL: '审议', PROPOSAL: '候选方案', CRITIQUE: '审阅', JUDGE: '比较', PROBE: '探查',
      REVIEW: '评审', COMMITTED: '已记录', PLANCOMMITTED: '计划已记录', PROBECOMMITTED: '探查已记录',
      COUNCILACCEPTPLAN: '审议通过计划', JUDGERETURNEDDECISION: '比较阶段返回决定', PROBESELECTED: '已选择探查方案'
    };
    return common[upper] ?? (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }).join(' ');
};

const statusDisplayLabel = (value: unknown, fallback = '状态未读取'): string => {
  const key = typeof value === 'string' ? value.toUpperCase() : '';
  const labels: Record<string, string> = {
    CREATED: '已创建', CLASSIFYING: '识别任务中', PRECHECKING: '安全预检中', ROUTING: '选择执行路线中',
    ALLOCATING_CONTEXTS: '分配角色上下文中', PLANNING: '整理计划中', EXECUTING_READ: '读取工作区中',
    SAFETY_EVALUATING: '评估动作安全性中', WAITING_APPROVAL: '等待你的批准', EXECUTING: '执行中',
    VERIFYING: '核对结果中', DIAGNOSING: '诊断中', RECOVERING: '恢复中', PAUSING: '暂停中',
    PAUSED: '已暂停', SUCCEEDED: '已完成', FAILED: '未完成', CANCELLED: '已取消',
    QUARANTINED: '已隔离', PAUSED_UNSUPPORTED: '因版本不兼容暂停', UNKNOWN: '未知状态',
    PASS: '通过', FAIL: '失败', ERROR: '错误', COMPLETE: '已完成', COMPLETED: '已完成', SKIPPED: '已跳过',
    PENDING: '等待中', STREAMING: '进行中', ACTIVE: '生效中', PROPOSED: '待评估', PRESENTED: '已呈现',
    REQUESTED: '等待批准', APPROVED: '已批准', CONSUMING: '消费中', CONSUMED: '已使用',
    REJECTED: '已拒绝', DECLINED: '已拒绝', EXPIRED: '已过期', ABSTAIN: '暂不判断',
    LOCAL_ONLY: '仅本地', READY: '就绪', REVOKED: '已撤销', UNKNOWN_OUTCOME: '结果不确定',
    ERROR_CONNECTION: '连接错误', DISABLED: '未启用', UNAVAILABLE: '不可用', MISCONFIGURED: '配置错误',
    RUNNING: '运行中', STARTING: '准备中', STOPPED: '已停止', DEGRADED: '已降级',
    VERIFIED: '已验证', RETRACTED: '已撤回', LOADED: '已加载', DISCOVERED: '已发现', COMMITTED: '已记录',
    VALIDATED: '已校验', SHADOW: '观察中', CANARY: '灰度中', PROMOTED: '已晋级',
    ROLLED_BACK: '已回滚', INSTALLED: '已安装', ROLLED_BACK_AVAILABLE: '可回滚', BLOCKED: '已阻断'
  };
  return labels[key] ?? (key ? humanizeCode(value, fallback) : fallback);
};

const toolDisplayLabel = (value: unknown): string => {
  const key = typeof value === 'string' ? value.toLowerCase() : '';
  const labels: Record<string, string> = {
    'workspace.list': '查看工作区目录',
    'workspace.read': '读取工作区文件',
    'workspace.snapshot': '记录工作区快照',
    'shell.execute': '执行命令',
    'file.read': '读取文件',
    'file.write': '写入文件',
    'file.patch': '修改文件',
    'test.execute': '运行测试',
    'network.request': '发送网络请求',
    'memory.search': '搜索记忆',
    'memory.write': '保存记忆'
  };
  return labels[key] ?? humanizeCode(value, '受控工具');
};

const reasonDisplayLabel = (value: unknown): string => {
  if (typeof value === 'string' && /runtime\s*未配置/iu.test(value)) return '当前运行时未配置远端恢复源';
  const key = typeof value === 'string' ? value.toUpperCase() : '';
  const labels: Record<string, string> = {
    RULE_PATTERN_MISMATCH: '与当前任务不匹配', POLICY_ALLOWED: '当前策略允许其他路线',
    ROUTE_BLOCKED: '执行路线被安全规则阻止', ROLE_ISOLATION_REQUIRED: '需要隔离角色上下文',
    BOUNDED_EXECUTION_REQUIRED: '需要限制执行范围', OUTCOME_NOT_VERIFIED_SUCCESS: '上次结果尚未验证成功',
    EVIDENCE_GAP_REMAINS: '仍缺少必要证据', JEV_ACTION_GATE_NOT_ALLOW: '安全决策未允许该动作',
    TOOL_NOT_ALLOWED_IN_MODE: '当前模式不允许该工具', TOOL_DUPLICATE_REQUEST: '同一轮重复请求',
    TOOL_EXECUTION_FAILED: '工具执行失败', FIXTURE_UNKNOWN_OUTCOME: '执行结果无法确认',
    COUNCIL_ACCEPT_PLAN: '审议通过计划', JUDGE_RETURNED_DECISION: '比较阶段返回决定', PROBE_SELECTED: '已选择探查方案',
    OWNER_PROCESS_LOST: '原执行进程已退出', CURRENT_RUNTIME_NOT_CONFIGURED: '当前运行时未配置',
    REMOTE_SOURCE_UNAVAILABLE: '远端恢复源不可用', POLICY_DENIED: '安全策略未允许',
    INVALID_REQUEST: '请求格式不正确', TIMEOUT: '操作超时'
  };
  return labels[key] ?? humanizeCode(value, '未提供原因');
};

const riskDisplayLabel = (value: unknown): string => ({
  LOW: '低', MEDIUM: '中', HIGH: '高', CRITICAL: '极高'
}[typeof value === 'string' ? value.toUpperCase() : ''] ?? humanizeCode(value, '未评估'));

const sensitivityDisplayLabel = (value: unknown): string => ({
  PUBLIC: '公开', INTERNAL: '内部', SENSITIVE: '敏感', RESTRICTED: '受限', SECURITY_AUDIT: '安全审计'
}[typeof value === 'string' ? value.toUpperCase() : ''] ?? humanizeCode(value, '未提供'));

const phaseDisplayLabel = (value: unknown): string => {
  const key = typeof value === 'string' ? value.toUpperCase() : '';
  const labels: Record<string, string> = {
    PLANNER: '规划阶段', EXECUTOR: '执行阶段', VERIFIER: '验证阶段', CRITIC: '审阅阶段',
    COORDINATOR: '协调阶段', COUNCIL: '多候选审议', JUDGE: '候选比较', MODEL: '模型调用'
  };
  return labels[key] ?? humanizeCode(value, '当前阶段');
};

const shortDigest = (value?: string): string => value
  ? `${value.slice(0, 18)}${value.length > 18 ? '…' : ''}`
  : '';

const contextSidecarStateLabel = (state?: RuntimeContextSidecarStatus['state']): string => ({
  DISABLED: '未启用',
  MISCONFIGURED: '记忆不可用（配置错误）',
  UNAVAILABLE: '记忆不可用',
  STARTING: '记忆启动中',
  READY: '记忆已就绪（托管）',
  EXTERNAL: '记忆已就绪（外部服务）',
  DEGRADED: '记忆不可用（已降级）',
  STOPPED: '已停止'
}[state ?? ''] ?? state ?? '状态未读取');

const timelineIcon = (item: TimelineItem): string => {
  if (item.kind === 'USER') return 'user-round';
  if (item.kind === 'WORKSPACE') return 'folder-open';
  if (item.kind === 'ERROR') return 'circle-alert';
  if (item.kind === 'STATUS') return item.status === 'COMPLETE' ? 'check-circle-2' : 'loader-circle';
  return 'bot';
};

const subAgentStateLabel = (state: SubAgentReadModel['state']): string => {
  const labels: Record<SubAgentReadModel['state'], string> = {
    STARTING: '准备中',
    RUNNING: '运行中',
    SUCCEEDED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消'
  };
  return labels[state] ?? statusDisplayLabel(state);
};

const executionStateLabel = (state: string): string => ({
  PROPOSED: '待评估',
  SAFETY_EVALUATING: '安全评估',
  PRESENTED: '已呈现',
  WAITING_APPROVAL: '等待批准',
  REQUESTED: '等待批准',
  APPROVED: '已批准',
  ACTIVE: '租约有效',
  EXECUTING: '执行中',
  CONSUMING: '消费中',
  COMPLETED: '已完成',
  CONSUMED: '已消费',
  FAILED: '失败',
  REJECTED: '已拒绝',
  DECLINED: '已拒绝',
  EXPIRED: '已过期'
}[state] ?? statusDisplayLabel(state));

const executionTypeLabel = (recordType: RuntimeExecutionRecord['recordType']): string => ({
  intent: '动作请求',
  approval: '审批请求',
  lease: '一次性授权'
}[recordType]);

const governanceStateLabel = (state: string): string => ({
  PROPOSED: '待提议',
  VERIFIED: '已验证',
  ACTIVE: '已激活',
  RETRACTED: '已撤回',
  EXPIRED: '已过期',
  RUNNING: '运行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  BLOCKED: '已阻断',
  DISCOVERED: '已发现',
  VALIDATED: '已校验',
  LOADED: '已加载',
  QUARANTINED: '已隔离',
  SHADOW: 'Shadow',
  CANARY: 'Canary',
  PROMOTED: '已晋级',
  ROLLED_BACK: '已回滚',
  INSTALLED: '已安装',
  ROLLED_BACK_AVAILABLE: '可回滚',
  DEGRADED: '降级',
  REJECTED: '已拒绝'
}[state] ?? statusDisplayLabel(state));

// The dashboard reports version lifecycle facts directly; the plugin list
// command is the fallback for the manual governance refresh path.
const pluginVersionSummaries = (
  versions: RuntimePluginVersionSummary[] | undefined,
  snapshot: RuntimePluginVersionLifecycleSnapshot | undefined
): RuntimePluginVersionSummary[] => {
  if (Array.isArray(versions) && versions.length) return versions;
  if (!snapshot || !Array.isArray(snapshot.versions)) return [];
  const byPlugin = new Map<string, RuntimePluginVersionSummary>();
  for (const version of snapshot.versions) {
    const entry = byPlugin.get(version.pluginId) ?? { pluginId: version.pluginId, versions: [] };
    entry.versions.push(version);
    byPlugin.set(version.pluginId, entry);
  }
  for (const [pluginId, entry] of byPlugin) {
    const activeKey = snapshot.active?.[pluginId];
    const active = entry.versions.find((item) => `${item.pluginId}@${item.version}` === activeKey);
    if (active) entry.activeVersion = active.version;
  }
  return [...byPlugin.values()];
};

const decisionStatusLabel = (node: RuntimeDecisionNode): string => node.outcomeStatus
  ? `${statusDisplayLabel(node.status)} · 结果：${statusDisplayLabel(node.outcomeStatus)}`
  : statusDisplayLabel(node.status);

const decisionOptionDisplayLabel = (optionId: string): string => ({
  'classify-inspect': '任务类型：检查与阅读',
  'classify-modify': '任务类型：修改文件',
  'classify-test': '任务类型：运行测试',
  'classify-unknown': '任务类型：暂时无法识别',
  'route-selected': '执行路径：允许继续',
  'route-blocked': '执行路径：在安全检查处停止',
  'contexts-dedicated': '上下文：角色隔离',
  'contexts-shared': '上下文：共享角色上下文',
  'plan-bounded-default': '计划：有界执行',
  'plan-abort': '计划：停止执行',
  'memory-proposal-create': '记忆：生成候选',
  'memory-proposal-skip': '记忆：跳过候选'
}[optionId] ?? `候选方案（${humanizeCode(optionId, '未命名方案')}）`);

const decisionReasonDisplayLabel = (reasonCode: string): string => ({
  RULE_PATTERN_MISMATCH: '不匹配当前任务',
  POLICY_ALLOWED: '当前安全策略允许另一条路径',
  ROUTE_BLOCKED: '执行路径被阻止',
  ROLE_ISOLATION_REQUIRED: '需要角色隔离',
  BOUNDED_EXECUTION_REQUIRED: '需要有界执行',
  OUTCOME_NOT_VERIFIED_SUCCESS: '上次结果未验证成功'
}[reasonCode] ?? reasonDisplayLabel(reasonCode));

const decisionOptionTechnicalReason = (option: RuntimeDecisionOption): string => option.rejectionReasonCodes.length
  ? `技术原因：${option.rejectionReasonCodes.map(reasonDisplayLabel).join('、')}`
  : '系统保留的候选方案，未记录额外淘汰原因';

// A candidate fanout decision carries one option per candidate. The label makes
// the outcome of each candidate explicit: only the selected one executed, the
// rest are counterfactual and must never look like they ran.
const decisionOptionLabel = (node: RuntimeDecisionNode, option: RuntimeDecisionOption): string => {
  const state = option.optionId === node.selectedOptionId
    ? '已采用'
    : (option.rejectionReasonCodes.length
      ? `未采用 · ${option.rejectionReasonCodes.map(decisionReasonDisplayLabel).join('、')}`
      : '未采用');
  const scores = [
    option.expectedQuality === undefined ? undefined : `质量 ${option.expectedQuality.toFixed(2)}`,
    option.expectedCost === undefined ? undefined : `成本 ${option.expectedCost}`,
    option.expectedLatencyMs === undefined ? undefined : `延迟 ${option.expectedLatencyMs}ms`
  ].filter(Boolean).join(' · ');
  return `${decisionOptionDisplayLabel(option.optionId)} · ${state}${scores ? ` · ${scores}` : ''}`;
};

// The Decision DAG is derived only from durable decision facts: nodes are the
// projected decisions and edges are the recorded parent/supersede links. A link
// that points outside the visible window is still rendered so a partial view
// never silently implies that a decision had no cause.
const renderDecisionTrace = (): string => {
  const allDecisions = model.decisions ?? [];
  const decisions = allDecisions
    .slice()
    .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))
    .slice(0, 12);
  const visible = new Set(decisions.map((node) => node.decisionId));
  const known = new Set(allDecisions.map((node) => node.decisionId));
  const edges = decisions.flatMap((node) => (node.parentDecisionIds ?? [])
    .map((parentId) => ({ parentId, childId: node.decisionId, resolved: visible.has(parentId) || known.has(parentId) })));
  const supersedes = decisions.filter((node) => node.supersedesDecisionId);
  return `
    <section class="context-section decision-trace-section" aria-label="决策关系">
      <div class="section-heading">
        <div><span class="section-kicker">决策关系</span><h3>决策图</h3></div>
        <span class="context-count">${allDecisions.length} 个决策 · ${edges.length} 条依赖</span>
      </div>
      ${decisions.length === 0
        ? '<div class="empty-note">暂无已提交决策</div>'
        : `<div class="decision-node-list">${decisions.map((node) => `
            <article class="governance-row decision-node" data-decision-id="${escapeHtml(node.decisionId)}" data-decision-status="${escapeHtml(node.status)}">
              <div class="governance-copy">
                <strong>${escapeHtml(humanizeCode(node.decisionType, '决策'))} · ${escapeHtml(humanizeCode(node.role, '未标注角色'))}</strong>
                <span>${escapeHtml(decisionStatusLabel(node))} · ${node.optionCount} 个方案${node.selectedOptionId ? ` · 已采用：${escapeHtml(decisionOptionDisplayLabel(node.selectedOptionId))}` : ''}${node.stepId ? ` · 步骤：${escapeHtml(humanizeCode(node.stepId, '未标注'))}` : ''}</span>
              </div>
              ${(node.options ?? []).length === 0 ? '' : `<div class="decision-option-list">${(node.options ?? []).map((option) => `<div class="runtime-line" data-decision-option="${escapeHtml(option.optionId)}" title="${escapeHtml(decisionOptionTechnicalReason(option))}"><i data-lucide="file"></i><span>${escapeHtml(decisionOptionLabel(node, option))}</span></div>`).join('')}</div>`}
              ${(node.reasonCodes ?? []).length === 0 ? '' : `<div class="decision-reason-list"><div class="runtime-line" data-decision-reason="selection"><i data-lucide="list-tree"></i><span>选择理由：${escapeHtml((node.reasonCodes ?? []).map(reasonDisplayLabel).join('、'))}</span></div>${(node.selectionCriteria ?? []).length ? `<div class="runtime-line" data-decision-reason="criteria"><i data-lucide="file-cog"></i><span>评分依据：${escapeHtml((node.selectionCriteria ?? []).map((value) => humanizeCode(value, '未提供')).join('、'))}</span></div>` : ''}</div>`}
            </article>`).join('')}</div>`}
      ${edges.length === 0 ? '' : `<div class="decision-edge-list"><span class="technical-label">技术关系</span>${edges.map((edge) => `<div class="runtime-line" data-decision-edge="parent"><i data-lucide="list-tree"></i><span>前置决策 ${escapeHtml(shortDigest(edge.parentId))} → 当前决策 ${escapeHtml(shortDigest(edge.childId))}${edge.resolved ? '' : ' · 前置节点不在当前窗口'}</span></div>`).join('')}</div>`}
      ${supersedes.length === 0 ? '' : `<div class="decision-edge-list"><span class="technical-label">替代关系</span>${supersedes.map((node) => `<div class="runtime-line" data-decision-edge="supersede"><i data-lucide="list-tree"></i><span>新决策已替代旧决策（${escapeHtml(shortDigest(node.supersedesDecisionId))} → ${escapeHtml(shortDigest(node.decisionId))}）</span></div>`).join('')}</div>`}
    </section>`;
};


const renderCouncilPanel = (): string => {
  const all = model.decisions ?? [];
  const council = all.filter((node) => {
    const type = String(node.decisionType ?? '').toUpperCase();
    const role = String(node.role ?? '').toUpperCase();
    return role === 'COUNCIL'
      || type === 'REVIEW_PLAN'
      || type.startsWith('COUNCIL_')
      || ['PROPOSAL', 'CRITIQUE', 'JUDGE', 'PROBE'].some((term) => type.includes(term));
  }).slice().sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)).slice(0, 8);
  const byType = (term: string) => council.filter((node) => String(node.decisionType ?? '').toUpperCase().includes(term));
  const proposals = byType('PROPOSAL');
  const critiques = byType('CRITIQUE');
  const judges = council.filter((node) => {
    const type = String(node.decisionType ?? '').toUpperCase();
    return type === 'REVIEW_PLAN' || type.includes('JUDGE') || (String(node.role ?? '').toUpperCase() === 'COUNCIL' && !type.includes('PROBE') && !type.includes('PROPOSAL') && !type.includes('CRITIQUE'));
  });
  const probes = byType('PROBE');
  const ranking = (node: RuntimeDecisionNode): string => {
    const options = node.options ?? [];
    if (!options.length) return '<div class="empty-note">暂无候选排序</div>';
    return `<div class="council-ranking" aria-label="候选排序">${options.map((option, index) => {
      const selected = option.optionId === node.selectedOptionId;
      const reason = option.rejectionReasonCodes.length ? ` · ${option.rejectionReasonCodes.map(reasonDisplayLabel).join('、')}` : '';
      return `<div class="runtime-line" data-council-ranking="${escapeHtml(option.optionId)}"><i data-lucide="${selected ? 'circle-check' : 'list-ordered'}"></i><span>${index + 1}. ${escapeHtml(decisionOptionDisplayLabel(option.optionId))} · ${selected ? '已采用' : '未执行'}${option.actionKind ? ` · ${escapeHtml(toolDisplayLabel(option.actionKind))}` : ''}${escapeHtml(reason)}</span></div>`;
    }).join('')}</div>`;
  };
  const section = (label: string, items: RuntimeDecisionNode[], empty: string, extra?: (node: RuntimeDecisionNode) => string): string => {
    const display = ({ Proposal: '候选方案', Critique: '审阅意见', Judge: '候选比较', Probe: '探查' } as Record<string, string>)[label] ?? label;
    return items.length === 0
      ? `<div class="council-column"><strong>${display}</strong><span class="empty-note">${empty}</span></div>`
      : `<div class="council-column"><strong>${display}</strong>${items.map((node) => `<div class="council-item" data-council-kind="${label}"><span>${escapeHtml(humanizeCode(node.decisionType ?? node.role, '未标注'))}</span><small>${escapeHtml(decisionStatusLabel(node))}${node.selectedOptionId ? ` · 已采用：${escapeHtml(decisionOptionDisplayLabel(node.selectedOptionId))}` : ''}${node.reasonCodes?.length ? ` · ${escapeHtml(node.reasonCodes.map(reasonDisplayLabel).join('、'))}` : ''}</small>${extra ? extra(node) : ''}</div>`).join('')}</div>`;
  };
  return `<section class="context-section council-section" aria-label="多候选审议"><div class="section-heading"><div><span class="section-kicker">多候选审议</span><h3>多候选审议</h3></div><span class="context-count">${council.length} 条持久化事实</span></div><div class="council-grid">${section('Proposal', proposals, '暂无独立候选方案记录')}${section('Critique', critiques, '暂无结构化审阅记录')}${section('Judge', judges, '暂无候选比较记录', ranking)}${section('Probe', probes, '暂无探查记录')}</div><div class="runtime-line"><i data-lucide="shield-check"></i><span>当前投影只展示已保存的决策和候选排序；缺少的主张、证据、审阅、探查、预算和轮数不会被推断为已完成。</span></div></section>`;
};

// The A-T distribution is the only evidence behind a continuous score, so it
// is shown as bounded percentages next to the score it produced. The runtime
// projection strips any prompt, output or reasoning text before it gets here.
const formatDistribution = (distribution?: ContinuousVerificationRecord['leftDistribution']): string => {
  if (!distribution || distribution.length === 0) return '';
  return distribution
    .filter((item) => Number.isFinite(item.probability) && item.probability >= 0.005)
    .map((item) => `${item.token} ${(item.probability * 100).toFixed(1)}%`)
    .join(' ');
};
// A process score always names the channel it came from, so the panel can show
// why a verdict abstained (missing probability evidence, unbound provider, ...).
const processSourceLabels: Record<string, string> = {
  TOKEN_LOGPROB_EXPECTATION: '令牌概率期望',
  LOGPROBS_MISSING: '缺少概率证据',
  UNBOUND: '未绑定验证模型',
  ERROR: '调用失败',
  FALLBACK_UNSTRUCTURED: '结构化回退',
  MODEL_STRUCTURED: '模型结构化'
};
const processSourceLabel = (source?: string): string => source ? (processSourceLabels[source] ?? source) : '';

const appendVerificationChecks = (current: HarnessReadModel, checks: unknown, runId?: string): HarnessReadModel => {
  let next = current;
  for (const value of Array.isArray(checks) ? checks : []) {
    if (!value || typeof value !== 'object') continue;
    const check = value as Record<string, unknown>;
    const status = typeof check.status === 'string' && ['PASS', 'FAIL', 'UNKNOWN', 'SKIPPED'].includes(check.status) ? check.status : 'UNKNOWN';
    const evidence = Array.isArray(check.evidence) ? check.evidence.filter((ref): ref is string => typeof ref === 'string') : [];
    next = appendTimelineItem(next, {
      kind: 'STATUS', evidenceKind: 'rule-verification-check', sourceRole: 'runtime-rule-verifier', runId,
      title: statusDisplayLabel(status) + ' · ' + (typeof check.id === 'string' ? check.id : '未提供检查标识'),
      body: [typeof check.message === 'string' ? check.message : '未提供检查说明',
        status === 'SKIPPED' ? '此项未执行，不代表检查通过。' : status === 'UNKNOWN' ? '此项证据不足，不能视为通过。' : undefined,
        evidence.length ? '证据引用：\n' + evidence.join('\n') : '未提供证据引用'
      ].filter(Boolean).join('\n'),
      status: status === 'PASS' ? 'COMPLETE' : status === 'FAIL' ? 'ERROR' : 'PENDING'
    });
  }
  return next;
};

const verificationEvidenceRefs = (item: TimelineItem): string[] => {
  const lines = item.body.split('\n');
  const start = lines.findIndex(line => line === '证据引用：');
  return start < 0 ? [] : lines.slice(start + 1).map(line => line.trim()).filter(Boolean);
};
const resolveEvidenceTarget = (ref: string): TimelineItem | undefined => {
  const value = ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
  return model.timeline.find(item => item.eventId === value || item.itemId === value || item.digest === ref || item.digest === value);
};
const renderVerificationEvidence = (item: TimelineItem): string => {
  const refs = verificationEvidenceRefs(item);
  if (!refs.length) return '<div class="verification-evidence"><strong>证据</strong><span data-evidence-state="unresolved">未提供可导航证据引用</span></div>';
  return '<div class="verification-evidence"><strong>证据</strong><div class="verification-evidence-list">' + refs.map(ref => {
    const target = resolveEvidenceTarget(ref);
    return target ? '<button class="evidence-link" data-action="focus-evidence" data-evidence-ref="' + escapeHtml(ref) + '">' + escapeHtml(ref) + '</button>' : '<span class="evidence-link-unresolved" data-evidence-state="unresolved">' + escapeHtml(ref) + ' · 未解析</span>';
  }).join('') + '</div></div>';
};

const renderFinalVerificationChecks = (): string => {
  const checks = model.timeline.filter(item => item.evidenceKind === 'rule-verification-check' && item.runId === activeRuntimeRunId);
  if (!checks.length) return '';
  return `<section class="verification-checks" aria-label="确定性验收检查">
    <h2>确定性验收检查</h2>
    <p>来源：运行时规则核对报告。以下时间为界面收到报告的时间；运行时未提供逐项检查时间和影响等级。</p>
    <div class="verification-check-list">${checks.map(item => `
      <article class="verification-check" data-status="${item.status}">
        <h3>${escapeHtml(item.title)}</h3>
        <pre>${escapeHtml(item.body)}</pre>
        ${renderVerificationEvidence(item)}
        <small>报告接收时间：${escapeHtml(new Date(item.createdAtMs).toLocaleString())}</small>
      </article>`).join('')}</div>
  </section>`;
};

const renderContinuousVerification = (): string => {
  const records = (model.continuousVerification ?? []).slice(-12);
  const samples = records.filter((record) => record.kind === 'CandidateVerificationSample');
  const completed = records.filter((record) => record.kind === 'CandidateVerificationCompleted');
  const process = model.processVerification;
  const processDistribution = formatDistribution(process?.distribution);
  const hasProcess = typeof process?.score === 'number' || processDistribution !== '';
  if (records.length === 0 && !hasProcess) return '';
  // The process row is the only place a step-level score appears, and it is
  // always the host-derived expectation rather than model-authored text.
  const processRow = hasProcess
    ? `<div class="runtime-line" data-verification-unknown="${process?.status === 'UNKNOWN' || process?.status === 'ABSTAIN' ? 'true' : ''}" data-process-verification="${escapeHtml(process?.status ?? 'ABSTAIN')}"><i data-lucide="shield-check"></i><span>过程验证：${escapeHtml(statusDisplayLabel(process?.status, '暂不判断'))} · 分数 ${typeof process?.score === 'number' ? process.score.toFixed(3) : '—'} · 波动 ${typeof process?.variance === 'number' ? process.variance.toFixed(4) : '—'}${processDistribution ? ` · 概率 ${escapeHtml(processDistribution)}` : ''}${process?.thresholds ? ` · 通过阈值 ${process.thresholds.passThreshold}，失败阈值 ${process.thresholds.failThreshold}` : ''}${processSourceLabel(process?.source) ? ` · 来源 ${escapeHtml(processSourceLabel(process?.source))}` : ''}</span></div>`
    : '';
  return `<section class="context-section continuous-verification-section" aria-label="连续验证">
    <div class="section-heading"><div><span class="section-kicker">连续验证</span><h3>连续验证</h3></div><span class="context-count">${completed.length} 次汇总 · ${records.length} 条样本</span></div>
    ${processRow}
    ${completed.map((record) => {
      const ranking = (record.ranking ?? []).map((item) => `${item.candidateId ?? '?'} ${typeof item.score === 'number' ? item.score.toFixed(2) : '—'}`).join(' · ');
      const config = record.config ? `重复 ${record.config.repetitions ?? '—'} · 最大比较 ${record.config.maxComparisons ?? '—'}` : '';
      const related = samples.filter((sample) => sample.stepId === record.stepId);
      const sampleText = related.map((sample) => {
        const leftDistribution = formatDistribution(sample.leftDistribution);
        const rightDistribution = formatDistribution(sample.rightDistribution);
        const left = `${sample.leftId ?? '?'}:${sample.leftScore?.toFixed(2) ?? '—'}±${sample.leftVariance?.toFixed(3) ?? '—'}${leftDistribution ? ` [${leftDistribution}]` : ''}`;
        const right = `${sample.rightId ?? '?'}:${sample.rightScore?.toFixed(2) ?? '—'}±${sample.rightVariance?.toFixed(3) ?? '—'}${rightDistribution ? ` [${rightDistribution}]` : ''}`;
        return `${left} vs ${right}`;
      }).join('；');
      return `<div class="governance-row" data-verification-event="${escapeHtml(record.eventId)}"><div class="governance-copy"><strong>${escapeHtml(record.stepId ?? 'verification')}</strong><span>${escapeHtml(config)}${ranking ? ` · 排名 ${escapeHtml(ranking)}` : ''}${sampleText ? ` · 样本 ${escapeHtml(sampleText)}` : ''}</span></div></div>`;
    }).join('')}
  </section>`;
};

const renderComposerCache = (): string => {
  const usage = model.modelUsage;
  const rate = usage?.status === 'REPORTED' && usage.cacheHitRate !== null
    ? `${(usage.cacheHitRate * 100).toFixed(1)}%` : '未知';
  const detail = !usage || usage.calls === 0
    ? '暂无记录'
    : usage.status !== 'REPORTED'
      ? '服务商未返回缓存统计'
      : `命中 ${usage.cachedInputTokens.toLocaleString()} / 可统计输入 ${usage.cacheEligibleInputTokens.toLocaleString()} 个令牌 · 覆盖 ${usage.cacheReportedCalls}/${usage.calls} 次调用`;
  return `<span class="cache-metric"><i data-lucide="gauge"></i>缓存命中率 <strong>${rate}</strong></span><span class="cache-detail">${escapeHtml(detail)}</span><span class="cache-scope" title="累计已记录的模型调用；历史缺失数据不按零计算。">调用累计</span>`;
};
const refreshComposerCache = (): void => {
  patchLiveRegion(app.querySelector('[data-model-cache="composer"]'), [model.modelUsage], renderComposerCache);
};

const renderSupportBundle = (): string => {
  const bundle = model.supportBundle;
  if (!bundle) return '';
  const scan = bundle.privacy.scan;
  const counts = Object.entries(bundle.stores)
    .map(([key, value]) => `${key} ${typeof value.count === 'number' ? value.count : '—'}`);
  // Egress is reported per candidate because one logical fanout can send one
  // prompt per candidate to a different provider.
  const egress = model.modelEgress;
  const usage = model.modelUsage;
  const cacheRate = usage?.status === 'REPORTED' && usage.cacheHitRate !== null
    ? `${(usage.cacheHitRate * 100).toFixed(1)}%`
    : '未知';
  const cacheCoverage = usage?.cacheCoverage !== null && usage?.cacheCoverage !== undefined
    ? `${(usage.cacheCoverage * 100).toFixed(1)}%`
    : '未知';
  const cachedTokens = usage?.status === 'REPORTED' ? String(usage.cachedInputTokens) : '未知';
  const uncachedTokens = usage?.status === 'REPORTED' ? String(usage.uncachedInputTokens) : '未知';
  const egressCandidates = Object.entries(egress?.byCandidate ?? {})
    .map(([candidateId, bucket]) => `${candidateId} · ${bucket.calls} 次 · 预估成本 ${bucket.expectedCost ?? '未知'}（已知 ${bucket.expectedCostKnown}/${bucket.calls}） · 实际成本 ${bucket.actualCost ?? '未知'}（已知 ${bucket.actualCostKnown}/${bucket.calls}） · 失败 ${bucket.failures}`);
  return `
    <section class="context-section support-bundle-section" aria-label="诊断导出">
      <div class="section-heading">
        <div><span class="section-kicker">诊断导出</span><h3>诊断导出就绪度</h3></div>
        <span class="governance-state governance-state-${scan.ok ? 'active' : 'failed'}">${scan.ok ? '脱敏检查通过' : '脱敏检查失败'}</span>
      </div>
      <div class="runtime-line" data-support-bundle-scan="${scan.ok ? 'pass' : 'fail'}"><i data-lucide="shield-check"></i><span>隐私扫描 ${scan.ok ? '通过' : '失败'} · ${scan.violations.length} 个违规</span></div>
      <div class="runtime-line"><i data-lucide="history"></i><span>${escapeHtml(bundle.evidenceSource)}</span></div>
      <div class="runtime-line"><i data-lucide="terminal-square"></i><span>${escapeHtml(bundle.exportInvocation)}</span></div>
      <div class="decision-edge-list">${counts.map((line) => `<div class="runtime-line"><i data-lucide="file"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>
      ${egress === undefined ? '' : `<div class="runtime-line" data-model-egress="total"><i data-lucide="list-tree"></i><span>出域 ${egress.recordCount} 条 · 调用 ${egress.totals.calls} · 失败 ${egress.totals.failures} · 预估成本 ${egress.totals.expectedCost ?? '未知'}（已知 ${egress.totals.expectedCostKnown}/${egress.totals.calls}） · 实际成本 ${egress.totals.actualCost ?? '未知'}（已知 ${egress.totals.actualCostKnown}/${egress.totals.calls}）</span></div>
      <div class="decision-edge-list">${egressCandidates.map((line) => `<div class="runtime-line" data-model-egress="candidate"><i data-lucide="file"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>`}
      ${usage === undefined ? '' : `<div class="runtime-line" data-model-cache="summary"><i data-lucide="database"></i><span>提示缓存命中率 ${cacheRate} · 统计覆盖 ${cacheCoverage} · 输入 ${usage.inputTokens} 个令牌 · 命中 ${cachedTokens} · 未命中 ${uncachedTokens}</span></div>`}
    </section>`;
};

const renderGovernance = (): string => {
  const memories = model.memories.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, 8);
  const dreams = model.dreamRuns.slice().sort((left, right) => right.startedAtMs - left.startedAtMs).slice(0, 6);
  const plugins = model.plugins.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, 8);
  const proposals = model.evolutionProposals.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, 8);
  const native = desktopBridge.isNative();
  const maintenance = model.runtime.dreamMaintenance;
  const maintenanceRunning = maintenance?.running === true;
  const maintenanceState = maintenance ? governanceStateLabel(maintenance.state) : '未托管';
  const maintenanceDetail = maintenance?.lastErrorCode
    ? ` · ${maintenance.lastErrorCode}`
    : maintenance?.cycleCount
      ? ` · 已完成 ${maintenance.cycleCount} 轮`
      : '';
  const memoryAction = (memory: typeof memories[number]): string => {
    const edit = ['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(memory.status)
      ? `<button class="governance-button" data-action="memory-edit" data-memory-id="${escapeHtml(memory.memoryId)}">编辑新版本</button>`
      : '';
    const conflict = memory.conflictsWithMemoryIds?.length
      ? `<button class="governance-button governance-button-warning" data-action="memory-action" data-operation="resolve-conflict" data-memory-id="${escapeHtml(memory.memoryId)}">处理冲突</button>`
      : '';
    if (memory.status === 'PROPOSED') {
      return `<div class="governance-actions">${edit}${conflict}
        <button class="governance-button governance-button-primary" data-action="memory-action" data-operation="verify" data-accepted="true" data-memory-id="${escapeHtml(memory.memoryId)}">验证</button>
        <button class="governance-button governance-button-danger" data-action="memory-action" data-operation="verify" data-accepted="false" data-memory-id="${escapeHtml(memory.memoryId)}">拒绝</button>
        <button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="${escapeHtml(memory.memoryId)}">删除</button>
      </div>`;
    }
    if (memory.status === 'VERIFIED') {
      return `<div class="governance-actions">${edit}${conflict}<button class="governance-button governance-button-primary" data-action="memory-action" data-operation="activate" data-memory-id="${escapeHtml(memory.memoryId)}">激活</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="${escapeHtml(memory.memoryId)}">删除</button></div>`;
    }
    if (memory.status === 'ACTIVE') {
      return `<div class="governance-actions">${edit}${conflict}<button class="governance-button governance-button-danger" data-action="memory-action" data-operation="retract" data-memory-id="${escapeHtml(memory.memoryId)}">撤回</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="${escapeHtml(memory.memoryId)}">删除</button></div>`;
    }
    return conflict ? `<div class="governance-actions">${conflict}</div>` : '';
  };
  const evolutionAction = (proposal: typeof proposals[number]): string => {
    if (['PROPOSED', 'VALIDATING', 'SHADOW', 'QUARANTINED'].includes(proposal.status)) {
      return `<button class="governance-button governance-button-danger" data-action="evolution-action" data-operation="transition" data-state="REJECTED" data-proposal-id="${escapeHtml(proposal.proposalId)}">拒绝</button>`;
    }
    if (['CANARY', 'ACTIVE'].includes(proposal.status)) {
      return `<div class="governance-actions"><button class="governance-button" data-action="evolution-action" data-operation="monitor" data-proposal-id="${escapeHtml(proposal.proposalId)}">在线监测</button><button class="governance-button governance-button-danger" data-action="evolution-action" data-operation="rollback" data-proposal-id="${escapeHtml(proposal.proposalId)}">回滚</button></div>`;
    }
    return '';
  };
  // S2-10 requires the panel to show installed/active/rolled-back versions and
  // the quarantine reason, sourced from the persisted lifecycle snapshot.
  const pluginVersionCopy = (pluginId: string): string => {
    const summary = pluginVersionSummaries(model.pluginVersions, pluginVersionSnapshot).find((item) => item.pluginId === pluginId);
    if (!summary || summary.versions.length === 0) return '';
    const installed = summary.versions.slice().sort((left, right) => right.installedAtMs - left.installedAtMs);
    const detail = installed
      .map((item) => `${item.version} · ${governanceStateLabel(item.state)}${item.failureCode ? ` · ${item.failureCode}` : ''}`)
      .join(' | ');
    return `<span>活跃版本 ${escapeHtml(summary.activeVersion ?? '无')} · ${escapeHtml(detail)}</span>`;
  };
  // S2-10 requires the panel to show the declared permission set, the ceiling
  // that bounds it and the recorded evidence count next to the version row.
  const pluginGrantCopy = (plugin: RuntimePluginGovernanceRecord): string => {
    const contributions = (plugin.manifest as { contributions?: unknown } | undefined)?.contributions;
    const list = Array.isArray(contributions) ? contributions as Array<Record<string, unknown>> : [];
    const permissions = [...new Set(list.flatMap((contribution) => Array.isArray(contribution.permissions)
      ? (contribution.permissions as unknown[]).filter((value): value is string => typeof value === 'string')
      : []))].slice(0, 12);
    const ceilings = [...new Set(list
      .map((contribution) => contribution.permissionCeiling)
      .filter((value): value is string => typeof value === 'string'))];
    const digest = typeof plugin.packageDigest === 'string' ? plugin.packageDigest.slice(0, 15) : '';
    const evidence = Array.isArray(plugin.history) ? plugin.history.length : 0;
    const parts = [
      `权限 ${permissions.length ? permissions.join('、') : '无'}`,
      ceilings.length ? `上限 ${ceilings.join('/')}` : '',
      digest ? `摘要 ${digest}…` : '',
      `状态证据 ${evidence} 条`
    ].filter(Boolean);
    return `<span>${escapeHtml(parts.join(' · '))}</span>`;
  };
  const pluginQuarantineCopy = (plugin: typeof plugins[number]): string => {
    const summary = pluginVersionSummaries(model.pluginVersions, pluginVersionSnapshot).find((item) => item.pluginId === plugin.pluginId);
    if (!summary?.quarantineReason) return '';
    return `<span>隔离原因 ${escapeHtml(summary.quarantineReason)}</span>`;
  };
  return `
    <section class="context-section governance-section" aria-label="治理状态">
      <div class="section-heading">
        <div><span class="section-kicker">治理状态</span><h3>记忆 · 后台整理 · 插件 · 演进</h3></div>
        <button class="icon-button small" data-action="refresh-governance" title="刷新治理状态" aria-label="刷新治理状态"><i data-lucide="rotate-ccw-clock"></i></button>
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>反馈</strong><span>${model.feedback.length} 条</span></div>
        ${model.feedback.length === 0
          ? '<div class="empty-note">暂无已提交反馈</div>'
          : model.feedback.slice().sort((left, right) => (right.eventSequence ?? 0) - (left.eventSequence ?? 0)).slice(0, 8).map((item) => {
            const status = typeof item.outcomeStatus === 'string' ? item.outcomeStatus : 'UNKNOWN';
            const key = typeof item.scenarioKey === 'string' ? item.scenarioKey : item.feedbackId ?? item.eventId ?? '脱敏反馈';
            return '<article class="governance-row"><div class="governance-copy"><strong>' + escapeHtml(key) + '</strong><span>' + escapeHtml(statusDisplayLabel(status)) + (item.runId ? ' · 运行 ' + escapeHtml(shortDigest(item.runId)) : '') + '</span></div><span class="governance-state governance-state-' + escapeHtml(status.toLowerCase()) + '">' + escapeHtml(statusDisplayLabel(status)) + '</span></article>';
          }).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>记忆</strong><span>${memories.length} 条</span></div>
        ${memories.length === 0
          ? '<div class="empty-note">暂无记忆候选或已激活记忆</div>'
          : memories.map((memory) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(memory.statement)}</strong><span>${escapeHtml(memory.scope)} · 置信度 ${(memory.confidence * 100).toFixed(0)}%</span></div>
              <span class="governance-state governance-state-${escapeHtml(memory.status.toLowerCase())}">${escapeHtml(governanceStateLabel(memory.status))}</span>
              ${memoryAction(memory)}
            </article>`).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>后台整理</strong><span>${dreams.length} 次</span><div class="governance-actions"><button class="governance-button governance-button-primary" data-action="run-dream" ${native ? '' : 'disabled'}>运行一次</button>${maintenanceRunning ? `<button class="governance-button governance-button-danger" data-action="stop-dream-maintenance">停止后台</button>` : `<button class="governance-button" data-action="start-dream-maintenance" ${native ? '' : 'disabled'}>启动后台</button>`}</div></div>
        <div class="governance-row"><div class="governance-copy"><strong>后台维护 · ${escapeHtml(maintenanceState)}</strong><span>${escapeHtml(maintenance?.projectId ?? model.workspace.rootLabel)}${escapeHtml(maintenanceDetail)}</span></div><span class="governance-state governance-state-${escapeHtml((maintenance?.state ?? 'DISABLED').toLowerCase())}">${escapeHtml(maintenanceState)}</span></div>
        ${dreams.length === 0
          ? '<div class="empty-note">暂无后台整理记录</div>'
          : dreams.map((dream) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(dream.projectId)}</strong><span>${escapeHtml(humanizeCode(dream.phase, '等待阶段'))} · ${escapeHtml(formatTime(dream.startedAtMs))}</span></div>
              <span class="governance-state governance-state-${escapeHtml(dream.state.toLowerCase())}">${escapeHtml(governanceStateLabel(dream.state))}</span>
            </article>`).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>插件</strong><span>${plugins.length} 个</span></div>
        ${plugins.length === 0
          ? '<div class="empty-note">暂无插件治理记录</div>'
          : plugins.map((plugin) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(plugin.pluginId)} · ${escapeHtml(plugin.version)}</strong><span>${escapeHtml(plugin.source)}</span></div>
              <div class="governance-copy">${pluginVersionCopy(plugin.pluginId)}${pluginQuarantineCopy(plugin)}${pluginGrantCopy(plugin)}</div>
              <span class="governance-state governance-state-${escapeHtml(plugin.state.toLowerCase())}">${escapeHtml(governanceStateLabel(plugin.state))}</span>
              <button class="governance-button" data-action="plugin-action" data-operation="validate" data-plugin-id="${escapeHtml(plugin.pluginId)}">校验</button>
              ${plugin.state === 'QUARANTINED' ? '' : `<button class="governance-button governance-button-danger" data-action="plugin-action" data-operation="transition" data-state="QUARANTINED" data-plugin-id="${escapeHtml(plugin.pluginId)}">隔离</button>`}
            </article>`).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>演进</strong><span>${proposals.length} 个候选</span></div>
        <article class="governance-row">
          <div class="governance-copy"><strong>全局停止开关</strong><span>${model.evolutionControl?.reason ? escapeHtml(reasonDisplayLabel(model.evolutionControl.reason)) : '未阻断'}</span></div>
          <span class="governance-state governance-state-${model.evolutionControl?.enabled === false ? 'failed' : 'active'}">${model.evolutionControl?.enabled === false ? '已阻断' : '允许'}</span>
        </article>
        ${proposals.length === 0
          ? '<div class="empty-note">暂无自进化提案</div>'
          : proposals.map((proposal) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(proposal.candidateId)}</strong><span>${escapeHtml(proposal.proposalId)} · ${escapeHtml(formatTime(proposal.updatedAtMs))}</span></div>
              <span class="governance-state governance-state-${escapeHtml(proposal.status.toLowerCase())}">${escapeHtml(governanceStateLabel(proposal.status))}</span>
              ${evolutionAction(proposal)}
            </article>`).join('')}
      </div>
    </section>`;
};

const subAgentIcon = (state: SubAgentReadModel['state']): string => {
  if (state === 'SUCCEEDED') return 'check-circle-2';
  if (state === 'FAILED' || state === 'CANCELLED') return 'circle-x';
  return state === 'RUNNING' ? 'loader-circle' : 'bot';
};

const renderEvidencePanel = (): string => {
  const items = model.timeline.filter((item) => item.evidenceKind === 'terminal' && item.commandText).slice(-6);
  if (items.length === 0) return '';
  return `
    <section class="evidence-panel" aria-label="命令证据">
      <div class="route-heading"><div><span class="eyebrow">命令</span><h2>命令证据</h2></div><span class="route-count">${items.length} 条</span></div>
      <p class="evidence-note">命令证据为受控摘要；截断或脱敏输出不会伪装成完整原始流。</p>
      ${items.map((item) => `
        <div class="evidence-command" data-timeline-item="${escapeHtml(item.itemId)}"><strong>${escapeHtml(toolDisplayLabel(item.toolName ?? 'tool'))}</strong><pre>${escapeHtml(item.commandText ?? '')}</pre>${item.digest ? `<small>输出摘要 ${escapeHtml(shortDigest(item.digest))}${item.truncated ? ' · 输出已截断' : ''}</small>` : ''}</div>
      `).join('')}
    </section>`;
};

const renderRoutePanel = (): string => {
  const egress = model.modelEgress;
  const decisions = (model.decisions ?? []).filter((node) => node.optionCount > 0).slice(0, 6);
  const candidates = decisions.flatMap((node) => (node.options ?? []).map((option) => ({ node, option })));
  const selected = candidates.filter(({ node, option }) => option.optionId === node.selectedOptionId).length;
  const rejected = candidates.filter(({ node, option }) => option.optionId !== node.selectedOptionId && option.rejectionReasonCodes.length > 0).length;
  const egressLines = egress ? Object.entries(egress.byCandidate ?? {}).map(([candidateId, bucket]) => `${humanizeCode(candidateId, '候选方案')} · 调用 ${bucket.calls} 次 · 预估成本 ${bucket.expectedCost ?? '未知'}`) : [];
  const roleLines = egress ? Object.entries(egress.byPhase ?? {}).map(([phase, bucket]) => `${phaseDisplayLabel(phase)} · 调用 ${bucket.calls} 次 · 失败 ${bucket.failures} 次 · 预估成本 ${bucket.expectedCost ?? '未知'}`) : [];
  if (candidates.length === 0 && !egress) return '';
  return `
    <section class="route-panel" aria-label="执行路线与候选">
      <div class="route-heading">
        <div><span class="eyebrow">执行路线</span><h2>模型选择与执行路径</h2></div>
        <span class="route-count">比较 ${candidates.length} 个方案 · 采用 ${selected} 个 · 未采用 ${rejected} 个</span>
        <label class="route-fixed-model" title="只影响新任务">模型偏好
          <select data-action="pinned-model" ${model.runtime.model ? '' : 'disabled'}>
            <option value="">自动选择</option>
            ${model.runtime.model ? `<option value="${escapeHtml(model.runtime.model.model)}" ${pinnedModel === model.runtime.model.model ? 'selected' : ''}>${escapeHtml(model.runtime.model.model)}</option>` : ''}
          </select>
        </label>
      </div>
      <p class="route-explanation">系统先排除与任务或安全规则不匹配的方案，再继续执行保留下来的方案。</p>
      ${egressLines.length === 0 ? '' : `<div class="route-egress"><strong>模型调用记录</strong>${egressLines.map((line) => `<div class="runtime-line"><i data-lucide="file"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>`}
      ${roleLines.length === 0 ? '' : `<div class="route-role"><strong>角色/阶段模型摘要</strong>${roleLines.map((line) => `<div class="runtime-line"><i data-lucide="cpu"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>`}
      <details class="route-candidates">
        <summary>查看候选方案与未采用原因</summary>
        <div class="route-list">
          ${candidates.map(({ node, option }) => `
            <div class="runtime-line" data-route-option="${escapeHtml(option.optionId)}" title="${escapeHtml(decisionOptionTechnicalReason(option))}"><i data-lucide="list-tree"></i><span>${escapeHtml(decisionOptionLabel(node, option))}</span></div>
          `).join('')}
        </div>
      </details>
    </section>`;
};

const renderApprovalCard = (approval: ApprovalReadModel): string => {
  const requested = approval.state === 'REQUESTED';
  const title = requested ? '需要批准一次'
    : approval.state === 'EXPIRED' ? '审批已过期'
    : approval.leaseState === 'FAILED' ? '授权不可继续使用 · 执行结果不确定'
    : approval.leaseState === 'CONSUMED' ? '授权已使用 · ' + (approval.executionOk === true ? '执行器报告完成，验证结果另见证据' : approval.executionOk === false ? '执行器报告失败' : '执行结果未提供')
    : approval.leaseState === 'CLAIMED' ? '执行器已领取授权'
    : approval.leaseId ? '已授权执行' : '正在重新检查策略';
  return `
    <article class="approval-card" data-approval-id="${escapeHtml(approval.requestId)}" role="alert" aria-live="assertive">
      <div class="approval-title"><i data-lucide="circle-alert"></i><strong>${title}</strong></div>
      <div class="approval-detail"><strong>${escapeHtml(toolDisplayLabel(approval.capability))}</strong>${approval.command ? ` · 命令：${escapeHtml(approval.command)}` : ''}${approval.path ? ` · 路径：${escapeHtml(approval.path)}` : ''}${approval.cwd ? ` · 工作目录：${escapeHtml(approval.cwd)}` : ''}${approval.host ? ` · ${escapeHtml(approval.method ?? 'GET')} ${escapeHtml(approval.scheme ?? 'https')}://${escapeHtml(approval.host)}${approval.port ? `:${approval.port}` : ''}` : ''}</div>
      <div class="approval-meta">
        ${approval.risk ? `<span class="approval-risk approval-risk-${approval.risk.toLowerCase()}">${escapeHtml(riskDisplayLabel(approval.risk))}风险</span>` : ''}
        ${approval.policyVersion ? `<span>策略 ${escapeHtml(approval.policyVersion)}</span>` : ''}
        ${approval.approvalExpiresAt ? `<span>有效至 ${escapeHtml(formatTime(approval.approvalExpiresAt))}</span>` : ''}
        <span>仅本次 · Windows 受限执行器</span>
      </div>
      ${approval.scope?.snapshotDigest ? `<div class="approval-scope" title="${escapeHtml(approval.scope.snapshotDigest)}">快照 ${escapeHtml(approval.scope.snapshotDigest.slice(0, 24))}...</div>` : ''}
      ${approval.requestDigest ? `<div class="approval-scope" title="${escapeHtml(approval.requestDigest)}">动作摘要 ${escapeHtml(approval.requestDigest)}</div>` : ''}
      ${requested ? `<div class="approval-actions">
        <button class="secondary-button" data-action="resolve-approval" data-approved="false" data-approval-id="${escapeHtml(approval.requestId)}" ${pendingApprovalResolutions.has(approval.requestId) ? 'disabled aria-busy="true"' : ''}>拒绝</button>
        <button class="primary-action approval-approve" data-action="resolve-approval" data-approved="true" data-approval-id="${escapeHtml(approval.requestId)}" ${pendingApprovalResolutions.has(approval.requestId) ? 'disabled aria-busy="true"' : ''}>${pendingApprovalResolutions.has(approval.requestId) ? '处理中…' : '批准一次'}</button>
        <button class="secondary-button" data-action="cancel-run">取消任务</button>
      </div>` : ''}
    </article>`;
};

let approvalConfirmation: { requestId: string; digest?: string; runId?: string; close: () => void } | undefined;

const dispatchApproval = (requestId: string, approved: boolean, digest?: string): void => {
  update(expireRequestedApprovals(model));
  const current = model.approvals.find(item => item.requestId === requestId);
  if (current?.state !== 'REQUESTED' || current.requestDigest !== digest || pendingApprovalResolutions.has(requestId)) return;
  pendingApprovalResolutions.add(requestId);
  render();
  void desktopBridge.resolveRuntimeApproval(requestId, approved, digest).catch(error => {
    pendingApprovalResolutions.delete(requestId);
    update(appendErrorTimelineItem(model, '审批回执', error));
  });
};

const confirmHighRiskApproval = (approval: ApprovalReadModel, trigger: HTMLElement): void => {
  if (approvalConfirmation) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'approval-confirmation';
  dialog.setAttribute('aria-labelledby', 'approval-confirmation-title');
  dialog.setAttribute('aria-describedby', 'approval-confirmation-description');
  dialog.innerHTML = `
    <h2 id="approval-confirmation-title">确认本次高风险操作</h2>
    <p id="approval-confirmation-description">此操作可能产生外部副作用。请核对下方动作；授权仅用于本次请求，已执行的操作不会自动撤销。</p>
    <pre></pre>
    <div class="approval-confirmation-actions">
      <button class="secondary-button" data-confirmation="back" autofocus>返回检查</button>
      <button class="secondary-button" data-confirmation="reject">拒绝</button>
      <button class="primary-action" data-confirmation="approve">确认批准一次</button>
    </div>`;
  dialog.querySelector('pre')!.textContent = [approval.capability, approval.command, approval.path,
    approval.cwd && 'cwd=' + approval.cwd, approval.host && (approval.method ?? 'GET') + ' ' + (approval.scheme ?? 'https') + '://' + approval.host + (approval.port ? ':' + approval.port : ''),
    approval.requestDigest && '动作摘要 ' + approval.requestDigest].filter(Boolean).join('\n');
  const close = (): void => {
    if (approvalConfirmation?.requestId === approval.requestId) approvalConfirmation = undefined;
    dialog.close();
    dialog.remove();
    if (trigger.isConnected && !(trigger as HTMLButtonElement).disabled) trigger.focus();
  };
  approvalConfirmation = { requestId: approval.requestId, digest: approval.requestDigest, runId: model.activeRun?.runId, close };
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => {
    const choice = (event.target as Element).closest<HTMLElement>('[data-confirmation]')?.dataset.confirmation;
    if (!choice) return;
    close();
    if (choice !== 'back') dispatchApproval(approval.requestId, choice === 'approve', approval.requestDigest);
  });
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('[data-confirmation="back"]')!.focus();
};

let subAgentsCollapsed = false;

const renderSubAgents = (): string => {
  if (model.subAgents.length === 0) return '';
  const runningCount = model.subAgents.filter((agent) => agent.state === 'RUNNING').length;
  const startingCount = model.subAgents.filter((agent) => agent.state === 'STARTING').length;
  const activeCount = runningCount + startingCount;
  // 任务结束后隐藏面板，避免 sticky 面板挡住时间线里的执行结果；
  // 终态信息已由时间线事件记录，无需常驻展示。
  const runTerminal = !model.activeRun || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun.state);
  if (activeCount === 0 && runTerminal) return '';
  return `
    <section class="subagent-panel" aria-label="子 Agent 状态" aria-live="polite">
      <div class="subagent-heading">
        <div>
          <span class="eyebrow">并行执行</span>
          <h2>子 Agent</h2>
        </div>
        <span class="subagent-count">${activeCount > 0
          ? [runningCount > 0 ? `${runningCount} 个运行中` : '', startingCount > 0 ? `${startingCount} 个准备中` : ''].filter(Boolean).join(' · ')
          : '本次任务'}</span>
      </div>
      <button class="secondary-button" type="button" data-action="toggle-subagents" aria-expanded="${!subAgentsCollapsed}" aria-controls="subagent-list">${subAgentsCollapsed ? "展开子 Agent" : "收起子 Agent"}</button>
      <div id="subagent-list" class="subagent-list" ${subAgentsCollapsed ? "hidden" : ""}>
        ${model.subAgents.map((agent) => `
          <article class="subagent-row subagent-${agent.state.toLowerCase()}" data-agent-id="${escapeHtml(agent.agentId)}">
            <div class="subagent-marker" aria-hidden="true"><i data-lucide="${subAgentIcon(agent.state)}"></i></div>
            <div class="subagent-copy">
              <div class="subagent-name">${escapeHtml(agent.name)}</div>
              <div class="subagent-task">${escapeHtml(agent.task)}</div>
            </div>
            <span class="subagent-status">${subAgentStateLabel(agent.state)}</span>
          </article>`).join('')}
      </div>
    </section>`;
};

const NON_CONVERSATIONAL_TIMELINE_KINDS = new Set([
  'RoleContextsReconciled', 'DiagnosisRequested', 'RecoveryPhaseEntered',
  'RecoveryStarted', 'RecoveryCompleted', 'ExecutionStateReconciled',
  'ExecutionStateChanged', 'GitStateObserved', 'ThreadCheckpointCommitted',
  'ThreadCheckpointCleared', 'DecisionTraceEvent', 'FeedbackFactRecorded',
  'FeedbackSubmitted', 'FeedbackRevised', 'FeedbackRetracted',
  'ModelScenarioScoreProjected', 'BayesianAssessmentCreated',
  'MemoryProposalCommitted', 'MemoryStateChanged', 'RoleContextAllocated',
  'RoleContextStateChanged', 'PluginDiscovered', 'PluginStateChangeCommitted',
  'EvolutionProposalCommitted', 'EvolutionStateChanged', 'EvolutionOutcomeRecorded',
  'EvolutionEvaluationRecorded', 'ProfileEvidenceRecorded',
  'ProfileProjectionUpdated', 'ModelRegistryRecordCommitted',
  'ModelRegistryRecordUpdated', 'CreditBlameRecorded', 'ModelEgressRecorded',
  'DreamRunStarted', 'DreamPhaseCheckpointed', 'DreamRunFinished',
  'DreamRunReconciled', 'CandidateVerificationSample',
  'CandidateVerificationCompleted'
]);

const timelineTitleDisplay = (title: string): string => {
  const labels: Record<string, string> = {
    'ActionIntent': '动作请求',
    'PolicyLease 已签发': '已获得一次性授权',
    'PolicyLease 已领取': '执行器已领取授权',
    'PolicyLease 已消费': '一次性授权已使用',
    'PolicyLease 执行结果不确定': '执行结果暂时无法确认',
    '工具调用': '正在调用工具',
    '工具结果': '工具执行结果',
    '模型路由': '执行路线已确定',
    '角色上下文': '已准备角色上下文',
    '运行状态': '任务进度',
    '计划步骤': '计划进度',
    'Council 审议': '多方案审议',
    '验证结果': '结果核对',
    '任务失败': '任务未完成',
    '任务完成': '任务已完成'
  };
  return labels[title] ?? title;
};

const timelineBodyDisplay = (item: TimelineItem): string => {
  if (item.toolName) {
    const tool = toolDisplayLabel(item.toolName);
    if (item.status === 'STREAMING' || item.status === 'PENDING') return `正在${tool.replace(/^查看|^读取|^执行|^运行|^发送/, '')}`;
  }
  if (/^[A-Z][A-Z0-9_]+$/.test(item.body.trim())) return statusDisplayLabel(item.body);
  return item.body;
};

const timelineTechnicalDetails = (item: TimelineItem): string => {
  const rows: Array<[string, string | number | undefined]> = [
    ['事件编号', item.eventId],
    ['事件序号', item.eventSequence],
    ['操作编号', item.operationId],
    ['工具请求', item.toolCallId],
    ['来源角色', item.sourceRole ? humanizeCode(item.sourceRole, '未标注') : undefined],
    ['插件版本', item.pluginVersion],
    ['输出摘要', item.digest ? shortDigest(item.digest) : undefined]
  ];
  const visible = rows.filter(([, value]) => value !== undefined && value !== null && String(value) !== '');
  if (visible.length === 0 && !item.truncated && item.kind !== 'AGENT') return '';
  if (visible.length === 0 && !item.truncated) return '<details class="timeline-details timeline-technical-details"><summary>技术详情</summary></details>';
  return `<details class="timeline-details timeline-technical-details"><summary>技术详情</summary><dl>${visible.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join('')}${item.truncated ? '<div><dt>输出状态</dt><dd>内容已截断或脱敏</dd></div>' : ''}</dl></details>`;
};

const timelineItemHtml = (item: TimelineItem): string => `
        <article class="timeline-item timeline-${item.kind.toLowerCase()}" data-status="${item.status}" data-item-id="${escapeHtml(item.itemId)}"${item.toolName ? ` data-tool-name="${escapeHtml(item.toolName)}"` : ''}>
          <div class="timeline-marker" aria-hidden="true">
            <i data-lucide="${timelineIcon(item)}"></i>
          </div>
          <div class="timeline-content">
            <div class="timeline-meta">
              <span>${escapeHtml(timelineTitleDisplay(item.title))}</span>
              <time>${formatTime(item.createdAtMs)}</time>
              <span class="timeline-status timeline-status-${item.status.toLowerCase()}">${escapeHtml(statusDisplayLabel(item.status))}</span>
            </div>
            <p class="timeline-body">${escapeHtml(timelineBodyDisplay(item))}</p>
            ${item.commandText ? `<pre class="timeline-command"><code>${escapeHtml(item.commandText)}</code></pre>` : ''}
            ${timelineTechnicalDetails(item)}
            ${item.status === 'STREAMING' ? '<span class="stream-caret" aria-label="正在生成"></span>' : ''}
          </div>
        </article>`;

const historyIcons = (root: ParentNode): void => createIcons({ icons: {
  Bot, UserRound, CircleAlert, CheckCircle2, TerminalSquare, File, Folder,
  ShieldCheck, LoaderCircle, History, ChevronDown, ChevronRight, ArrowLeft, FolderOpen,
  XCircle, Cpu, FileCog, PanelRight, Gauge, HeartPulse, ListTree, Square,
  RotateCcwClock: History, Database
} }, root);
const renderProjectThreadList = (): string => {
  const activeProjectId = currentProjectId();
  return projectGroups().map((group) => {
    const open = !collapsedProjectIds.has(group.id) && (expandedProjectIds.has(group.id) || group.id === activeProjectId);
    const edit = !group.discovered && group.id !== PROJECTLESS_ID
      ? `<button class="icon-button small project-edit-button" type="button" data-action="edit-project" data-project-id="${escapeHtml(group.id)}" title="编辑项目" aria-label="编辑项目"><i data-lucide="settings"></i></button>` : '';
    const countLabel = group.threads.length ? `${group.threads.length} 个会话` : '暂无会话';
    return `<section class="project-group ${open ? 'open' : ''}" data-project-group="${escapeHtml(group.id)}" aria-label="${escapeHtml(group.name)}，${countLabel}">
      <div class="project-header-row"><button class="project-header" type="button" data-action="toggle-project" data-project-id="${escapeHtml(group.id)}" aria-expanded="${open}" aria-label="${escapeHtml(group.name)}，${open ? '收起' : '展开'}">
        <i data-lucide="${open ? 'folder-open' : 'folder'}"></i>
        <span class="project-header-copy"><strong>${escapeHtml(group.name)}</strong></span>
        <i class="project-chevron" data-lucide="${open ? 'chevron-down' : 'chevron-right'}"></i>
      </button>${edit}</div>
      ${open ? `<div class="project-thread-list">
        ${group.threads.length ? group.threads.map((thread) => `<button class="thread-row project-thread-row ${thread.id === model.activeThreadId ? 'active' : ''}" type="button" data-action="select-thread" data-thread-id="${escapeHtml(thread.id)}" aria-current="${thread.id === model.activeThreadId}">
          <span class="thread-title">${escapeHtml(thread.title || '未命名会话')}</span>
          <span class="thread-meta">${thread.turnCount} 次 Turn${thread.resumable || thread.checkpoint?.plan ? ' · 可恢复' : ''}</span>
        </button>`).join('') : '<div class="project-empty">暂无会话</div>'}
      </div>` : ''}
    </section>`;
  }).join('');
};

const threadListInputs = new WeakMap<HTMLElement, { threads: HarnessReadModel['threads']; activeId?: string; catalogKey: string; expansionKey: string }>();
const updateThreadList = (): void => {
  const list = app.querySelector<HTMLElement>('[data-region="thread-list"]');
  if (!list) return;
  const previous = threadListInputs.get(list);
  const catalogKey = projectCatalog.map((project) => `${project.id}:${project.lastUsedAtMs}`).join('|');
  const expansionKey = `${[...expandedProjectIds].sort().join('|')}::${[...collapsedProjectIds].sort().join('|')}`;
  if (previous?.threads === model.threads && previous.activeId === model.activeThreadId && previous.catalogKey === catalogKey && previous.expansionKey === expansionKey) return;
  threadListInputs.set(list, { threads: model.threads, activeId: model.activeThreadId, catalogKey, expansionKey });
  list.innerHTML = renderProjectThreadList() || '<div class="thread-empty">暂无已保存任务</div>';
  historyIcons(list);
};

let persistedNavigation = savedNavigation;
const persistNavigation = (): void => {
  const value = JSON.stringify({ page: activePage, threadId: model.activeThreadId ?? null,
    runId: model.activeRun?.runId ?? null, workspacePath: model.workspace.currentPath ?? null, scrollTop: transcriptScrollTop });
  if (value === persistedNavigation) return;
  try { localStorage.setItem('hmcodex.nav', value); persistedNavigation = value; } catch { /* storage may be unavailable */ }
};

const renderPrimaryNavigation = (): string => `
        <nav class="nav-list context-page-nav" aria-label="工作台导航">
          <div class="context-page-nav-title">工作台</div>
          <button class="nav-item ${activePage === 'workbench' ? 'active' : ''}" data-action="navigate" data-page="workbench"><i data-lucide="layout-dashboard"></i><span>工作台</span></button>
          <button class="nav-item ${activePage === 'runs' ? 'active' : ''}" data-action="navigate" data-page="runs"><i data-lucide="history"></i><span>运行记录</span></button>
          <button class="nav-item ${activePage === 'workspace' ? 'active' : ''}" data-action="navigate" data-page="workspace"><i data-lucide="list-tree"></i><span>工作区</span></button>
          <button class="nav-item ${activePage === 'memory' ? 'active' : ''}" data-action="navigate" data-page="memory"><i data-lucide="file"></i><span>记忆</span></button>
          <button class="nav-item ${activePage === 'safety' ? 'active' : ''}" data-action="navigate" data-page="safety"><i data-lucide="shield-check"></i><span>能力与安全</span></button>
          <button class="nav-item ${activePage === 'diagnostics' ? 'active' : ''}" data-action="navigate" data-page="diagnostics"><i data-lucide="heart-pulse"></i><span>设置与诊断</span></button>
        </nav>`;

const renderContextContent = (): string => {
  const workspaceTitle = model.workspace.rootLabel || '默认工作区';
  const workspacePath = workspaceDisplayPath(model.workspace.rootPath, workspaceTitle, model.workspace.currentPath);
  const controlled = model.composer.mode === 'CONTROLLED';
  const runtimeRoute = model.runtime.model
    ? `${model.runtime.model.provider} 服务 · ${model.runtime.model.model}`
    : model.runtime.platform === 'WINDOWS' ? '模型路由未读取' : 'Web 预览无本地模型';
  const runtimeHealth = model.runtime.runtimeReady === true ? '健康检查通过'
    : model.runtime.platform === 'WINDOWS' ? '等待健康检查' : '演示运行时';
  const runtimeConfig = model.runtime.platform === 'WINDOWS'
    ? model.runtime.configLoaded ? '已加载用户模型配置' : '使用内置模型默认值'
    : '不读取本地模型配置';
  const contextSidecar = model.runtime.contextSidecar;
  const contextSidecarState = contextSidecarStateLabel(contextSidecar?.state);
  const contextSidecarDetail = contextSidecar?.errorCode ? ` · ${reasonDisplayLabel(contextSidecar.errorCode)}`
    : contextSidecar?.managed && contextSidecar.pid ? ` · 进程号 ${contextSidecar.pid}` : '';
  return `
        ${renderPrimaryNavigation()}
        <div class="context-header">
          <div>
            <span class="eyebrow">上下文</span>
            <h2>任务上下文</h2>
          </div>
          <button class="icon-button mobile-context-close" data-action="toggle-context" title="关闭" aria-label="关闭上下文面板"><i data-lucide="x-circle"></i></button>
        </div>

        <section class="context-section workspace-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">工作区</span>
              <h3 title="${escapeHtml(workspacePath)}">${escapeHtml(model.workspace.rootLabel)}</h3>
            </div>
            ${model.workspace.granted && model.workspace.currentPath
              ? '<button class="icon-button small" data-action="workspace-up" title="返回上级" aria-label="返回上级"><i data-lucide="arrow-left"></i></button>'
              : ''}
          </div>
          <div class="workspace-path" title="${escapeHtml(workspacePath)}">${escapeHtml(workspacePath)}</div>
          <div class="workspace-list" data-scroll-anchor="workspace-list">${renderWorkspaceEntries()}</div>
        </section>

        ${renderSelectedFile()}

        <section class="context-section capability-section">
          <div class="section-heading">
            <div><span class="section-kicker">安全边界</span><h3>能力边界</h3></div>
          </div>
          <dl class="capability-list">
            <div><dt>发布渠道</dt><dd>${escapeHtml(model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' ? 'Windows 只读版' : model.runtime.releaseChannel === 'WINDOWS_PHASE1_5_CONTROLLED' ? 'Windows 受控版' : model.runtime.releaseChannel ?? '尚未确认')}</dd></div>
            <div><dt>工作区读取</dt><dd class="capability-on"><i data-lucide="check-circle-2"></i>允许</dd></div>
            <div><dt>命令执行</dt><dd class="${controlled ? 'capability-on' : ''}"><i data-lucide="${controlled ? 'check-circle-2' : 'x-circle'}"></i>${controlled ? '受控' : '关闭'}</dd></div>
            <div><dt>文件写入</dt><dd class="${controlled ? 'capability-on' : ''}"><i data-lucide="${controlled ? 'check-circle-2' : 'x-circle'}"></i>${controlled ? '受控' : '关闭'}</dd></div>
            <div><dt>外部网络</dt><dd class="${controlled && controlledNetworkTargets.parsed.length ? 'capability-on' : ''}"><i data-lucide="${controlled && controlledNetworkTargets.parsed.length ? 'check-circle-2' : 'x-circle'}"></i>${controlled && controlledNetworkTargets.parsed.length ? `受控 · ${escapeHtml(controlledNetworkTargets.parsed.map((target) => target.host).join(', '))}` : '关闭'}</dd></div>
          </dl>
          ${controlled ? `
            <div class="network-target-editor">
              <label for="network-targets-input">网络目标列表（JSON，留空表示关闭）</label>
              <input id="network-targets-input" data-role="network-targets" type="text" spellcheck="false"
                placeholder='[{"host":"api.example.com","port":443,"scheme":"https","methods":["GET"]}]'
                value="${escapeHtml(controlledNetworkTargets.text)}" />
              ${controlledNetworkTargets.error ? `<div class="network-target-error">${escapeHtml(controlledNetworkTargets.error)}</div>` : ''}
            </div>` : ''}
          ${model.approvals.filter((approval) => approval.state === 'REQUESTED' || approval.state === 'APPROVED' || approval.state === 'EXPIRED').map(renderApprovalCard).join('')}
        </section>

        <section class="context-section execution-state-section">
          <div class="section-heading">
            <div><span class="section-kicker">执行状态</span><h3>受控状态</h3></div>
            <button class="icon-button small" data-action="refresh-execution-state" title="刷新执行状态" aria-label="刷新执行状态"><i data-lucide="rotate-ccw-clock"></i></button>
          </div>
          ${executionRecords.length === 0
            ? '<div class="empty-note">暂无已保存的动作请求、审批或一次性授权</div>'
            : `<div class="execution-record-list">${executionRecords.slice(-12).reverse().map((record) => `
              <div class="execution-record">
                <div class="execution-record-heading"><strong>${executionTypeLabel(record.recordType)}</strong><span>${escapeHtml(executionStateLabel(record.state))}</span></div>
                <div class="execution-record-meta">${escapeHtml(record.capability ?? '受控能力')} · ${escapeHtml(formatTime(record.updatedAtMs))}</div>
              </div>`).join('')}</div>`}
        </section>

        ${renderGovernance()}

        ${renderDecisionTrace()}

        ${renderCouncilPanel()}

        ${renderSupportBundle()}

        <section class="context-section runtime-section">
          <div class="section-heading"><div><span class="section-kicker">运行时</span><h3>运行时</h3></div></div>
          <div class="runtime-line"><i data-lucide="terminal-square"></i><span>${model.runtime.platform === 'WINDOWS' ? 'Windows 本地运行时' : 'Web 预览'}</span></div>
          <div class="runtime-line"><i data-lucide="heart-pulse"></i><span>${escapeHtml(runtimeHealth)}</span></div>
          <div class="runtime-line"><i data-lucide="cpu"></i><span title="${escapeHtml(runtimeRoute)}">${escapeHtml(runtimeRoute)}</span></div>
          <div class="runtime-line"><i data-lucide="file-cog"></i><span>${escapeHtml(runtimeConfig)}</span></div>
          <div class="runtime-line"><i data-lucide="database"></i><span title="${escapeHtml(contextSidecar?.state ?? 'LOCAL')} ">本地记忆日志 · ${escapeHtml(contextSidecarState)}${escapeHtml(contextSidecarDetail)}</span></div>
          <div class="runtime-line"><i data-lucide="gauge"></i><span data-projection-version>运行投影 v${model.projectionVersion}</span></div>
        </section>
`;
};

const setTextIfChanged = (element: Node | null, text: string): void => {
  if (element && element.textContent !== text) element.textContent = text;
};
const refreshModeControls = (): void => {
  const controlled = model.composer.mode === 'CONTROLLED';
  const mode = app.querySelector<HTMLButtonElement>('[data-action="toggle-mode"]');
  if (mode) {
    mode.title = desktopBridge.isNative()
      ? (model.runtime.releaseChannel ?? '发布渠道尚未确认')
      : 'Web 预览仅支持只读模式';
    mode.disabled = running || !desktopBridge.isNative() || model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY';
    mode.classList.toggle('mode-controlled', controlled);
    const label = mode.lastChild;
    if (label?.nodeType === Node.TEXT_NODE) setTextIfChanged(label, controlled ? '受控模式' : '只读模式');
  }
  const version = app.querySelector<HTMLElement>('.version-label');
  setTextIfChanged(version, `v${model.runtime.version} · ${controlled ? '受控模式' : '只读模式'}`);
  const note = app.querySelector<HTMLElement>('.composer-note');
  setTextIfChanged(note, controlled
    ? '受控模式只允许已配置范围；每个命令或写入仍需单次审批。'
    : '当前为只读模式，不会执行命令、修改文件或发起外部网络操作。');
};

const renderHistoryView = (timelineItems = model.timeline): void => {
  const view = historyView;
  if (!view || activePage !== 'workbench') return;
  updateThreadList();
  refreshComposerCache();
  refreshModeControls();
  const region = app.querySelector<HTMLElement>('[data-region="conversation"]');
  if (!region) return;
  app.querySelector('.app-shell')?.classList.toggle('context-open', contextVisible);
  app.querySelectorAll<HTMLElement>('[data-action="navigate"]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === activePage);
  });
  if (!settingsVisible) {
    app.querySelector('.settings-backdrop')?.remove();
    const shell = app.querySelector<HTMLElement>('.app-shell');
    if (shell) shell.inert = false;
  }
  if (!region.querySelector('[data-history-items]')) {
    region.innerHTML = `<div class="transcript-heading"><div><span class="eyebrow">任务时间线</span><h1 data-history-title></h1></div></div>
      <div data-history-status role="status"></div>
      <button class="secondary-button" data-action="history-older"><i data-lucide="history"></i><span>加载更早记录</span></button>
      <div class="timeline" data-history-items></div>`;
    historyIcons(region);
  }
  region.querySelector('[data-history-title]')!.textContent = model.threads.find((thread) => thread.id === view.threadId)?.title ?? '历史会话';
  region.setAttribute('aria-busy', String(view.loading));
  const threadRoot = model.threads.find((thread) => thread.id === view.threadId)?.cwd;
  const workspaceHint = threadRoot && model.workspace.rootPath && !sameWorkspaceRoot(threadRoot, model.workspace.rootPath)
    ? '当前工作区与此历史会话不同，发送将在当前目录创建新会话；如需续接，请先打开原目录再选择此会话。' : '';
  const responseHint = model.timeline.some((item) => item.title === '任务完成' && item.body.includes('本地没有可恢复的模型回复正文'))
    ? '此页部分旧任务未保存模型回复正文，现有运行记录无法还原原回复。' : '';
  region.querySelector('[data-history-status]')!.textContent = view.error ?? (view.loading ? '正在加载历史会话…' : [workspaceHint, responseHint].filter(Boolean).join(' ') || (model.timeline.length ? '' : '暂无可显示的历史记录'));
  const older = region.querySelector<HTMLButtonElement>('[data-action="history-older"]')!;
  older.hidden = !view.hasMore && !view.error;
  older.disabled = view.loading || view.loadingOlder;
  older.querySelector('span')!.textContent = view.loadingOlder ? '正在加载…' : view.error ? '重试加载' : '加载更早记录';
  syncKeyedList(region.querySelector<HTMLElement>('[data-history-items]')!, timelineItems,
    (item) => item.itemId, timelineItemHtml, historyIcons);
  const composer = app.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  if (composer) {
    // Keep the editor usable while a directory read is in flight.  The send
    // action remains gated below, so workspace changes cannot start a task,
    // but toggling the disabled attribute no longer makes the composer flash.
    composer.disabled = !model.composer.enabled;
    composer.placeholder = model.composer.placeholder;
  }
  const send = app.querySelector<HTMLButtonElement>('.composer .send-button');
  if (send) send.disabled = !model.composer.enabled || workspaceChanging;
  app.querySelectorAll<HTMLButtonElement>('[data-action="open-workspace"]').forEach((button) => {
    button.disabled = running || workspaceChanging;
  });
  const stop = app.querySelector<HTMLButtonElement>('.composer-stop');
  if (stop) stop.disabled = true;
  const status = app.querySelector<HTMLElement>('.run-status');
  if (status) status.textContent = view.loading ? '正在加载历史会话…' : '历史会话';
  const connection = app.querySelector<HTMLElement>('.connection-status');
  if (connection) {
    connection.className = `connection-status ${model.connection.state === 'READY' ? 'status-ready' : model.connection.state === 'ERROR' ? 'status-error' : 'status-waiting'}`;
    const label = connection.lastChild;
    if (label?.nodeType === Node.TEXT_NODE) label.textContent = model.connection.label;
  }
  const brand = app.querySelector<HTMLElement>('.brand-row strong + span');
  if (brand) brand.textContent = model.runtime.platform === 'WINDOWS' ? 'Windows 本地运行时' : 'Web 预览';
  const mode = app.querySelector<HTMLButtonElement>('[data-action="toggle-mode"]');
  if (mode) {
    mode.title = desktopBridge.isNative()
      ? (model.runtime.releaseChannel ?? '发布渠道尚未确认')
      : 'Web 预览仅支持只读模式';
    mode.disabled = !desktopBridge.isNative() || model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY';
    mode.classList.toggle('mode-controlled', model.composer.mode === 'CONTROLLED');
    const label = mode.lastChild;
    if (label?.nodeType === Node.TEXT_NODE) label.textContent = model.composer.mode === 'CONTROLLED' ? '受控模式' : '只读模式';
  }
  const workspaceTitle = model.workspace.rootLabel || '默认工作区';
  const workspace = app.querySelector<HTMLElement>('.workspace-identity strong');
  if (workspace) { workspace.textContent = workspaceTitle; workspace.title = workspaceTitle; }
  const project = app.querySelector<HTMLElement>('.composer-project');
  if (project) project.textContent = workspaceTitle;
  const route = app.querySelector<HTMLElement>('.composer-summary');
  if (route && model.runtime.model) {
    const value = `${model.runtime.model.provider} 服务 · ${model.runtime.model.model}`;
    route.title = value;
    if (route.lastChild?.nodeType === Node.TEXT_NODE) route.lastChild.textContent = value;
  }
  const context = app.querySelector<HTMLElement>('.context-panel');
  if (context) patchLiveRegion(context, contextPanelInputs(), renderContextContent);
};

const renderWorkspaceEntries = (): string => {
  if (!model.workspace.granted) {
    return `
      <div class="empty-state compact-empty">
        <i data-lucide="folder-open"></i>
        <p>正在加载默认工作区，可以直接开始只读分析。</p>
      </div>`;
  }
  if (model.workspace.entries.length === 0) {
    return '<div class="inline-empty">此目录为空</div>';
  }
  return model.workspace.entries
    .map(
      (entry) => `
        <button class="workspace-entry" data-entry-path="${escapeHtml(entry.relativePath)}" data-entry-kind="${entry.kind}">
          <i data-lucide="${entry.kind === 'DIRECTORY' ? 'folder' : 'file'}"></i>
          <span class="workspace-entry-name">${escapeHtml(entry.name)}</span>
          <span class="workspace-entry-size">${entry.kind === 'FILE' ? formatBytes(entry.sizeBytes) : ''}</span>
          ${entry.kind === 'DIRECTORY' ? '<i data-lucide="chevron-right" class="entry-chevron"></i>' : ''}
        </button>`
    )
    .join('');
};

const renderSelectedFile = (): string => {
  const file = model.workspace.selectedFile;
  if (!file) return '';
  const preview = file.binary
    ? '<div class="binary-notice">二进制文件仅显示元数据，未载入正文。</div>'
    : `<pre>${escapeHtml(file.content)}</pre>`;
  return `
    <section class="file-preview" aria-label="文件预览">
      <div class="section-heading file-heading">
        <div>
          <span class="section-kicker">只读预览</span>
          <h3>${escapeHtml(file.relativePath)}</h3>
        </div>
        <span class="file-size">${formatBytes(file.totalBytes)}${file.truncated ? ' · 已截断' : ''}</span>
      </div>
      ${preview}
      <div class="digest" title="${escapeHtml(file.contentDigest)}">${escapeHtml(file.contentDigest)}</div>
    </section>`;
};

const exportData = async (scope: string): Promise<void> => {
  exportNotice = '正在导出…'; render();
  try {
    const result = await desktopBridge.exportData(scope);
    exportNotice = result.ok ? `导出完成：${result.output ?? '已生成文件'}` : `导出未完成：${result.error ?? '未知错误'}`;
  } catch (error) { exportNotice = `导出未完成：${error instanceof Error ? error.message : String(error)}`; }
  render();
};

const recordRecovery = (recovery: RuntimeRecoveryResponse): void => {
  lastRecovery = {
    reconciled: recovery.reconciled,
    atMs: Date.now(),
    execution: recovery.execution?.reconciled ?? 0,
    roles: recovery.roles?.reconciled ?? 0,
    dream: recovery.dream?.reconciled ?? 0,
    pendingApprovals: recovery.pendingApprovals ?? 0,
    pendingApprovalRecords: Array.isArray(recovery.pendingApprovalRecords) ? recovery.pendingApprovalRecords : [],
    leaseRecords: Array.isArray(recovery.leaseRecords)
      ? recovery.leaseRecords
      : (Array.isArray(recovery.revokedLeaseRecords) ? recovery.revokedLeaseRecords as unknown as RuntimeExecutionRecord[] : []),
    revokedLeases: recovery.revokedLeases ?? 0,
    revokedLeaseRecords: Array.isArray(recovery.revokedLeaseRecords) ? recovery.revokedLeaseRecords : [],
    executionRecords: recovery.execution?.records ?? [],
    workspace: recovery.workspace,
    remote: recovery.remote
  };
};

const runRecoveryCheck = async (): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  try {
    const recovery = await desktopBridge.reconcileRuntimeState();
    recordRecovery(recovery);
    update(appendTimelineItem(model, {
      kind: 'STATUS',
      title: '恢复检查',
      body: `已核对 ${recovery.reconciled} 条待恢复记录，未自动重放任何任务或副作用。`,
      status: 'COMPLETE'
    }));
  } catch (error) {
    update(appendErrorTimelineItem(model, '恢复检查', error));
  }
};

const runRecoveryRecordAction = async (element: HTMLElement): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  const action = element.dataset.action;
  const recordId = element.dataset.recordId ?? '';
  const expectedDigest = element.dataset.recordDigest || undefined;
  const key = `${action}:${recordId}`;
  if (!recordId || pendingRecoveryActions.has(key)) return;
  pendingRecoveryActions.add(key);
  const button = element instanceof HTMLButtonElement ? element : undefined;
  const idleLabel = button?.textContent ?? '';
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = '处理中…';
  }
  try {
    if (action === 'cancel-recovery-approval') {
      await desktopBridge.cancelExecutionApproval(recordId, expectedDigest);
    } else if (action === 'revoke-recovery-lease') {
      await desktopBridge.revokeExecutionLease(recordId, expectedDigest);
    } else {
      return;
    }
    update(appendTimelineItem(model, {
      kind: 'STATUS',
      title: '恢复操作',
      body: action === 'cancel-recovery-approval' ? `已提交审批 ${recordId} 的安全取消。` : `已提交 Lease ${recordId} 的撤销。`,
      status: 'COMPLETE'
    }));
    await refreshExecutionState({ allowDuringRun: true });
    await runRecoveryCheck();
  } catch (error) {
    update(appendErrorTimelineItem(model, '恢复操作', error));
  } finally {
    pendingRecoveryActions.delete(key);
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = idleLabel;
    }
  }
};

const renderWorkspaceDiff = (): string => {
  const intents = executionRecords.filter((record) => record.recordType === 'intent');
  const leases = executionRecords.filter((record) => record.recordType === 'lease');
  const proposed = intents.map((record) => ({ id: record.operationId ?? record.recordId, detail: `${toolDisplayLabel(record.capability ?? '受控操作')} · ${executionStateLabel(record.state)}` }));
  const executed = leases.filter((record) => ['CONSUMED', 'REVOKED', 'EXPIRED'].includes(String(record.state).toUpperCase())).map((record) => ({ id: record.operationId ?? record.recordId, detail: `${toolDisplayLabel(record.capability ?? '受控操作')} · ${executionStateLabel(record.state)}` }));
  const verifier = model.processVerification;
  const verified = verifier?.status ? [{ id: verifier.lastRunId ?? '当前验证', detail: `${statusDisplayLabel(verifier.status, '暂不判断')}${verifier.source ? ` · ${processSourceLabel(verifier.source)}` : ''}` }] : [];
  const sections = [
    { state: 'PROPOSED', label: '建议变更', rows: proposed, empty: '暂无已保存的动作请求；模型建议不会被视为已写入。' },
    { state: 'EXECUTED', label: '已执行变更', rows: executed, empty: '暂无已确认的执行结果。' },
    { state: 'VERIFIED', label: '已验证变更', rows: verified, empty: '暂无通过验证的变更证据。' }
  ];
  const workspace = lastRecovery?.workspace;
  return `<section class="context-section workspace-diff-section" aria-label="工作区变更证据" data-diff-panel="workspace">
    <div class="section-heading"><div><span class="section-kicker">工作区差异</span><h3>变更证据</h3></div><span class="context-count">建议 / 执行 / 验证</span></div>
    <div class="runtime-line"><i data-lucide="git-compare"></i><span>${workspace ? `当前观察 ${statusDisplayLabel(workspace.status, '未知')} · ${workspace.changedFiles ?? 0} 个路径 · 路径摘要 ${(workspace.pathDigests ?? []).length} 条` : '尚未生成工作区观察'}</span></div>
    <div class="workspace-diff-grid">${sections.map((section) => `<div class="workspace-diff-column" data-diff-state="${section.state.toLowerCase()}"><strong>${section.label}</strong>${section.rows.length ? section.rows.map((row) => `<div class="runtime-line" data-diff-row="${escapeHtml(row.id)}"><i data-lucide="file-diff"></i><span>${escapeHtml(row.id)} · ${escapeHtml(row.detail)}</span></div>`).join('') : `<span class="empty-note">${section.empty}</span>`}</div>`).join('')}</div>
    <div class="runtime-line"><i data-lucide="shield-check"></i><span>三种状态分别来自动作请求、一次性授权和结果核对；缺少证据时保持空态。</span></div>
  </section>`;
};

const renderWorkspacePage = (): string => {
  const title = model.workspace.rootLabel || '默认工作区';
  const fullPath = workspaceDisplayPath(model.workspace.rootPath, title, model.workspace.currentPath);
  const entries = model.workspace.granted ? renderWorkspaceEntries() : '<div class="page-status page-status-loading"><i data-lucide="loader-circle" class="spin"></i><span>正在加载授权工作区…</span></div>';
  return `<div class="page-placeholder"><span class="eyebrow">工作区</span><h1>${escapeHtml(title)}</h1>
    <div class="route-heading"><div><span class="eyebrow">Workspace</span><h2>${escapeHtml(title)}</h2><div class="workspace-path workspace-page-path" title="${escapeHtml(fullPath)}">${escapeHtml(fullPath)}</div></div>${model.workspace.granted && model.workspace.currentPath ? '<button class="secondary-button" data-action="workspace-up">返回上级</button>' : `<button class="secondary-button" data-action="open-workspace" ${running || workspaceChanging ? 'disabled' : ''}>打开项目</button>`}</div>
    <div class="workspace-list" data-scroll-anchor="workspace-diff-list">${entries}</div>
    ${renderSelectedFile()}
    ${renderWorkspaceDiff()}
    <button class="secondary-button" data-action="navigate" data-page="workbench">返回工作台</button>
  </div>`;
};
const renderMemoryPage = (): string => {
  const allMemories = model.memories.slice().sort((left, right) => right.updatedAtMs - left.updatedAtMs || left.memoryId.localeCompare(right.memoryId));
  const pageCount = Math.max(1, Math.ceil(allMemories.length / 8));
  memoryPage = Math.min(memoryPage, pageCount);
  const memories = allMemories.slice((memoryPage - 1) * 8, memoryPage * 8);
  const dreams = model.dreamRuns.slice().sort((left, right) => right.startedAtMs - left.startedAtMs).slice(0, 6);
  const counts = {
    active: allMemories.filter((memory) => memory.status === 'ACTIVE').length,
    proposed: allMemories.filter((memory) => memory.status === 'PROPOSED' || memory.status === 'VERIFIED').length,
    conflicts: allMemories.filter((memory) => (memory.conflictsWithMemoryIds?.length ?? 0) > 0).length,
    retracted: allMemories.filter((memory) => ['RETRACTED', 'PRUNED', 'REJECTED'].includes(memory.status)).length
  };
  const renderMemoryActions = (memory: typeof allMemories[number]): string => {
    const edit = ['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(memory.status)
      ? '<button class="governance-button" data-action="memory-edit" data-memory-id="' + escapeHtml(memory.memoryId) + '">编辑新版本</button>'
      : '';
    const conflict = memory.conflictsWithMemoryIds?.length
      ? '<button class="governance-button governance-button-warning" data-action="memory-action" data-operation="resolve-conflict" data-memory-id="' + escapeHtml(memory.memoryId) + '">处理冲突</button>'
      : '';
    if (memory.status === 'PROPOSED') return '<div class="governance-actions">' + edit + conflict + '<button class="governance-button governance-button-primary" data-action="memory-action" data-operation="verify" data-accepted="true" data-memory-id="' + escapeHtml(memory.memoryId) + '">验证</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="verify" data-accepted="false" data-memory-id="' + escapeHtml(memory.memoryId) + '">拒绝</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="' + escapeHtml(memory.memoryId) + '">删除</button></div>';
    if (memory.status === 'VERIFIED') return '<div class="governance-actions">' + edit + conflict + '<button class="governance-button governance-button-primary" data-action="memory-action" data-operation="activate" data-memory-id="' + escapeHtml(memory.memoryId) + '">激活</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="' + escapeHtml(memory.memoryId) + '">删除</button></div>';
    if (memory.status === 'ACTIVE') return '<div class="governance-actions">' + edit + conflict + '<button class="governance-button governance-button-danger" data-action="memory-action" data-operation="retract" data-memory-id="' + escapeHtml(memory.memoryId) + '">撤回</button><button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="' + escapeHtml(memory.memoryId) + '">删除</button></div>';
    return conflict ? '<div class="governance-actions">' + conflict + '</div>' : '';
  };
  const renderEditForm = (memory: typeof allMemories[number]): string => {
    const draft = memoryEditState?.memoryId === memory.memoryId
      ? memoryEditState
      : {
          memoryId: memory.memoryId,
          statement: memory.statement,
          scope: memory.scope,
          confidence: String(memory.confidence),
          sourceEventIds: (memory.sourceEventIds ?? []).join(', '),
          sensitivity: memory.sensitivity ?? 'INTERNAL'
        };
    return '<form class="memory-edit-form" data-form="memory-edit" data-memory-id="' + escapeHtml(memory.memoryId) + '" novalidate>'
      + '<div class="memory-edit-heading"><strong>编辑新版本</strong><span>保存后生成版本 ' + escapeHtml(String(Number(memory.version ?? 1) + 1)) + '，旧记录仍保留审计关系。</span></div>'
      + '<label class="settings-field settings-field-multiline"><span>结论</span><textarea name="statement" rows="3" maxlength="2000" required>' + escapeHtml(draft.statement) + '</textarea></label>'
      + '<div class="settings-grid"><label class="settings-field"><span>适用范围</span><input name="scope" maxlength="256" required value="' + escapeHtml(draft.scope) + '"></label>'
      + '<label class="settings-field"><span>置信度（0-1）</span><input name="confidence" type="number" min="0" max="1" step="0.01" required value="' + escapeHtml(draft.confidence) + '"></label></div>'
      + '<div class="settings-grid"><label class="settings-field"><span>敏感性</span><select name="sensitivity"><option value="PUBLIC" ' + (draft.sensitivity === 'PUBLIC' ? 'selected' : '') + '>公开</option><option value="INTERNAL" ' + (draft.sensitivity === 'INTERNAL' ? 'selected' : '') + '>内部</option><option value="SENSITIVE" ' + (draft.sensitivity === 'SENSITIVE' ? 'selected' : '') + '>敏感</option><option value="RESTRICTED" ' + (draft.sensitivity === 'RESTRICTED' ? 'selected' : '') + '>受限</option></select></label>'
      + '<label class="settings-field"><span>来源事件编号</span><input name="sourceEventIds" maxlength="8000" required value="' + escapeHtml(draft.sourceEventIds) + '"></label></div>'
      + (memoryEditError ? '<div class="settings-message settings-message-error" role="alert">' + escapeHtml(memoryEditError) + '</div>' : '')
      + '<div class="governance-actions"><button type="button" class="secondary-button" data-action="memory-edit-cancel">取消</button><button type="submit" class="governance-button governance-button-primary">保存为新版本</button></div></form>';
  };
  const memoryRows = memories.map((memory) => {
    const supersededBy = allMemories.find((candidate) => candidate.supersedesMemoryId === memory.memoryId);
    const relations = [
      memory.supersedesMemoryId ? '替代 ' + memory.supersedesMemoryId : '',
      supersededBy ? '已被新版本替代 ' + supersededBy.memoryId : '',
      memory.conflictsWithMemoryIds?.length ? '冲突 ' + memory.conflictsWithMemoryIds.join(', ') : ''
    ].filter(Boolean).join(' · ');
    const details = '来源 ' + ((memory.sourceEventIds ?? []).join(', ') || '未知')
      + ' · 有效期 ' + (memory.expiresAtMs === undefined ? '未设置' : new Date(memory.expiresAtMs).toLocaleString('zh-CN', { timeZoneName: 'short' }))
      + ' · ' + (memory.untrainable === true ? '禁止训练标记：是' : memory.untrainable === false ? '禁止训练标记：否（不代表已获训练授权）' : '训练限制：未提供')
      + (memory.sensitivity ? ' · 敏感性 ' + sensitivityDisplayLabel(memory.sensitivity) : '')
      + (memory.version !== undefined ? ' · 版本 ' + memory.version : '')
      + (relations ? ' · ' + relations : '');
    const editing = memoryEditState?.memoryId === memory.memoryId;
    return '<article class="run-history-row memory-row" data-memory-id="' + escapeHtml(memory.memoryId) + '"><div class="run-history-copy"><strong>' + escapeHtml(memory.statement) + '</strong><span>' + escapeHtml(memory.scope) + ' · 置信度 ' + Math.round(memory.confidence * 100) + '% · ' + escapeHtml(governanceStateLabel(memory.status)) + '</span><small>' + escapeHtml(details) + '</small></div>' + (editing ? renderEditForm(memory) : renderMemoryActions(memory)) + '</article>';
  }).join('');
  const statusSummary = '<div class="memory-status-summary" aria-label="记忆分类"><span>已启用 ' + counts.active + '</span><span>待确认 ' + counts.proposed + '</span><span class="memory-conflict-count">冲突 ' + counts.conflicts + '</span><span>已撤回 ' + counts.retracted + '</span></div>';
  const editHint = memoryEditState ? '<div class="page-status memory-edit-hint"><strong>正在编辑 ' + escapeHtml(memoryEditState.memoryId) + '</strong><span>编辑会创建新版本，提交前请核对来源和敏感性。</span></div>' : '';
  return '<div class="page-placeholder"><span class="eyebrow">记忆</span><h1>记忆</h1>'
    + (governanceReadFailed ? '<div class="page-status memory-action-error" role="alert"><strong>刷新未完成</strong><span>无法读取最新治理状态，当前显示上次读取的记录。请重新读取后核对。</span><button class="secondary-button" data-action="refresh-governance">重新读取</button></div>' : '')
    + (memoryActionError ? '<div class="page-status memory-action-error" role="alert"><strong>操作未完成</strong><span>请求未成功返回，结果尚未确认。请先刷新治理状态核对，再决定是否重试；页面保留上次读取的记录。</span><button class="secondary-button" data-action="refresh-governance">刷新治理状态</button></div>' : '')
    + statusSummary + editHint
    + '<div class="run-history-list">' + (memoryRows || '<div class="page-status page-status-empty"><strong>暂无记忆</strong><span>当前没有已提交记忆。</span></div>') + '</div>'
    + (pageCount > 1 ? '<nav aria-label="记忆分页" class="route-heading"><button class="secondary-button" data-action="memory-page" data-delta="-1" ' + (memoryPage === 1 ? 'disabled' : '') + '>上一页</button><span>第 ' + memoryPage + ' / ' + pageCount + ' 页 · 共 ' + allMemories.length + ' 条</span><button class="secondary-button" data-action="memory-page" data-delta="1" ' + (memoryPage === pageCount ? 'disabled' : '') + '>下一页</button></nav>' : '')
    + '<div class="route-heading"><div><span class="eyebrow">后台整理</span><h2>后台整理状态</h2></div><div class="governance-actions"><button class="governance-button governance-button-primary" data-action="run-dream" ' + (desktopBridge.isNative() ? '' : 'disabled') + '>运行一次</button>' + (model.runtime.dreamMaintenance?.running === true ? '<button class="governance-button governance-button-danger" data-action="stop-dream-maintenance">停止后台</button>' : '<button class="governance-button" data-action="start-dream-maintenance" ' + (desktopBridge.isNative() ? '' : 'disabled') + '>启动后台</button>') + '</div></div>'
    + '<div class="run-history-list">' + (dreams.map((dream) => '<div class="run-history-row"><div class="run-history-copy"><strong>后台记忆整理 · ' + escapeHtml(shortDigest(dream.runId)) + '</strong><span>' + escapeHtml(statusDisplayLabel(dream.state)) + ' · ' + escapeHtml(formatTime(dream.startedAtMs)) + '</span></div><span class="run-history-state">' + escapeHtml(dream.errorCode ? reasonDisplayLabel(dream.errorCode) : (dream.finishedAtMs ? '已完成' : '运行中')) + '</span></div>').join('') || '<div class="page-status page-status-empty"><strong>暂无后台整理记录</strong><span>当前没有后台记忆整理运行记录。</span></div>') + '</div>'
    + '<button class="secondary-button" data-action="navigate" data-page="workbench">返回工作台</button></div>';
};
const renderSafetyPage = (): string => {
  const approvals = model.approvals.filter((approval) => approval.state === 'REQUESTED' || approval.state === 'APPROVED' || approval.state === 'EXPIRED');
  const controlled = model.composer.mode === 'CONTROLLED';
  const network = controlledNetworkTargets.parsed.length ? controlledNetworkTargets.parsed.map((target) => target.host).join(', ') : '关闭';
  const records = executionRecords.slice(-12).reverse();
  const latestApproval = approvals[0];
  const actionRows = latestApproval ? [
    ['能力', latestApproval.capability || '未提供'],
    ['审批状态', latestApproval.state],
    ['策略判定', '未提供'],
    ['风险等级', latestApproval.risk ?? '未提供'],
    ['required controls', '未提供'],
    ['适用范围', latestApproval.scope?.snapshotDigest ? `快照 ${latestApproval.scope.snapshotDigest.slice(0, 20)}…` : '未提供'],
    ['策略版本', latestApproval.policyVersion ?? '未提供'],
    ['权限上限来源', '未提供']
  ] : [];
  const rows = [
    ['执行模式', controlled ? '受控，逐项审批' : '只读'],
    ['命令执行', controlled ? '受控' : '关闭'],
    ['文件写入', controlled ? '受控' : '关闭'],
    ['外部网络', network]
  ].map(([k, v]) => '<div class="run-history-row"><div class="run-history-copy"><strong>' + escapeHtml(k) + '</strong><span>' + escapeHtml(v) + '</span></div></div>').join('');
  const recordRows = records.map((record) => '<div class="run-history-row"><div class="run-history-copy"><strong>' + escapeHtml(executionTypeLabel(record.recordType)) + '</strong><span>' + escapeHtml(record.capability ?? '受控能力') + ' · ' + escapeHtml(formatTime(record.updatedAtMs)) + '</span></div><span class="run-history-state">' + escapeHtml(executionStateLabel(record.state)) + '</span></div>').join('');
  return `<div class="page-placeholder"><span class="eyebrow">能力与安全</span><h1>能力与安全</h1>
    <div class="run-history-list">${rows}</div>
    <div class="route-heading"><div><span class="eyebrow">动作审批</span><h2>待审批动作信息</h2></div><span class="route-count">${actionRows.length ? '已记录' : '暂无'}</span></div>
    ${actionRows.length ? `<div class="run-history-list">${actionRows.map(([k, v]) => '<div class="run-history-row"><div class="run-history-copy"><strong>' + escapeHtml(k) + '</strong><span>' + escapeHtml(v) + '</span></div></div>').join('')}</div>` : '<div class="page-status page-status-empty"><strong>暂无待审批动作</strong><span>收到审批请求后显示已记录字段；未提供的策略信息保持未知。</span></div>'}
    <div class="route-heading"><div><span class="eyebrow">执行状态</span><h2>受控记录</h2></div><span class="route-count">${records.length} 条</span></div>
    ${recordRows ? `<div class="run-history-list">${recordRows}</div>` : '<div class="page-status page-status-empty"><strong>暂无受控记录</strong><span>当前没有已保存的动作请求、审批或一次性授权。</span></div>'}
    ${approvals.length ? `<section class="workbench-approvals" aria-label="审批与授权状态"><div class="transcript-heading"><div><span class="eyebrow">审批</span><h2>审批与授权状态</h2></div></div>${approvals.map(renderApprovalCard).join('')}</section>` : ''}
    <button class="secondary-button" data-action="navigate" data-page="workbench">返回工作台</button>
  </div>`;
};
const renderRecoveryDetails = (recovery: NonNullable<typeof lastRecovery>): string => {
  const recoveryRecordRow = (record: Record<string, unknown>, label: string): string => {
    const recordId = typeof record.recordId === 'string' ? record.recordId : '未知记录';
    const state = typeof record.state === 'string' ? record.state : '未知状态';
    const runId = typeof record.runId === 'string' ? record.runId : '';
    const operationId = typeof record.operationId === 'string' ? record.operationId : '';
    const recordDigest = typeof record.recordDigest === 'string' ? record.recordDigest : '';
    const transition = record.transition && typeof record.transition === 'object' && !Array.isArray(record.transition) ? record.transition as Record<string, unknown> : undefined;
    const metadata = transition?.metadata && typeof transition.metadata === 'object' && !Array.isArray(transition.metadata) ? transition.metadata as Record<string, unknown> : undefined;
    const reason = typeof record.reason === 'string' ? record.reason : typeof metadata?.reason === 'string' ? metadata.reason : '';
    const view = '<button class="governance-button" data-action="view-recovery-record" data-record-id="' + escapeHtml(recordId) + '">查看状态</button>';
    const digestAttr = recordDigest ? ' data-record-digest="' + escapeHtml(recordDigest) + '"' : '';
    const approvalAction = label === '待处理审批' && ['REQUESTED', 'PRESENTED'].includes(state)
      ? '<button class="governance-button governance-button-warning" data-action="cancel-recovery-approval" data-record-id="' + escapeHtml(recordId) + '"' + digestAttr + '>安全取消</button>'
      : '';
    const leaseAction = label === '一次性授权' && ['PROPOSED', 'ACTIVE', 'CONSUMING'].includes(state)
      ? '<button class="governance-button governance-button-danger" data-action="revoke-recovery-lease" data-record-id="' + escapeHtml(recordId) + '"' + digestAttr + '>撤销授权</button>'
      : '';
    return '<div class="run-history-row" data-recovery-record="' + escapeHtml(recordId) + '"><div class="run-history-copy"><strong>' + escapeHtml(label) + '</strong><span>记录 ' + escapeHtml(shortDigest(recordId)) + (operationId ? ' · 操作 ' + escapeHtml(shortDigest(operationId)) : '') + '</span><small>状态 ' + escapeHtml(executionStateLabel(state)) + (runId ? ' · 运行 ' + escapeHtml(shortDigest(runId)) : '') + (reason ? ' · 原因 ' + escapeHtml(reasonDisplayLabel(reason)) : '') + (recordDigest ? ' · 校验摘要 ' + escapeHtml(shortDigest(recordDigest)) : '') + '</small></div><span class="run-history-state">' + escapeHtml(executionStateLabel(state)) + '</span><div class="governance-actions">' + view + approvalAction + leaseAction + '</div></div>';
  };
  const approvalRows = recovery.pendingApprovalRecords.map((record) => recoveryRecordRow(record, '待处理审批'));
  const leaseRows = recovery.leaseRecords.map((record) => recoveryRecordRow(record as unknown as Record<string, unknown>, '一次性授权'));
  const executionRows = recovery.executionRecords.slice(-12).reverse().map((record) => '<div class="run-history-row"><div class="run-history-copy"><strong>' + escapeHtml(executionTypeLabel(record.recordType)) + '</strong><span>记录 ' + escapeHtml(shortDigest(record.recordId)) + ' · ' + escapeHtml(toolDisplayLabel(record.capability ?? '受控能力')) + '</span><small>状态 ' + escapeHtml(executionStateLabel(record.state)) + ' · 更新时间 ' + escapeHtml(formatTime(record.updatedAtMs)) + (record.recordDigest ? ' · 校验摘要 ' + escapeHtml(shortDigest(record.recordDigest)) : '') + '</small></div><span class="run-history-state">' + escapeHtml(executionStateLabel(record.state)) + '</span><button class="governance-button" data-action="view-recovery-record" data-record-id="' + escapeHtml(record.recordId) + '">查看状态</button></div>');
  const workspaceLine = recovery.workspace
    ? '<div class="runtime-line"><i data-lucide="git-branch"></i><span>工作区检查：' + escapeHtml((recovery.workspace.statusCodes ?? []).join(', ') || '未发现状态码') + ' · 路径摘要 ' + String((recovery.workspace.pathDigests ?? []).length) + ' 条' + (recovery.workspace.pathDigestTruncated ? '（已截断）' : '') + '</span></div>'
    : '';
  const remote = recovery.remote ?? { state: 'LOCAL_ONLY' as const, reason: '当前只使用本地恢复存储' };
  const remoteLine = '<div class="runtime-line" data-recovery-remote-state="' + escapeHtml(remote.state) + '"><i data-lucide="cloud"></i><span>远端状态：' + escapeHtml(statusDisplayLabel(remote.state, '未读取')) + (remote.endpoint ? ' · ' + escapeHtml(remote.endpoint) : '') + (remote.reason ? ' · ' + escapeHtml(reasonDisplayLabel(remote.reason)) : '') + '</span></div>';
  const count = recovery.executionRecords.length + recovery.pendingApprovalRecords.length + recovery.leaseRecords.length;
  const executionBlock = executionRows.length ? '<div class="run-history-list" aria-label="执行记录">' + executionRows.join('') + '</div>' : '<div class="empty-note">暂无可恢复执行记录</div>';
  const approvalBlock = approvalRows.length ? '<div class="run-history-list" aria-label="待处理审批">' + approvalRows.join('') + '</div>' : '<div class="empty-note">暂无待处理审批</div>';
  const leaseBlock = leaseRows.length ? '<div class="run-history-list" aria-label="一次性授权记录">' + leaseRows.join('') + '</div>' : '<div class="empty-note">暂无一次性授权记录</div>';
  const workspaceSummary = recovery.workspace
    ? ' · 工作区 ' + escapeHtml(statusDisplayLabel(recovery.workspace.status, '未知')) + ' · 差异 ' + String(recovery.workspace.changedFiles ?? 0) + '（暂存 ' + String(recovery.workspace.staged ?? 0) + ' / 未暂存 ' + String(recovery.workspace.unstaged ?? 0) + ' / 未跟踪 ' + String(recovery.workspace.untracked ?? 0) + ' / 冲突 ' + String(recovery.workspace.conflicted ?? 0) + '）'
    : '';
  return '<div class="run-history-row"><div class="run-history-copy"><strong>最近恢复检查</strong><span>' + String(recovery.reconciled) + ' 条待恢复记录 · ' + escapeHtml(formatTime(recovery.atMs)) + '</span><small>执行 ' + String(recovery.execution) + ' · 角色 ' + String(recovery.roles) + ' · 后台记忆整理 ' + String(recovery.dream) + ' · 待审批 ' + String(recovery.pendingApprovals) + ' · 已撤销授权 ' + String(recovery.revokedLeases) + workspaceSummary + '</small></div><span class="run-history-state">已核对</span></div><section class="recovery-details" aria-label="恢复逐项详情"><div class="section-heading"><div><span class="section-kicker">恢复详情</span><h3>逐项恢复事实</h3></div><span class="context-count">' + String(count) + ' 条记录</span></div>' + executionBlock + approvalBlock + leaseBlock + workspaceLine + remoteLine + '</section>';
};

const renderDiagnosticsPage = (): string => {
  const health = model.runtime.runtimeReady === true ? '健康检查通过' : model.runtime.platform === 'WINDOWS' ? '等待健康检查' : 'Web 预览无本地模型';
  const connection = model.connection.mode === 'LOCAL_RUNTIME' ? '本地运行时' : 'Web 预览';
  const support = model.supportBundle;
  const supportLine = support
    ? `隐私扫描 ${support.privacy.scan.ok ? '通过' : '失败'} · ${support.privacy.scan.violations.length} 个违规`
    : '诊断包尚未生成';
  const usage = model.modelUsage;
  const cacheRate = usage?.status === 'REPORTED' && usage.cacheHitRate !== null
    ? `${(usage.cacheHitRate * 100).toFixed(1)}%`
    : '未知';
  const cacheCoverage = usage?.cacheCoverage !== null && usage?.cacheCoverage !== undefined
    ? `${(usage.cacheCoverage * 100).toFixed(1)}%`
    : '未知';
  const cachedTokens = usage?.status === 'REPORTED' ? String(usage.cachedInputTokens) : '未知';
  const uncachedTokens = usage?.status === 'REPORTED' ? String(usage.uncachedInputTokens) : '未知';
  const cacheLine = usage
    ? `命中率 ${cacheRate} · 覆盖率 ${cacheCoverage} · 已复用 ${cachedTokens} 个令牌 · 未复用 ${uncachedTokens} 个令牌 · 输入 ${usage.inputTokens} 个令牌`
    : '尚无模型用量记录';
  return `
    <div class="page-placeholder"><span class="eyebrow">设置与诊断</span><h1>设置与诊断</h1>
      <div class="run-history-list">
      <div class="run-history-row"><div class="run-history-copy"><strong>运行时状态</strong><span>${escapeHtml(connection)} · ${escapeHtml(health)}</span></div><span class="run-history-state">${model.runtime.runtimeReady === true ? '就绪' : '未就绪'}</span></div>
        <div class="run-history-row"><div class="run-history-copy"><strong>诊断导出</strong><span>${escapeHtml(supportLine)}</span></div><span class="run-history-state">${support ? '可用' : '未生成'}</span></div>
        <div class="run-history-row" data-model-cache="diagnostics"><div class="run-history-copy"><strong>提示缓存</strong><span>${escapeHtml(cacheLine)}</span></div><span class="run-history-state">${usage?.status === 'REPORTED' ? '已观测' : '未知'}</span></div>
      </div>
      ${lastRecovery ? renderRecoveryDetails(lastRecovery) : ''}
      ${exportNotice ? `<div class="page-status" role="status">${escapeHtml(exportNotice)}</div>` : ''}
      <div class="diagnostic-actions"><button class="secondary-button" data-action="run-recovery-check" ${desktopBridge.isNative() ? '' : 'disabled'}>恢复检查</button><button class="secondary-button" data-action="export-data" data-scope="all" ${desktopBridge.isNative() ? '' : 'disabled'}>导出全部数据</button></div>
    </div>
  `;
};
const renderRunsPage = (): string => {
  const allRuns = projectionRuns.slice().sort((left, right) => right.startedAtMs - left.startedAtMs);
  const perPage = 50;
  const pageCount = Math.max(1, Math.ceil(allRuns.length / perPage));
  if (runsPage > pageCount) runsPage = pageCount;
  const runs = allRuns.slice((runsPage - 1) * perPage, runsPage * perPage);
  const summary = allRuns.length > 0 ? allRuns.length + " 次运行" : "暂无运行记录";
  return `<div class="page-placeholder"><span class="eyebrow">运行记录</span><h1>运行记录</h1>
    <div class="route-heading"><div><span class="eyebrow">运行投影</span><h2>${escapeHtml(summary)}</h2></div><span class="route-count">${runs.length} 条已载入</span></div>
    ${runs.length === 0 ? `<div class="page-status page-status-empty"><strong>暂无运行记录</strong><span>当前投影还没有持久化运行记录。</span></div>` : `<div class="run-history-list">${runs.map((run) => `<div class="run-history-row" data-run-id="${escapeHtml(run.runId)}"><div class="run-history-copy"><strong>${escapeHtml(run.title)}</strong><span>${escapeHtml(statusDisplayLabel(run.state, '状态未读取'))} · ${escapeHtml(formatTime(run.startedAtMs))} · 已记录 ${run.lastEventSequence} 项事件</span></div><span class="run-history-state">${escapeHtml(run.terminal ? "已结束" : "进行中")}</span><button class="secondary-button" data-action="focus-run" data-run-id="${escapeHtml(run.runId)}">查看</button></div>`).join("")}</div>`}
    ${allRuns.length > perPage ? '<div class="route-heading"><button class="secondary-button" data-action="runs-page" data-delta="-1" ' + (runsPage <= 1 ? 'disabled' : '') + '>上一页</button><span class="route-count">第 ' + runsPage + ' / ' + pageCount + ' 页</span><button class="secondary-button" data-action="runs-page" data-delta="1" ' + (runsPage >= pageCount ? 'disabled' : '') + '>下一页</button></div>' : ''}
    <button class="secondary-button" data-action="navigate" data-page="workbench">返回工作台</button></div>`;
};

const renderPageStatus = (page: string): string => {
  const meta = primaryPages[page] ?? { title: '页面', description: '内容正在准备。' };
  const stale = model.connection.state === 'ERROR' ? 'stale' : '';
  const loading = !stale && page !== 'workbench' && !model.workspace.granted;
  const body = loading
    ? '<div class="page-status page-status-loading"><i data-lucide="loader-circle" class="spin"></i><span>正在加载页面数据…</span></div>'
    : stale
      ? '<div class="page-status page-status-stale" role="alert"><strong>连接状态已过期</strong><span>连接失败，请检查本地运行时状态。</span></div>'
      : '<div class="page-status page-status-empty"><strong>暂无内容</strong><span>' + escapeHtml(meta.description) + '</span></div>';
  return '<div class="page-placeholder"><span class="eyebrow">' + escapeHtml(meta.title) + '</span><h1>' + escapeHtml(meta.title) + '</h1>' + body + '<button class="secondary-button" data-action="navigate" data-page="workbench">返回工作台</button></div>';
};

const liveRegions = new WeakMap<HTMLElement, { inputs: unknown[]; html: string }>();
type ScrollSnapshot = { key: string; top: number; left: number };
const scrollAnchors = (element: HTMLElement): HTMLElement[] => [
  element,
  ...[...element.querySelectorAll<HTMLElement>('[data-scroll-anchor], .file-preview pre, .subagent-list')]
];
const captureScrollPositions = (element: HTMLElement): ScrollSnapshot[] => scrollAnchors(element).map((node, index) => ({
  key: node === element ? '__root__' : node.dataset.scrollAnchor ?? `${node.tagName.toLowerCase()}:${node.className}:${index}`,
  top: node.scrollTop,
  left: node.scrollLeft
}));
const restoreScrollPositions = (element: HTMLElement, snapshots: ScrollSnapshot[]): void => {
  const nodes = new Map(scrollAnchors(element).map((node, index) => [
    node === element ? '__root__' : node.dataset.scrollAnchor ?? `${node.tagName.toLowerCase()}:${node.className}:${index}`,
    node
  ]));
  snapshots.forEach(({ key, top, left }) => {
    const node = nodes.get(key);
    if (!node) return;
    node.scrollTop = Math.min(top, Math.max(0, node.scrollHeight - node.clientHeight));
    node.scrollLeft = Math.min(left, Math.max(0, node.scrollWidth - node.clientWidth));
  });
};
const patchLiveRegion = (element: HTMLElement | null, inputs: unknown[], html: () => string, scrollSelector?: string): void => {
  if (!element) return;
  const previous = liveRegions.get(element);
  if (previous && inputs.length === previous.inputs.length && inputs.every((value, i) => value === previous.inputs[i])) return;
  const content = html();
  // The initial shell already contains the same HTML. Avoid replacing it a
  // second time just to seed the cache; that replacement resets scroll/layout
  // in the WebView and is visible as a brief panel jump during startup.
  const needsPatch = previous ? content !== previous.html : element.innerHTML !== content;
  if (needsPatch) {
    const scrollPositions = captureScrollPositions(element);
    const scrollTarget = scrollSelector ? element.querySelector<HTMLElement>(scrollSelector) : element;
    const scroll = scrollTarget?.scrollTop ?? 0;
    const disclosures = [...element.querySelectorAll('details')].map((detail) => detail.open);
    element.innerHTML = content;
    element.querySelectorAll('details').forEach((detail, i) => { detail.open = disclosures[i] ?? detail.open; });
    historyIcons(element);
    restoreScrollPositions(element, scrollPositions);
    const restoredTarget = scrollSelector ? element.querySelector<HTMLElement>(scrollSelector) : element;
    if (restoredTarget && scroll !== 0) restoredTarget.scrollTop = scroll;
  }
  liveRegions.set(element, { inputs, html: content });
};
const contextPanelInputs = (): unknown[] => [model.workspace, model.runtime, model.composer.mode,
  model.approvals, [...pendingApprovalResolutions].join(','), executionRecords, model.memories, model.dreamRuns,
  model.plugins, model.pluginVersions, model.evolutionProposals, model.evolutionReports, model.evolutionControl,
  model.decisions, model.feedback, model.supportBundle, model.modelEgress, model.modelUsage, controlledNetworkTargets.text, controlledNetworkTargets.error];
let contextPanelPatchTimer: number | undefined;
let pendingContextPanelPatch: { element: HTMLElement; inputs: unknown[]; html: () => string } | undefined;
const patchContextPanel = (element: HTMLElement | null, inputs: unknown[], html: () => string): void => {
  if (!element) return;
  const previous = liveRegions.get(element);
  if (previous && previous.inputs.length === inputs.length && inputs.every((value, index) => value === previous.inputs[index])) return;
  pendingContextPanelPatch = { element, inputs, html };
  window.clearTimeout(contextPanelPatchTimer);
  contextPanelPatchTimer = window.setTimeout(() => {
    contextPanelPatchTimer = undefined;
    const pending = pendingContextPanelPatch;
    pendingContextPanelPatch = undefined;
    if (!pending || !pending.element.isConnected || pending.element !== app.querySelector('.context-panel')) return;
    patchLiveRegion(pending.element, pending.inputs, pending.html);
  }, 700);
};
let liveTimeline: { container: HTMLElement; human: LiveTimeline; tools: LiveTimeline;
  source?: TimelineItem[]; focus?: string | null; expanded?: boolean } | undefined;
const liveTaskRunning = (): boolean => Boolean(model.activeRun && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun.state));
let transcriptFollowFrame: number | undefined;
const followLiveTranscript = (): void => {
  if (!transcriptStick || transcriptFollowFrame !== undefined) return;
  // Human rows, tool rows and the surrounding shell can all request following.
  // Read layout once after their DOM writes, and respect intervening user scroll.
  transcriptFollowFrame = requestAnimationFrame(() => {
    transcriptFollowFrame = undefined;
    const transcript = app?.querySelector<HTMLElement>('.transcript');
    if (transcript && transcriptStick) transcript.scrollTop = transcript.scrollHeight;
  });
};
const renderRunControls = (): void => {
  refreshComposerCache();
  refreshModeControls();
  patchLiveRegion(app.querySelector('.run-status'), [model.activeRun?.state], () => `
    <i data-lucide="${liveTaskRunning() ? 'loader-circle' : 'shield-check'}" class="${liveTaskRunning() ? 'spin' : ''}"></i>
    <span>${escapeHtml(runStateLabel(model.activeRun?.state))}</span> <small class="run-next-step">${escapeHtml(runStateNextStep(model.activeRun?.state))}</small>`);
  const composer = app.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  if (composer) { composer.disabled = !model.composer.enabled; composer.placeholder = model.composer.placeholder; }
  const stop = app.querySelector<HTMLButtonElement>('.composer-stop');
  if (stop) { stop.disabled = !liveTaskRunning(); stop.title = liveTaskRunning() ? '取消任务' : '当前没有运行中的任务'; }
  const send = app.querySelector<HTMLButtonElement>('.send-button');
  if (send) {
    send.disabled = running || liveTaskRunning() || !model.composer.enabled || workspaceChanging;
    send.title = workspaceChanging ? '目录切换中，请稍候' : running || liveTaskRunning() ? '任务运行中，请先取消' : '发送任务';
  }
  app.querySelectorAll<HTMLButtonElement>('[data-action="open-workspace"]').forEach((button) => {
    button.disabled = running || workspaceChanging;
    button.title = running || workspaceChanging ? '请等待当前任务或目录切换完成' : '';
  });
};
const refreshWorkspaceChrome = (): void => {
  const workspaceTitle = model.workspace.rootLabel || '默认工作区';
  const identity = app.querySelector<HTMLElement>('.workspace-identity strong');
  if (identity) {
    identity.textContent = workspaceTitle;
    identity.title = workspaceTitle;
  }
  const workspaceButtonLabel = model.workspace.granted ? '更换项目' : '打开项目';
  app.querySelectorAll<HTMLButtonElement>('[data-action="open-workspace"] span').forEach((label) => setTextIfChanged(label, workspaceButtonLabel));
  setTextIfChanged(app.querySelector<HTMLElement>('.composer-project'), workspaceTitle);
};
const renderLiveView = (): void => {
  renderRunControls();
  refreshWorkspaceChrome();
  const container = app.querySelector<HTMLElement>('[data-live-workbench]');
  if (!container) return;
  if (liveTimeline?.container !== container) {
    liveTimeline = { container,
      human: new LiveTimeline(container.querySelector('[data-live-human]')!, timelineItemHtml, historyIcons, followLiveTranscript),
      tools: new LiveTimeline(container.querySelector('[data-live-tools]')!, timelineItemHtml, historyIcons, followLiveTranscript) };
  }
  const slot = (name: string) => container.querySelector<HTMLElement>(`[data-live-region="${name}"]`);
  patchLiveRegion(slot('route'), [model.decisions, model.modelEgress, model.runtime.model, pinnedModel], renderRoutePanel);
  patchLiveRegion(slot('evidence'), [model.timeline], renderEvidencePanel);
  patchLiveRegion(slot('decisions'), [model.decisions], renderDecisionTrace);
  patchLiveRegion(slot('approvals'), [model.approvals, [...pendingApprovalResolutions].join(',')], () => {
    const approvals = model.approvals.filter((approval) => approval.state === 'REQUESTED' || approval.state === 'APPROVED' || approval.state === 'EXPIRED');
    return approvals.length ? `<section class="workbench-approvals" aria-label="审批与授权状态"><div class="transcript-heading"><h2>审批与授权状态</h2></div>${approvals.map(renderApprovalCard).join('')}</section>` : '';
  });
  const agents = slot('agents');
  patchLiveRegion(agents, [model.subAgents, model.activeRun?.state, subAgentsCollapsed], renderSubAgents, '.subagent-list');
  patchLiveRegion(slot('heading'), [model.activeRun?.title, focusedRunId], () => `
    <div class="transcript-heading"><div><span class="eyebrow">任务时间线</span><h1>${escapeHtml(model.activeRun?.title ?? 'Windows 只读工作台')}</h1>
      ${focusedRunId ? '<button class="secondary-button" data-action="clear-run-focus">清除运行筛选</button>' : ''}</div></div>`);
  patchLiveRegion(slot('receipt'), [lastSubmitReceipt?.id, lastSubmitReceipt?.status], () => lastSubmitReceipt
    ? `<div class="submit-receipt submit-receipt-${lastSubmitReceipt.status}"><strong>提交回执 ${escapeHtml(lastSubmitReceipt.id)}</strong><span>${lastSubmitReceipt.status === 'pending' ? '等待运行时确认' : lastSubmitReceipt.status === 'accepted' ? '已被接受' : lastSubmitReceipt.status === 'unconfirmed' ? '未收到运行时接受确认' : '已被拒绝'}</span><small>${escapeHtml(lastSubmitReceipt.prompt)}</small></div>` : '');
  const lists = liveTimeline!;
  if (lists.source !== model.timeline || lists.focus !== focusedRunId || lists.expanded !== executionGroupExpanded) {
    const all = focusedRunId ? model.timeline.filter((item) => item.runId === focusedRunId) : model.timeline;
    const tools = all.filter((item) => item.kind === 'STATUS' || item.kind === 'WORKSPACE');
    // Tool cards stay in the main conversation so a reader can follow the
    // active task without opening a secondary audit disclosure.  The group
    // below still contains the complete structured execution history.
    lists.human.update(all.filter((item) => item.kind !== 'STATUS' && item.kind !== 'WORKSPACE' || Boolean(item.toolName)));
    const group = container.querySelector<HTMLDetailsElement>('[data-execution-group]')!;
    group.hidden = tools.length === 0;
    const activeToolCount = tools.filter((item) => Boolean(item.toolName)).length;
    group.open = executionGroupExpanded;
    setTextIfChanged(group.querySelector('summary'), `工具执行过程${activeToolCount ? `（${activeToolCount} 个工具步骤）` : `（${tools.length} 条事件）`}`);
    // The full audit list remains on-demand; the human-facing tool cards above
    // are mounted immediately and do not require a click.
    if (executionGroupExpanded) lists.tools.update(tools);
    else lists.tools.pause();
    lists.source = model.timeline; lists.focus = focusedRunId; lists.expanded = executionGroupExpanded;
  }
  patchLiveRegion(slot('verification'), [model.continuousVerification, model.processVerification, model.timeline], () => renderFinalVerificationChecks() + renderContinuousVerification());
  patchLiveRegion(app.querySelector('.connection-status'), [model.connection], () => `<span></span>${escapeHtml(model.connection.label)}`);
  const connection = app.querySelector<HTMLElement>('.connection-status');
  if (connection) connection.className = `connection-status ${model.connection.state === 'READY' ? 'status-ready' : model.connection.state === 'ERROR' ? 'status-error' : 'status-waiting'}`;
  app.querySelector('.app-shell')?.classList.toggle('context-open', contextVisible);
  updateThreadList();
  // The context drawer is hidden by default. Avoid rebuilding its large governance
  // subtree on every streaming delta; it is refreshed when opened and while visible.
  if (contextVisible) patchContextPanel(app.querySelector('.context-panel'), contextPanelInputs(), renderContextContent);
  const projection = app.querySelector('[data-projection-version]');
  if (projection) projection.textContent = `运行投影 v${model.projectionVersion}`;
  syncMemoryActionControls();
  followLiveTranscript();
};
const render = (): void => {
  if (historyView && activePage === 'workbench' && !model.activeRun && !settingsVisible && !projectPickerVisible && !projectNameDialog) {
    renderHistoryView();
    return;
  }
  if (!historyView && activePage === 'workbench' && app.querySelector('[data-live-workbench]')
    && app.querySelector<HTMLElement>('.app-shell')?.dataset.composerMode === model.composer.mode
    && settingsVisible === Boolean(app.querySelector('[data-settings-dialog]')) && !settingsVisible && !projectPickerVisible && !projectNameDialog && !projectEditDialog
    && !app.querySelector('.project-picker-backdrop')) {
    renderLiveView();
    return;
  }
  const focusedSetting = document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-settings-dialog]')
    ? document.activeElement as HTMLInputElement | HTMLTextAreaElement : undefined;
  const focusedName = focusedSetting?.getAttribute('name');
  const selectionStart = (focusedSetting instanceof HTMLInputElement || focusedSetting instanceof HTMLTextAreaElement) ? focusedSetting.selectionStart : null;
  const selectionEnd = (focusedSetting instanceof HTMLInputElement || focusedSetting instanceof HTMLTextAreaElement) ? focusedSetting.selectionEnd : null;
  const settingsScroll = document.querySelector('.settings-main')?.scrollTop ?? 0;
  const previousComposer = app.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  const composerDraft = previousComposer?.value ?? '';
  const composerFocus = previousComposer && document.activeElement === previousComposer ? {
    start: previousComposer.selectionStart, end: previousComposer.selectionEnd,
    direction: previousComposer.selectionDirection, scrollTop: previousComposer.scrollTop
  } : undefined;
  const statusClass = model.connection.state === 'READY' ? 'status-ready' :
    model.connection.state === 'ERROR' ? 'status-error' : 'status-waiting';
  const workspaceTitle = model.workspace.rootLabel || '默认工作区';
  // Read-only is an execution policy, not an input lock. Keep the composer
  // editable while the native runtime hydrates; a submitted prompt waits for
  // that one-time read to finish before the task child is spawned.
  const canCompose = model.composer.enabled;
  const canSend = canCompose && !workspaceChanging;
  const taskRunning = Boolean(model.activeRun && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun.state));
  const controlled = model.composer.mode === 'CONTROLLED';
  const runtimeRoute = model.runtime.model
    ? `${model.runtime.model.provider} 服务 · ${model.runtime.model.model}`
    : model.runtime.platform === 'WINDOWS' ? '模型路由未读取' : 'Web 预览无本地模型';

  app.innerHTML = `
    <div class="app-shell ${contextVisible ? 'context-open' : ''}" data-composer-mode="${model.composer.mode}">
      <aside class="navigation-rail" aria-label="项目与设置">
        <div class="brand-row">
          <div class="brand-mark">hm</div>
          <div>
            <strong>dda</strong>
            <span>${model.runtime.platform === 'WINDOWS' ? 'Windows 本地运行时' : 'Web 预览'}</span>
          </div>
        </div>

        <button class="primary-action" data-action="new-task" title="新建任务">
          <i data-lucide="plus"></i>
          <span>新建任务</span>
        </button>

        <div class="nav-section-heading"><button class="project-section-toggle" type="button" data-action="toggle-project-section" aria-expanded="${!projectsSectionCollapsed}"><span class="nav-section-label">项目</span><i data-lucide="${projectsSectionCollapsed ? 'chevron-right' : 'chevron-down'}"></i></button><button class="icon-button small" type="button" data-action="add-project" title="添加项目" aria-label="添加项目"><i data-lucide="plus"></i></button></div>
        <div class="thread-list project-list ${projectsSectionCollapsed ? 'project-list-collapsed' : ''}" data-region="thread-list" ${projectsSectionCollapsed ? 'hidden' : ''}>
          ${renderProjectThreadList() || '<div class="thread-empty">暂无已保存任务</div>'}
        </div>

        <div class="rail-footer">
          <button class="nav-item ${settingsVisible ? 'active' : ''}" data-action="open-settings" aria-label="模型设置"><i data-lucide="settings"></i><span>设置</span></button>
          <div class="version-label">v${escapeHtml(model.runtime.version)} · ${controlled ? '受控模式' : '只读模式'}</div>
        </div>
      </aside>

      <main class="workbench">
        <header class="topbar">
          <div class="workspace-identity">
            <span class="eyebrow">当前工作区</span>
            <strong title="${escapeHtml(workspaceTitle)}">${escapeHtml(workspaceTitle)}</strong>
          </div>
          <div class="topbar-actions">
            <button class="icon-button" title="搜索" aria-label="搜索"><i data-lucide="search"></i></button>
            <button class="icon-button context-toggle" data-action="toggle-context" title="${contextVisible ? '隐藏任务上下文' : '显示任务上下文'}" aria-label="${contextVisible ? '隐藏任务上下文' : '显示任务上下文'}" aria-expanded="${contextVisible}"><i data-lucide="panel-right"></i></button>
            <button class="secondary-button" data-action="open-workspace" ${running || workspaceChanging ? 'disabled title="请等待当前任务或目录切换完成"' : ''}>
              <i data-lucide="folder-open"></i>
              <span>${model.workspace.granted ? '更换项目' : '打开项目'}</span>
            </button>
          </div>
        </header>

        <section class="run-strip" aria-live="polite">
          <div class="connection-status ${statusClass}"><span></span>${escapeHtml(model.connection.label)}</div>
          <div class="run-status">
            ${model.activeRun?.state === 'PLANNING' || model.activeRun?.state === 'EXECUTING_READ' || model.activeRun?.state === 'VERIFYING'
              ? '<i data-lucide="loader-circle" class="spin"></i>'
              : '<i data-lucide="shield-check"></i>'}
            <span>${escapeHtml(runStateLabel(model.activeRun?.state))}</span> <small class="run-next-step">${escapeHtml(runStateNextStep(model.activeRun?.state))}</small>
          </div>
          <button class="mode-pill ${controlled ? 'mode-controlled' : ''}" data-action="toggle-mode" title="${escapeHtml(desktopBridge.isNative() ? (model.runtime.releaseChannel ?? '发布渠道尚未确认') : 'Web 预览仅支持只读模式')}" ${!desktopBridge.isNative() || model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' ? 'disabled' : ''}>
            <i data-lucide="shield-check"></i>${controlled ? '受控模式' : '只读模式'}
          </button>
        </section>

        <section class="transcript" aria-label="任务时间线">
          <div class="transcript-inner" data-region="conversation">
            ${activePage === 'runs' ? renderRunsPage() : activePage === 'diagnostics' ? renderDiagnosticsPage() : activePage === 'workspace' ? renderWorkspacePage() : activePage === 'memory' ? renderMemoryPage() : activePage === 'safety' ? renderSafetyPage() : activePage !== 'workbench' ? renderPageStatus(activePage) : ''}
            ${activePage === 'workbench' ? `
            <div data-live-workbench>
              <div class="live-region" data-live-region="route"></div>
              <div class="live-region" data-live-region="evidence"></div>
              <div class="live-region" data-live-region="decisions"></div>
              <div class="live-region" data-live-region="approvals"></div>
              <div class="live-region" data-live-region="agents"></div>
              <div class="live-region" data-live-region="heading"></div>
              <div class="timeline">
                <div class="live-region" data-live-region="receipt"></div>
                <div data-live-human></div>
                <details class="execution-group" data-execution-group hidden><summary></summary><div data-live-tools></div></details>
              </div>
              <div class="live-region" data-live-region="verification"></div>
            </div>` : ''}
          </div>
        </section>

        <footer class="composer-wrap">
          <div class="composer-cache" data-model-cache="composer" role="status" aria-label="缓存命中率">${renderComposerCache()}</div>
          <form class="composer" data-form="composer">
            <textarea name="prompt" rows="2" maxlength="8000" placeholder="${escapeHtml(model.composer.placeholder)}" ${canCompose ? '' : 'disabled'}></textarea>
            <div class="composer-bottom">
              <div class="composer-context">
                <span><i data-lucide="shield-check"></i>${controlled ? '受控执行，逐项审批' : '只读分析'}</span>
                <span class="composer-project">${escapeHtml(workspaceTitle)}</span><span class="composer-summary" title="${escapeHtml(runtimeRoute)}"><i data-lucide="cpu"></i>${escapeHtml(runtimeRoute)}</span>
              </div>
              <div class="composer-actions">
                <button class="stop-button composer-stop" type="button" data-action="cancel-run" ${taskRunning ? '' : 'disabled'} title="${taskRunning ? '取消任务' : '当前没有运行中的任务'}" aria-label="取消任务"><i data-lucide="square"></i><span>取消任务</span></button>
                <button class="send-button" type="submit" ${!taskRunning && canSend ? '' : 'disabled'} title="${workspaceChanging ? '目录切换中，请稍候' : taskRunning ? '任务运行中，请先取消' : '发送任务'}"><i data-lucide="send"></i><span>发送</span></button>
              </div>
            </div>
          </form>
          <p class="composer-note">${controlled ? '受控模式只允许已配置范围；每个命令或写入仍需单次审批。' : '当前为只读模式，不会执行命令、修改文件或发起外部网络操作。'}</p>
        </footer>
      </main>

      <aside class="context-panel" aria-label="上下文">${renderContextContent()}</aside>
    </div>
    ${renderSettingsModal()}
    ${renderProjectPicker()}
    ${renderProjectNameDialog()}
    ${renderProjectEditDialog()}`;

  const composer = app.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]');
  if (composer) composer.value = composerDraft;
  if (activePage === 'workbench') renderLiveView();
  // Startup and idle-state refreshes replace the shell. Restore the draft's
  // editing position so a background update cannot interrupt the next keystroke.
  if (composer && composerFocus && !composer.disabled && !settingsVisible) {
    composer.focus({ preventScroll: true });
    composer.setSelectionRange(composerFocus.start, composerFocus.end, composerFocus.direction);
    composer.scrollTop = composerFocus.scrollTop;
  }
  const settingsDialog = document.querySelector<HTMLElement>('[data-settings-dialog]');
  const shell = app.querySelector<HTMLElement>('.app-shell');
  if (shell) shell.inert = Boolean(settingsDialog);
  if (settingsDialog) {
    const form = settingsDialog.querySelector<HTMLFormElement>('[data-form="model-settings"]');
    if (settingsDraft && form) {
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]').forEach((field) => {
        if (settingsDraft?.[field.name] !== undefined) field.value = settingsDraft[field.name];
      });
    }
    form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input,textarea,select').forEach((field) => { field.disabled = settingsSaving; });
    syncSettingsView();
    settingsDialog.querySelector<HTMLElement>('.settings-main')!.scrollTop = settingsScroll;
    const field = focusedName ? [...settingsDialog.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[name]')].find((item) => item.name === focusedName) : undefined;
    field?.focus({ preventScroll: true });
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && selectionStart !== null && selectionEnd !== null) field.setSelectionRange(selectionStart, selectionEnd);
    if (!field && !focusedSetting) settingsDialog.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  createIcons({
    icons: {
      ArrowLeft,
      Bot,
      CheckCircle2,
      ChevronDown,
      ChevronRight,
      CircleAlert,
      Cpu,
      Database,
      File,
      FileCog,
      Folder,
      FolderOpen,
      Gauge,
      HeartPulse,
      History,
      RotateCcwClock: History,
      LayoutDashboard,
      ListTree,
      LoaderCircle,
      PanelRight,
      Plus,
      Search,
      Send,
      Settings,
      ShieldCheck,
      Square,
      TerminalSquare,
      UserRound,
      XCircle
    }
  });
  syncMemoryActionControls();
  requestAnimationFrame(() => {
    const transcript = document.querySelector<HTMLElement>('.transcript');
    if (transcript) {
      // 中间时间线：只在用户停在底部时自动跟随。
      if (transcriptStick) transcript.scrollTop = transcript.scrollHeight;
      else transcript.scrollTop = Math.min(transcriptScrollTop, transcript.scrollHeight);
    }
    const contextPanel = document.querySelector<HTMLElement>('.context-panel');
    if (contextPanel) {
      // 右侧上下文面板每次 render 都会重建，显式恢复用户的滚动位置。
      contextPanel.scrollTop = Math.min(contextScrollTop, contextPanel.scrollHeight);
    }
  });
};

const renderWithFallback = (background = false): void => {
  try {
    if (background && (settingsVisible || activePage !== 'workbench')) {
      if (activePage === 'workbench' && !historyView) renderLiveView();
      else renderRunControls();
      return;
    }
    render();
  } catch (error) {
    // 渲染异常绝不能静默白屏：把错误直接画到页面上，方便定位。
    console.error('render failed', error);
    app.innerHTML = `<div class="empty-state" style="padding:32px"><h2>界面渲染出错</h2><p style="white-space:pre-wrap;font-family:monospace">${String(error instanceof Error ? error.stack : error).replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as Record<string, string>)[ch] ?? ch)}</p><p>可以点击下方按钮重试或新建任务。</p><button id="render-retry" style="padding:8px 16px;cursor:pointer">重试渲染</button></div>`;
    const retry = document.getElementById('render-retry');
    retry?.addEventListener('click', () => { try { render(); } catch { location.reload(); } });
  }
};

// Streaming providers can emit hundreds of text deltas per second.  A full
// innerHTML render per delta freezes the WebView, so coalesce those updates
// into at most one render per animation frame while keeping the model current.
let renderFrame: number | undefined;
const scheduleRender = (): void => {
  if (renderFrame !== undefined) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = undefined;
    renderWithFallback(true);
  });
};

let approvalExpiryTimer: number | undefined;
const scheduleApprovalExpiry = (): void => {
  window.clearTimeout(approvalExpiryTimer);
  const deadlines = model.approvals.filter((approval) => approval.state === 'REQUESTED' && approval.approvalExpiresAt !== undefined)
    .map((approval) => approval.approvalExpiresAt!);
  if (!deadlines.length) { approvalExpiryTimer = undefined; return; }
  approvalExpiryTimer = window.setTimeout(() => {
    const next = expireRequestedApprovals(model);
    if (next !== model) update(next);
    else scheduleApprovalExpiry();
  }, Math.min(2147483647, Math.max(0, Math.min(...deadlines) - Date.now())));
};

// Preserve event order in the model while sharing one DOM update per frame.
const update = (next: HarnessReadModel, { coalesce = false }: { coalesce?: boolean } = {}): void => {
  next = expireRequestedApprovals(next);
  if (next === model) return;
  const approvalsChanged = next.approvals !== model.approvals;
  const navigationChanged = next.activeThreadId !== model.activeThreadId
    || next.activeRun?.runId !== model.activeRun?.runId
    || next.workspace.currentPath !== model.workspace.currentPath;
  model = next;
  if (approvalConfirmation) {
    const pending = model.approvals.find(item => item.requestId === approvalConfirmation!.requestId);
    if (pending?.state !== 'REQUESTED' || pending.requestDigest !== approvalConfirmation.digest
      || model.activeRun?.runId !== approvalConfirmation.runId) approvalConfirmation.close();
  }
  if (approvalsChanged) scheduleApprovalExpiry();
  if (coalesce || running) {
    if (navigationChanged) persistNavigation();
    scheduleRender();
    return;
  }
  persistNavigation();
  renderWithFallback();
};

const refreshExecutionState = async (options: { allowDuringRun?: boolean } = {}): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  if (running && !options.allowDuringRun) {
    // The task owns the Harness database while it is running. The runtime
    // events already project the visible approval state, so defer this read
    // until the child exits instead of opening a competing SQLite connection.
    executionRefreshQueued = true;
    return;
  }
  const runAtStart = model.activeRun?.runId;
  try {
    const records = await desktopBridge.listExecutionState();
    if (running || model.activeRun?.runId !== runAtStart) return;
    executionRecords = records;
    render();
  } catch (error) {
    update(appendErrorTimelineItem(model, '执行状态', error));
  }
};

type DashboardRefreshOptions = { startup?: boolean; allowDuringRun?: boolean };

const refreshDashboard = async (options: DashboardRefreshOptions = {}): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  if (dashboardRefreshInFlight) {
    await dashboardRefreshInFlight;
    if (options.startup || dashboardDetailsLoaded) return;
  }
  if (running && !options.startup && !options.allowDuringRun) {
    // A dashboard read opens the same Harness SQLite database as a task. Do
    // not let a manual refresh overwrite a live run or block its first event.
    return;
  }
  const runAtStart = model.activeRun?.runId;
  const request = (async () => {
    try {
      const [dashboard, contextSidecar, dreamMaintenance] = await Promise.all([
        desktopBridge.runtimeDashboard({ details: !options.startup }),
        options.startup ? undefined : desktopBridge.contextSidecarStatus(),
        options.startup ? undefined : desktopBridge.dreamMaintenanceStatus()
      ]);
      if (!dashboard) return;
      if (dashboard.summaryOnly) {
        reconcileHistoryPageCache(dashboard.threads);
        model = setThreads(model, dashboard.threads);
        model = { ...model, runtime: { ...model.runtime,
          ...(contextSidecar ? { contextSidecar } : {}), ...(dreamMaintenance ? { dreamMaintenance } : {}) } };
        updateThreadList();
        return;
      }
      // A non-startup refresh may have started before a task was submitted.
      // Drop its result rather than replacing live sub-agent rows with the
      // older dashboard projection.
      if (!options.startup && (running || model.activeRun?.runId !== runAtStart)) return;
      dashboardDetailsLoaded = true;
      reconcileHistoryPageCache(dashboard.threads);
      for (const runId of dashboard.deletedRunIds ?? []) deletedRuntimeRunIds.add(runId);
      executionRecords = dashboard.execution.records;
      projectionRuns = dashboard.projection?.runs ?? projectionRuns;
      // Dashboard events are global audit facts. The workbench transcript is
      // scoped to the selected thread and live run, so never merge them here.
      const timeline = model.timeline.filter((item) => !item.itemId.startsWith('projection-'));
      update({
        ...setThreads(model, dashboard.threads),
        runtime: {
          ...model.runtime,
          ...(contextSidecar ? { contextSidecar } : {}),
          ...(dreamMaintenance ? { dreamMaintenance } : {})
        },
        feedback: dashboard.feedback,
        memories: dashboard.memories,
        dreamRuns: dashboard.dreams,
        plugins: dashboard.plugins,
        pluginVersions: dashboard.pluginVersions ?? [],
        evolutionProposals: dashboard.evolution.proposals,
        evolutionReports: dashboard.evolution.reports,
        evolutionControl: dashboard.evolution.control,
        decisions: dashboard.projection?.decisions ?? [],
        ...(dashboard.projection?.verifier ? { processVerification: dashboard.projection.verifier as ProcessVerificationReadModel } : {}),
        ...(dashboard.supportBundle ? { supportBundle: dashboard.supportBundle } : {}),
        ...(dashboard.modelEgress ? { modelEgress: dashboard.modelEgress } : {}),
        ...(dashboard.modelUsage ? { modelUsage: dashboard.modelUsage } : {}),
        timeline: removeDeletedRunTimeline(timeline, [...deletedRuntimeRunIds]),
        projectionVersion: dashboard.projection?.projectionVersion ?? model.projectionVersion + 1
      }, { coalesce: options.startup });
    } catch (error) {
      update(appendErrorTimelineItem(model, '启动状态', error));
    }
  })();
  dashboardRefreshInFlight = request;
  try {
    await request;
  } finally {
    if (dashboardRefreshInFlight === request) dashboardRefreshInFlight = undefined;
  }
};

const loadPageDetails = async (): Promise<void> => {
  if (!contextVisible && !['runs', 'memory', 'safety', 'diagnostics'].includes(activePage)) return;
  await historyStartupReady;
  if (!dashboardDetailsLoaded) await refreshDashboard();
};

const refreshGovernance = async (options: { allowDuringRun?: boolean } = {}): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  if (running && !options.allowDuringRun) {
    governanceRefreshQueued = true;
    return;
  }
  const runAtStart = model.activeRun?.runId;
  try {
    const [memories, dreamRuns, pluginGovernance, evolution, dreamMaintenance, dashboard] = await Promise.all([
      desktopBridge.listMemories(),
      desktopBridge.listDreamRuns(),
      desktopBridge.listPluginGovernance(),
      desktopBridge.listEvolution(),
      desktopBridge.dreamMaintenanceStatus(),
      desktopBridge.runtimeDashboard({ details: true })
    ]);
    if (running || model.activeRun?.runId !== runAtStart) return;
    const plugins = pluginGovernance.plugins;
    pluginVersionSnapshot = pluginGovernance.versionLifecycle;
    const pluginVersions = dashboard?.pluginVersions ?? pluginVersionSummaries(undefined, pluginGovernance.versionLifecycle);
    governanceReadFailed = false;
    memoryActionsAwaitingRefresh.clear();
    update({
      ...model,
      projectionVersion: model.projectionVersion + 1,
      memories,
      dreamRuns,
      plugins,
      pluginVersions,
      evolutionProposals: evolution.proposals,
      evolutionReports: evolution.reports,
      ...(dashboard ? { evolutionControl: dashboard.evolution.control } : {}),
      ...(dashboard ? { feedback: dashboard.feedback } : {}),
      ...(dashboard?.projection?.decisions ? { decisions: dashboard.projection.decisions } : {}),
      ...(dashboard?.projection?.continuousVerification ? { continuousVerification: dashboard.projection.continuousVerification } : {}),
      ...(dashboard?.projection?.verifier ? { processVerification: dashboard.projection.verifier as ProcessVerificationReadModel } : {}),
      ...(dashboard?.supportBundle ? { supportBundle: dashboard.supportBundle } : {}),
      ...(dashboard?.modelEgress ? { modelEgress: dashboard.modelEgress } : {}),
      ...(dashboard?.modelUsage ? { modelUsage: dashboard.modelUsage } : {}),
      runtime: dreamMaintenance ? { ...model.runtime, dreamMaintenance } : model.runtime
    });
  } catch (error) {
    governanceReadFailed = true;
    const next = appendErrorTimelineItem(model, '治理状态', error);
    update({ ...next });
  }
};

const runGovernanceAction = async (action: string, element: HTMLElement): Promise<void> => {
  let pendingMemoryId: string | undefined;
  try {
    if (action === 'memory-action') {
      const memoryId = element.dataset.memoryId;
      const operation = element.dataset.operation as 'edit' | 'resolve-conflict' | 'verify' | 'activate' | 'retract' | 'delete' | undefined;
      const accepted = element.dataset.accepted === undefined ? undefined : element.dataset.accepted === 'true';
      if (!memoryId || !operation || pendingMemoryActions.has(memoryId) || memoryActionsAwaitingRefresh.has(memoryId)) return;
      memoryActionError = '';
      pendingMemoryActions.add(memoryId);
      pendingMemoryId = memoryId;
      syncMemoryActionControls();
      await desktopBridge.memoryAction(operation, { memoryId, accepted, reason: operation === 'resolve-conflict' ? '用户从记忆页处理冲突' : undefined });
      memoryActionsAwaitingRefresh.add(memoryId);
    } else if (action === 'run-dream') {
      await desktopBridge.runDream({ projectId: model.workspace.rootLabel, idle: true, safetyAllowed: true, activeRuns: 0 });
    } else if (action === 'start-dream-maintenance') {
      await desktopBridge.startDreamMaintenance({ projectId: model.workspace.rootLabel });
    } else if (action === 'stop-dream-maintenance') {
      await desktopBridge.stopDreamMaintenance();
    } else if (action === 'plugin-action') {
      const pluginId = element.dataset.pluginId;
      const operation = element.dataset.operation as 'validate' | 'transition' | undefined;
      if (pluginId && operation) await desktopBridge.pluginAction(pluginId, operation, element.dataset.state);
    } else if (action === 'evolution-action') {
      const proposalId = element.dataset.proposalId;
      const operation = element.dataset.operation as 'transition' | 'rollback' | 'monitor' | undefined;
      if (proposalId && operation === 'transition') {
        await desktopBridge.evolutionAction(proposalId, 'transition', element.dataset.state);
      } else if (proposalId && operation === 'rollback') {
        await desktopBridge.evolutionAction(proposalId, 'rollback', undefined, '用户从治理面板回滚');
      } else if (proposalId && operation === 'monitor') {
        await desktopBridge.evolutionAction(proposalId, 'monitor');
      }
    }
    await refreshGovernance();
  } catch (error) {
    if (action === 'memory-action') memoryActionError = 'FAILED';
    update(appendErrorTimelineItem(model, '治理操作', error));
  } finally {
    if (pendingMemoryId) pendingMemoryActions.delete(pendingMemoryId);
    syncMemoryActionControls();
  }
};

const runtimeFailureText = (event: RuntimeEvent): string => {
  const payload = event.payload ?? {};
  const reason = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : '';
  const code = typeof payload.errorCode === 'string' ? payload.errorCode : typeof payload.code === 'string' ? payload.code : '';
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  const detailKeys = ['failurePhase', 'failureStatus', 'stepId', 'stepErrorCode', 'reasonCode', 'cause', 'status', 'reportStatus', 'nextAction'];
  const details = (Array.isArray(payload.failureCodes) && payload.failureCodes.length ? [`失败码：${payload.failureCodes.join(', ')}`] : [])
    .concat(detailKeys.map((key) => typeof payload[key] === 'string' || typeof payload[key] === 'number' ? `${key}：${String(payload[key])}` : '').filter(Boolean));
  const failedChecks = Array.isArray(payload.checks)
    ? payload.checks.filter((check) => check && typeof check === 'object' && String((check as Record<string, unknown>).status).toUpperCase() === 'FAIL')
      .slice(0, 8)
      .map((check) => {
        const item = check as Record<string, unknown>;
        return `检查失败：${typeof item.id === 'string' ? item.id : 'unknown'}${typeof item.message === 'string' ? `（${item.message}）` : ''}`;
      })
    : [];
  const tool = typeof payload.toolName === 'string' ? `工具：${payload.toolName}` : typeof payload.name === 'string' ? `工具：${payload.name}` : '';
  const parts = [phase && `阶段：${phase}`, tool, code && `错误码：${code}`, reason, ...details, ...failedChecks].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  return details.length ? details.join(' · ') : '任务运行失败：运行时未提供具体原因，请检查对应工具结果和计划步骤。';
};

const logRuntimeFailure = (event: RuntimeEvent, source: string): void => {
  console.error('[runtime-failure]', { source, kind: event.kind, runId: event.runId, sequence: event.sequence, payload: event.payload });
};

const runtimeEventText = (event: RuntimeEvent): string => {
  const payload = event.payload;
  if (typeof payload.text === 'string') return payload.text;
  if (payload.ok === false) {
    const reason = typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : typeof payload.reason === 'string' ? payload.reason : '';
    const code = typeof payload.errorCode === 'string' ? payload.errorCode : '';
    const detail = [code ? reasonDisplayLabel(code) : '', reason].filter(Boolean).join('：');
    if (typeof payload.name === 'string') return detail ? `${toolDisplayLabel(payload.name)}失败：${detail}` : `${toolDisplayLabel(payload.name)}失败`;
    if (detail) return detail;
  }
  if (typeof payload.name === 'string') {
    if (payload.kind === 'tool.call_requested') return `正在${toolDisplayLabel(payload.name).replace(/^查看|^读取|^执行|^运行|^发送/, '')}`;
    return toolDisplayLabel(payload.name);
  }
  if (typeof payload.errorCode === 'string') return reasonDisplayLabel(payload.errorCode);
  return humanizeCode(event.kind, '运行时事件');
};

const replayEventTimelineItem = (event: RuntimeEvent): TimelineItem | undefined => {
  const payload = event.payload ?? {};
  const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const digestSuffix = (value: unknown) => typeof value === 'string' && value.length > 18 ? ` · ${value.slice(0, 18)}...` : '';
  const persistedKind = typeof payload.persistedKind === 'string' ? payload.persistedKind : event.kind;
  if (NON_CONVERSATIONAL_TIMELINE_KINDS.has(persistedKind)) return undefined;
  // Historical pages persist the completed tool fact.  Live pages also show
  // the request itself, but replay should not invent a request that was never
  // durably stored.
  if (persistedKind === 'ToolCallRequested') return undefined;
  if (persistedKind === 'ToolInvocationCompleted'
    && payload.ok !== false
    && String(payload.status ?? '').toUpperCase() !== 'FAILED') return undefined;
  const common = {
    itemId: `replay-${event.eventId ?? `${event.runId}-${event.sequence}`}`,
    createdAtMs: Number.isFinite(event.emittedAtMs) ? event.emittedAtMs : Date.now(),
    eventId: event.eventId,
    eventSequence: event.sequence,
    runId: event.runId,
    operationId: typeof payload.operationId === 'string' ? payload.operationId : undefined,
    sourceRole: typeof payload.sourceRole === 'string' ? payload.sourceRole : typeof payload.role === 'string' ? payload.role : undefined,
    pluginVersion: typeof payload.pluginVersion === 'string' ? payload.pluginVersion : undefined,
    digest: typeof payload.digest === 'string' ? payload.digest : typeof payload.outputDigest === 'string' ? payload.outputDigest : typeof payload.snapshotDigest === 'string' ? payload.snapshotDigest : undefined
  };
  switch (persistedKind) {
    case 'TaskRunCreated':
      return { ...common, kind: 'STATUS', title: '任务已创建', body: '已恢复该次任务的结构化运行记录。', status: 'COMPLETE' };
    case 'RunStateChanged':
      return {
        ...common,
        kind: 'STATUS',
        title: '运行状态',
        body: `${statusDisplayLabel(payload.from, '未读取')} → ${statusDisplayLabel(payload.to, '未读取')}`,
        status: 'COMPLETE'
      };
    case 'ModelRouteResolved':
      return {
        ...common,
        kind: 'STATUS',
        title: '模型路由',
        body: `已连接 ${text(payload.provider, '默认服务')} · ${text(payload.model, '未指定模型')}`,
        status: 'COMPLETE'
      };
    case 'RoleContextsAllocated':
      return {
        ...common,
        kind: 'STATUS',
        title: '角色上下文',
        body: `已分配 ${number(payload.contextCount) ?? (Array.isArray(payload.contexts) ? payload.contexts.length : 0)} 个独立上下文`,
        status: 'COMPLETE'
      };
    case 'WorkspaceSnapshotCreated':
      return {
        ...common,
        kind: 'WORKSPACE',
        title: '工作区快照',
        body: `已记录 ${number(payload.entryCount) ?? 0} 项${digestSuffix(payload.snapshotDigest)}`,
        status: 'COMPLETE'
      };
    case 'PlanStepStateChanged':
      return {
        ...common,
        kind: 'STATUS',
        title: '计划步骤',
        body: `${humanizeCode(payload.stepId, '未命名步骤')} · ${statusDisplayLabel(payload.to ?? payload.status, '已更新')}`,
        status: 'COMPLETE'
      };
    case 'ToolCallRequested':
      return {
        ...common,
        kind: 'STATUS',
        title: '工具调用',
        body: `正在${toolDisplayLabel(text(payload.toolName, text(payload.name, '受控工具'))).replace(/^查看|^读取|^执行|^运行|^发送/, '')}`,
        status: 'COMPLETE'
      };
    case 'ToolInvocationCompleted': {
      const rawToolName = text(payload.toolName, text(payload.name, '受控工具'));
      const toolName = toolDisplayLabel(rawToolName);
      const failure = payload.ok === false || text(payload.status, '').toUpperCase() === 'FAILED';
      const errorCode = text(payload.errorCode, '');
      const message = text(payload.message, '');
      const outputChars = number(payload.outputChars);
      const detail = failure
        ? ['失败', errorCode ? reasonDisplayLabel(errorCode) : '', message].filter(Boolean).join('：')
        : ['已完成', outputChars === undefined ? '' : `输出 ${outputChars.toLocaleString('zh-CN')} 字符`].filter(Boolean).join(' · ');
      return {
        ...common,
        kind: failure ? 'ERROR' : 'STATUS',
        title: '工具结果',
        body: `${failure ? '无法完成' : '已完成'}：${toolName}${detail ? ` · ${detail}` : ''}`,
        status: failure ? 'ERROR' : 'COMPLETE',
        toolName: rawToolName,
        commandText: typeof payload.command === 'string' ? payload.command : undefined,
        evidenceKind: 'terminal',
        truncated: payload.truncated === true
      };
    }

    case 'VerificationCompleted': {
      const checks = Array.isArray(payload.checks) ? payload.checks : [];
      const failedChecks = checks.filter((check) => check && typeof check === 'object' && String((check as Record<string, unknown>).status).toUpperCase() === 'FAIL')
        .slice(0, 6)
        .map((check) => {
          const item = check as Record<string, unknown>;
          return `${typeof item.id === 'string' ? item.id : 'unknown'}${typeof item.message === 'string' ? `：${item.message}` : ''}`;
        });
      const failures = Array.isArray(payload.failureCodes) ? payload.failureCodes.filter((code): code is string => typeof code === 'string').slice(0, 8) : [];
      const bodyParts = [
        text(payload.status, 'UNKNOWN'),
        text(payload.summary, '未提供摘要'),
        failures.length ? `失败码 ${failures.join(', ')}` : '',
        failedChecks.length ? `失败检查 ${failedChecks.join('；')}` : '',
        text(payload.nextAction, '') ? `下一步 ${text(payload.nextAction, '')}` : ''
      ].filter(Boolean);
      return {
        ...common,
        kind: payload.status === 'FAIL' ? 'ERROR' : 'STATUS',
        title: '验证结果',
        body: bodyParts.join(' · '),
        status: payload.status === 'FAIL' ? 'ERROR' : (payload.status === 'UNKNOWN' || payload.status === 'ABSTAIN' ? 'PENDING' : 'COMPLETE')
      };
    }
    case 'CouncilPlanReviewCompleted':
      return {
        ...common,
        kind: 'STATUS',
        title: 'Council 审议',
        body: `${text(payload.decision, 'ABSTAIN')} · ${number(payload.proposalCount) ?? 0} 个候选`,
        status: 'COMPLETE'
      };
    case 'ExecutionStateReconciled':
      return {
        ...common,
        kind: 'STATUS',
        title: '受控状态恢复',
        body: `已核对 ${number(payload.reconciled) ?? 0} 条执行记录`,
        status: 'COMPLETE'
      };
    case 'TaskRunCompleted':
      if (typeof payload.responseText === 'string' && payload.responseText.trim()) {
        return { ...common, kind: 'AGENT', title: 'dda', body: payload.responseText, status: 'COMPLETE' };
      }
      return {
        ...common,
        kind: 'STATUS',
        title: '任务完成',
        body: payload.responseUnavailable === true
          ? '任务已完成，但本地没有可恢复的模型回复正文（旧版未保存或文件已丢失）。'
          : `已完成${digestSuffix(payload.outputDigest)}`,
        status: 'COMPLETE'
      };
    case 'TaskRunFailed': {
      const failureEvent = { ...event, payload } as RuntimeEvent;
      return {
        ...common,
        kind: 'ERROR',
        title: '任务失败',
        body: runtimeFailureText(failureEvent),
        status: 'ERROR'
      };
    }
    default:
      return undefined;
  }
};

const replayThreadEvents = (base: HarnessReadModel, events: RuntimeEvent[]): HarnessReadModel => {
  // The backend returns one chronological page. Do not sort/truncate the full
  // history here, or older pages would silently become inaccessible.
  const seen = new Set<string>();
  const timeline: TimelineItem[] = [];
  for (const event of events) {
    const item = replayEventTimelineItem(event);
    if (!item || seen.has(item.itemId)) continue;
    if (event.payload?.persistedKind === 'TaskRunFailed'
      && typeof event.payload.responseText === 'string' && event.payload.responseText.trim()) {
      timeline.push({ ...item, itemId: `${item.itemId}-response`, kind: 'AGENT',
        title: 'dda（中断前的回复）', body: event.payload.responseText, status: 'COMPLETE' });
    }
    seen.add(item.itemId);
    timeline.push(item);
  }
  return { ...base, projectionVersion: base.projectionVersion + 1, timeline };
};

const replaceTimelineItem = (current: HarnessReadModel, itemId: string, patch: Partial<TimelineItem>): HarnessReadModel => {
  const index = current.timeline.findIndex((item) => item.itemId === itemId);
  if (index < 0) return current;
  const timeline = current.timeline.slice();
  timeline[index] = { ...timeline[index], ...patch };
  return { ...current, projectionVersion: current.projectionVersion + 1, timeline };
};

const toolTimelineItemId = (event: RuntimeEvent, callId: string): string => `tool-${event.runId}-${callId}`;

const toolEventTimelineItem = (event: RuntimeEvent): TimelineItem | undefined => {
  const payload = event.payload ?? {};
  const callId = typeof payload.id === 'string' ? payload.id : '';
  const rawName = typeof payload.name === 'string' ? payload.name : typeof payload.toolName === 'string' ? payload.toolName : '';
  if (!callId && !rawName) return undefined;
  const toolName = toolDisplayLabel(rawName);
  const isResult = event.kind === 'tool.result';
  const failed = isResult && payload.ok === false;
  const outputChars = typeof payload.outputChars === 'number' && Number.isFinite(payload.outputChars) ? payload.outputChars : undefined;
  const message = typeof payload.message === 'string' ? payload.message : '';
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : '';
  const digest = typeof payload.outputDigest === 'string' ? payload.outputDigest : undefined;
  const body = !isResult
    ? `正在${toolName.replace(/^查看|^读取|^执行|^运行|^发送/, '')}`
    : failed
      ? `无法完成：${toolName}${errorCode ? ` · ${reasonDisplayLabel(errorCode)}` : ''}${message ? ` · ${message}` : ''}`
      : `已完成：${toolName}${outputChars !== undefined ? ` · 输出 ${outputChars.toLocaleString('zh-CN')} 字符` : ''}`;
  return {
    itemId: toolTimelineItemId(event, callId || rawName),
    eventId: event.eventId,
    eventSequence: event.sequence,
    runId: event.runId,
    operationId: callId || undefined,
    toolCallId: callId || undefined,
    kind: failed ? 'ERROR' : 'STATUS',
    title: failed ? '工具执行失败' : isResult ? '工具执行完成' : '正在调用工具',
    body,
    status: failed ? 'ERROR' : isResult ? 'COMPLETE' : 'STREAMING',
    createdAtMs: Number.isFinite(event.emittedAtMs) ? event.emittedAtMs : Date.now(),
    toolName: rawName || undefined,
    digest,
    evidenceKind: isResult ? 'terminal' : undefined,
    truncated: payload.truncated === true,
    commandText: typeof payload.command === 'string' ? payload.command : undefined
  };
};

const applyRuntimeEvent = (event: RuntimeEvent): void => {
  if (!event || event.schemaVersion !== '1.0' || !Number.isInteger(event.sequence) || event.sequence < 1 || !Number.isFinite(event.emittedAtMs)) return;
  // A child can flush a few lines after cancellation, and an earlier run can
  // still be draining while a new run starts. Bind only the runtime process
  // started for the current UI run; its id is intentionally different from
  // the local display run id generated by beginRun().
  if (deletedRuntimeRunIds.has(event.runId)) return;
  if (!model.activeRun || model.activeRun.state === 'CANCELLED') return;
  if (event.kind === 'run.started') {
    if (event.emittedAtMs < runtimeEventFloorMs) return;
    if (activeRuntimeRunId && activeRuntimeRunId !== event.runId) return;
    activeRuntimeRunId = event.runId;
  }
  if (!activeRuntimeRunId || event.runId !== activeRuntimeRunId) return;
  // The runtime emits a strictly increasing sequence per invocation. Ignore
  // late/replayed frames instead of allowing a stale state transition or
  // duplicate approval to regress the read model.
  if (event.sequence <= lastRuntimeEventSequence) return;
  lastRuntimeEventSequence = event.sequence;
  const eventKey = `${event.runId}:${event.sequence}`;
  if (observedRuntimeEvents.has(eventKey)) return;
  observedRuntimeEvents.add(eventKey);
  const payload = event.payload ?? {};
  if (event.kind === 'run.started' && lastSubmitReceipt) {
    lastSubmitReceipt.status = 'accepted';
    scheduleRender();
  }
  // Heartbeats are transport supervision frames. They advance the runtime
  // sequence and Rust watchdog timestamp, but must not pollute the user-facing
  // task timeline or mutate the task state projection.
  if (event.kind === 'runtime.heartbeat') return;
  if (event.kind === 'run.state_changed' && typeof payload.to === 'string') {
    const state = payload.to as RunState;
    update(setRunState(model, state));
    return;
  }
  if (event.kind === 'role.text_delta' || event.kind === 'role.turn_completed' || event.kind === 'planner.restored') {
    update(applyRuntimeSubAgentEvent(model, event));
    return;
  }
  if (event.kind === 'RoleContextAllocated' || event.kind === 'RoleContextStateChanged') {
    update(applyRuntimeSubAgentEvent(model, event));
    return;
  }
  if (event.kind === 'role.contexts_reconciled') {
    const reconciled = typeof payload.reconciled === 'number' && Number.isFinite(payload.reconciled)
      ? payload.reconciled
      : Array.isArray(payload.contexts) ? payload.contexts.length : 0;
    update(appendTimelineItem(applyRuntimeSubAgentEvent(model, event), {
      itemId: `runtime-${eventKey}`,
      kind: reconciled > 0 ? 'ERROR' : 'STATUS',
      title: '角色上下文恢复',
      body: reconciled > 0 ? `检测到上次运行异常退出，已标记 ${reconciled} 个角色上下文失败。` : '角色上下文已完成恢复核对。',
      status: reconciled > 0 ? 'ERROR' : 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'task.classified' || event.kind === 'task.prechecked' || event.kind === 'route.selected' || event.kind === 'role.contexts_allocated') {
    const title = event.kind === 'task.classified'
      ? '任务分类'
      : event.kind === 'task.prechecked'
        ? '安全预检'
        : event.kind === 'route.selected'
          ? '执行路由'
          : '角色上下文';
    const body = event.kind === 'task.classified'
      ? `任务类型：${humanizeCode(payload.taskClass, '暂未识别')}`
      : event.kind === 'task.prechecked'
        ? `${statusDisplayLabel(payload.status, '未读取')}${payload.reason ? ` · ${reasonDisplayLabel(payload.reason)}` : ''}`
        : event.kind === 'route.selected'
          ? `${humanizeCode(payload.taskClass, '当前任务')} · ${payload.reason ? reasonDisplayLabel(payload.reason) : '已通过安全检查'}`
          : `已分配 ${Array.isArray(payload.contexts) ? payload.contexts.length : 0} 个独立上下文`;
    const projected = event.kind === 'role.contexts_allocated'
      ? applyRuntimeSubAgentEvent(model, event)
      : model;
    update(appendTimelineItem(projected, { kind: 'STATUS', title, body, status: 'COMPLETE' }));
    return;
  }
  if (event.kind === 'model.text_delta') {
    runtimeStreamObserved = true;
    const streamId = `${event.runId}-response`;
    model = upsertStreamingAgent(model, streamId, typeof payload.text === 'string' ? payload.text : '', false, event.runId);
    scheduleRender();
    return;
  }
  if (event.kind === 'approval.requested') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (!requestId) return;
    const scopeValue = payload.scope && typeof payload.scope === 'object' && !Array.isArray(payload.scope)
      ? payload.scope as Record<string, unknown>
      : undefined;
    const scope = scopeValue
      ? {
          ...(typeof scopeValue.capability === 'string' ? { capability: scopeValue.capability } : {}),
          ...(typeof scopeValue.snapshotDigest === 'string' ? { snapshotDigest: scopeValue.snapshotDigest } : {})
        }
      : undefined;
    const risk = payload.risk === 'LOW' || payload.risk === 'MEDIUM' || payload.risk === 'HIGH'
      ? payload.risk
      : undefined;
    update(upsertApproval(model, {
      requestId,
      capability: typeof payload.capability === 'string' ? payload.capability : 'unknown',
      requestDigest: typeof payload.requestDigest === 'string' ? payload.requestDigest : '',
      ...(typeof payload.intentId === 'string' ? { intentId: payload.intentId } : {}),
      ...(typeof payload.approvalId === 'string' ? { approvalId: payload.approvalId } : {}),
      ...(risk ? { risk } : {}),
      ...(scope ? { scope } : {}),
      ...(typeof payload.policyVersion === 'string' ? { policyVersion: payload.policyVersion } : {}),
      ...(typeof payload.approvalExpiresAt === 'number' ? { approvalExpiresAt: payload.approvalExpiresAt } : {}),
      ...(typeof payload.command === 'string' ? { command: payload.command } : {}),
      ...(typeof payload.path === 'string' ? { path: payload.path } : {}),
      ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
      ...(typeof payload.host === 'string' ? { host: payload.host } : {}),
      ...(typeof payload.port === 'number' ? { port: payload.port } : {}),
      ...(typeof payload.scheme === 'string' ? { scheme: payload.scheme } : {}),
      ...(typeof payload.method === 'string' ? { method: payload.method } : {}),
      state: 'REQUESTED',
      createdAtMs: event.emittedAtMs
    }));
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: '等待审批',
      body: `${toolDisplayLabel(typeof payload.capability === 'string' ? payload.capability : '受控操作')} 请求一次性授权`,
      status: 'PENDING'
    }));
    void refreshExecutionState();
    return;
  }
  if (event.kind === 'approval.resolved') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (requestId) pendingApprovalResolutions.delete(requestId);
    const current = model.approvals.find((approval) => approval.requestId === requestId);
    if (current) {
      const state = payload.state === 'APPROVED' || payload.state === 'DECLINED' ? payload.state : current.state;
      update(upsertApproval(model, {
        ...current,
        state,
        ...(typeof payload.intentId === 'string' ? { intentId: payload.intentId } : {}),
        ...(typeof payload.approvalId === 'string' ? { approvalId: payload.approvalId } : {})
      }));
    }
    void refreshExecutionState();
    return;
  }
  if (event.kind === 'lease.issued') {
    const intentId = typeof payload.intentId === 'string' ? payload.intentId : '';
    const current = model.approvals.find((approval) => approval.intentId === intentId);
    if (current) {
      update(upsertApproval(model, {
        ...current,
        state: 'APPROVED',
        leaseState: 'ISSUED',
        ...(typeof payload.leaseId === 'string' ? { leaseId: payload.leaseId } : {}),
        ...(typeof payload.expiresAt === 'number' ? { leaseExpiresAt: payload.expiresAt } : {}),
        ...(typeof payload.policyVersion === 'string' ? { policyVersion: payload.policyVersion } : {})
      }));
    }
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: 'PolicyLease 已签发',
      body: `${toolDisplayLabel(typeof payload.capability === 'string' ? payload.capability : '受控操作')} · 仅本次`,
      status: 'COMPLETE'
    }));
    void refreshExecutionState();
    return;
  }
  if (event.kind === 'approval.expired') {
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (requestId) pendingApprovalResolutions.delete(requestId);
    const current = model.approvals.find((approval) => approval.requestId === requestId);
    if (current) update(upsertApproval(model, { ...current, state: 'EXPIRED' }));
    void refreshExecutionState();
    return;
  }
  if (event.kind === 'run.completed') {
    // A provider may finish without emitting any text deltas (for example a
    // non-streaming gateway fallback).  Do not create an empty timeline row;
    // runCordisTask will project the returned text once the final response is
    // available.  When a stream exists, this only flips its status to complete.
    update(completeStreamingAgent(model, `${event.runId}-response`));
    return;
  }
  if (event.kind === 'run.failed') {
    runtimeFailureEvents.add(event.runId);
    logRuntimeFailure(event, 'run.failed');
    pendingApprovalResolutions.clear();
    // A killed runtime may flush a buffered failure event after the user
    // cancellation has already been acknowledged. Preserve the user's
    // terminal cancellation state instead of regressing it to FAILED.
    if ((model.activeRun?.state as string | undefined) === 'CANCELLED') return;
    update(appendErrorTimelineItem(
      cancelPendingApprovals(setRunState(appendVerificationChecks(model, payload.checks, event.runId), 'FAILED')),
      'Cordis runtime',
      runtimeFailureText(event)
    ));
    return;
  }
  if (event.kind === 'action_intent.created') {
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: 'ActionIntent',
      body: `${toolDisplayLabel(typeof payload.capability === 'string' ? payload.capability : '受控操作')} 已进入审批状态`,
      status: 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'lease.claimed' || event.kind === 'lease.consumed' || event.kind === 'lease.failed') {
    const current = model.approvals.find((approval) =>
      (typeof payload.leaseId === 'string' && approval.leaseId === payload.leaseId)
      || (typeof payload.intentId === 'string' && approval.intentId === payload.intentId));
    if (current) {
      update(upsertApproval(model, {
        ...current,
        leaseState: event.kind === 'lease.failed' ? 'FAILED' : event.kind === 'lease.consumed' ? 'CONSUMED' : 'CLAIMED',
        ...(typeof payload.ok === 'boolean' ? { executionOk: payload.ok } : {})
      }));
    }
    const labels: Record<string, string> = {
      'lease.failed': 'PolicyLease 执行结果不确定',
      'lease.claimed': 'PolicyLease 已领取',
      'lease.consumed': 'PolicyLease 已消费'
    };
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: labels[event.kind],
      body: `${toolDisplayLabel(typeof payload.capability === 'string' ? payload.capability : '受控操作')}${payload.ok === false ? ' · 失败' : ''}`,
      status: event.kind === 'lease.failed' || payload.ok === false ? 'ERROR' : 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'model.route_resolved') {
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: '模型路由',
      body: `已连接 ${typeof payload.provider === 'string' ? payload.provider : '默认服务'} · ${typeof payload.model === 'string' ? payload.model : '未指定模型'}`,
      status: 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'tool.call_requested' || event.kind === 'tool.result' || event.kind === 'workspace.snapshot') {
    if (event.kind === 'tool.call_requested' || event.kind === 'tool.result') {
      const item = toolEventTimelineItem(event);
      if (!item) return;
      const existing = model.timeline.find((candidate) => candidate.toolCallId === item.toolCallId
        || (item.operationId !== undefined && candidate.operationId === item.operationId && candidate.toolName === item.toolName));
      if (event.kind === 'tool.result' && payload.ok === false) logRuntimeFailure(event, 'tool.result');
      update(existing
        ? replaceTimelineItem(model, existing.itemId, item)
        : appendTimelineItem(model, item));
    } else {
      update(appendTimelineItem(model, {
        itemId: `runtime-${eventKey}`,
        eventId: event.eventId,
        eventSequence: event.sequence,
        runId: event.runId,
        kind: 'WORKSPACE',
        title: '工作区快照',
        body: runtimeEventText(event),
        status: 'COMPLETE'
      }));
    }
  }
};

const applyWorkspaceGrant = (grant: WorkspaceGrant): boolean => {
  if (grant.rootPath) rememberProject(grant.rootPath);
  const next = setWorkspace(model, grant.rootLabel, '', [], grant.rootPath);
  const reset = next.activeThreadId !== model.activeThreadId
    || Boolean(model.workspace.rootPath && grant.rootPath && !sameWorkspaceRoot(model.workspace.rootPath, grant.rootPath));
  if (reset) {
    historyView = undefined;
    historyRenderSerial++;
    focusedRunId = null;
    localStorage.removeItem('hmcodex.focusedRunId');
    lastSubmitReceipt = undefined;
    transcriptStick = true;
    transcriptScrollTop = 0;
  }
  update(next);
  return reset;
};

const resetToNewTask = (): void => {
  running = false;
  executionGroupExpanded = false;
  historyView = undefined;
  historyRenderSerial++;
  historyPageCache.clear();
  activePage = 'workbench';
  settingsVisible = false;
  lastSubmitReceipt = undefined;
  model = { ...model, timeline: [], subAgents: [], approvals: [] };
  scheduleApprovalExpiry();
  let next: HarnessReadModel = { ...model, activeRun: undefined, composer: { ...model.composer, enabled: true } };
  next = setActiveThread(next, undefined);
  update(next);
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[name="prompt"]')?.focus());
};

const continueProjectPickerAction = async (projectId: string): Promise<void> => {
  if (projectPickerBusy || running || workspaceChanging) return;
  const mode = projectPickerMode;
  const threadId = projectPickerThreadId;
  const savedProject = projectId === PROJECTLESS_ID ? undefined : projectCatalog.find((item) => item.id === projectId);
  const discoveredProject = projectId === PROJECTLESS_ID ? undefined : projectGroups().find((item) => item.id === projectId && item.path);
  const projectPath = savedProject?.path ?? discoveredProject?.path;
  projectPickerBusy = true;
  render();
  workspaceChanging = true;
  try {
    await workspaceReady;
    if (projectPath) {
      const grant = await desktopBridge.setWorkspace(projectPath);
      applyWorkspaceGrant(grant);
      const entries = await desktopBridge.listWorkspace('');
      update(setWorkspace(model, grant.rootLabel, '', entries, grant.rootPath));
    } else {
      update(clearWorkspace(model));
      try { localStorage.removeItem(LAST_PROJECT_STORAGE_KEY); } catch { /* storage may be unavailable */ }
      lastProjectId = '';
    }
  } catch (error) {
    update(appendErrorTimelineItem(model, '项目切换', `无法打开项目：${compactError(error)}`));
    return;
  } finally {
    workspaceChanging = false;
    projectPickerBusy = false;
    projectPickerVisible = false;
  }
  if (mode === 'new-task') resetToNewTask();
  else if (threadId) await selectThread(threadId);
  else render();
};

const ensureThreadWorkspace = async (thread: HarnessReadModel['threads'][number]): Promise<boolean> => {
  const threadPath = thread.cwd?.trim();
  const currentRoot = model.workspace.rootPath?.trim();
  if (!threadPath) {
    if (!currentRoot) return true;
    projectPickerMode = 'select-thread';
    projectPickerThreadId = thread.id;
    await continueProjectPickerAction(PROJECTLESS_ID);
    return false;
  }
  if (currentRoot && sameWorkspaceRoot(currentRoot, threadPath)) return true;
  const known = projectForThread(thread);
  if (!known) rememberProject(threadPath);
  projectPickerMode = 'select-thread';
  projectPickerThreadId = thread.id;
  await continueProjectPickerAction(projectIdForPath(threadPath));
  return false;
};

const openWorkspace = async (): Promise<boolean> => {
  if (running || workspaceChanging) return false;
  workspaceChanging = true;
  navigationTouched = true;
  render();
  let opened = false;
  try {
    await workspaceReady;
    const grant = await desktopBridge.chooseWorkspace();
    const reset = applyWorkspaceGrant(grant);
    update(appendTimelineItem(model, {
      kind: 'WORKSPACE',
      title: reset ? '工作区已切换' : '工作区授权',
      body: `已以只读方式打开 ${grant.rootPath ?? grant.rootLabel}${reset ? '。下次发送将在此目录创建新会话，原会话保留在历史列表中。' : ''}`,
      status: 'COMPLETE'
    }));
    const entries = await desktopBridge.listWorkspace('');
    update(setWorkspace(model, grant.rootLabel, '', entries, grant.rootPath));
    opened = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('cancelled')) return false;
    update(appendErrorTimelineItem(model, '工作区', `无法打开工作区：${compactError(error)}`));
  } finally {
    workspaceChanging = false;
    render();
  }
  return opened;
};

const showProjectNameDialog = (followUp?: { mode: 'new-task' | 'select-thread'; threadId: string }): void => {
  const path = model.workspace.rootPath?.trim();
  if (!path) return;
  const existing = projectCatalog.find((project) => sameWorkspaceRoot(project.path, path));
  projectNameError = '';
  projectNameDialog = {
    path,
    suggestedName: projectNameForPath(path),
    draftName: existing?.name || projectNameForPath(path),
    followUp
  };
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('[data-role="project-name"]');
    input?.focus();
    input?.select();
  });
};

const finishProjectNameDialog = (name: string): void => {
  const flow = projectNameDialog;
  if (!flow) return;
  const cleanName = name.trim();
  if (!cleanName) {
    projectNameError = '请输入项目名称，或选择“使用文件夹名”。';
    render();
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-role="project-name"]')?.focus());
    return;
  }
  rememberProject(flow.path, cleanName);
  projectNameDialog = undefined;
  projectNameError = '';
  const followUp = flow.followUp;
  if (followUp?.mode === 'new-task') resetToNewTask();
  else if (followUp?.mode === 'select-thread') void selectThread(followUp.threadId);
  else render();
};

const beginProjectEdit = (projectId: string): void => {
  const project = projectCatalog.find((item) => item.id === projectId);
  if (!project) return;
  projectEditDialog = { projectId, draftName: project.name, paths: projectTargetPaths(project), busy: false };
  render();
  requestAnimationFrame(() => {
    const input = document.querySelector<HTMLInputElement>('[data-role="project-edit-name"]');
    input?.focus();
    input?.select();
  });
};

const saveProjectEdit = (): void => {
  const flow = projectEditDialog;
  if (!flow) return;
  const name = flow.draftName.trim();
  if (!name) {
    projectEditDialog = { ...flow, error: '请输入项目名称。' };
    render();
    return;
  }
  const paths = [...new Set(flow.paths.filter(Boolean))];
  if (!paths.length) {
    projectEditDialog = { ...flow, error: '项目至少需要一个源文件夹。' };
    render();
    return;
  }
  projectCatalog = projectCatalog.map((project) => project.id === flow.projectId
    ? { ...project, name, path: paths[0], paths, lastUsedAtMs: Date.now() }
    : project);
  persistProjectCatalog();
  projectEditDialog = undefined;
  render();
};

const addProjectTarget = async (projectId: string): Promise<void> => {
  const flow = projectEditDialog;
  const project = projectCatalog.find((item) => item.id === projectId);
  if (!flow || !project || flow.busy) return;
  const previousRoot = model.workspace.rootPath;
  projectEditDialog = { ...flow, busy: true, error: undefined };
  render();
  try {
    const grant = await desktopBridge.chooseWorkspace();
    const target = grant.rootPath?.trim();
    if (!target) throw new Error('未返回所选文件夹');
    const paths = projectTargetPaths(project);
    if (paths.some((path) => sameWorkspaceRoot(path, target))) {
      projectEditDialog = { ...projectEditDialog!, busy: false, error: '这个文件夹已经在项目中了。' };
    } else {
      projectEditDialog = { ...projectEditDialog!, busy: false, paths: [...paths, target] };
    }
    if (previousRoot && !sameWorkspaceRoot(previousRoot, target)) await desktopBridge.setWorkspace(previousRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('cancelled')) projectEditDialog = { ...projectEditDialog!, busy: false, error: `无法添加文件夹：${compactError(error)}` };
    else projectEditDialog = { ...projectEditDialog!, busy: false };
  }
  render();
};

const removeProjectTarget = (projectId: string, index: number): void => {
  if (!projectEditDialog || projectEditDialog.projectId !== projectId || index <= 0 || projectEditDialog.paths.length <= 1) return;
  projectEditDialog = { ...projectEditDialog, paths: projectEditDialog.paths.filter((_, targetIndex) => targetIndex !== index), error: undefined };
  render();
};

const loadDefaultWorkspace = async (): Promise<void> => {
  if (!desktopBridge.isNative() || model.workspace.granted) return;
  try {
    const grant = await desktopBridge.defaultWorkspace();
    if (!grant) return;
    applyWorkspaceGrant(grant);
    const entries = await desktopBridge.listWorkspace('');
    let next = setWorkspace(model, grant.rootLabel, '', entries, grant.rootPath);
    next = appendTimelineItem(next, {
      kind: 'WORKSPACE',
      title: '默认工作区',
      body: `已自动使用 ${grant.rootPath ?? grant.rootLabel} 作为只读工作区。需要切换目录时可点击“打开项目”。`,
      status: 'COMPLETE'
    });
    update(next);
  } catch (error) {
    update(appendErrorTimelineItem(model, '默认工作区', error));
  }
};

const openWorkspaceEntry = async (entry: WorkspaceEntry): Promise<void> => {
  if (workspaceChanging) return;
  const workspace = model.workspace;
  try {
    if (entry.kind === 'DIRECTORY') {
      const entries = await desktopBridge.listWorkspace(entry.relativePath);
      if (workspaceChanging || model.workspace !== workspace) return;
      update(setWorkspace(model, model.workspace.rootLabel, entry.relativePath, entries));
      return;
    }
    const file = await desktopBridge.readWorkspaceFile(entry.relativePath);
    if (workspaceChanging || model.workspace !== workspace) return;
    update(setWorkspaceFile(model, file));
  } catch (error) {
    if (workspaceChanging || model.workspace !== workspace) return;
    update(appendErrorTimelineItem(model, '文件读取', error));
  }
};

const workspaceUp = async (): Promise<void> => {
  if (workspaceChanging) return;
  const workspace = model.workspace;
  const current = model.workspace.currentPath;
  const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  try {
    const entries = await desktopBridge.listWorkspace(parent);
    if (workspaceChanging || model.workspace !== workspace) return;
    update(setWorkspace(model, workspace.rootLabel, parent, entries));
  } catch (error) {
    if (workspaceChanging || model.workspace !== workspace) return;
    update(appendErrorTimelineItem(model, '工作区', error));
  }
};

const restoreSavedNavigation = async (): Promise<void> => {
  try {
    await workspaceReady;
    const raw = savedNavigation;
    if (!raw) return;
    if (navigationTouched || running) return;
    const saved = JSON.parse(raw) as { page?: string; threadId?: string | null; scrollTop?: number };
    if (saved.page && Object.prototype.hasOwnProperty.call(primaryPages, saved.page)) activePage = saved.page;
    if (typeof saved.scrollTop === 'number') transcriptScrollTop = saved.scrollTop;
    focusedRunId = localStorage.getItem('hmcodex.focusedRunId') || null;
    if (saved.threadId && !running && activePage === 'workbench') await selectThread(saved.threadId);
    else render();
  } catch { /* ignore restore errors */ }
};

const selectThread = async (threadId: string): Promise<void> => {
  if (running || workspaceChanging || !threadId) return;
  const selectedThread = model.threads.find((thread) => thread.id === threadId);
  if (selectedThread && !hasPersistedTurn(selectedThread)) {
    historyView = undefined;
    historyRenderSerial++;
    model = { ...setActiveThread(model, undefined), timeline: [], activeRun: undefined, composer: { ...model.composer, enabled: true } };
    persistNavigation();
    render();
    return;
  }
  if (selectedThread && !(await ensureThreadWorkspace(selectedThread))) return;
  if (historyView?.threadId === threadId && !historyView.error) {
    activePage = 'workbench';
    settingsVisible = false;
    renderHistoryView();
    persistNavigation();
    return;
  }
  const view: HistoryView = { threadId, loading: true, loadingOlder: false, hasMore: false };
  const renderSerial = ++historyRenderSerial;
  historyView = view;
  activePage = 'workbench';
  settingsVisible = false;
  focusedRunId = null;
  localStorage.removeItem('hmcodex.focusedRunId');
  lastSubmitReceipt = undefined;
  transcriptStick = true;
  transcriptScrollTop = 0;
  model = { ...setActiveThread(model, threadId), activeRun: undefined, subAgents: [], approvals: [],
    continuousVerification: [], processVerification: undefined, decisions: [], timeline: [],
    composer: { ...model.composer, enabled: false } };
  renderHistoryView();
  persistNavigation();
  try {
    const page = await loadInitialHistoryPage(threadId);
    if (historyView !== view || running) return;
    if (page.thread) model = setThreads(model, [page.thread, ...model.threads.filter((thread) => thread.id !== threadId)]);
    model = setActiveThread(model, threadId, Boolean(page.thread?.resumable || page.thread?.checkpoint?.plan));
    const pageModel = replayThreadEvents({ ...model, timeline: [] }, page.events);
    model = { ...model, timeline: [] };
    renderHistoryView();
    await syncKeyedListIncrementally(
      app.querySelector<HTMLElement>('[data-history-items]')!, pageModel.timeline,
      (item) => item.itemId, timelineItemHtml, historyIcons,
      () => historyView !== view || historyRenderSerial !== renderSerial || running);
    if (historyView !== view || historyRenderSerial !== renderSerial || running) return;
    model = { ...model, timeline: pageModel.timeline };
    view.hasMore = page.hasMore;
    view.cursor = page.nextCursor;
  } catch (error) {
    if (historyView === view) {
      const message = compactError(error);
      // A persisted navigation entry can outlive its workspace data (for
      // example after switching to a fresh project or clearing test state).
      // Do not leave the composer locked on an unrecoverable history page;
      // discard the stale selection and return to a new-task surface.
      if (message.includes('THREAD_NOT_FOUND')) {
        historyView = undefined;
        historyRenderSerial++;
        focusedRunId = null;
        localStorage.removeItem('hmcodex.focusedRunId');
        model = {
          ...setActiveThread(model, undefined),
          activeRun: undefined,
          timeline: [],
          subAgents: [],
          approvals: [],
          composer: { ...model.composer, enabled: true }
        };
        persistNavigation();
        render();
      } else {
        view.error = message;
      }
    }
  } finally {
    if (historyView === view && !running) {
      view.loading = false;
      model = { ...model, composer: { ...model.composer, enabled: !view.error } };
      renderHistoryView();
      const transcript = app.querySelector<HTMLElement>('.transcript');
      if (transcript && transcriptStick) transcript.scrollTop = transcript.scrollHeight;
      persistNavigation();
    }
  }
};

const loadOlderHistory = async (): Promise<void> => {
  const view = historyView;
  const renderSerial = historyRenderSerial;
  if (!view || view.loading || view.loadingOlder || running) return;
  if (!view.cursor) { if (view.error) await selectThread(view.threadId); return; }
  view.loadingOlder = true;
  view.error = undefined;
  model = { ...model, composer: { ...model.composer, enabled: false } };
  renderHistoryView();
  try {
    const page = await desktopBridge.listThreadEvents(view.threadId, { before: view.cursor });
    if (historyView !== view || historyRenderSerial !== renderSerial || running) return;
    const older = replayThreadEvents({ ...model, timeline: [] }, page.events);
    const seen = new Set(model.timeline.map((item) => item.itemId));
    const transcript = app.querySelector<HTMLElement>('.transcript');
    const viewportTop = transcript?.getBoundingClientRect().top ?? 0;
    const anchor = [...app.querySelectorAll<HTMLElement>('[data-history-items] > .timeline-item')]
      .find((row) => row.getBoundingClientRect().bottom >= viewportTop);
    const anchorTop = anchor?.getBoundingClientRect().top ?? 0;
    const mergedTimeline = [...older.timeline.filter((item) => !seen.has(item.itemId)), ...model.timeline];
    model = { ...model, timeline: model.timeline };
    view.hasMore = page.hasMore;
    view.cursor = page.nextCursor;
    renderHistoryView();
    await syncKeyedListIncrementally(
      app.querySelector<HTMLElement>('[data-history-items]')!, mergedTimeline,
      (item) => item.itemId, timelineItemHtml, historyIcons,
      () => historyView !== view || historyRenderSerial !== renderSerial || running);
    if (historyView !== view || historyRenderSerial !== renderSerial || running) return;
    model = { ...model, timeline: mergedTimeline };
    renderHistoryView();
    if (transcript && anchor) {
      const nextScrollTop = transcript.scrollTop + anchor.getBoundingClientRect().top - anchorTop;
      // Update the shared restoration state before writing the element. A
      // generic render frame may already be queued from startup hydration;
      // otherwise that frame can immediately restore the old top position.
      transcriptScrollTop = Math.max(0, nextScrollTop);
      transcriptStick = false;
      transcript.scrollTop = transcriptScrollTop;
    }
  } catch (error) {
    if (historyView === view) view.error = compactError(error);
  } finally {
    if (historyView === view && !running) {
      view.loadingOlder = false;
      model = { ...model, composer: { ...model.composer, enabled: true } };
      renderHistoryView();
    }
  }
};

const runMockTask = async (prompt: string): Promise<void> => {
  if (running || workspaceChanging) return;
  running = true;
  const started = beginRun(model, prompt);
  const runId = started.activeRun?.runId;
  if (!runId) {
    running = false;
    return;
  }
  const workspaceAgentId = `${runId}-workspace`;
  const safetyAgentId = `${runId}-safety`;
  const summaryAgentId = `${runId}-summary`;
  let next = upsertSubAgent(started, {
    agentId: workspaceAgentId,
    name: '结构扫描',
    task: '准备读取授权工作区',
    state: 'STARTING'
  });
  next = upsertSubAgent(next, {
    agentId: safetyAgentId,
    name: '安全校验',
    task: '准备核对只读能力边界',
    state: 'STARTING'
  });
  next = upsertSubAgent(next, {
    agentId: summaryAgentId,
    name: '结果汇总',
    task: '等待前置检查完成',
    state: 'STARTING'
  });
  update(next);
  const isCurrentRunActive = (): boolean =>
    Boolean(model.activeRun?.runId === runId && pendingCancellationRunId !== runId && model.activeRun.state !== 'CANCELLED');

  try {
    await new Promise((resolve) => window.setTimeout(resolve, 280));
    if (!isCurrentRunActive()) return;
    next = setRunState(model, 'EXECUTING_READ');
    next = upsertSubAgent(next, {
      agentId: workspaceAgentId,
      task: model.workspace.granted ? '扫描已授权工作区的目录结构' : '检查工作区授权状态',
      state: 'RUNNING'
    });
    next = upsertSubAgent(next, {
      agentId: safetyAgentId,
      task: '核对路径范围与只读能力边界',
      state: 'RUNNING'
    });
    update(next);
    const response = `我会在只读工作区“${model.workspace.rootLabel}”内进行检查。当前 Windows MVP 已建立稳定的 ReadModel、受限工作区接口和明确的安全能力边界。需要切换目录时可点击右上角“打开项目”。`;
    const streamId = `agent-${Date.now()}`;
    for (let index = 0; index < response.length; index += 3) {
      if (!isCurrentRunActive()) return;
      update(upsertStreamingAgent(model, streamId, response.slice(index, index + 3)));
      await new Promise((resolve) => window.setTimeout(resolve, 18));
    }
    if (!isCurrentRunActive()) return;
    next = upsertStreamingAgent(model, streamId, '', true);
    next = upsertSubAgent(next, {
      agentId: workspaceAgentId,
      task: '目录结构读取完成',
      state: 'SUCCEEDED'
    });
    next = upsertSubAgent(next, {
      agentId: safetyAgentId,
      task: '只读边界核对完成',
      state: 'SUCCEEDED'
    });
    next = upsertSubAgent(next, {
      agentId: summaryAgentId,
      task: '整理本次检查结果',
      state: 'RUNNING'
    });
    next = setRunState(next, 'VERIFYING');
    update(next);
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    if (!isCurrentRunActive()) return;
    next = upsertSubAgent(model, {
      agentId: summaryAgentId,
      task: '检查结果已汇总',
      state: 'SUCCEEDED'
    });
    update(setRunState(next, 'SUCCEEDED'));
  } finally {
    running = false;
    render();
  }
};

const runCordisTask = async (prompt: string): Promise<void> => {
  if (running || workspaceChanging) return;
  // Acquire the local run lock before awaiting event subscription setup. A
  // rapid double-submit during startup must not create two overlapping
  // runtime children or let the second display run replace the first.
  running = true;
  // Ensure the native event subscription is installed before spawning the
  // runtime child. This prevents losing the first streamed delta or approval
  // request when a user submits immediately after application launch.
  try {
    // Wait for the one-time runtime snapshot/recovery/dashboard hydration. The
    // dashboard command reads the same Harness SQLite file that the task
    // writes, so starting both processes from the first paint is unsafe.
    await runtimeHydrationReady;
    await runtimeEventsReady;
    await workspaceReady;
  } catch (error) {
    running = false;
    update(appendErrorTimelineItem(model, 'Cordis runtime 事件流', error));
    return;
  }
  runtimeStreamObserved = false;
  activeRuntimeRunId = undefined;
  runtimeEventFloorMs = Date.now();
  lastRuntimeEventSequence = 0;
  // Event keys include runId, but clearing this bounded-lifetime set avoids
  // retaining every historical run for the lifetime of the desktop process.
  observedRuntimeEvents.clear();
  let next = beginRun(model, prompt);
  const runId = next.activeRun?.runId;
  if (!runId) {
    running = false;
    return;
  }
  const hostAgentId = `${runId}-cordis-host`;
  const workspaceAgentId = `${runId}-workspace-plugin`;
  const modelAgentId = `${runId}-model-plugin`;
  const summaryAgentId = `${runId}-summary-plugin`;
  for (const agent of [
    { agentId: hostAgentId, name: 'Cordis 插件宿主', task: '装载已签名插件组合', state: 'STARTING' as const },
    { agentId: workspaceAgentId, name: '只读工作区', task: '等待生成授权目录快照', state: 'STARTING' as const },
    { agentId: modelAgentId, name: '模型提供方', task: '等待模型调用', state: 'STARTING' as const },
    { agentId: summaryAgentId, name: '结果汇总', task: '等待插件任务完成', state: 'STARTING' as const }
  ]) {
    next = upsertSubAgent(next, agent);
  }
  update(next);
  const isCurrentRunActive = (): boolean =>
    Boolean(model.activeRun?.runId === runId && pendingCancellationRunId !== runId && model.activeRun.state !== 'CANCELLED'
      && (!activeRuntimeRunId || !deletedRuntimeRunIds.has(activeRuntimeRunId)));
  try {
    next = setRunState(model, 'EXECUTING_READ');
    next = upsertSubAgent(next, { agentId: hostAgentId, task: 'Cordis 服务注入已完成', state: 'SUCCEEDED' });
    next = upsertSubAgent(next, { agentId: workspaceAgentId, task: '生成 canonical 只读 workspace snapshot', state: 'RUNNING' });
    next = upsertSubAgent(next, { agentId: modelAgentId, task: '等待只读快照后调用模型', state: 'STARTING' });
    update(next);

    const taskOptions: RuntimeTaskOptions = model.composer.mode === 'CONTROLLED'
      ? {
          executionMode: 'CONTROLLED' as const,
          leaseCapabilities: controlledCapabilities,
          leaseCommands: controlledCommands,
          ...(controlledNetworkTargets.parsed.length ? { leaseNetworkTargets: controlledNetworkTargets.parsed } : {})
        }
      : { executionMode: 'READ_ONLY' as const };
    Object.assign(taskOptions, workspaceThreadOptions(model));
    if (model.activeThreadId && !taskOptions.threadId) update(setActiveThread(model, undefined));
    const result = await desktopBridge.runModelTask(prompt, pinnedModel ?? undefined, taskOptions);
    // A completed bridge promise may belong to a cancelled/replaced UI run.
    // Do not let that response rebind the new run's runtime identity.
    if (!isCurrentRunActive()) return;
    {
      const identity = resolveRuntimeResultIdentity(activeRuntimeRunId, result.runId, deletedRuntimeRunIds);
      activeRuntimeRunId = identity.runId;
      if (identity.deleted) return;
    }
    executionRefreshQueued = true;
    governanceRefreshQueued = true;
    if (!isCurrentRunActive()) return;
    // Runtime events are applied asynchronously while the bridge promise is
    // pending. Rebase the result projection on the current model so event
    // timeline items (workspace snapshots, tool results, approvals, etc.)
    // cannot be overwritten by the stale pre-submit snapshot.
    next = model;
    if (!result.ok) {
      next = upsertSubAgent(next, { agentId: workspaceAgentId, task: 'workspace snapshot 未能提交', state: 'FAILED' });
      next = upsertSubAgent(next, { agentId: modelAgentId, task: result.error, state: 'FAILED' });
      next = upsertSubAgent(next, { agentId: summaryAgentId, task: '未生成结果', state: 'CANCELLED' });
      if (lastSubmitReceipt?.status === 'pending') lastSubmitReceipt.status = 'unconfirmed';
      if (!runtimeFailureEvents.has(result.runId ?? activeRuntimeRunId ?? '')) next = appendErrorTimelineItem(setRunState(next, 'FAILED'), 'Cordis runtime', result.error);
      else next = setRunState(next, 'FAILED');
      update(next);
      return;
    }

    if (lastSubmitReceipt) lastSubmitReceipt.status = 'accepted';
    next = model;
    next = upsertSubAgent(next, { agentId: workspaceAgentId, task: `snapshot 已提交（${result.workspace.entryCount ?? 0} 项）`, state: 'SUCCEEDED' });
    next = setActiveThread(next, result.threadId);
    next = setThreads(next, [result.thread, ...next.threads.filter((thread) => thread.id !== result.thread.id)]);
    const modelSummary = result.model
      ? `${result.model.provider} 服务 · ${result.model.model}`
      : '模型配置未返回';
    next = upsertSubAgent(next, { agentId: modelAgentId, task: `流式响应已完成（${modelSummary}）`, state: 'SUCCEEDED' });
    next = upsertSubAgent(next, { agentId: summaryAgentId, task: '整理模型结果', state: 'RUNNING' });
    next = setRunState(next, 'VERIFYING');
    update(next);

    if (!runtimeStreamObserved) {
      const streamId = `${runId}-response`;
      next = upsertStreamingAgent(next, streamId, result.text, true, activeRuntimeRunId);
    }
    const evolutionSummary = result.evolution
      ? `演化注册表${result.evolution.store === 'PERSISTED' ? '已持久化' : '仅内存'}（${result.evolution.proposalCount} 个候选）`
      : '演化注册表状态未返回';
    const trajectorySummary = result.trajectory
      ? `轨迹${result.trajectory.store === 'PERSISTED' ? '已持久化' : '仅内存'}（${result.trajectory.eventCount} 个事件）`
      : '轨迹状态未返回';
    const contextSummary = result.context
      ? `${result.context.provider} 上下文${result.context.status === 'COMMITTED' ? '已提交' : '已降级'}（召回 ${result.context.recalledCount ?? 0}，提交 ${result.context.committedCount ?? 0}）`
      : '上下文状态未返回';
    const toolSummary = result.toolCallCount
      ? `完成 ${result.toolCallCount} 次工具调用（${result.toolRounds ?? 0} 轮）`
      : '未请求工具';
    const sideEffectSummary = result.executionMode === 'CONTROLLED' ? '受控执行' : '只读边界';
    next = upsertSubAgent(next, { agentId: summaryAgentId, task: `结果已汇总，${toolSummary}，${sideEffectSummary}，${contextSummary}，${evolutionSummary}，${trajectorySummary}`, state: 'SUCCEEDED' });
    if (result.context?.status === 'DEGRADED') {
      next = appendTimelineItem(next, {
        kind: 'STATUS',
        title: '上下文降级',
        body: `${result.context.provider} 未能完整完成上下文流程，任务结果仍已返回。${result.context.recallError ?? ''}`.trim(),
        status: 'ERROR'
      });
    }
    next = appendVerificationChecks(next, result.verification?.checks, activeRuntimeRunId);
    if (result.verification?.semantic) {
      const semantic = result.verification.semantic;
      const identity = semantic.modelIdentity
        ? Object.values(semantic.modelIdentity).filter((value) => typeof value === 'string' && value.trim()).join(' · ')
        : '';
      const evidence = semantic.evidenceRefs?.length ? semantic.evidenceRefs.join(', ') : '无';
      const failures = semantic.failureCodes?.length ? semantic.failureCodes.join(', ') : '';
      const gateReason = typeof semantic.gate?.reasonCode === 'string' ? semantic.gate.reasonCode : '';
      const degradation = [
        semantic.source ? `来源 ${semantic.source}` : undefined,
        semantic.required === undefined ? undefined : (semantic.required ? '高风险要求独立验证' : '常规风险'),
        gateReason || undefined
      ].filter(Boolean).join(' · ');
      next = appendTimelineItem(next, {
        kind: 'STATUS',
        title: '语义 Verifier 证据',
        body: [
          `Verdict ${semantic.status}`,
          semantic.summary,
          identity ? `模型身份 ${identity}` : undefined,
          degradation ? `降级原因 ${degradation}` : undefined,
          `证据 ${evidence}`,
          failures ? `失败码 ${failures}` : undefined
        ].filter(Boolean).join(' · '),
        status: semantic.status === 'PASS' ? 'COMPLETE' : semantic.status === 'FAIL' ? 'ERROR' : 'PENDING'
      });
    }
    const verification = result.verification;
    const semantic = verification?.semantic;
    const verified = verification?.status === 'PASS'
      && (!semantic?.required || semantic.status === 'PASS');
    if (!verified) {
      next = appendTimelineItem(next, {
        kind: 'STATUS',
        title: '未达到验收条件',
        body: [
          verification ? '验证结果 ' + verification.status : '运行时未提供验证结果',
          verification?.summary,
          semantic?.required && semantic.status !== 'PASS' ? '必需的独立语义验证未通过：' + semantic.status : undefined,
          '已保留输出；已执行操作不会自动撤销，请核对证据和工作区。'
        ].filter(Boolean).join(' · '),
        status: verification?.status === 'FAIL' || semantic?.status === 'FAIL' ? 'ERROR' : 'PENDING'
      });
    }
    update(setRunState(next, verified ? 'SUCCEEDED' : 'FAILED'));
  } catch (error) {
    if (!isCurrentRunActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    const compactMessage = compactError(message);
    next = model;
    next = upsertSubAgent(next, { agentId: modelAgentId, task: compactMessage, state: 'FAILED' });
    if (lastSubmitReceipt?.status === 'pending') lastSubmitReceipt.status = 'unconfirmed';
    update(appendErrorTimelineItem(setRunState(next, 'FAILED'), 'Cordis runtime', compactMessage));
  } finally {
    running = false;
    scheduleRender();
    // Reads requested by approval events or manual refreshes are deferred
    // while the runtime owns the Harness database. Flush them only after the
    // child has exited, when the SQLite connection is no longer contested.
    if (executionRefreshQueued) {
      executionRefreshQueued = false;
      void refreshExecutionState();
    }
    if (governanceRefreshQueued) {
      governanceRefreshQueued = false;
      void refreshGovernance();
    }
    // A native cancellation acknowledges taskkill before the blocking
    // runtime reader has necessarily drained and cleared its process state.
    // Keep the composer disabled until this invocation has actually returned,
    // then release it for the next task.
    if (model.activeRun?.runId === runId && !model.composer.enabled) {
      update({ ...model, composer: { ...model.composer, enabled: true }, projectionVersion: model.projectionVersion + 1 });
    } else {
      renderWithFallback(true);
    }
  }
};

function closeSettings(): void {
  if (settingsSaving) return;
  settingsVisible = false;
  settingsError = '';
  settingsSaved = false;
  render();
  app?.querySelector<HTMLElement>('[data-action="open-settings"]')?.focus({ preventScroll: true });
}

app.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.classList.contains('settings-backdrop') && !settingsSaving) {
    closeSettings();
    return;
  }
  if (target?.classList.contains('project-picker-backdrop') && !projectPickerBusy) {
    closeProjectPicker();
    return;
  }
  const actionElement = target?.closest<HTMLElement>('[data-action]');
  const action = actionElement?.dataset.action;
  if (action === 'settings-section') {
    const section = actionElement?.dataset.section;
    if (section && Object.prototype.hasOwnProperty.call(settingsSections, section)) {
      settingsSection = section as SettingsSection;
      settingsSearch = '';
      const search = app.querySelector<HTMLInputElement>('.settings-search');
      if (search) search.value = '';
      syncSettingsView();
      const content = app.querySelector('.settings-main');
      if (content) content.scrollTop = 0;
    }
    return;
  }
  if (action === 'close-project-picker') {
    closeProjectPicker();
    return;
  }
  if (action === 'cancel-project-name') {
    projectNameDialog = undefined;
    projectNameError = '';
    render();
    return;
  }
  if (action === 'edit-project') {
    beginProjectEdit(actionElement?.dataset.projectId ?? '');
    return;
  }
  if (action === 'cancel-project-edit') {
    projectEditDialog = undefined;
    render();
    return;
  }
  if (action === 'save-project-edit') {
    saveProjectEdit();
    return;
  }
  if (action === 'add-project-target') {
    void addProjectTarget(actionElement?.dataset.projectId ?? '');
    return;
  }
  if (action === 'remove-project-target') {
    removeProjectTarget(actionElement?.dataset.projectId ?? '', Number(actionElement?.dataset.targetIndex ?? -1));
    return;
  }
  if (action === 'save-project-name') {
    finishProjectNameDialog(projectNameDialog?.draftName ?? '');
    return;
  }
  if (action === 'skip-project-name') {
    finishProjectNameDialog(projectNameDialog?.suggestedName ?? '');
    return;
  }
  if (action === 'toggle-project-section') {
    projectsSectionCollapsed = !projectsSectionCollapsed;
    try { localStorage.setItem('hmcodex.projectsSectionCollapsed', String(projectsSectionCollapsed)); } catch { /* storage may be unavailable */ }
    const projectList = app.querySelector<HTMLElement>('[data-region="thread-list"]');
    const toggle = actionElement;
    if (projectList) {
      projectList.hidden = projectsSectionCollapsed;
      projectList.classList.toggle('project-list-collapsed', projectsSectionCollapsed);
    }
    toggle?.setAttribute('aria-expanded', String(!projectsSectionCollapsed));
    if (toggle) {
      const icon = toggle.querySelector('svg');
      if (icon) icon.outerHTML = `<i data-lucide="${projectsSectionCollapsed ? 'chevron-right' : 'chevron-down'}"></i>`;
      historyIcons(toggle);
    }
    return;
  }
  if (action === 'toggle-project') {
    const projectId = actionElement?.dataset.projectId ?? '';
    const activeProjectId = currentProjectId();
    const isOpen = !collapsedProjectIds.has(projectId) && (expandedProjectIds.has(projectId) || projectId === activeProjectId);
    if (isOpen) {
      expandedProjectIds.delete(projectId);
      collapsedProjectIds.add(projectId);
    } else {
      expandedProjectIds.add(projectId);
      collapsedProjectIds.delete(projectId);
    }
    updateThreadList();
    return;
  }
  if (action === 'select-new-task-project') {
    void continueProjectPickerAction(actionElement?.dataset.projectId ?? PROJECTLESS_ID);
    return;
  }
  if (action === 'add-project') {
    const pickerMode = projectPickerMode;
    const pickerThreadId = projectPickerThreadId;
    projectPickerVisible = false;
    render();
    void (async () => {
      const opened = await openWorkspace();
      if (!opened) return;
      const followUp = pickerMode === 'new-task'
        ? { mode: 'new-task' as const, threadId: '' }
        : pickerThreadId ? { mode: 'select-thread' as const, threadId: pickerThreadId } : undefined;
      showProjectNameDialog(followUp);
    })();
    return;
  }
  if (action === 'navigate' || action === 'new-task' || action === 'select-thread') navigationTouched = true;
  if (action === 'history-older') { void loadOlderHistory(); return; }
  if (action === 'toggle-subagents') {
    subAgentsCollapsed = !subAgentsCollapsed;
    const panel = actionElement?.closest('.subagent-panel');
    const list = panel?.querySelector<HTMLElement>('.subagent-list');
    if (list) list.hidden = subAgentsCollapsed;
    actionElement?.setAttribute('aria-expanded', String(!subAgentsCollapsed));
    if (actionElement) actionElement.textContent = subAgentsCollapsed ? '展开子 Agent' : '收起子 Agent';
    return;
  }
  if (action) console.info('[ui-action]', action, { running, activeRun: model.activeRun?.runId, state: model.activeRun?.state });
  if (action === 'navigate') {
    activePage = actionElement?.dataset.page ?? 'workbench';
    localStorage.setItem('hmcodex.activePage', activePage);
    render();
    void loadPageDetails();
    return;
  }
  if (action === 'focus-evidence') {
    const ref = actionElement?.dataset.evidenceRef ?? '';
    const target = resolveEvidenceTarget(ref);
    if (!target) return;
    historyView = undefined;
    focusedRunId = target.runId ?? null;
    activePage = 'workbench';
    // Evidence may point at a tool/workspace row mounted only when the execution group is open.
    executionGroupExpanded = true;
    render();
    requestAnimationFrame(() => { const node = app.querySelector<HTMLElement>('[data-item-id="' + CSS.escape(target.itemId) + '"]'); node?.querySelectorAll<HTMLDetailsElement>('details').forEach(d => d.open = true); node?.scrollIntoView({ block: 'center' }); });
    return;
  }
  if (action === 'focus-run') { historyView = undefined; focusedRunId = actionElement?.dataset.runId ?? null; activePage = 'workbench'; localStorage.setItem('hmcodex.activePage', 'workbench'); if (focusedRunId) localStorage.setItem('hmcodex.focusedRunId', focusedRunId); else localStorage.removeItem('hmcodex.focusedRunId'); render(); return; }
  if (action === 'clear-run-focus') { focusedRunId = null; localStorage.removeItem('hmcodex.focusedRunId'); render(); return; }
  if (action === 'memory-page') { const delta = Number(actionElement?.dataset.delta); if (delta === 1 || delta === -1) memoryPage = Math.max(1, memoryPage + delta); render(); return; }
  if (action === 'memory-edit') {
    const memoryId = actionElement?.dataset.memoryId;
    const memory = model.memories.find((candidate) => candidate.memoryId === memoryId);
    if (!memory) return;
    memoryEditState = { memoryId: memory.memoryId, statement: memory.statement, scope: memory.scope, confidence: String(memory.confidence), sourceEventIds: (memory.sourceEventIds ?? []).join(', '), sensitivity: memory.sensitivity ?? 'INTERNAL' };
    memoryEditError = '';
    activePage = 'memory';
    localStorage.setItem('hmcodex.activePage', 'memory');
    render();
    requestAnimationFrame(() => app.querySelector<HTMLTextAreaElement>('[data-form="memory-edit"] textarea[name="statement"]')?.focus());
    return;
  }
  if (action === 'memory-edit-cancel') { memoryEditState = undefined; memoryEditError = ''; render(); return; }
  if (action === 'runs-page') { const delta = Number(actionElement?.dataset.delta ?? 0); if (delta && runsPage + delta >= 1) runsPage += delta; render(); return; }
    if (action === 'pinned-model') { pinnedModel = actionElement instanceof HTMLSelectElement ? actionElement.value || null : pinnedModel; if (pinnedModel) localStorage.setItem('hmcodex.pinnedModel', pinnedModel); else localStorage.removeItem('hmcodex.pinnedModel'); return; }
  if (action === 'run-recovery-check') void runRecoveryCheck();
  if (action === 'cancel-recovery-approval' || action === 'revoke-recovery-lease') { void runRecoveryRecordAction(actionElement!); return; }
  if (action === 'view-recovery-record') {
    activePage = 'safety';
    localStorage.setItem('hmcodex.activePage', 'safety');
    contextVisible = true;
    render();
    requestAnimationFrame(() => app.querySelector('.execution-state-section')?.scrollIntoView({ block: 'center' }));
    return;
  }
  if (action === 'export-data') void exportData(actionElement?.dataset.scope ?? 'all');
  if (action === 'open-workspace') void openWorkspace();
  if (action === 'open-settings') void openSettings();
  if (action === 'close-settings' && !settingsSaving) {
    closeSettings();
  }
  if (action === 'toggle-mode' && desktopBridge.isNative() && !running && model.runtime.releaseChannel !== 'WINDOWS_PHASE1_READ_ONLY') {
    update(setExecutionMode(model, model.composer.mode === 'READ_ONLY' ? 'CONTROLLED' : 'READ_ONLY'));
  }
  if (action === 'resolve-approval') {
    update(expireRequestedApprovals(model));
    const requestId = actionElement?.dataset.approvalId ?? '';
    const approval = model.approvals.find((item) => item.requestId === requestId);
    const approved = actionElement?.dataset.approved === 'true';
    if (approval?.state === 'REQUESTED' && requestId && !pendingApprovalResolutions.has(requestId)) {
      if (approved && approval.risk === 'HIGH' && actionElement instanceof HTMLElement) confirmHighRiskApproval(approval, actionElement);
      else dispatchApproval(requestId, approved, approval.requestDigest);
    }
  }
  if (action === 'toggle-context') {
    contextVisible = !contextVisible;
    render();
    void loadPageDetails();
  }
  if (action === 'cancel-run') {
    void (async () => {
      const cancelRunId = model.activeRun?.runId;
      if (!cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun?.state ?? '')) return;
      try {
        pendingCancellationRunId = cancelRunId;
        const cancellation = desktopBridge.isNative()
          ? await desktopBridge.cancelModelTask()
          : { cancelled: true };
        if (!cancellation.cancelled) {
          if (model.activeRun?.runId !== cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun?.state ?? '')) return;
          update(appendErrorTimelineItem(model, '运行时取消', '当前没有可取消的 Cordis runtime 任务'));
          return;
        }
        // A terminal event can be delivered while the native cancel command
        // is waiting for taskkill. Never regress that authoritative outcome
        // to CANCELLED, and never mutate a newer run.
        if (model.activeRun?.runId !== cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'].includes(model.activeRun?.state ?? '')) return;
        pendingApprovalResolutions.clear();
        const stopped = { ...model, timeline: model.timeline.map((item) => item.status === 'STREAMING'
          ? { ...item, status: 'COMPLETE' as const } : item) };
        const cancelled = cancelPendingApprovals(setRunState(stopped, 'CANCELLED'));
        update(appendTimelineItem({
          ...cancelled,
          // The reader may already have settled before cancellation returns.
          // Block only while that invocation still owns the submission lock.
          composer: { ...cancelled.composer, enabled: !desktopBridge.isNative() || !running }
        }, {
          kind: 'STATUS',
          title: '运行控制',
          body: cancelled.composer.mode === 'CONTROLLED'
            ? '任务已由用户取消。已经执行的操作不会自动撤销，请核对执行记录和工作区。'
            : '任务已由用户取消。只读运行没有产生外部副作用。',
          status: 'COMPLETE'
        }));
      } catch (error) {
        update(appendErrorTimelineItem(model, '运行时取消', error));
      } finally {
        if (pendingCancellationRunId === cancelRunId) pendingCancellationRunId = undefined;
      }
    })();
  }
  if (action === 'new-task') {
    if (workspaceChanging) return;
    // A stale submission lock must not make the primary action inert. The
    // active run state is authoritative for whether a task is actually live.
    if (running && model.activeRun) return;
    projectPickerMode = 'new-task';
    projectPickerThreadId = '';
    projectPickerVisible = true;
    render();
  }
  if (action === 'workspace-up') void workspaceUp();
  if (action === 'select-thread') void selectThread(actionElement?.dataset.threadId ?? '');
  if (action === 'refresh-execution-state') void refreshExecutionState();
  if (action === 'refresh-governance') void refreshGovernance();
  if (action === 'memory-action' || action === 'run-dream' || action === 'start-dream-maintenance' || action === 'stop-dream-maintenance' || action === 'plugin-action' || action === 'evolution-action') {
    if (actionElement && !actionElement.hasAttribute('disabled')) void runGovernanceAction(action, actionElement);
  }

  const entryElement = target?.closest<HTMLElement>('[data-entry-path]');
  if (entryElement) {
    const entry = model.workspace.entries.find(
      (candidate) => candidate.relativePath === entryElement.dataset.entryPath
    );
    if (entry) void openWorkspaceEntry(entry);
  }
});

// S3-02: make composer submission semantics explicit and user configurable.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && projectPickerVisible && !projectPickerBusy) {
    event.preventDefault();
    closeProjectPicker();
    return;
  }
  const target = event.target as HTMLElement;
  if (!(target instanceof HTMLTextAreaElement) || target.name !== 'prompt') return;
  const ctrlSubmit = localStorage.getItem('hmcodex.composerSubmit') === 'ctrl-enter';
  const submit = ctrlSubmit ? event.ctrlKey && event.key === 'Enter' : !event.ctrlKey && event.key === 'Enter';
  if (submit) {
    event.preventDefault();
    target.form?.requestSubmit();
  }
});

app.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.matches('[data-role="project-name"]') && projectNameDialog) {
    projectNameDialog = { ...projectNameDialog, draftName: target.value };
    projectNameError = '';
    return;
  }
  if (target.matches('[data-role="project-edit-name"]') && projectEditDialog) {
    projectEditDialog = { ...projectEditDialog, draftName: target.value, error: undefined };
    return;
  }
  if (target.matches('.settings-search')) {
    settingsSearch = target.value;
    syncSettingsView();
    return;
  }
  const memoryEditForm = target.closest<HTMLFormElement>('[data-form="memory-edit"]');
  if (memoryEditForm && memoryEditState) {
    const data = new FormData(memoryEditForm);
    memoryEditState = {
      memoryId: memoryEditForm.dataset.memoryId ?? memoryEditState.memoryId,
      statement: String(data.get('statement') ?? ''),
      scope: String(data.get('scope') ?? ''),
      confidence: String(data.get('confidence') ?? ''),
      sourceEventIds: String(data.get('sourceEventIds') ?? ''),
      sensitivity: String(data.get('sensitivity') ?? 'INTERNAL')
    };
    memoryEditError = '';
    return;
  }
  if (target.closest('[data-form="model-settings"]')) {
    captureSettingsDraft();
    settingsSaved = false;
    app.querySelector('.settings-message-success')?.remove();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && projectEditDialog) {
    event.preventDefault();
    projectEditDialog = undefined;
    render();
    return;
  }
  if (event.key === 'Escape' && projectNameDialog) {
    event.preventDefault();
    projectNameDialog = undefined;
    projectNameError = '';
    render();
    return;
  }
  if (event.key === 'Enter' && projectNameDialog && event.target instanceof HTMLInputElement && event.target.matches('[data-role="project-name"]')) {
    event.preventDefault();
    finishProjectNameDialog(projectNameDialog.draftName);
    return;
  }
  if (event.key === 'Enter' && projectEditDialog && event.target instanceof HTMLInputElement && event.target.matches('[data-role="project-edit-name"]')) {
    event.preventDefault();
    saveProjectEdit();
    return;
  }
  if (event.key === 'Tab' && settingsVisible) {
    const controls = [...document.querySelectorAll<HTMLElement>('[data-settings-dialog] button:not(:disabled), [data-settings-dialog] input:not(:disabled), [data-settings-dialog] select:not(:disabled), [data-settings-dialog] textarea:not(:disabled)')].filter((control) => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  if (event.key === 'Escape' && settingsVisible && !settingsSaving) {
    closeSettings();
  }
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;
  if (target?.dataset?.role === 'model-provider') {
    const protocol = document.querySelector<HTMLSelectElement>('[data-role="model-protocol"]');
    if (protocol) {
      protocol.value = target.value === 'deepseek'
        ? 'deepseek-harness'
        : target.value === 'openai' || target.value === 'openai-responses' ? 'responses' : 'chat-completions';
      captureSettingsDraft();
    }
    return;
  }
  if (target?.dataset?.role !== 'network-targets') return;
  const parsed = parseNetworkTargetsText(target.value);
  controlledNetworkTargets.text = target.value;
  controlledNetworkTargets.parsed = parsed.targets;
  controlledNetworkTargets.error = parsed.error;
  render();
});

app.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  if (form.matches('[data-form="memory-edit"]')) {
    event.preventDefault();
    if (!desktopBridge.isNative() || pendingMemoryActions.size > 0) return;
    if (!form.reportValidity()) return;
    const memoryId = form.dataset.memoryId;
    if (!memoryId) return;
    const data = new FormData(form);
    const sourceEventIds = [...new Set(String(data.get('sourceEventIds') ?? '').split(/[\s,]+/).map((value) => value.trim()).filter(Boolean))];
    if (sourceEventIds.length === 0 || sourceEventIds.length > 32) {
      memoryEditError = '至少提供一个来源 event ID，最多 32 个。';
      render();
      return;
    }
    const statement = String(data.get('statement') ?? '').trim();
    const scope = String(data.get('scope') ?? '').trim();
    const confidence = Number(data.get('confidence'));
    const sensitivity = String(data.get('sensitivity') ?? 'INTERNAL');
    pendingMemoryActions.add(memoryId);
    memoryEditState = undefined;
    memoryEditError = '';
    render();
    syncMemoryActionControls();
    void (async () => {
      try {
        await desktopBridge.memoryAction('edit', { memoryId, statement, scope, confidence, sourceEventIds, sensitivity });
        memoryActionsAwaitingRefresh.add(memoryId);
        await refreshGovernance();
      } catch (error) {
        memoryActionError = 'FAILED';
        update(appendErrorTimelineItem(model, '记忆编辑', error));
      } finally {
        pendingMemoryActions.delete(memoryId);
        syncMemoryActionControls();
        render();
      }
    })();
    return;
  }
  if (form.matches('[data-form="model-settings"]')) {
    event.preventDefault();
    if (settingsSaving || !desktopBridge.isNative()) return;
    captureSettingsDraft();
    const invalid = form.querySelector<HTMLInputElement>(':invalid');
    if (invalid) {
      settingsSection = invalid.closest<HTMLElement>('[data-settings-panel]')!.dataset.settingsPanel as SettingsSection;
      settingsSearch = '';
      const search = app.querySelector<HTMLInputElement>('.settings-search');
      if (search) search.value = '';
      syncSettingsView();
      invalid.reportValidity();
      return;
    }
    const data = new FormData(form);
    const optional = (name: string): string | undefined => String(data.get(name) ?? '').trim() || undefined;
    const config: ModelConfig = {
      schemaVersion: '1.0',
      provider: String(data.get('provider')) as ModelConfig['provider'],
      protocol: String(data.get('protocol')) as ModelConfig['protocol'],
      model: String(data.get('model') ?? '').trim(),
      baseURL: optional('baseURL'),
      endpoint: optional('endpoint'),
      apiKeyEnv: String(data.get('apiKeyEnv') ?? '').trim(),
      sessionHeader: optional('sessionHeader'),
      customInstructions: optional('customInstructions')
    };
    config.decision = {
      enabled: String(data.get('decisionEnabled') ?? 'true') === 'true',
      enforce: String(data.get('decisionEnabled') ?? 'true') === 'true',
      endpoint: optional('decisionEndpoint'),
      apiKeyEnv: String(data.get('decisionApiKeyEnv') ?? '').trim(),
      model: String(data.get('decisionModel') ?? '').trim(),
      timeoutMs: Number(data.get('decisionTimeoutMs') ?? 1200)
    };
    const verifierFormValues: Record<string, string> = {};
    for (const [key, value] of data.entries()) verifierFormValues[String(key)] = String(value);
    const parsedVerifier = parseVerifierFormValues(verifierFormValues);
    if (!parsedVerifier.ok) {
      settingsError = parsedVerifier.error;
      settingsSection = 'verifier';
      settingsSearch = '';
      render();
      return;
    }
    if (parsedVerifier.verifier) config.verifier = parsedVerifier.verifier;
    settingsConfig = config;
    settingsSaving = true;
    settingsError = '';
    settingsSaved = false;
    render();
    void desktopBridge.saveModelConfig(config).then(async (response) => {
      settingsConfig = response.config;
      settingsConfigPath = response.configPath;
      settingsDraft = undefined;
      settingsSaved = true;
      const snapshot = await desktopBridge.runtimeSnapshot();
      if (snapshot) model = setRuntimeReady(model, snapshot);
    }).catch((error) => {
      settingsError = compactError(error);
    }).finally(() => {
      settingsSaving = false;
      render();
    });
    return;
  }
  if (!form.matches('[data-form="composer"]')) return;
  event.preventDefault();
  const data = new FormData(form);
  const prompt = String(data.get('prompt') ?? '').trim();
  if (!prompt || !model.composer.enabled || running || workspaceChanging) return;
  historyView = undefined;
  lastSubmitReceipt = { id: `cmd-${Date.now().toString(36)}`, prompt, status: 'pending', atMs: Date.now() };
  form.reset();
  // A new run may append events to the currently selected thread. Do not
  // reuse a pre-run first page after the task completes.
  historyPageCache.clear();
  void (async () => {
    if (desktopBridge.isNative() && model.connection.state !== 'READY') {
      try {
        const snapshot = await desktopBridge.runtimeSnapshot();
        if (snapshot) update(setRuntimeReady(model, snapshot));
      } catch (error) {
        update(appendErrorTimelineItem(model, 'Cordis runtime', error));
        return;
      }
      if ((model.connection.state as string) !== 'READY') return;
    }
    await (desktopBridge.isNative() ? runCordisTask(prompt) : runMockTask(prompt));
  })();
});

render();

const runtimeEventsReady = desktopBridge.listenRuntimeEvents(applyRuntimeEvent);
void desktopBridge.listenContextSidecarStatus((status) => {
  update(setContextSidecarStatus(model, status));
});
void desktopBridge.listenDreamMaintenanceStatus((status) => {
  update(setDreamMaintenanceStatus(model, status));
});
workspaceReady = loadDefaultWorkspace();

historyStartupReady = (async () => {
  // The saved task's recent window is independent of the sidebar summary.
  // Start both reads together so first paint does not pay two cold runtime
  // launches in series. The page is still rendered incrementally below.
  const savedPage = savedNavigationThreadId();
  const savedPageRequest = savedPage
    ? loadInitialHistoryPage(savedPage).catch(() => undefined)
    : Promise.resolve(undefined);
  await Promise.all([refreshDashboard({ startup: true }), savedPageRequest]);
  await restoreSavedNavigation();
})();
void historyStartupReady.then(() => loadPageDetails());

runtimeHydrationReady = (async () => {
  try {
    const snapshot = await desktopBridge.runtimeSnapshot();
    update(setRuntimeReady(model, snapshot));
    if (desktopBridge.isNative()) {
      const recovery = await desktopBridge.reconcileRuntimeState();
      recordRecovery(recovery);
      if (recovery.reconciled > 0) {
        update(appendTimelineItem(model, {
          kind: 'STATUS',
          title: '运行状态恢复',
          body: `已回收 ${recovery.reconciled} 条上次异常退出留下的受控状态记录。未自动重放任何任务或副作用。`,
          status: 'COMPLETE'
        }));
      }
    }
  } catch (error) {
    update({
      ...model,
      connection: {
        state: 'ERROR',
        mode: 'LOCAL_RUNTIME',
        label: compactError(error)
      },
      // We are already inside the native Tauri shell when this check fails.
      // Keep the runtime identity truthful so a health-check error cannot
      // make the UI fall back to the misleading Web Preview label.
      runtime: {
        ...model.runtime,
        platform: 'WINDOWS',
        runtimeReady: false
      }
    });
    // The submit path retries the health check when the user submits after a
    // transient startup failure. Do not start a second dashboard process here.
  }
})();

// Hydrate the persistent composer metric after startup without delaying history
// or requiring the user to open the diagnostics/context panel.
void Promise.all([historyStartupReady, runtimeHydrationReady]).then(async () => {
  if (desktopBridge.isNative() && model.runtime.runtimeReady && !dashboardDetailsLoaded) await refreshDashboard();
});
