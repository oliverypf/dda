import type {
  ApprovalReadModel,
  CellsAvailabilityReadModel,
  CellsSessionReadModel,
  TimelineItem
} from './models';

export const CELLS_BADGE_TEXT = '无 OS 沙箱 · 以当前用户权限运行';
export const CELLS_SESSION_BANNER_TEXT = '无 OS 沙箱';
export const CELLS_CONFIRM_TEXT = '不是安全沙箱，代码以你的 Windows 用户权限运行；Node vm 也不是安全边界';
export const CELLS_TOGGLE_LABEL = '实验性：代码 cell（无 OS 沙箱）';
export const CELLS_SESSION_KEEP_HINT = '需要会话保持模式';
export const CELLS_UNKNOWN_TITLE = '结果不确定（进程中断）';
export const CELLS_RESET_TITLE = 'cell 环境已重置，变量已丢失';
export const CELLS_RUNNING_LABEL = '运行中';
export const CELL_CODE_PREVIEW_LIMIT = 240;
export const CELL_APPROVAL_TTL_MS = 120_000;

const FRESH_HEALTH_REASONS = new Set(['NODE_TOO_OLD', 'DESKTOP_SESSION_KEEP_REQUIRED']);
const LIVE_SESSION_REASONS = new Set([
  'KERNEL_NOT_ATTACHED',
  'JOURNAL_UNAVAILABLE',
  'WINDOWS_DESKTOP_CELLS_REQUIRED'
]);

export interface DesktopCellsSettings {
  experimentalCodeCells: boolean;
}

export const defaultDesktopCellsSettings = (): DesktopCellsSettings => ({
  experimentalCodeCells: false
});

export const parseDesktopCellsSettings = (raw: unknown): DesktopCellsSettings => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultDesktopCellsSettings();
  const value = (raw as { experimentalCodeCells?: unknown }).experimentalCodeCells;
  return { experimentalCodeCells: value === true };
};

/** Badge only when the payload itself carries both worker READY fields. */
export const showsWindowsNoOsSandboxBadge = (payload: {
  warning?: string;
  sandbox?: string;
} | undefined): boolean =>
  payload?.warning === 'WINDOWS_NO_OS_SANDBOX' && payload.sandbox === 'none';

export const showsCellsSessionBanner = (session: CellsSessionReadModel | undefined): boolean =>
  session?.available === true && session.reason === 'WINDOWS_NO_OS_SANDBOX';

export const truncateCellCode = (code: string): string =>
  code.length <= CELL_CODE_PREVIEW_LIMIT ? code : `${code.slice(0, CELL_CODE_PREVIEW_LIMIT)}…`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

export const sandboxBadgeHtml = (payload: { warning?: string; sandbox?: string } | undefined): string =>
  showsWindowsNoOsSandboxBadge(payload)
    ? `<p class="cells-no-sandbox-badge" role="status">${CELLS_BADGE_TEXT}</p>`
    : '';

export const sessionBannerHtml = (session: CellsSessionReadModel | undefined): string =>
  showsCellsSessionBanner(session)
    ? `<div class="cells-session-banner" role="status" data-cells-session-banner>${CELLS_SESSION_BANNER_TEXT}</div>`
    : '';

const reasonText: Record<string, string> = {
  NODE_TOO_OLD: '当前 Node 低于 24，代码 cell 不可用',
  DESKTOP_SESSION_KEEP_REQUIRED: CELLS_SESSION_KEEP_HINT,
  KERNEL_NOT_ATTACHED: '会话保持进程尚未 attach',
  JOURNAL_UNAVAILABLE: 'journal 不可写',
  WINDOWS_DESKTOP_CELLS_REQUIRED: '尚未确认桌面代码 cell',
  WINDOWS_UNSANDBOXED_REQUIRED: '缺少无沙箱确认标志',
  SANDBOX_UNSUPPORTED_ON_WINDOWS: 'Windows 不支持 OS 沙箱标志',
  WINDOWS_NO_OS_SANDBOX: '可用，以当前用户权限运行'
};

export const cellsReasonLabel = (reason: string | undefined): string =>
  reason ? (reasonText[reason] ?? reason) : '尚未读取';

export const cellsSourceCaption = (source: CellsAvailabilityReadModel['source'] | CellsSessionReadModel['source'] | undefined): string => {
  if (source === 'fresh-health') return '新鲜健康检查（只到步骤 1–2：NODE_TOO_OLD 或 DESKTOP_SESSION_KEEP_REQUIRED）';
  if (source === 'live-session') return '活着的会话保持进程（步骤 3–5：KERNEL_NOT_ATTACHED、JOURNAL_UNAVAILABLE、WINDOWS_DESKTOP_CELLS_REQUIRED）';
  return '尚未读取';
};

export const freshHealthStopsEarly = (reason: string | undefined): boolean =>
  reason !== undefined && FRESH_HEALTH_REASONS.has(reason);

export const liveSessionReason = (reason: string | undefined): boolean =>
  reason !== undefined && LIVE_SESSION_REASONS.has(reason);

export interface CellsSettingsPanelInput {
  settings: DesktopCellsSettings;
  fresh?: CellsAvailabilityReadModel;
  live?: CellsSessionReadModel;
  loading?: boolean;
  error?: string;
  settingsPath?: string;
}

