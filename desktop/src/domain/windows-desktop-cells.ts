import type {
  ApprovalReadModel,
  CellExecRow,
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

export const approvalCardTitle = (approval: Pick<ApprovalReadModel, 'state' | 'leaseState' | 'executionOk' | 'leaseId'>): string => {
  if (approval.state === 'REQUESTED') return '需要批准一次';
  if (approval.state === 'EXPIRED') return '审批已过期';
  if (approval.state === 'CANCELLED') return '已取消（cell 已结束）';
  if (approval.leaseState === 'FAILED') return '授权不可继续使用 · 执行结果不确定';
  if (approval.leaseState === 'CONSUMED') {
    return '授权已使用 · ' + (approval.executionOk === true
      ? '执行器报告完成，验证结果另见证据'
      : approval.executionOk === false ? '执行器报告失败' : '执行结果未提供');
  }
  if (approval.leaseState === 'CLAIMED') return '执行器已领取授权';
  if (approval.leaseId) return '已授权执行';
  return '正在重新检查策略';
};

export const approvalStateFromResolved = (
  payloadState: unknown,
  current: ApprovalReadModel['state']
): ApprovalReadModel['state'] =>
  payloadState === 'APPROVED' || payloadState === 'DECLINED' || payloadState === 'CANCELLED' ? payloadState : current;

/** Pending section stays REQUESTED-only. Status lists also show CANCELLED. Past list adds CANCELLED and DECLINED. */
export const isPendingApprovalSection = (state: string): boolean => state === 'REQUESTED';
export const isApprovalStatusList = (state: string): boolean =>
  state === 'REQUESTED' || state === 'APPROVED' || state === 'EXPIRED' || state === 'CANCELLED';
export const isPastApprovalList = (state: string): boolean =>
  state === 'APPROVED' || state === 'EXPIRED' || state === 'CANCELLED' || state === 'DECLINED';

const finishedRead = (row: CellExecRow): boolean =>
  row.classification === 'read' && row.state !== 'RUNNING' && row.approvalWaiting !== true;

/** Consecutive finished reads in one epoch collapse. Effect and approval-pending rows stay separate. */
export const groupCellExecRows = (rows: CellExecRow[]): Array<{ kind: 'reads' | 'single'; rows: CellExecRow[] }> => {
  const epochs: string[] = [];
  const byEpoch = new Map<string, CellExecRow[]>();
  for (const row of rows) {
    if (!byEpoch.has(row.epoch)) epochs.push(row.epoch);
    const list = byEpoch.get(row.epoch) ?? [];
    list.push(row);
    byEpoch.set(row.epoch, list);
  }
  const groups: Array<{ kind: 'reads' | 'single'; rows: CellExecRow[] }> = [];
  for (const epoch of epochs) {
    const list = (byEpoch.get(epoch) ?? []).slice().sort((a, b) => a.cellOpIndex - b.cellOpIndex);
    let current: { kind: 'reads' | 'single'; rows: CellExecRow[] } | undefined;
    for (const row of list) {
      if (finishedRead(row) && current?.kind === 'reads') {
        const prev = current.rows[current.rows.length - 1];
        if (row.cellOpIndex === prev.cellOpIndex + 1) {
          current.rows.push(row);
          continue;
        }
      }
      current = { kind: finishedRead(row) ? 'reads' : 'single', rows: [row] };
      groups.push(current);
    }
  }
  return groups.map((group) => group.kind === 'reads' && group.rows.length < 2
    ? { kind: 'single', rows: group.rows }
    : group);
};

export const cellOpElapsedMs = (row: CellExecRow, now: number): number => {
  if (row.durationMs !== undefined && row.state !== 'RUNNING') return Math.max(0, row.durationMs);
  const start = row.startedAtMs ?? now;
  const wait = row.approvalWaitMs ?? 0;
  if (row.approvalWaiting && row.approvalStartedAt !== undefined) {
    return Math.max(0, row.approvalStartedAt - start - wait);
  }
  return Math.max(0, now - start - wait);
};

const ROW_STATE_LABEL: Record<string, string> = {
  RUNNING: '进行中',
  COMPLETED: '完成',
  FAILED: '失败',
  REFUSED: '已拒绝',
  DECLINED: '已拒绝批准',
  EXPIRED: '已过期',
  UNKNOWN: '不确定',
  CANCELLED: '已取消'
};

const rowClass = (state: string): string => {
  if (state === 'FAILED' || state === 'REFUSED' || state === 'DECLINED') return 'cell-op cell-op-bad';
  if (state === 'EXPIRED' || state === 'CANCELLED') return 'cell-op cell-op-muted';
  if (state === 'UNKNOWN') return 'cell-op cell-op-unknown';
  return 'cell-op';
};

const rowHtml = (row: CellExecRow, now: number): string => {
  const elapsed = cellOpElapsedMs(row, now);
  const journal = row.state === 'UNKNOWN'
    ? `<button type="button" class="secondary-button" data-action="view-cell-journal">查看 journal</button>${row.journalPath ? `<pre class="cell-journal-path">${escapeHtml(row.journalPath)}</pre>` : ''}`
    : '';
  const output = row.output
    ? `<pre class="cell-op-output">${escapeHtml(row.output)}</pre>`
    : '';
  return `<li class="${rowClass(row.state)}" data-state="${escapeHtml(row.state)}" data-epoch="${escapeHtml(row.epoch)}" data-tool-call-id="${escapeHtml(row.toolCallId)}">
    <div class="cell-op-title">${escapeHtml(row.title)}</div>
    <div class="cell-op-meta">
      <span>${escapeHtml(ROW_STATE_LABEL[row.state] ?? row.state)}</span>
      <time class="cell-op-timer" data-cell-op-timer="1" data-started-at="${row.startedAtMs ?? ''}" data-approval-wait-ms="${row.approvalWaitMs ?? 0}" data-approval-paused="${row.approvalWaiting === true ? 'true' : 'false'}" data-approval-started-at="${row.approvalStartedAt ?? ''}" data-duration-ms="${row.durationMs ?? ''}">${elapsed} ms</time>
      ${row.truncated ? '<span>输出已截断</span>' : ''}
    </div>
    ${journal}
    ${output}
  </li>`;
};

export const cellExecTimelineHtml = (rows: CellExecRow[] | undefined, now = Date.now()): string => {
  if (!rows?.length) return '';
  const groups = groupCellExecRows(rows);
  const items = groups.map((group) => {
    if (group.kind === 'reads') {
      return `<li class="cell-op cell-op-group" data-state="COMPLETED">读取 ${group.rows.length} 项 · ${group.rows.map((row) => escapeHtml(row.title)).join('、')}</li>`;
    }
    return rowHtml(group.rows[0], now);
  }).join('');
  return `<details class="cell-exec-timeline" open>
    <summary>操作时间线 · ${rows.length}</summary>
    <ol class="cell-op-list">${items}</ol>
  </details>`;
};

/** Merge one row onto the cell stream card. Other card fields stay. */
export const mergeCellOpRow = (item: TimelineItem | undefined, row: CellExecRow): CellExecRow[] => {
  const rows = Array.isArray(item?.rows) ? item.rows.slice() : [];
  const index = rows.findIndex((existing) => existing.epoch === row.epoch && existing.toolCallId === row.toolCallId);
  if (index < 0) rows.push(row);
  else rows[index] = { ...rows[index], ...row };
  return rows;
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
