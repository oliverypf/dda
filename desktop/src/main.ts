import ArrowLeft from 'lucide/dist/esm/icons/arrow-left.mjs';
import Bot from 'lucide/dist/esm/icons/bot.mjs';
import CheckCircle2 from 'lucide/dist/esm/icons/circle-check.mjs';
import ChevronRight from 'lucide/dist/esm/icons/chevron-right.mjs';
import CircleAlert from 'lucide/dist/esm/icons/circle-alert.mjs';
import Cpu from 'lucide/dist/esm/icons/cpu.mjs';
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
import { mergeTimelinePage, projectionTimelineStatus, removeDeletedRunTimeline } from './domain/projection-status';
import { parseNetworkTargetsText } from './domain/network-targets';
import { resolveRuntimeResultIdentity } from './domain/runtime-result-identity';
import type { HarnessReadModel, ModelConfig, NetworkTargetOption, RunState, RuntimeContextSidecarStatus, RuntimeDashboardResponse, RuntimeDecisionNode, RuntimeDecisionOption, RuntimeExecutionRecord, RuntimeTaskOptions, SubAgentReadModel, TimelineItem, WorkspaceEntry } from './domain/models';
import {
  appendTimelineItem,
  applyRuntimeSubAgentEvent,
  beginRun,
  cancelPendingApprovals,
  completeStreamingAgent,
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
import { desktopBridge } from './services/desktopBridge';
import type { RuntimeEvent } from './domain/models';

type IconNode = [tag: string, attrs: Record<string, string>][];

const createIcons = ({ icons }: { icons: Record<string, IconNode> }): void => {
  document.querySelectorAll<HTMLElement>('[data-lucide]').forEach((element) => {
    replaceElement(element, { nameAttr: 'data-lucide', icons, attrs: {} });
  });
};

const app = document.querySelector<HTMLDivElement>('#app');

// Transcript 滚动状态：sticky 表示"跟随到底"。由 scroll 事件维护，
// innerHTML 全量重绘不会丢失用户的阅读位置。
let transcriptStick = true;
let transcriptScrollTop = 0;
let contextScrollTop = 0;
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
if (!app) throw new Error('Missing #app root');

let model: HarnessReadModel = createInitialReadModel();
let contextVisible = false;
let running = false;
let runtimeStreamObserved = false;
// The desktop creates a local display run id, while Cordis creates its own
// process-scoped run id. Bind the event stream after the runtime's first
// run.started event instead of comparing those unrelated identifiers.
let activeRuntimeRunId: string | undefined;
const deletedRuntimeRunIds = new Set<string>();
let runtimeEventFloorMs = 0;
let lastRuntimeEventSequence = 0;
let executionRecords: RuntimeExecutionRecord[] = [];
let projectionTimelineNextCursor: number | undefined;
let projectionTimelineHasMore = false;
let projectionTimelineLoading = false;
// Keep an approval visually pending until the runtime acknowledges it. The
// stdin write only means that the response reached the runtime; it does not
// mean that the persisted Approval/ActionIntent transition succeeded.
const pendingApprovalResolutions = new Set<string>();
// Tauri events are delivered globally. Include the run and sequence when
// de-duplicating so reconnects/re-renders cannot append the same event twice.
const observedRuntimeEvents = new Set<string>();
const controlledCapabilities = ['shell.execute', 'file.write', 'test.execute'];
const controlledCommands = ['node', 'npm', 'npx', 'cargo', 'rustc', 'git'];
// Network stays disabled until the user types an explicit allowlist. The
// runtime re-validates every request and every lease regardless of this text.
const controlledNetworkTargets = {
  text: '',
  error: '' as string,
  parsed: [] as NetworkTargetOption[]
};
let settingsVisible = false;
let settingsLoading = false;
let settingsSaving = false;
let settingsError = '';
let settingsSaved = false;
let settingsConfigPath = '';
let settingsConfig: ModelConfig | undefined;


const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

const renderSettingsModal = (): string => {
  if (!settingsVisible) return '';
  const config = settingsConfig;
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
        <header class="settings-header">
          <div><span class="eyebrow">Runtime</span><h2 id="settings-title">模型设置</h2></div>
          <button class="icon-button" type="button" data-action="close-settings" title="关闭" aria-label="关闭设置"><i data-lucide="x-circle"></i></button>
        </header>
        ${settingsLoading || !config
          ? settingsError
            ? `<div class="settings-form"><div class="settings-message settings-message-error" role="alert">${escapeHtml(settingsError)}</div><button class="secondary-button" data-action="open-settings">重试读取</button></div>`
            : '<div class="settings-loading"><i data-lucide="loader-circle" class="spin"></i><span>正在读取模型配置…</span></div>'
          : `<form class="settings-form" data-form="model-settings">
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
              <p class="settings-hint">API Key 不写入配置文件，请在启动 hmCodex 前设置上面的环境变量。已有角色绑定保持不变；绑定了独立模型的角色仍使用其指定模型。</p>
              ${settingsConfigPath ? `<p class="settings-path" title="${escapeHtml(settingsConfigPath)}">${escapeHtml(settingsConfigPath)}</p>` : ''}
              ${settingsError ? `<div class="settings-message settings-message-error" role="alert">${escapeHtml(settingsError)}</div>` : ''}
              ${settingsSaved ? '<div class="settings-message settings-message-success">配置已保存，下一次任务会使用新模型。</div>' : ''}
              <footer class="settings-actions">
                <button class="secondary-button" type="button" data-action="close-settings">取消</button>
                <button class="send-button" type="submit" ${settingsSaving || !desktopBridge.isNative() ? 'disabled' : ''}>${settingsSaving ? '保存中…' : '保存配置'}</button>
              </footer>
            </form>`}
      </section>
    </div>`;
};

const openSettings = async (): Promise<void> => {
  if (settingsLoading || settingsSaving) return;
  settingsConfig = undefined;
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
    PAUSED_UNSUPPORTED: '因不兼容暂停'
  };
  return state ? labels[state] ?? state : '等待任务';
};

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
  return labels[state];
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
}[state] ?? state);

const executionTypeLabel = (recordType: RuntimeExecutionRecord['recordType']): string => ({
  intent: 'ActionIntent',
  approval: 'Approval',
  lease: 'PolicyLease'
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
  ROLLED_BACK: '已回滚'
}[state] ?? state);

const decisionStatusLabel = (node: RuntimeDecisionNode): string => node.outcomeStatus
  ? `${node.status} · ${node.outcomeStatus}`
  : node.status;

// A candidate fanout decision carries one option per candidate. The label makes
// the outcome of each candidate explicit: only the selected one executed, the
// rest are counterfactual and must never look like they ran.
const decisionOptionLabel = (node: RuntimeDecisionNode, option: RuntimeDecisionOption): string => {
  const state = option.optionId === node.selectedOptionId
    ? '已选中'
    : (option.rejectionReasonCodes.length ? `硬淘汰 ${option.rejectionReasonCodes.join('/')}` : '未执行');
  const scores = [
    option.expectedQuality === undefined ? undefined : `质量 ${option.expectedQuality.toFixed(2)}`,
    option.expectedCost === undefined ? undefined : `成本 ${option.expectedCost}`,
    option.expectedLatencyMs === undefined ? undefined : `延迟 ${option.expectedLatencyMs}ms`
  ].filter(Boolean).join(' · ');
  return `${option.optionId} · ${state}${scores ? ` · ${scores}` : ''}`;
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
    <section class="context-section decision-trace-section" aria-label="Decision DAG">
      <div class="section-heading">
        <div><span class="section-kicker">Decision DAG</span><h3>决策图</h3></div>
        <span class="context-count">${allDecisions.length} 个决策 · ${edges.length} 条依赖</span>
      </div>
      ${decisions.length === 0
        ? '<div class="empty-note">暂无已提交决策</div>'
        : `<div class="decision-node-list">${decisions.map((node) => `
            <article class="governance-row decision-node" data-decision-id="${escapeHtml(node.decisionId)}" data-decision-status="${escapeHtml(node.status)}">
              <div class="governance-copy">
                <strong>${escapeHtml(node.decisionType ?? 'decision')} · ${escapeHtml(node.role ?? '未标注角色')}</strong>
                <span>${escapeHtml(decisionStatusLabel(node))} · ${node.optionCount} 个选项${node.selectedOptionId ? ` · 选中 ${escapeHtml(node.selectedOptionId)}` : ''}${node.stepId ? ` · ${escapeHtml(node.stepId)}` : ''}${node.agentInstanceId ? ` · ${escapeHtml(node.agentInstanceId)}` : ''}</span>
              </div>
              ${(node.options ?? []).length === 0 ? '' : `<div class="decision-option-list">${(node.options ?? []).map((option) => `<div class="runtime-line" data-decision-option="${escapeHtml(option.optionId)}"><i data-lucide="file"></i><span>${escapeHtml(decisionOptionLabel(node, option))}</span></div>`).join('')}</div>`}
              ${(node.reasonCodes ?? []).length === 0 ? '' : `<div class="decision-reason-list"><div class="runtime-line" data-decision-reason="selection"><i data-lucide="list-tree"></i><span>选择理由 ${escapeHtml((node.reasonCodes ?? []).join(' · '))}</span></div>${(node.selectionCriteria ?? []).length ? `<div class="runtime-line" data-decision-reason="criteria"><i data-lucide="file-cog"></i><span>评分口径 ${escapeHtml((node.selectionCriteria ?? []).join(' · '))}</span></div>` : ''}</div>`}
            </article>`).join('')}</div>`}
      ${edges.length === 0 ? '' : `<div class="decision-edge-list">${edges.map((edge) => `<div class="runtime-line" data-decision-edge="parent"><i data-lucide="list-tree"></i><span>${escapeHtml(edge.parentId)} → ${escapeHtml(edge.childId)}${edge.resolved ? '' : ' · 父节点不在当前窗口'}</span></div>`).join('')}</div>`}
      ${supersedes.length === 0 ? '' : `<div class="decision-edge-list">${supersedes.map((node) => `<div class="runtime-line" data-decision-edge="supersede"><i data-lucide="list-tree"></i><span>${escapeHtml(node.supersedesDecisionId ?? '')} ⊘ ${escapeHtml(node.decisionId)}</span></div>`).join('')}</div>`}
    </section>`;
};

const renderContinuousVerification = (): string => {
  const records = (model.continuousVerification ?? []).slice(-12);
  const samples = records.filter((record) => record.kind === 'CandidateVerificationSample');
  if (records.length === 0) return '';
  const completed = records.filter((record) => record.kind === 'CandidateVerificationCompleted');
  return `<section class="context-section continuous-verification-section" aria-label="Continuous verification">
    <div class="section-heading"><div><span class="section-kicker">Continuous verification</span><h3>连续验证</h3></div><span class="context-count">${completed.length} 次汇总 · ${records.length} 条样本</span></div>
    ${completed.map((record) => {
      const ranking = (record.ranking ?? []).map((item) => `${item.candidateId ?? '?'} ${typeof item.score === 'number' ? item.score.toFixed(2) : '—'}`).join(' · ');
      const config = record.config ? `重复 ${record.config.repetitions ?? '—'} · 最大比较 ${record.config.maxComparisons ?? '—'}` : '';
      const related = samples.filter((sample) => sample.stepId === record.stepId);
      const sampleText = related.map((sample) => `${sample.leftId ?? '?'}:${sample.leftScore?.toFixed(2) ?? '—'}±${sample.leftVariance?.toFixed(3) ?? '—'} vs ${sample.rightId ?? '?'}:${sample.rightScore?.toFixed(2) ?? '—'}±${sample.rightVariance?.toFixed(3) ?? '—'}`).join('；');
      return `<div class="governance-row" data-verification-event="${escapeHtml(record.eventId)}"><div class="governance-copy"><strong>${escapeHtml(record.stepId ?? 'verification')}</strong><span>${escapeHtml(config)}${ranking ? ` · 排名 ${escapeHtml(ranking)}` : ''}${sampleText ? ` · 样本 ${escapeHtml(sampleText)}` : ''}</span></div></div>`;
    }).join('')}
  </section>`;
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
  const egressCandidates = Object.entries(egress?.byCandidate ?? {})
    .map(([candidateId, bucket]) => `${candidateId} · ${bucket.calls} 次 · 预估成本 ${bucket.expectedCost ?? '未知'}（已知 ${bucket.expectedCostKnown}/${bucket.calls}） · 实际成本 ${bucket.actualCost ?? '未知'}（已知 ${bucket.actualCostKnown}/${bucket.calls}） · 失败 ${bucket.failures}`);
  return `
    <section class="context-section support-bundle-section" aria-label="Support Bundle">
      <div class="section-heading">
        <div><span class="section-kicker">Support Bundle</span><h3>诊断导出就绪度</h3></div>
        <span class="governance-state governance-state-${scan.ok ? 'active' : 'failed'}">${scan.ok ? '脱敏检查通过' : '脱敏检查失败'}</span>
      </div>
      <div class="runtime-line" data-support-bundle-scan="${scan.ok ? 'pass' : 'fail'}"><i data-lucide="shield-check"></i><span>隐私扫描 ${scan.ok ? 'PASS' : 'FAIL'} · ${scan.violations.length} 个违规</span></div>
      <div class="runtime-line"><i data-lucide="history"></i><span>${escapeHtml(bundle.evidenceSource)}</span></div>
      <div class="runtime-line"><i data-lucide="terminal-square"></i><span>${escapeHtml(bundle.exportInvocation)}</span></div>
      <div class="decision-edge-list">${counts.map((line) => `<div class="runtime-line"><i data-lucide="file"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>
      ${egress === undefined ? '' : `<div class="runtime-line" data-model-egress="total"><i data-lucide="list-tree"></i><span>出域 ${egress.recordCount} 条 · 调用 ${egress.totals.calls} · 失败 ${egress.totals.failures} · 预估成本 ${egress.totals.expectedCost ?? '未知'}（已知 ${egress.totals.expectedCostKnown}/${egress.totals.calls}） · 实际成本 ${egress.totals.actualCost ?? '未知'}（已知 ${egress.totals.actualCostKnown}/${egress.totals.calls}）</span></div>
      <div class="decision-edge-list">${egressCandidates.map((line) => `<div class="runtime-line" data-model-egress="candidate"><i data-lucide="file"></i><span>${escapeHtml(line)}</span></div>`).join('')}</div>`}
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
    if (memory.status === 'PROPOSED') {
      return `<div class="governance-actions">
        <button class="governance-button governance-button-primary" data-action="memory-action" data-operation="verify" data-accepted="true" data-memory-id="${escapeHtml(memory.memoryId)}">验证</button>
        <button class="governance-button governance-button-danger" data-action="memory-action" data-operation="verify" data-accepted="false" data-memory-id="${escapeHtml(memory.memoryId)}">拒绝</button>
      </div>`;
    }
    if (memory.status === 'VERIFIED') {
      return `<button class="governance-button governance-button-primary" data-action="memory-action" data-operation="activate" data-memory-id="${escapeHtml(memory.memoryId)}">激活</button>`;
    }
    if (memory.status === 'ACTIVE') {
      return `<button class="governance-button governance-button-danger" data-action="memory-action" data-operation="retract" data-memory-id="${escapeHtml(memory.memoryId)}">撤回</button>`;
    }
    if (['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(memory.status)) {
      return `<button class="governance-button governance-button-danger" data-action="memory-action" data-operation="delete" data-memory-id="${escapeHtml(memory.memoryId)}">删除</button>`;
    }
    return '';
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
  return `
    <section class="context-section governance-section" aria-label="治理状态">
      <div class="section-heading">
        <div><span class="section-kicker">Governance</span><h3>Memory · Dream · Plugins · Evolution</h3></div>
        <button class="icon-button small" data-action="refresh-governance" title="刷新治理状态" aria-label="刷新治理状态"><i data-lucide="rotate-ccw-clock"></i></button>
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>Feedback</strong><span>${model.feedback.length} 条</span></div>
        ${model.feedback.length === 0
          ? '<div class="empty-note">暂无已提交反馈</div>'
          : model.feedback.slice().sort((left, right) => (right.eventSequence ?? 0) - (left.eventSequence ?? 0)).slice(0, 8).map((item) => {
            const status = typeof item.outcomeStatus === 'string' ? item.outcomeStatus : 'UNKNOWN';
            const key = typeof item.scenarioKey === 'string' ? item.scenarioKey : item.feedbackId ?? item.eventId ?? '脱敏反馈';
            return '<article class="governance-row"><div class="governance-copy"><strong>' + escapeHtml(key) + '</strong><span>' + escapeHtml(status) + (item.runId ? ' · ' + escapeHtml(item.runId) : '') + '</span></div><span class="governance-state governance-state-' + escapeHtml(status.toLowerCase()) + '">' + escapeHtml(status) + '</span></article>';
          }).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>Memory</strong><span>${memories.length} 条</span></div>
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
        <div class="governance-group-heading"><strong>Dreaming</strong><span>${dreams.length} 次</span><div class="governance-actions"><button class="governance-button governance-button-primary" data-action="run-dream" ${native ? '' : 'disabled'}>运行一次</button>${maintenanceRunning ? `<button class="governance-button governance-button-danger" data-action="stop-dream-maintenance">停止后台</button>` : `<button class="governance-button" data-action="start-dream-maintenance" ${native ? '' : 'disabled'}>启动后台</button>`}</div></div>
        <div class="governance-row"><div class="governance-copy"><strong>后台维护 · ${escapeHtml(maintenanceState)}</strong><span>${escapeHtml(maintenance?.projectId ?? model.workspace.rootLabel)}${escapeHtml(maintenanceDetail)}</span></div><span class="governance-state governance-state-${escapeHtml((maintenance?.state ?? 'DISABLED').toLowerCase())}">${escapeHtml(maintenanceState)}</span></div>
        ${dreams.length === 0
          ? '<div class="empty-note">暂无 Dream run</div>'
          : dreams.map((dream) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(dream.projectId)}</strong><span>${escapeHtml(dream.phase ?? '等待阶段')} · ${escapeHtml(formatTime(dream.startedAtMs))}</span></div>
              <span class="governance-state governance-state-${escapeHtml(dream.state.toLowerCase())}">${escapeHtml(governanceStateLabel(dream.state))}</span>
            </article>`).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>Plugins</strong><span>${plugins.length} 个</span></div>
        ${plugins.length === 0
          ? '<div class="empty-note">暂无插件治理记录</div>'
          : plugins.map((plugin) => `
            <article class="governance-row">
              <div class="governance-copy"><strong>${escapeHtml(plugin.pluginId)} · ${escapeHtml(plugin.version)}</strong><span>${escapeHtml(plugin.source)}</span></div>
              <span class="governance-state governance-state-${escapeHtml(plugin.state.toLowerCase())}">${escapeHtml(governanceStateLabel(plugin.state))}</span>
              <button class="governance-button" data-action="plugin-action" data-operation="validate" data-plugin-id="${escapeHtml(plugin.pluginId)}">校验</button>
              ${plugin.state === 'QUARANTINED' ? '' : `<button class="governance-button governance-button-danger" data-action="plugin-action" data-operation="transition" data-state="QUARANTINED" data-plugin-id="${escapeHtml(plugin.pluginId)}">隔离</button>`}
            </article>`).join('')}
      </div>
      <div class="governance-group">
        <div class="governance-group-heading"><strong>Evolution</strong><span>${proposals.length} 个候选</span></div>
        <article class="governance-row">
          <div class="governance-copy"><strong>全局 Kill Switch</strong><span>${model.evolutionControl?.reason ? escapeHtml(model.evolutionControl.reason) : '未阻断'}</span></div>
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

const renderSubAgents = (): string => {
  if (model.subAgents.length === 0) return '';
  const activeCount = model.subAgents.filter((agent) => agent.state === 'STARTING' || agent.state === 'RUNNING').length;
  // 任务结束后隐藏面板，避免 sticky 面板挡住时间线里的执行结果；
  // 终态信息已由时间线事件记录，无需常驻展示。
  const runTerminal = !model.activeRun || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun.state);
  if (activeCount === 0 && runTerminal) return '';
  return `
    <section class="subagent-panel" aria-label="子 Agent 状态" aria-live="polite">
      <div class="subagent-heading">
        <div>
          <span class="eyebrow">并行执行</span>
          <h2>子 Agent</h2>
        </div>
        <span class="subagent-count">${activeCount > 0 ? `${activeCount} 个运行中` : '本次任务'}</span>
      </div>
      <div class="subagent-list">
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

const projectionTimelineItems = (
  items: NonNullable<RuntimeDashboardResponse['projection']>['timeline']
): TimelineItem[] =>
  items.map((item) => ({
    itemId: `projection-${item.eventId}`,
    runId: item.runId,
    kind: 'STATUS' as const,
    title: item.title,
    body: item.status,
    status: projectionTimelineStatus(item.status),
    createdAtMs: item.createdAtMs
  }));

const renderTimeline = (): string =>
  model.timeline
    .map(
      (item) => `
        <article class="timeline-item timeline-${item.kind.toLowerCase()}" data-status="${item.status}" data-item-id="${escapeHtml(item.itemId)}">
          <div class="timeline-marker" aria-hidden="true">
            <i data-lucide="${timelineIcon(item)}"></i>
          </div>
          <div class="timeline-content">
            <div class="timeline-meta">
              <span>${escapeHtml(item.title)}</span>
              <time>${formatTime(item.createdAtMs)}</time>
            </div>
            <div class="timeline-body">${escapeHtml(item.body).replaceAll('\n', '<br>')}</div>
            ${item.status === 'STREAMING' ? '<span class="stream-caret" aria-label="正在生成"></span>' : ''}
          </div>
        </article>`
    )
    .join('');

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

const render = (): void => {
  const focusedSetting = document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-settings-dialog]')
    ? document.activeElement as HTMLInputElement : undefined;
  const focusedName = focusedSetting?.getAttribute('name');
  const selectionStart = focusedSetting instanceof HTMLInputElement ? focusedSetting.selectionStart : null;
  const selectionEnd = focusedSetting instanceof HTMLInputElement ? focusedSetting.selectionEnd : null;
  const settingsScroll = document.querySelector('.settings-dialog')?.scrollTop ?? 0;
  const statusClass = model.connection.state === 'READY' ? 'status-ready' :
    model.connection.state === 'ERROR' ? 'status-error' : 'status-waiting';
  const workspaceTitle = model.workspace.granted ? model.workspace.rootLabel : '默认工作区';
  // Read-only is an execution policy, not an input lock.  Keep the composer
  // editable while the native runtime performs its startup health check, and
  // gate only the actual submit action on a ready connection.
  const canCompose = model.composer.enabled;
  // A slow health check must not make the composer look read-only.  The
  // submit handler below performs the readiness check before dispatching a
  // native task, so users can enter and submit a prompt during startup too.
  const canSend = canCompose;
  const taskRunning = Boolean(model.activeRun && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun.state));
  const controlled = model.composer.mode === 'CONTROLLED';
  const runtimeRoute = model.runtime.model
    ? `${model.runtime.model.provider} · ${model.runtime.model.protocol} · ${model.runtime.model.model}`
    : model.runtime.platform === 'WINDOWS' ? '模型路由未读取' : 'Web 预览无本地模型';
  const runtimeHealth = model.runtime.runtimeReady === true
    ? '健康检查通过'
    : model.runtime.platform === 'WINDOWS' ? '等待健康检查' : '演示运行时';
  const runtimeConfig = model.runtime.platform === 'WINDOWS'
    ? model.runtime.configLoaded ? '已加载用户模型配置' : '使用内置模型默认值'
    : '不读取本地模型配置';
  const contextSidecar = model.runtime.contextSidecar;
  const contextSidecarState = contextSidecarStateLabel(contextSidecar?.state);
  const contextSidecarDetail = contextSidecar?.errorCode
    ? ` · ${contextSidecar.errorCode}`
    : contextSidecar?.managed && contextSidecar.pid
      ? ` · PID ${contextSidecar.pid}`
      : '';

  app.innerHTML = `
    <div class="app-shell ${contextVisible ? 'context-open' : ''}">
      <aside class="navigation-rail" aria-label="主导航">
        <div class="brand-row">
          <div class="brand-mark">hm</div>
          <div>
            <strong>hmCodex</strong>
            <span>${model.runtime.platform === 'WINDOWS' ? 'Windows Native' : 'Web Preview'}</span>
          </div>
        </div>

        <button class="primary-action" data-action="new-task">
          <i data-lucide="plus"></i>
          <span>新建任务</span>
        </button>

        <nav class="nav-list">
          <button class="nav-item active"><i data-lucide="layout-dashboard"></i><span>工作台</span></button>
          <button class="nav-item"><i data-lucide="history"></i><span>运行记录</span></button>
          <button class="nav-item"><i data-lucide="list-tree"></i><span>工作区</span></button>
        </nav>

        <div class="nav-section-label">最近任务</div>
        <div class="thread-list">
          ${model.threads.length === 0
            ? '<div class="thread-empty">暂无已保存任务</div>'
            : model.threads.slice(0, 8).map((thread) => `
              <button class="thread-row ${thread.id === model.activeThreadId ? 'active' : ''}" data-action="select-thread" data-thread-id="${escapeHtml(thread.id)}">
                <span class="thread-title">${escapeHtml(thread.title)}</span>
                <span class="thread-meta">${thread.turnCount} 次 Turn${thread.checkpoint?.plan ? ' · 可恢复' : ''}</span>
              </button>`).join('')}
        </div>

        <div class="rail-footer">
          <button class="nav-item ${settingsVisible ? 'active' : ''}" data-action="open-settings" aria-label="模型设置"><i data-lucide="settings"></i><span>设置</span></button>
          <div class="version-label">v${escapeHtml(model.runtime.version)} · 只读阶段</div>
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
            <button class="icon-button context-toggle" data-action="toggle-context" title="上下文面板" aria-label="切换上下文面板"><i data-lucide="panel-right"></i></button>
            <button class="secondary-button" data-action="open-workspace">
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
            <span>${escapeHtml(runStateLabel(model.activeRun?.state))}</span>
          </div>
          <button class="mode-pill ${controlled ? 'mode-controlled' : ''}" data-action="toggle-mode" title="${escapeHtml(model.runtime.releaseChannel ?? '发布渠道尚未确认')}" ${model.runtime.releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' ? 'disabled' : ''}>
            <i data-lucide="shield-check"></i>${controlled ? 'CONTROLLED' : 'READ ONLY'}
          </button>
        </section>

        <section class="transcript" aria-label="任务时间线">
          <div class="transcript-inner">
            ${renderSubAgents()}
            <div class="transcript-heading">
              <div>
                <span class="eyebrow">任务时间线</span>
                <h1>${escapeHtml(model.activeRun?.title ?? 'Windows 只读工作台')}</h1>
              </div>
              ${model.activeRun && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun.state)
                ? '<button class="icon-button stop-button" data-action="cancel-run" title="取消任务" aria-label="取消任务"><i data-lucide="square"></i></button>'
                : ''}
            </div>
            <div class="timeline">${renderTimeline()}</div>
            ${renderContinuousVerification()}
            ${projectionTimelineHasMore
              ? `<div class="timeline-more"><button class="secondary-button" data-action="load-more-timeline" ${projectionTimelineLoading ? 'disabled aria-busy="true"' : ''}>${projectionTimelineLoading ? '加载中…' : '加载更早的事件'}</button></div>`
              : ''}
          </div>
        </section>

        <footer class="composer-wrap">
          <form class="composer" data-form="composer">
            <textarea name="prompt" rows="2" maxlength="8000" placeholder="${escapeHtml(model.composer.placeholder)}" ${canCompose ? '' : 'disabled'}></textarea>
            <div class="composer-bottom">
              <div class="composer-context">
                <span><i data-lucide="shield-check"></i>${controlled ? '受控执行，逐项审批' : '只读分析'}</span>
                <span class="composer-project">${escapeHtml(workspaceTitle)}</span>
              </div>
              <div class="composer-actions">
                <button class="stop-button composer-stop" type="button" data-action="cancel-run" ${taskRunning ? '' : 'disabled'} title="${taskRunning ? '取消任务' : '当前没有运行中的任务'}" aria-label="取消任务"><i data-lucide="square"></i><span>取消任务</span></button>
                <button class="send-button" type="submit" ${!taskRunning && canSend ? '' : 'disabled'} title="${taskRunning ? '任务运行中，请先取消' : '发送任务'}"><i data-lucide="send"></i><span>发送</span></button>
              </div>
            </div>
          </form>
          <p class="composer-note">${controlled ? '受控模式只允许已配置范围；每个命令或写入仍需单次审批。' : '当前版本不会执行命令、修改文件或发起外部网络操作。'}</p>
        </footer>
      </main>

      <aside class="context-panel" aria-label="上下文">
        <div class="context-header">
          <div>
            <span class="eyebrow">Context</span>
            <h2>任务上下文</h2>
          </div>
          <button class="icon-button mobile-context-close" data-action="toggle-context" title="关闭" aria-label="关闭上下文面板"><i data-lucide="x-circle"></i></button>
        </div>

        <section class="context-section workspace-section">
          <div class="section-heading">
            <div>
              <span class="section-kicker">Workspace</span>
              <h3 title="${escapeHtml(model.workspace.rootLabel)}">${escapeHtml(model.workspace.rootLabel)}</h3>
            </div>
            ${model.workspace.granted && model.workspace.currentPath
              ? '<button class="icon-button small" data-action="workspace-up" title="返回上级" aria-label="返回上级"><i data-lucide="arrow-left"></i></button>'
              : ''}
          </div>
          <div class="workspace-path">/${escapeHtml(model.workspace.currentPath)}</div>
          <div class="workspace-list">${renderWorkspaceEntries()}</div>
        </section>

        ${renderSelectedFile()}

        <section class="context-section capability-section">
          <div class="section-heading">
            <div><span class="section-kicker">Safety</span><h3>能力边界</h3></div>
          </div>
          <dl class="capability-list">
            <div><dt>发布渠道</dt><dd>${escapeHtml(model.runtime.releaseChannel ?? '尚未确认')}</dd></div>
            <div><dt>工作区读取</dt><dd class="capability-on"><i data-lucide="check-circle-2"></i>允许</dd></div>
            <div><dt>命令执行</dt><dd class="${controlled ? 'capability-on' : ''}"><i data-lucide="${controlled ? 'check-circle-2' : 'x-circle'}"></i>${controlled ? '受控' : '关闭'}</dd></div>
            <div><dt>文件写入</dt><dd class="${controlled ? 'capability-on' : ''}"><i data-lucide="${controlled ? 'check-circle-2' : 'x-circle'}"></i>${controlled ? '受控' : '关闭'}</dd></div>
            <div><dt>外部网络</dt><dd class="${controlled && controlledNetworkTargets.parsed.length ? 'capability-on' : ''}"><i data-lucide="${controlled && controlledNetworkTargets.parsed.length ? 'check-circle-2' : 'x-circle'}"></i>${controlled && controlledNetworkTargets.parsed.length ? `受控 · ${escapeHtml(controlledNetworkTargets.parsed.map((target) => target.host).join(', '))}` : '关闭'}</dd></div>
          </dl>
          ${controlled ? `
            <div class="network-target-editor">
              <label for="network-targets-input">网络目标 allowlist（JSON，留空禁用）</label>
              <input id="network-targets-input" data-role="network-targets" type="text" spellcheck="false"
                placeholder='[{"host":"api.example.com","port":443,"scheme":"https","methods":["GET"]}]'
                value="${escapeHtml(controlledNetworkTargets.text)}" />
              ${controlledNetworkTargets.error ? `<div class="network-target-error">${escapeHtml(controlledNetworkTargets.error)}</div>` : ''}
            </div>` : ''}
          ${model.approvals.filter((approval) => approval.state === 'REQUESTED').map((approval) => `
            <article class="approval-card" data-approval-id="${escapeHtml(approval.requestId)}" role="alert" aria-live="assertive">
              <div class="approval-title"><i data-lucide="circle-alert"></i><strong>需要批准一次</strong></div>
              <div class="approval-detail">${escapeHtml(approval.capability)}${approval.command ? ` · ${escapeHtml(approval.command)}` : ''}${approval.path ? ` · ${escapeHtml(approval.path)}` : ''}${approval.cwd ? ` · cwd=${escapeHtml(approval.cwd)}` : ''}${approval.host ? ` · ${escapeHtml(approval.method ?? 'GET')} ${escapeHtml(approval.scheme ?? 'https')}://${escapeHtml(approval.host)}${approval.port ? `:${approval.port}` : ''}` : ''}</div>
              <div class="approval-meta">
                ${approval.risk ? `<span class="approval-risk approval-risk-${approval.risk.toLowerCase()}">${escapeHtml(approval.risk)} 风险</span>` : ''}
                ${approval.policyVersion ? `<span>策略 ${escapeHtml(approval.policyVersion)}</span>` : ''}
                ${approval.approvalExpiresAt ? `<span>有效至 ${escapeHtml(formatTime(approval.approvalExpiresAt))}</span>` : ''}
                <span>仅本次 · Windows 受限执行器</span>
              </div>
              ${approval.scope?.snapshotDigest ? `<div class="approval-scope" title="${escapeHtml(approval.scope.snapshotDigest)}">快照 ${escapeHtml(approval.scope.snapshotDigest.slice(0, 24))}...</div>` : ''}
              ${approval.requestDigest ? `<div class="approval-scope" title="${escapeHtml(approval.requestDigest)}">动作摘要 ${escapeHtml(approval.requestDigest)}</div>` : ''}
              <div class="approval-actions">
                <button class="secondary-button" data-action="resolve-approval" data-approved="false" data-approval-id="${escapeHtml(approval.requestId)}" ${pendingApprovalResolutions.has(approval.requestId) ? 'disabled aria-busy="true"' : ''}>拒绝</button>
                <button class="primary-action approval-approve" data-action="resolve-approval" data-approved="true" data-approval-id="${escapeHtml(approval.requestId)}" ${pendingApprovalResolutions.has(approval.requestId) ? 'disabled aria-busy="true"' : ''}>${pendingApprovalResolutions.has(approval.requestId) ? '处理中…' : '批准一次'}</button>
              </div>
            </article>`).join('')}
        </section>

        <section class="context-section execution-state-section">
          <div class="section-heading">
            <div><span class="section-kicker">Execution State</span><h3>受控状态</h3></div>
            <button class="icon-button small" data-action="refresh-execution-state" title="刷新执行状态" aria-label="刷新执行状态"><i data-lucide="rotate-ccw-clock"></i></button>
          </div>
          ${executionRecords.length === 0
            ? '<div class="empty-note">暂无持久化 Intent、Approval 或 Lease</div>'
            : `<div class="execution-record-list">${executionRecords.slice(-12).reverse().map((record) => `
              <div class="execution-record">
                <div class="execution-record-heading"><strong>${executionTypeLabel(record.recordType)}</strong><span>${escapeHtml(executionStateLabel(record.state))}</span></div>
                <div class="execution-record-meta">${escapeHtml(record.capability ?? '受控能力')} · ${escapeHtml(formatTime(record.updatedAtMs))}</div>
              </div>`).join('')}</div>`}
        </section>

        ${renderGovernance()}

        ${renderDecisionTrace()}

        ${renderSupportBundle()}

        <section class="context-section runtime-section">
          <div class="section-heading"><div><span class="section-kicker">Runtime</span><h3>运行时</h3></div></div>
          <div class="runtime-line"><i data-lucide="terminal-square"></i><span>${model.runtime.platform === 'WINDOWS' ? 'Windows native' : 'Web preview'}</span></div>
          <div class="runtime-line"><i data-lucide="heart-pulse"></i><span>${escapeHtml(runtimeHealth)}</span></div>
          <div class="runtime-line"><i data-lucide="cpu"></i><span title="${escapeHtml(runtimeRoute)}">${escapeHtml(runtimeRoute)}</span></div>
          <div class="runtime-line"><i data-lucide="file-cog"></i><span>${escapeHtml(runtimeConfig)}</span></div>
          <div class="runtime-line"><i data-lucide="panel-right"></i><span title="${escapeHtml(contextSidecar?.state ?? 'UNKNOWN')}">OpenViking Context · ${escapeHtml(contextSidecarState)}${escapeHtml(contextSidecarDetail)}</span></div>
          <div class="runtime-line"><i data-lucide="gauge"></i><span>Projection ${model.projectionVersion}</span></div>
        </section>
      </aside>
    </div>
    ${renderSettingsModal()}`;

  const settingsDialog = document.querySelector<HTMLElement>('[data-settings-dialog]');
  if (settingsDialog) {
    settingsDialog.scrollTop = settingsScroll;
    const field = focusedName ? [...settingsDialog.querySelectorAll<HTMLInputElement>('[name]')].find((item) => item.name === focusedName) : undefined;
    field?.focus({ preventScroll: true });
    if (field instanceof HTMLInputElement && selectionStart !== null && selectionEnd !== null) field.setSelectionRange(selectionStart, selectionEnd);
    if (!field && !focusedSetting) settingsDialog.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  createIcons({
    icons: {
      ArrowLeft,
      Bot,
      CheckCircle2,
      ChevronRight,
      CircleAlert,
      Cpu,
      File,
      FileCog,
      Folder,
      FolderOpen,
      Gauge,
      HeartPulse,
      History,
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

const renderWithFallback = (): void => {
  try {
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
    renderWithFallback();
  });
};

// Streaming deltas only change one timeline row. Rebuilding the whole
// document (and re-running createIcons) on every delta makes the window
// visibly jitter, so patch the row's text in place and let the normal render
// path finalize it when the turn completes.
let streamingFrame: number | undefined;
let pendingStreamingItemId: string | undefined;
const scheduleStreamingUpdate = (itemId: string): void => {
  pendingStreamingItemId = itemId;
  if (streamingFrame !== undefined) return;
  streamingFrame = window.requestAnimationFrame(() => {
    streamingFrame = undefined;
    const targetId = pendingStreamingItemId;
    pendingStreamingItemId = undefined;
    if (!targetId) return;
    const item = model.timeline.find((entry) => entry.itemId === targetId);
    const element = [...document.querySelectorAll<HTMLElement>('[data-item-id]')]
      .find((candidate) => candidate.dataset.itemId === targetId);
    if (!item || !element) {
      renderWithFallback();
      return;
    }
    const body = element.querySelector<HTMLElement>('.timeline-body');
    if (body) body.innerHTML = escapeHtml(item.body).replaceAll('\n', '<br>');
    const caret = element.querySelector('.stream-caret');
    if (item.status === 'STREAMING' && !caret) {
      body?.insertAdjacentHTML('afterend', '<span class="stream-caret" aria-label="正在生成"></span>');
    } else if (item.status !== 'STREAMING' && caret) {
      caret.remove();
    }
    const transcript = document.querySelector<HTMLElement>('.transcript');
    if (transcript && transcriptStick) transcript.scrollTop = transcript.scrollHeight;
  });
};

const update = (next: HarnessReadModel, { coalesce = false }: { coalesce?: boolean } = {}): void => {
  model = next;
  if (coalesce) {
    scheduleRender();
    return;
  }
  renderWithFallback();
};

const refreshExecutionState = async (): Promise<void> => {
  try {
    executionRecords = await desktopBridge.listExecutionState();
    render();
  } catch (error) {
    update(appendErrorTimelineItem(model, '执行状态', error));
  }
};

const refreshDashboard = async (): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  try {
    const [dashboard, contextSidecar, dreamMaintenance] = await Promise.all([
      desktopBridge.runtimeDashboard(),
      desktopBridge.contextSidecarStatus(),
      desktopBridge.dreamMaintenanceStatus()
    ]);
    if (!dashboard) return;
    for (const runId of dashboard.deletedRunIds ?? []) deletedRuntimeRunIds.add(runId);
    executionRecords = dashboard.execution.records;
    const projectedTimeline = dashboard.projection
      ? projectionTimelineItems(dashboard.projection.timeline)
      : undefined;
    projectionTimelineNextCursor = dashboard.projection?.timelinePage?.nextCursor;
    projectionTimelineHasMore = dashboard.projection?.timelinePage?.hasMore ?? false;
    const timeline = projectedTimeline
      ? [...model.timeline.filter((item) => !item.itemId.startsWith('projection-')), ...projectedTimeline]
      : model.timeline;
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
      evolutionProposals: dashboard.evolution.proposals,
      evolutionReports: dashboard.evolution.reports,
      evolutionControl: dashboard.evolution.control,
      decisions: dashboard.projection?.decisions ?? [],
      ...(dashboard.supportBundle ? { supportBundle: dashboard.supportBundle } : {}),
      ...(dashboard.modelEgress ? { modelEgress: dashboard.modelEgress } : {}),
      timeline: removeDeletedRunTimeline(timeline, [...deletedRuntimeRunIds]),
      projectionVersion: dashboard.projection?.projectionVersion ?? model.projectionVersion + 1
    });
  } catch (error) {
    update(appendErrorTimelineItem(model, '启动状态', error));
  }
};

const refreshGovernance = async (): Promise<void> => {
  if (!desktopBridge.isNative()) return;
  try {
    const [memories, dreamRuns, plugins, evolution, dreamMaintenance, dashboard] = await Promise.all([
      desktopBridge.listMemories(),
      desktopBridge.listDreamRuns(),
      desktopBridge.listPluginGovernance(),
      desktopBridge.listEvolution(),
      desktopBridge.dreamMaintenanceStatus(),
      desktopBridge.runtimeDashboard()
    ]);
    update({
      ...model,
      projectionVersion: model.projectionVersion + 1,
      memories,
      dreamRuns,
      plugins,
      evolutionProposals: evolution.proposals,
      evolutionReports: evolution.reports,
      ...(dashboard ? { evolutionControl: dashboard.evolution.control } : {}),
      ...(dashboard ? { feedback: dashboard.feedback } : {}),
      ...(dashboard?.projection?.decisions ? { decisions: dashboard.projection.decisions } : {}),
      ...(dashboard?.projection?.continuousVerification ? { continuousVerification: dashboard.projection.continuousVerification } : {}),
      ...(dashboard?.supportBundle ? { supportBundle: dashboard.supportBundle } : {}),
      ...(dashboard?.modelEgress ? { modelEgress: dashboard.modelEgress } : {}),
      runtime: dreamMaintenance ? { ...model.runtime, dreamMaintenance } : model.runtime
    });
  } catch (error) {
    update(appendErrorTimelineItem(model, '治理状态', error));
  }
};

const runGovernanceAction = async (action: string, element: HTMLElement): Promise<void> => {
  try {
    if (action === 'memory-action') {
      const memoryId = element.dataset.memoryId;
      const operation = element.dataset.operation as 'verify' | 'activate' | 'retract' | undefined;
      const accepted = element.dataset.accepted === undefined ? undefined : element.dataset.accepted === 'true';
      if (memoryId && operation) await desktopBridge.memoryAction(operation, { memoryId, accepted });
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
    update(appendErrorTimelineItem(model, '治理操作', error));
  }
};

const runtimeEventText = (event: RuntimeEvent): string => {
  const payload = event.payload;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.name === 'string') {
    if (payload.ok === false) return `${payload.name} 失败`;
    if (payload.kind === 'tool.call_requested') return `${payload.name} 执行中`;
    return payload.name;
  }
  if (typeof payload.errorCode === 'string') return payload.errorCode;
  return event.kind;
};

const replayEventTimelineItem = (event: RuntimeEvent): TimelineItem | undefined => {
  const payload = event.payload ?? {};
  const text = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const digestSuffix = (value: unknown) => typeof value === 'string' && value.length > 18 ? ` · ${value.slice(0, 18)}...` : '';
  const persistedKind = typeof payload.persistedKind === 'string' ? payload.persistedKind : event.kind;
  const common = {
    itemId: `replay-${event.eventId ?? `${event.runId}-${event.sequence}`}`,
    createdAtMs: Number.isFinite(event.emittedAtMs) ? event.emittedAtMs : Date.now()
  };
  switch (persistedKind) {
    case 'TaskRunCreated':
      return { ...common, kind: 'STATUS', title: '任务已创建', body: '已恢复该次任务的结构化运行记录。', status: 'COMPLETE' };
    case 'RunStateChanged':
      return {
        ...common,
        kind: 'STATUS',
        title: '运行状态',
        body: `${text(payload.from, 'UNKNOWN')} -> ${text(payload.to, 'UNKNOWN')}`,
        status: 'COMPLETE'
      };
    case 'ModelRouteResolved':
      return {
        ...common,
        kind: 'STATUS',
        title: '模型路由',
        body: [text(payload.provider, 'unknown'), text(payload.protocol, 'unknown'), text(payload.model, 'unknown')].join(' · '),
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
        body: `${text(payload.stepId, 'unknown')} · ${text(payload.to, text(payload.status, 'UPDATED'))}`,
        status: 'COMPLETE'
      };
    case 'ToolCallRequested':
      return {
        ...common,
        kind: 'STATUS',
        title: '工具调用',
        body: text(payload.toolName, text(payload.name, '受控工具')),
        status: 'COMPLETE'
      };
    case 'ToolInvocationCompleted':
      return {
        ...common,
        kind: 'STATUS',
        title: '工具结果',
        body: `${text(payload.toolName, text(payload.name, '受控工具'))} · ${text(payload.status, payload.ok === false ? 'FAILED' : 'COMPLETED')}`,
        status: payload.ok === false ? 'ERROR' : 'COMPLETE'
      };
    case 'VerificationCompleted':
      return {
        ...common,
        kind: payload.status === 'FAIL' ? 'ERROR' : 'STATUS',
        title: '验证结果',
        body: `${text(payload.status, 'UNKNOWN')} · ${text(payload.summary, '未提供摘要')}`,
        status: payload.status === 'FAIL' ? 'ERROR' : 'COMPLETE'
      };
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
      return {
        ...common,
        kind: 'STATUS',
        title: '任务完成',
        body: `已完成${digestSuffix(payload.outputDigest)}`,
        status: 'COMPLETE'
      };
    case 'TaskRunFailed':
      return {
        ...common,
        kind: 'ERROR',
        title: '任务失败',
        body: text(payload.code, '运行时失败'),
        status: 'ERROR'
      };
    case 'RecoveryStarted':
    case 'DiagnosisRequested':
      return {
        ...common,
        kind: 'STATUS',
        title: persistedKind === 'RecoveryStarted' ? '恢复任务' : '诊断任务',
        body: text(payload.status, text(payload.reason, persistedKind)),
        status: 'COMPLETE'
      };
    default:
      return undefined;
  }
};

const replayThreadEvents = (base: HarnessReadModel, events: RuntimeEvent[]): HarnessReadModel => {
  const items = events
    .slice()
    .sort((left, right) => (left.emittedAtMs - right.emittedAtMs) || (left.sequence - right.sequence))
    .map(replayEventTimelineItem)
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const seen = new Set<string>();
  const uniqueItems = items.filter((item) => {
    const key = item.itemId ?? `${item.createdAtMs}-${item.title}-${item.body}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...base,
    projectionVersion: base.projectionVersion + 1,
    timeline: [...base.timeline.filter((item) => item.itemId === 'welcome'), ...uniqueItems]
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
      ? String(payload.taskClass ?? 'unknown')
      : event.kind === 'task.prechecked'
        ? `${String(payload.status ?? 'UNKNOWN')} · ${String(payload.reason ?? '')}`
        : event.kind === 'route.selected'
          ? `${String(payload.taskClass ?? 'unknown')} · ${String(payload.reason ?? '')}`
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
    scheduleStreamingUpdate(streamId);
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
      body: `${typeof payload.capability === 'string' ? payload.capability : '受控操作'} 请求一次性授权`,
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
        ...(typeof payload.leaseId === 'string' ? { leaseId: payload.leaseId } : {}),
        ...(typeof payload.expiresAt === 'number' ? { leaseExpiresAt: payload.expiresAt } : {}),
        ...(typeof payload.policyVersion === 'string' ? { policyVersion: payload.policyVersion } : {})
      }));
    }
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: 'PolicyLease 已签发',
      body: `${typeof payload.capability === 'string' ? payload.capability : '受控操作'} · 仅本次`,
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
    pendingApprovalResolutions.clear();
    // A killed runtime may flush a buffered failure event after the user
    // cancellation has already been acknowledged. Preserve the user's
    // terminal cancellation state instead of regressing it to FAILED.
    if ((model.activeRun?.state as string | undefined) === 'CANCELLED') return;
    update(appendErrorTimelineItem(
      cancelPendingApprovals(setRunState(model, 'FAILED')),
      'Cordis runtime',
      runtimeEventText(event)
    ));
    return;
  }
  if (event.kind === 'action_intent.created') {
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: 'ActionIntent',
      body: `${typeof payload.capability === 'string' ? payload.capability : '受控操作'} 已进入审批状态`,
      status: 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'lease.issued' || event.kind === 'lease.claimed' || event.kind === 'lease.consumed') {
    const labels: Record<string, string> = {
      'lease.issued': 'PolicyLease 已签发',
      'lease.claimed': 'PolicyLease 已领取',
      'lease.consumed': 'PolicyLease 已消费'
    };
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: labels[event.kind],
      body: `${typeof payload.capability === 'string' ? payload.capability : '受控操作'}${payload.ok === false ? ' · 失败' : ''}`,
      status: payload.ok === false ? 'ERROR' : 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'model.route_resolved') {
    update(appendTimelineItem(model, {
      itemId: `runtime-${eventKey}`,
      kind: 'STATUS',
      title: '模型路由',
      body: [payload.provider, payload.protocol, payload.model].filter((value): value is string => typeof value === 'string').join(' · ') || '模型路由已解析',
      status: 'COMPLETE'
    }));
    return;
  }
  if (event.kind === 'tool.call_requested' || event.kind === 'tool.result' || event.kind === 'workspace.snapshot') {
    const title = event.kind === 'tool.call_requested' ? '工具调用' : event.kind === 'tool.result' ? '工具结果' : '工作区快照';
    if (event.kind === 'tool.result' && payload.ok === false) {
      update(appendErrorTimelineItem(model, title, runtimeEventText(event)));
    } else {
      update(appendTimelineItem(model, {
        kind: event.kind === 'workspace.snapshot' ? 'WORKSPACE' : 'STATUS',
        title,
        body: runtimeEventText(event),
        status: 'COMPLETE'
      }));
    }
  }
};

const openWorkspace = async (): Promise<void> => {
  try {
    const grant = await desktopBridge.chooseWorkspace();
    const entries = await desktopBridge.listWorkspace('');
    let next = setWorkspace(model, grant.rootLabel, '', entries);
    next = appendTimelineItem(next, {
      kind: 'WORKSPACE',
      title: '工作区授权',
      body: `已以只读方式打开 ${grant.rootLabel}`,
      status: 'COMPLETE'
    });
    update(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('cancelled')) return;
    update(appendErrorTimelineItem(model, '工作区', `无法打开工作区：${compactError(error)}`));
  }
};

const loadDefaultWorkspace = async (): Promise<void> => {
  if (!desktopBridge.isNative() || model.workspace.granted) return;
  try {
    const grant = await desktopBridge.defaultWorkspace();
    if (!grant) return;
    const entries = await desktopBridge.listWorkspace('');
    let next = setWorkspace(model, grant.rootLabel, '', entries);
    next = appendTimelineItem(next, {
      kind: 'WORKSPACE',
      title: '默认工作区',
      body: `已自动使用 ${grant.rootLabel} 作为只读工作区。需要切换目录时可点击“打开项目”。`,
      status: 'COMPLETE'
    });
    update(next);
  } catch (error) {
    update(appendErrorTimelineItem(model, '默认工作区', error));
  }
};

const openWorkspaceEntry = async (entry: WorkspaceEntry): Promise<void> => {
  try {
    if (entry.kind === 'DIRECTORY') {
      const entries = await desktopBridge.listWorkspace(entry.relativePath);
      update(setWorkspace(model, model.workspace.rootLabel, entry.relativePath, entries));
      return;
    }
    const file = await desktopBridge.readWorkspaceFile(entry.relativePath);
    update(setWorkspaceFile(model, file));
  } catch (error) {
    update(appendErrorTimelineItem(model, '文件读取', error));
  }
};

const workspaceUp = async (): Promise<void> => {
  const current = model.workspace.currentPath;
  const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  const entries = await desktopBridge.listWorkspace(parent);
  update(setWorkspace(model, model.workspace.rootLabel, parent, entries));
};

const selectThread = async (threadId: string): Promise<void> => {
  if (running || !threadId) return;
  try {
    const thread = await desktopBridge.getThread(threadId);
    if (!thread) return;
    const events = await desktopBridge.listThreadEvents(thread.id);
    const threadSummary = {
      ...thread,
      turnCount: thread.turns.length
    };
    let next = setThreads(model, model.threads.map((item) => item.id === thread.id ? threadSummary : item));
    next = setActiveThread(next, thread.id, Boolean(thread.checkpoint?.plan));
    next = {
      ...next,
      activeRun: undefined,
      composer: { ...next.composer, enabled: true }
    };
    next = replayThreadEvents(next, events);
    next = appendTimelineItem(next, {
      kind: 'STATUS',
      title: 'Thread 已恢复',
      body: `${thread.title}，已有 ${thread.turns.length} 次 Turn 摘要。${thread.checkpoint?.plan ? '检测到未完成 checkpoint，下一次提交会从断点恢复。' : '下一次任务会继续使用这个 Thread。'}`,
      status: 'COMPLETE'
    });
    update(next);
  } catch (error) {
    update(appendErrorTimelineItem(model, 'Thread 恢复', error));
  }
};

const runMockTask = async (prompt: string): Promise<void> => {
  if (running) return;
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
    Boolean(model.activeRun?.runId === runId && model.activeRun.state !== 'CANCELLED');

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
  }
};

const runCordisTask = async (prompt: string): Promise<void> => {
  if (running) return;
  // Acquire the local run lock before awaiting event subscription setup. A
  // rapid double-submit during startup must not create two overlapping
  // runtime children or let the second display run replace the first.
  running = true;
  // Ensure the native event subscription is installed before spawning the
  // runtime child. This prevents losing the first streamed delta or approval
  // request when a user submits immediately after application launch.
  try {
    await runtimeEventsReady;
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
    Boolean(model.activeRun?.runId === runId && model.activeRun.state !== 'CANCELLED'
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
    if (model.activeThreadId) {
      taskOptions.threadId = model.activeThreadId;
      if (model.resumeThreadId === model.activeThreadId) taskOptions.resume = true;
    }
    const result = await desktopBridge.runModelTask(prompt, undefined, taskOptions);
    // A completed bridge promise may belong to a cancelled/replaced UI run.
    // Do not let that response rebind the new run's runtime identity.
    if (!isCurrentRunActive()) return;
    {
      const identity = resolveRuntimeResultIdentity(activeRuntimeRunId, result.runId, deletedRuntimeRunIds);
      activeRuntimeRunId = identity.runId;
      if (identity.deleted) return;
    }
    await refreshExecutionState();
    await refreshGovernance();
    if (!isCurrentRunActive()) return;
    if (!result.ok) {
      next = upsertSubAgent(model, { agentId: workspaceAgentId, task: 'workspace snapshot 未能提交', state: 'FAILED' });
      next = upsertSubAgent(next, { agentId: modelAgentId, task: result.error, state: 'FAILED' });
      next = upsertSubAgent(next, { agentId: summaryAgentId, task: '未生成结果', state: 'CANCELLED' });
      next = appendErrorTimelineItem(setRunState(next, 'FAILED'), 'Cordis runtime', result.error);
      update(next);
      return;
    }

    next = upsertSubAgent(model, { agentId: workspaceAgentId, task: `snapshot 已提交（${result.workspace.entryCount ?? 0} 项）`, state: 'SUCCEEDED' });
    next = setActiveThread(next, result.threadId);
    next = setThreads(next, [result.thread, ...model.threads.filter((thread) => thread.id !== result.thread.id)]);
    const modelSummary = result.model
      ? `${result.model.provider} · ${result.model.protocol} · ${result.model.model}`
      : '模型配置未返回';
    next = upsertSubAgent(next, { agentId: modelAgentId, task: `流式响应已完成（${modelSummary}）`, state: 'SUCCEEDED' });
    next = upsertSubAgent(next, { agentId: summaryAgentId, task: '整理模型结果', state: 'RUNNING' });
    next = setRunState(next, 'VERIFYING');
    update(next);

    if (!runtimeStreamObserved) {
      const streamId = `${runId}-response`;
      for (let index = 0; index < result.text.length; index += 3) {
        if (!isCurrentRunActive()) return;
        // Advance the local projection on every chunk. Reusing the original
        // `next` snapshot would replace the body each time and leave only the
        // final three characters visible for non-streaming providers.
        next = upsertStreamingAgent(next, streamId, result.text.slice(index, index + 3), false, activeRuntimeRunId);
        update(next, { coalesce: true });
        await new Promise((resolve) => window.setTimeout(resolve, 14));
      }
      if (!isCurrentRunActive()) return;
      next = completeStreamingAgent(next, streamId);
    } else {
      next = next;
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
    if (result.verification?.semantic) {
      const semantic = result.verification.semantic;
      const identity = semantic.modelIdentity
        ? Object.values(semantic.modelIdentity).filter((value) => typeof value === 'string' && value.trim()).join(' · ')
        : '';
      const evidence = semantic.evidenceRefs?.length ? semantic.evidenceRefs.join(', ') : '无';
      const failures = semantic.failureCodes?.length ? semantic.failureCodes.join(', ') : '';
      next = appendTimelineItem(next, {
        kind: 'STATUS',
        title: '语义 Verifier 证据',
        body: [
          `Verdict ${semantic.status}`,
          semantic.summary,
          identity ? `模型身份 ${identity}` : undefined,
          `证据 ${evidence}`,
          failures ? `失败码 ${failures}` : undefined
        ].filter(Boolean).join(' · '),
        status: semantic.status === 'PASS' ? 'COMPLETE' : semantic.status === 'FAIL' ? 'ERROR' : 'PENDING'
      });
    }
    update(setRunState(next, 'SUCCEEDED'));
  } catch (error) {
    if (!isCurrentRunActive()) return;
    const message = error instanceof Error ? error.message : String(error);
    const compactMessage = compactError(message);
    next = upsertSubAgent(model, { agentId: modelAgentId, task: compactMessage, state: 'FAILED' });
    update(appendErrorTimelineItem(setRunState(next, 'FAILED'), 'Cordis runtime', compactMessage));
  } finally {
    running = false;
    // A native cancellation acknowledges taskkill before the blocking
    // runtime reader has necessarily drained and cleared its process state.
    // Keep the composer disabled until this invocation has actually returned,
    // then release it for the next task.
    if (model.activeRun?.runId === runId && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun.state) && !model.composer.enabled) {
      update({ ...model, composer: { ...model.composer, enabled: true }, projectionVersion: model.projectionVersion + 1 });
    }
  }
};

app.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  if (target.classList.contains('settings-backdrop') && !settingsSaving) {
    settingsVisible = false;
    settingsError = '';
    settingsSaved = false;
    render();
    return;
  }
  const actionElement = target.closest<HTMLElement>('[data-action]');
  const action = actionElement?.dataset.action;
  if (action === 'open-workspace') void openWorkspace();
  if (action === 'open-settings') void openSettings();
  if (action === 'close-settings' && !settingsSaving) {
    settingsVisible = false;
    settingsError = '';
    settingsSaved = false;
    render();
  }
  if (action === 'toggle-mode' && !running && model.runtime.releaseChannel !== 'WINDOWS_PHASE1_READ_ONLY') {
    update(setExecutionMode(model, model.composer.mode === 'READ_ONLY' ? 'CONTROLLED' : 'READ_ONLY'));
  }
  if (action === 'resolve-approval') {
    const requestId = actionElement?.dataset.approvalId ?? '';
    const approval = model.approvals.find((item) => item.requestId === requestId);
    const approved = actionElement?.dataset.approved === 'true';
    if (approval && requestId && !pendingApprovalResolutions.has(requestId)) {
      pendingApprovalResolutions.add(requestId);
      render();
      void desktopBridge.resolveRuntimeApproval(requestId, approved, approval.requestDigest).catch((error) => {
        pendingApprovalResolutions.delete(requestId);
        update(appendErrorTimelineItem(model, '审批回执', error));
      });
    }
  }
  if (action === 'toggle-context') {
    contextVisible = !contextVisible;
    render();
  }
  if (action === 'cancel-run') {
    void (async () => {
      const cancelRunId = model.activeRun?.runId;
      if (!cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun?.state ?? '')) return;
      try {
        const cancellation = desktopBridge.isNative()
          ? await desktopBridge.cancelModelTask()
          : { cancelled: true };
        if (!cancellation.cancelled) {
          if (model.activeRun?.runId !== cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun?.state ?? '')) return;
          update(appendErrorTimelineItem(model, '运行时取消', '当前没有可取消的 Cordis runtime 任务'));
          return;
        }
        // A terminal event can be delivered while the native cancel command
        // is waiting for taskkill. Never regress that authoritative outcome
        // to CANCELLED, and never mutate a newer run.
        if (model.activeRun?.runId !== cancelRunId || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(model.activeRun?.state ?? '')) return;
        pendingApprovalResolutions.clear();
        const cancelled = cancelPendingApprovals(setRunState(model, 'CANCELLED'));
        update(appendTimelineItem({
          ...cancelled,
          // The runtime reader still owns the old child until its await
          // returns. Keep submission blocked to prevent overlapping native
          // runs; Web Mock has no child process and can be reused immediately.
          composer: { ...cancelled.composer, enabled: desktopBridge.isNative() ? false : cancelled.composer.enabled }
        }, {
          kind: 'STATUS',
          title: '运行控制',
          body: '任务已由用户取消。只读运行没有产生外部副作用。',
          status: 'COMPLETE'
        }));
      } catch (error) {
        update(appendErrorTimelineItem(model, '运行时取消', error));
      }
    })();
  }
  if (action === 'new-task') {
    if (running) return;
    let next: HarnessReadModel = { ...model, activeRun: undefined, composer: { ...model.composer, enabled: true } };
    next = setActiveThread(next, undefined);
    update(next);
  }
  if (action === 'workspace-up') void workspaceUp();
  if (action === 'select-thread') void selectThread(actionElement?.dataset.threadId ?? '');
  if (action === 'refresh-execution-state') void refreshExecutionState();
  if (action === 'refresh-governance') void refreshGovernance();
  if (action === 'load-more-timeline' && !projectionTimelineLoading && projectionTimelineNextCursor !== undefined) {
    void (async () => {
      const cursor = projectionTimelineNextCursor;
      projectionTimelineLoading = true;
      render();
      try {
        const page = await desktopBridge.runtimeTimelinePage(cursor as number, 200);
        if (!page) return;
        const merged = mergeTimelinePage(model.timeline, projectionTimelineItems(page.items));
        projectionTimelineNextCursor = page.nextCursor;
        projectionTimelineHasMore = page.hasMore;
        update({ ...model, timeline: merged });
      } catch (error) {
        update(appendErrorTimelineItem(model, '加载时间线', error));
      } finally {
        projectionTimelineLoading = false;
        render();
      }
    })();
  }
  if (action === 'memory-action' || action === 'run-dream' || action === 'start-dream-maintenance' || action === 'stop-dream-maintenance' || action === 'plugin-action' || action === 'evolution-action') {
    if (actionElement && !actionElement.hasAttribute('disabled')) void runGovernanceAction(action, actionElement);
  }

  const entryElement = target.closest<HTMLElement>('[data-entry-path]');
  if (entryElement) {
    const entry = model.workspace.entries.find(
      (candidate) => candidate.relativePath === entryElement.dataset.entryPath
    );
    if (entry) void openWorkspaceEntry(entry);
  }
});

app.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.closest('[data-form="model-settings"]') && settingsConfig) {
    Object.assign(settingsConfig, { [target.name]: target.value });
    settingsSaved = false;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && settingsVisible) {
    const controls = [...document.querySelectorAll<HTMLElement>('[data-settings-dialog] button:not(:disabled), [data-settings-dialog] input:not(:disabled), [data-settings-dialog] select:not(:disabled)')];
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
    settingsVisible = false;
    render();
    document.querySelector<HTMLElement>('[data-action="open-settings"]')?.focus();
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
      if (settingsConfig) settingsConfig.protocol = protocol.value as ModelConfig['protocol'];
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
  if (form.matches('[data-form="model-settings"]')) {
    event.preventDefault();
    if (settingsSaving || !desktopBridge.isNative()) return;
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
      sessionHeader: optional('sessionHeader')
    };
    settingsConfig = config;
    settingsSaving = true;
    settingsError = '';
    settingsSaved = false;
    render();
    void desktopBridge.saveModelConfig(config).then(async (response) => {
      settingsConfig = response.config;
      settingsConfigPath = response.configPath;
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
  if (!prompt || !model.composer.enabled) return;
  form.reset();
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
void loadDefaultWorkspace();

void desktopBridge.runtimeSnapshot()
  .then(async (snapshot) => {
    update(setRuntimeReady(model, snapshot));
    if (!desktopBridge.isNative()) return;
    const recovery = await desktopBridge.reconcileRuntimeState();
    if (recovery.reconciled > 0) {
      update(appendTimelineItem(model, {
        kind: 'STATUS',
        title: '运行状态恢复',
        body: `已回收 ${recovery.reconciled} 条上次异常退出留下的受控状态记录。未自动重放任何任务或副作用。`,
        status: 'COMPLETE'
      }));
    }
    await refreshDashboard();
  })
  .catch((error) => {
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
    void refreshDashboard();
  });