export const cellsSettingsPanelHtml = (input: CellsSettingsPanelInput): string => {
  const nodeTooOld = input.fresh?.reason === 'NODE_TOO_OLD';
  const checked = input.settings.experimentalCodeCells ? 'checked' : '';
  const disabled = nodeTooOld || input.loading ? 'disabled' : '';
  const freshReason = cellsReasonLabel(input.fresh?.reason);
  const liveReason = input.live ? cellsReasonLabel(input.live.reason) : '当前没有活着的会话保持进程';
  return `<section class="settings-group" id="settings-panel-cells" data-settings-panel="cells" aria-label="实验性代码 cell">
    <h3>${CELLS_TOGGLE_LABEL}</h3>
    <div class="settings-card">
      <label class="settings-field" data-action="toggle-experimental-cells">
        <span>${CELLS_TOGGLE_LABEL}<small>${CELLS_CONFIRM_TEXT}。${CELLS_SESSION_KEEP_HINT}。确认只在打开开关时出现一次。</small></span>
        <input type="checkbox" ${checked} ${disabled} aria-describedby="cells-settings-hint">
      </label>
      <div class="settings-field settings-field-readonly"><span>新鲜健康检查</span><output data-cells-fresh-health>${escapeHtml(cellsSourceCaption('fresh-health'))} · ${escapeHtml(freshReason)}</output></div>
      <div class="settings-field settings-field-readonly"><span>活着的会话</span><output data-cells-live-session>${escapeHtml(cellsSourceCaption('live-session'))} · ${escapeHtml(liveReason)}</output></div>
      ${input.settingsPath ? `<div class="settings-field settings-field-readonly"><span>桌面设置</span><output>${escapeHtml(input.settingsPath)}</output></div>` : ''}
    </div>
    <p class="settings-hint" id="cells-settings-hint">${input.error ? escapeHtml(input.error) : '写入 desktop-settings.json 的 experimentalCodeCells，默认关闭。不写入模型配置。没有 OS 沙箱选项。'}</p>
  </section>`;
};

export const settingsPanelOffersSandboxOption = (html: string): boolean =>
  /name=["']sandbox["']|name=["']osSandbox["']|OS 沙箱模式|DDA_KERNEL_SANDBOX/.test(html);

export const approvalCellDetailsHtml = (approval: Pick<ApprovalReadModel, 'cellOpIndex' | 'fingerprint' | 'codePreview' | 'requestDigest' | 'warning' | 'sandbox' | 'state'>): string => {
  const badge = sandboxBadgeHtml(approval);
  const expired = approval.state === 'EXPIRED' ? '<p class="approval-expired">审批已过期</p>' : '';
  const preview = approval.codePreview
    ? `<pre class="cell-code-preview">${escapeHtml(approval.codePreview)}</pre>`
    : '';
  const rows = [
    approval.cellOpIndex !== undefined ? `<div><dt>cell 操作序号</dt><dd>${escapeHtml(String(approval.cellOpIndex))}</dd></div>` : '',
    approval.fingerprint ? `<div><dt>核对指纹</dt><dd>${escapeHtml(approval.fingerprint)}</dd></div>` : ''
  ].join('');
  const fingerprintNote = approval.fingerprint && approval.fingerprint === approval.requestDigest
    ? '<p class="cell-fingerprint-note">指纹与动作摘要是同一份 requestDigest，批准只校验这一次。</p>'
    : '';
  if (!badge && !expired && !preview && !rows) return '';
  return `${badge}${expired}${preview}${rows ? `<dl class="cell-approval-fields">${rows}</dl>` : ''}${fingerprintNote}`;
};

export const unknownJournalHtml = (item: Pick<TimelineItem, 'title' | 'cellState' | 'journalPath' | 'toolName'>): string => {
  if (item.toolName !== 'kernel.exec') return '';
  if (item.cellState !== 'UNKNOWN' && item.title !== CELLS_UNKNOWN_TITLE) return '';
  const path = item.journalPath ? `<pre class="cell-journal-path" tabindex="-1">${escapeHtml(item.journalPath)}</pre>` : '';
  return `<div class="timeline-cell-unknown"><strong>${CELLS_UNKNOWN_TITLE}</strong><button type="button" class="secondary-button" data-action="view-cell-journal">查看 journal</button>${path}</div>`;
};

export const isToolCard = (item: Pick<TimelineItem, 'toolName'>): boolean => Boolean(item.toolName);

export type KernelExecCopyBranch = 'windows-desktop' | 'windows-cli' | 'linux';

/** Desktop copy wins when both flags are set. A shared boolean must not overwrite CLI copy. */
export const kernelExecCopyBranch = (flags: { windowsDesktop?: boolean; windowsUnsandboxed?: boolean }): KernelExecCopyBranch => {
  if (flags.windowsDesktop) return 'windows-desktop';
  if (flags.windowsUnsandboxed) return 'windows-cli';
  return 'linux';
};

export const projectCellsSession = (payload: {
  available?: boolean;
  reason?: string;
  source?: string;
  sandboxAvailable?: boolean;
  ready?: boolean;
}): CellsSessionReadModel | undefined => {
  if (payload.source !== 'live-session') return undefined;
  const available = payload.available === true || payload.ready === true;
  return {
    available,
    source: 'live-session',
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
    ...(typeof payload.sandboxAvailable === 'boolean' ? { sandboxAvailable: payload.sandboxAvailable } : {})
  };
};
