import { describe, expect, it } from 'vitest';
import { createInitialReadModel, setCellsSession, setRuntimeReady } from './store';
import {
  CELLS_BADGE_TEXT,
  CELLS_CONFIRM_TEXT,
  CELLS_RESET_TITLE,
  CELLS_SESSION_BANNER_TEXT,
  CELLS_SESSION_KEEP_HINT,
  CELLS_TOGGLE_LABEL,
  CELLS_UNKNOWN_TITLE,
  approvalCellDetailsHtml,
  cellsSettingsPanelHtml,
  defaultDesktopCellsSettings,
  freshHealthStopsEarly,
  kernelExecCopyBranch,
  liveSessionReason,
  parseDesktopCellsSettings,
  sandboxBadgeHtml,
  sessionBannerHtml,
  settingsPanelOffersSandboxOption,
  showsWindowsNoOsSandboxBadge,
  truncateCellCode,
  unknownJournalHtml
} from './windows-desktop-cells';

describe('windows desktop code cells presentation', () => {
  it('badges only when warning and sandbox both match the worker READY fields', () => {
    expect(showsWindowsNoOsSandboxBadge({ warning: 'WINDOWS_NO_OS_SANDBOX', sandbox: 'none' })).toBe(true);
    expect(sandboxBadgeHtml({ warning: 'WINDOWS_NO_OS_SANDBOX', sandbox: 'none' })).toContain(CELLS_BADGE_TEXT);
    expect(showsWindowsNoOsSandboxBadge({ warning: 'NOT_A_SECURITY_SANDBOX', sandbox: 'none' })).toBe(false);
    expect(showsWindowsNoOsSandboxBadge({ warning: 'WINDOWS_NO_OS_SANDBOX', sandbox: 'bwrap' })).toBe(false);
    expect(showsWindowsNoOsSandboxBadge({ warning: 'WINDOWS_NO_OS_SANDBOX' })).toBe(false);
    expect(sandboxBadgeHtml({ warning: 'NOT_A_SECURITY_SANDBOX', sandbox: 'none' })).toBe('');
  });

  it('shows a session banner only for a live WINDOWS_NO_OS_SANDBOX session', () => {
    const html = sessionBannerHtml({
      available: true,
      reason: 'WINDOWS_NO_OS_SANDBOX',
      source: 'live-session',
      sandboxAvailable: false
    });
    expect(html).toContain(CELLS_SESSION_BANNER_TEXT);
    expect(html).not.toContain('关闭');
    expect(sessionBannerHtml({
      available: false,
      reason: 'DESKTOP_SESSION_KEEP_REQUIRED',
      source: 'live-session'
    })).toBe('');
    expect(sessionBannerHtml(undefined)).toBe('');
  });

  it('renders approval cell fields, expiry, and the same digest as the fingerprint', () => {
    const digest = 'sha256:cell';
    const html = approvalCellDetailsHtml({
      state: 'REQUESTED',
      requestDigest: digest,
      cellOpIndex: 2,
      fingerprint: digest,
      codePreview: 'await host.request("fs.read", {})',
      warning: 'WINDOWS_NO_OS_SANDBOX',
      sandbox: 'none'
    });
    expect(html).toContain(CELLS_BADGE_TEXT);
    expect(html).toContain('cell 操作序号');
    expect(html).toContain('>2<');
    expect(html).toContain(digest);
    expect(html).toContain('await host.request');
    expect(html).toContain('批准只校验这一次');
    expect(approvalCellDetailsHtml({
      state: 'EXPIRED',
      requestDigest: digest,
      fingerprint: digest
    })).toContain('审批已过期');
  });

  it('styles UNKNOWN journal rows and keeps tool cards behind toolName', () => {
    const unknown = unknownJournalHtml({
      toolName: 'kernel.exec',
      title: CELLS_UNKNOWN_TITLE,
      cellState: 'UNKNOWN',
      journalPath: 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\journal\\windows-desktop\\kernel-effect-journal.json'
    });
    expect(unknown).toContain('timeline-cell-unknown');
    expect(unknown).toContain('查看 journal');
    expect(unknown).toContain('kernel-effect-journal.json');
    expect(unknownJournalHtml({ title: CELLS_UNKNOWN_TITLE })).toBe('');
    expect(unknownJournalHtml({ toolName: 'shell.execute', title: CELLS_RESET_TITLE })).toBe('');
  });

  it('settings default off, confirm copy, session-keep hint, and no OS sandbox option', () => {
    expect(defaultDesktopCellsSettings()).toEqual({ experimentalCodeCells: false });
    expect(parseDesktopCellsSettings({})).toEqual({ experimentalCodeCells: false });
    expect(parseDesktopCellsSettings({ experimentalCodeCells: true }).experimentalCodeCells).toBe(true);
    expect(parseDesktopCellsSettings({ experimentalCodeCells: '1' }).experimentalCodeCells).toBe(false);
    const html = cellsSettingsPanelHtml({
      settings: { experimentalCodeCells: false },
      fresh: { available: false, reason: 'DESKTOP_SESSION_KEEP_REQUIRED', source: 'fresh-health', sandboxAvailable: false },
      settingsPath: 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\desktop-settings.json'
    });
    expect(html).toContain(CELLS_TOGGLE_LABEL);
    expect(html).toContain(CELLS_CONFIRM_TEXT);
    expect(html).toContain(CELLS_SESSION_KEEP_HINT);
    expect(html).toContain('desktop-settings.json');
    expect(html).toContain('新鲜健康检查');
    expect(html).toContain('活着的会话保持进程');
    expect(html).not.toContain('model-config.json');
    expect(settingsPanelOffersSandboxOption(html)).toBe(false);
    expect(html).not.toContain('type="radio"');
    expect(freshHealthStopsEarly('NODE_TOO_OLD')).toBe(true);
    expect(freshHealthStopsEarly('DESKTOP_SESSION_KEEP_REQUIRED')).toBe(true);
    expect(freshHealthStopsEarly('KERNEL_NOT_ATTACHED')).toBe(false);
    expect(liveSessionReason('JOURNAL_UNAVAILABLE')).toBe(true);
    expect(liveSessionReason('WINDOWS_DESKTOP_CELLS_REQUIRED')).toBe(true);
    expect(liveSessionReason('NODE_TOO_OLD')).toBe(false);
  });

  it('keeps desktop and CLI tool-description branches independent', () => {
    expect(kernelExecCopyBranch({ windowsDesktop: true, windowsUnsandboxed: true })).toBe('windows-desktop');
    expect(kernelExecCopyBranch({ windowsUnsandboxed: true })).toBe('windows-cli');
    expect(kernelExecCopyBranch({})).toBe('linux');
  });

  it('truncates cell code preview at 240 characters', () => {
    expect(truncateCellCode('abc')).toBe('abc');
    expect(truncateCellCode('x'.repeat(241))).toBe(`${'x'.repeat(240)}…`);
  });

  it('preserves a live cells session when fresh health replaces runtime', () => {
    const live = setCellsSession(createInitialReadModel(), {
      available: true,
      reason: 'WINDOWS_NO_OS_SANDBOX',
      source: 'live-session',
      sandboxAvailable: false
    });
    const next = setRuntimeReady(live, {
      platform: 'WINDOWS',
      version: '0.1.0',
      readOnly: true,
      workspaceRead: true,
      commandExecution: false,
      networkSideEffects: false,
      cellsAvailability: {
        available: false,
        reason: 'DESKTOP_SESSION_KEEP_REQUIRED',
        source: 'fresh-health',
        sandboxAvailable: false
      }
    });
    expect(next.cellsSession?.reason).toBe('WINDOWS_NO_OS_SANDBOX');
    expect(next.runtime.cellsAvailability?.reason).toBe('DESKTOP_SESSION_KEEP_REQUIRED');
    expect(next.runtime.cellsAvailability?.source).toBe('fresh-health');
  });
});
