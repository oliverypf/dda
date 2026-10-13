import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeCellsAvailability, isCodeCellsEnabled, isWindowsUnsandboxedEnabled, isWindowsDesktopCellsEnabled,
  observeCodeCells, createCellHost, KERNEL_CODE_CELLS_FLAG, KERNEL_WINDOWS_UNSANDBOXED_FLAG,
  KERNEL_WINDOWS_DESKTOP_CELLS_FLAG
} from '../src/kernel/cell-host.mjs';
import { detectKernelOsSandbox, isKernelSandboxEnabled } from '../src/kernel/sandbox.mjs';
import { residentKernelAvailability, KERNEL_WINDOWS_UNSANDBOXED_FLAG as FEATURE_WIN_FLAG } from '../src/kernel/feature.mjs';
import { isLinuxCliPlatform, resolveKernelEffectJournalPath, resolveKernelSessionPath, legacyRootKernelEffectJournalPath } from '../src/platform/paths.mjs';
import { migrateLegacyWindowsCliJournal, JOURNAL_STATES } from '../src/kernel/effect-journal.mjs';
import { approvalSubject, cellApprovalPresentation, CELL_EFFECT_APPROVAL_TTL_MS } from '../src/kernel/cell-approval.mjs';
import { executionDigest } from '../src/execution-state-store.mjs';
import {
  registerKernelExecTool, WINDOWS_CLI_KERNEL_EXEC_DESCRIPTION, WINDOWS_DESKTOP_KERNEL_EXEC_DESCRIPTION
} from '../src/kernel/kernel-tools.mjs';
import { readFileSync } from 'node:fs';

const baseWin = {
  DDA_RESIDENT_KERNEL: '1',
  DDA_PLATFORM: 'windows-cli',
  [KERNEL_CODE_CELLS_FLAG]: '1',
  [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1'
};

test('windows-cli is not folded into portable / isLinuxCliPlatform', () => {
  assert.equal(isLinuxCliPlatform({ DDA_PLATFORM: 'windows-cli' }), false);
  assert.equal(isLinuxCliPlatform({ DDA_PLATFORM: 'linux-cli' }), true);
  assert.equal(FEATURE_WIN_FLAG, 'DDA_KERNEL_WINDOWS_UNSANDBOXED');
});

test('flags default OFF', () => {
  assert.equal(isCodeCellsEnabled({}), false);
  assert.equal(isWindowsUnsandboxedEnabled({}), false);
  assert.equal(isKernelSandboxEnabled({}), false);
});

test('win32 + windows-cli + CODE_CELLS + WINDOWS_UNSANDBOXED → available WINDOWS_NO_OS_SANDBOX', async () => {
  const result = await codeCellsAvailability({
    env: baseWin,
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, true);
  assert.equal(result.reason, 'WINDOWS_NO_OS_SANDBOX');
  assert.equal(result.sandbox?.available, false);
  assert.equal(result.sandbox?.reason, 'NON_LINUX_PLATFORM');
  assert.equal(result.sandbox?.backend, null);
  assert.equal(result.windowsUnsandboxed, true);
});

test('win32 + CODE_CELLS without WINDOWS_UNSANDBOXED → WINDOWS_UNSANDBOXED_REQUIRED', async () => {
  const env = { ...baseWin };
  delete env[KERNEL_WINDOWS_UNSANDBOXED_FLAG];
  const result = await codeCellsAvailability({
    env,
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'WINDOWS_UNSANDBOXED_REQUIRED');
});

test('win32 + linux-cli → PLATFORM_IDENTITY_MISMATCH (before sandbox probe)', async () => {
  const result = await codeCellsAvailability({
    env: { ...baseWin, DDA_PLATFORM: 'linux-cli' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'PLATFORM_IDENTITY_MISMATCH');
});

test('win32 + windows-desktop without DESKTOP_CELLS → WINDOWS_DESKTOP_CELLS_REQUIRED', async () => {
  const result = await codeCellsAvailability({
    env: { ...baseWin, DDA_PLATFORM: 'windows-desktop' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true,
    nodeVersion: 'v24.0.0'
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'WINDOWS_DESKTOP_CELLS_REQUIRED');
});

test('linux + windows-cli must not fall through to sandboxed cells', async () => {
  const result = await codeCellsAvailability({
    env: {
      DDA_PLATFORM: 'windows-cli',
      [KERNEL_CODE_CELLS_FLAG]: '1',
      [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1',
      DDA_KERNEL_SANDBOX: '1'
    },
    platform: 'linux',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'PLATFORM_IDENTITY_MISMATCH');
});

test('win32 + windows-cli + truthy DDA_KERNEL_SANDBOX → SANDBOX_UNSUPPORTED_ON_WINDOWS', async () => {
  const result = await codeCellsAvailability({
    env: { ...baseWin, DDA_KERNEL_SANDBOX: '1' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'SANDBOX_UNSUPPORTED_ON_WINDOWS');
});

test('linux without sandbox stays fail-closed; WINDOWS_UNSANDBOXED must not substitute', async () => {
  const result = await codeCellsAvailability({
    env: {
      DDA_PLATFORM: 'linux-cli',
      [KERNEL_CODE_CELLS_FLAG]: '1',
      [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1'
      // no DDA_KERNEL_SANDBOX
    },
    platform: 'linux',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'SANDBOX_DISABLED');
});

test('resident attach on win32+windows-cli allowed with sandboxAvailable false', () => {
  const avail = residentKernelAvailability(baseWin, { platform: 'win32', nodeVersion: 'v24.0.0' });
  assert.equal(avail.available, true);
  assert.equal(avail.sandboxAvailable, false);
  assert.equal(avail.windowsCliIdentity, true);
  // Override must not light sandboxAvailable on Windows.
  const withOverride = residentKernelAvailability(
    { ...baseWin, DDA_RESIDENT_KERNEL_SANDBOX: '1' },
    { platform: 'win32', nodeVersion: 'v24.0.0' }
  );
  assert.equal(withOverride.available, true);
  assert.equal(withOverride.sandboxAvailable, false);
});

test('detectKernelOsSandbox accepts injected platform (win32 → NON_LINUX)', async () => {
  const detected = await detectKernelOsSandbox({ DDA_KERNEL_SANDBOX: '1' }, 'win32');
  assert.equal(detected.available, false);
  assert.equal(detected.reason, 'NON_LINUX_PLATFORM');
  assert.equal(detected.backend, null);
});

test('CellHost Windows path: protocol ready only, no bwrap canary, exec works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-win-cells-'));
  const journalPath = join(dir, 'journal.json');
  await writeFile(journalPath, JSON.stringify({ journalSchema: 1, effects: [], uncertainClears: [] }));
  const host = createCellHost({
    env: baseWin,
    platform: 'win32',
    journal: { available: true },
    cellTimeoutMs: 10_000
  });
  try {
    const started = await host.start({ journalPath });
    assert.equal(started.ready, true);
    assert.equal(started.windowsUnsandboxed, true);
    assert.equal(started.backend, null);
    assert.equal(started.reason, 'WINDOWS_NO_OS_SANDBOX');
    assert.equal(started.warning, 'NOT_A_SECURITY_SANDBOX');
    assert.equal(started.sandbox, 'none');
    assert.equal(started.workerWarning, 'WINDOWS_NO_OS_SANDBOX');

    const result = await host.exec({ code: 'return 2 + 40;', cellId: 'cell-test-1' });
    assert.equal(result.ok, true);
    assert.equal(result.result, 42);
  } finally {
    await host.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const desktopReady = {
  DDA_PLATFORM: 'windows-desktop',
  [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1',
  [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1'
};

const desktopCall = (env, extra = {}) => codeCellsAvailability({
  env,
  platform: 'win32',
  journalAvailable: true,
  residentAvailable: true,
  sessionKeep: true,
  nodeVersion: 'v24.0.0',
  ...extra
});

test('desktop flags default OFF and windows-desktop stays out of the portable set', () => {
  assert.equal(isWindowsDesktopCellsEnabled({}), false);
  assert.equal(isLinuxCliPlatform({ DDA_PLATFORM: 'windows-desktop' }), false);
  assert.equal(KERNEL_WINDOWS_DESKTOP_CELLS_FLAG, 'DDA_KERNEL_WINDOWS_DESKTOP_CELLS');
});

test('win32 × windows-desktop with every cells flag + sessionKeep → WINDOWS_NO_OS_SANDBOX', async () => {
  const result = await desktopCall(desktopReady);
  assert.equal(result.available, true);
  assert.equal(result.reason, 'WINDOWS_NO_OS_SANDBOX');
  assert.equal(result.windowsDesktop, true);
  assert.equal(result.windowsUnsandboxed, undefined);
  assert.equal(result.sandbox?.available, false);
});

test('win32 × windows-desktop never returns CODE_CELLS_DISABLED', async () => {
  const result = await desktopCall({ DDA_PLATFORM: 'windows-desktop' }, { sessionKeep: false, journalAvailable: false, residentAvailable: false });
  assert.equal(result.reason, 'DESKTOP_SESSION_KEEP_REQUIRED');
  assert.notEqual(result.reason, 'CODE_CELLS_DISABLED');
});

test('desktop arm reason order is node, sessionKeep, resident, journal, desktop flag, sandbox, unsandboxed', async () => {
  assert.equal((await desktopCall(desktopReady, { nodeVersion: 'v22.0.0', sessionKeep: false })).reason, 'NODE_TOO_OLD');
  assert.equal((await desktopCall(desktopReady, { sessionKeep: false })).reason, 'DESKTOP_SESSION_KEEP_REQUIRED');
  assert.equal((await desktopCall(desktopReady, { residentAvailable: false })).reason, 'KERNEL_NOT_ATTACHED');
  assert.equal((await desktopCall({ DDA_PLATFORM: 'windows-desktop' }, { residentAvailable: false })).reason, 'KERNEL_NOT_ATTACHED');
  assert.equal((await desktopCall(desktopReady, { journalAvailable: false })).reason, 'JOURNAL_UNAVAILABLE');
  assert.equal((await desktopCall({ DDA_PLATFORM: 'windows-desktop', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' })).reason, 'WINDOWS_DESKTOP_CELLS_REQUIRED');
  assert.equal((await desktopCall({ ...desktopReady, DDA_KERNEL_SANDBOX: '1' })).reason, 'SANDBOX_UNSUPPORTED_ON_WINDOWS');
  assert.equal((await desktopCall({ DDA_PLATFORM: 'windows-desktop', [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1' })).reason, 'WINDOWS_UNSANDBOXED_REQUIRED');
});

test('linux × windows-desktop without CODE_CELLS stays CODE_CELLS_DISABLED', async () => {
  const result = await codeCellsAvailability({
    env: { DDA_PLATFORM: 'windows-desktop' },
    platform: 'linux',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true
  });
  assert.equal(result.reason, 'CODE_CELLS_DISABLED');
});

test('linux × explicit windows-desktop → PLATFORM_IDENTITY_MISMATCH (no bwrap fall-through)', async () => {
  const result = await codeCellsAvailability({
    env: {
      DDA_PLATFORM: 'windows-desktop',
      [KERNEL_CODE_CELLS_FLAG]: '1',
      [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1',
      [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1',
      DDA_KERNEL_SANDBOX: '1'
    },
    platform: 'linux',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'PLATFORM_IDENTITY_MISMATCH');
});

test('windows-cli + DESKTOP_CELLS → PLATFORM_IDENTITY_MISMATCH', async () => {
  const result = await codeCellsAvailability({
    env: { ...baseWin, [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true
  });
  assert.equal(result.reason, 'PLATFORM_IDENTITY_MISMATCH');
});

test('unset DDA_PLATFORM does not enter the desktop arm', async () => {
  const linuxUnset = await codeCellsAvailability({
    env: { [KERNEL_CODE_CELLS_FLAG]: '1' },
    platform: 'linux',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(linuxUnset.reason, 'SANDBOX_DISABLED');
  const winUnset = await codeCellsAvailability({
    env: { [KERNEL_CODE_CELLS_FLAG]: '1', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true
  });
  assert.equal(winUnset.reason, 'PLATFORM_IDENTITY_MISMATCH');
});

test('fresh health observation stops at desktop steps 1–2; steps 3–5 need a live session-keep process', async () => {
  const healthOld = await observeCodeCells({
    env: { DDA_PLATFORM: 'windows-desktop', [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' },
    platform: 'win32',
    nodeVersion: 'v22.1.0',
    residentAttached: true,
    journalAvailable: true
  });
  assert.equal(healthOld.reason, 'NODE_TOO_OLD');
  const healthFresh = await observeCodeCells({
    env: { DDA_PLATFORM: 'windows-desktop', [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' },
    platform: 'win32',
    nodeVersion: 'v24.0.0',
    residentAttached: true,
    journalAvailable: true
  });
  assert.equal(healthFresh.reason, 'DESKTOP_SESSION_KEEP_REQUIRED');
  const liveDetached = await observeCodeCells({
    env: { ...desktopReady, DDA_RESIDENT_KERNEL: '1' },
    platform: 'win32',
    nodeVersion: 'v24.0.0',
    residentAttached: false,
    journalAvailable: true
  });
  assert.equal(liveDetached.reason, 'KERNEL_NOT_ATTACHED');
  const liveJournal = await observeCodeCells({
    env: { ...desktopReady, DDA_RESIDENT_KERNEL: '1' },
    platform: 'win32',
    nodeVersion: 'v24.0.0',
    residentAttached: true,
    journalAvailable: false
  });
  assert.equal(liveJournal.reason, 'JOURNAL_UNAVAILABLE');
  const liveFlag = await observeCodeCells({
    env: { DDA_PLATFORM: 'windows-desktop', DDA_RESIDENT_KERNEL: '1', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' },
    platform: 'win32',
    nodeVersion: 'v24.0.0',
    residentAttached: true,
    journalAvailable: true
  });
  assert.equal(liveFlag.reason, 'WINDOWS_DESKTOP_CELLS_REQUIRED');
});

test('windows-cli success path reason priority is unchanged', async () => {
  const ok = await codeCellsAvailability({
    env: baseWin,
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(ok.reason, 'WINDOWS_NO_OS_SANDBOX');
  assert.equal(ok.windowsUnsandboxed, true);
  const noCells = await codeCellsAvailability({
    env: { ...baseWin, [KERNEL_CODE_CELLS_FLAG]: undefined },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true,
    sessionKeep: true
  });
  assert.equal(noCells.reason, 'CODE_CELLS_DISABLED');
});

test('identity journal paths never fall back to the hmCodex root file', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local', DDA_PLATFORM: 'windows-desktop' };
  const journal = resolveKernelEffectJournalPath(env);
  const session = resolveKernelSessionPath(env);
  const legacy = legacyRootKernelEffectJournalPath(env);
  assert.equal(journal, 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\journal\\windows-desktop\\kernel-effect-journal.json');
  assert.equal(session, 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\journal\\windows-desktop\\kernel-session.json');
  assert.notEqual(journal, legacy);
  assert.equal(resolveKernelEffectJournalPath({ ...env, DDA_PLATFORM: 'windows-cli' }).endsWith('journal\\windows-cli\\kernel-effect-journal.json'), true);
  assert.equal(resolveKernelEffectJournalPath({ DDA_PLATFORM: 'windows-desktop' }), undefined);
  assert.equal(resolveKernelEffectJournalPath({ DDA_PLATFORM: 'linux-cli', HOME: '/home/tester' }).includes('kernel-effect-journal.json'), true);
});

test('legacy root journal migrates once on windows-cli only and folds STARTED to UNKNOWN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-journal-split-'));
  const legacy = join(dir, 'kernel-effect-journal.json');
  const cliDest = join(dir, 'windows-cli', 'kernel-effect-journal.json');
  const desktopDest = join(dir, 'windows-desktop', 'kernel-effect-journal.json');
  await writeFile(legacy, JSON.stringify({
    journalSchema: 'dda-effect-journal-1',
    effects: [{ effectId: 'e1', state: 'STARTED' }],
    uncertainClears: []
  }));
  const skipped = await migrateLegacyWindowsCliJournal({
    env: { DDA_PLATFORM: 'windows-desktop' },
    legacyPath: legacy,
    destPath: desktopDest
  });
  assert.equal(skipped.reason, 'NOT_WINDOWS_CLI');
  assert.equal(JSON.parse(await readFile(legacy, 'utf8')).effects[0].state, 'STARTED');
  const migrated = await migrateLegacyWindowsCliJournal({
    env: { DDA_PLATFORM: 'windows-cli' },
    legacyPath: legacy,
    destPath: cliDest
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.startedToUnknown, 1);
  const body = JSON.parse(await readFile(cliDest, 'utf8'));
  assert.equal(body.effects[0].state, JOURNAL_STATES.UNKNOWN);
  const again = await migrateLegacyWindowsCliJournal({
    env: { DDA_PLATFORM: 'windows-cli' },
    legacyPath: legacy,
    destPath: cliDest
  });
  assert.equal(again.reason, 'DEST_EXISTS');
  await rm(dir, { recursive: true, force: true });
});

test('desktop and CLI kernel.exec descriptions stay on separate branch keys', () => {
  const registered = [];
  const registry = { register(tool) { registered.push(tool); } };
  const host = { exec() {} };
  registerKernelExecTool(registry, host, { windowsUnsandboxed: true });
  registerKernelExecTool(registry, host, { windowsDesktop: true, windowsUnsandboxed: true });
  assert.equal(registered[0].description, WINDOWS_CLI_KERNEL_EXEC_DESCRIPTION);
  assert.equal(registered[1].description, WINDOWS_DESKTOP_KERNEL_EXEC_DESCRIPTION);
  assert.match(registered[1].description, /windows-desktop/);
  assert.match(registered[1].description, /DDA_KERNEL_WINDOWS_DESKTOP_CELLS/);
  assert.match(registered[1].description, /NOT a security sandbox/);
  assert.match(registered[0].description, /windows-cli/);
  assert.equal(registered[0].description.includes('DDA_KERNEL_WINDOWS_DESKTOP_CELLS'), false);
});

test('cell approval digest covers code, cellOpIndex, and host.request; fingerprint is that digest', () => {
  assert.equal(CELL_EFFECT_APPROVAL_TTL_MS, 120_000);
  const base = {
    capability: 'WRITE_FILE',
    request: { path: 'a.txt' },
    context: { cellApproval: { code: 'return 1', cellOpIndex: 2, hostRequest: { kind: 'fs.write', payload: { path: 'a.txt' } } } }
  };
  const digest = executionDigest(approvalSubject(base));
  const changedCode = executionDigest(approvalSubject({ ...base, context: { cellApproval: { ...base.context.cellApproval, code: 'return 2' } } }));
  const changedIndex = executionDigest(approvalSubject({ ...base, context: { cellApproval: { ...base.context.cellApproval, cellOpIndex: 3 } } }));
  const changedPayload = executionDigest(approvalSubject({ ...base, context: { cellApproval: { ...base.context.cellApproval, hostRequest: { kind: 'fs.write', payload: { path: 'b.txt' } } } } }));
  assert.notEqual(digest, changedCode);
  assert.notEqual(digest, changedIndex);
  assert.notEqual(digest, changedPayload);
  assert.equal(executionDigest(approvalSubject({ capability: 'WRITE_FILE', request: { path: 'a.txt' } })), executionDigest({ capability: 'WRITE_FILE', request: { path: 'a.txt' } }));
  const presentation = cellApprovalPresentation(digest, base.context.cellApproval);
  assert.equal(presentation.fingerprint, digest);
  assert.equal(presentation.cellOpIndex, 2);
  assert.equal(presentation.codePreview, 'return 1');
});

test('desktop CellHost without sessionKeep does not spawn a worker', async () => {
  const host = createCellHost({
    env: { DDA_PLATFORM: 'windows-desktop', [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1', [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1' },
    platform: 'win32',
    nodeVersion: 'v24.0.0',
    sessionKeep: false,
    residentAvailable: true,
    journal: { available: true }
  });
  const started = await host.start();
  assert.equal(started.ready, false);
  assert.equal(started.reason, 'DESKTOP_SESSION_KEEP_REQUIRED');
  assert.equal(host.ready, false);
});

test('bundle resources include the windows cell worker entrypoints', () => {
  const conf = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.equal(conf.bundle.resources['../../runtime/src'], 'runtime/src');
  const worker = readFileSync(new URL('../src/kernel/cell-worker-windows.mjs', import.meta.url), 'utf8');
  const protocol = readFileSync(new URL('../src/kernel/cell-protocol.mjs', import.meta.url), 'utf8');
  assert.match(worker, /sandbox:\s*'none'/);
  assert.match(worker, /WINDOWS_NO_OS_SANDBOX/);
  assert.match(protocol, /CELL_PROTOCOL_VERSION/);
});
