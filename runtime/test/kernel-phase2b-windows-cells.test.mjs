import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codeCellsAvailability, isCodeCellsEnabled, isWindowsUnsandboxedEnabled,
  createCellHost, KERNEL_CODE_CELLS_FLAG, KERNEL_WINDOWS_UNSANDBOXED_FLAG
} from '../src/kernel/cell-host.mjs';
import { detectKernelOsSandbox, isKernelSandboxEnabled } from '../src/kernel/sandbox.mjs';
import { residentKernelAvailability, KERNEL_WINDOWS_UNSANDBOXED_FLAG as FEATURE_WIN_FLAG } from '../src/kernel/feature.mjs';
import { isLinuxCliPlatform } from '../src/platform/paths.mjs';

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

test('win32 + windows-desktop → PLATFORM_IDENTITY_MISMATCH', async () => {
  const result = await codeCellsAvailability({
    env: { ...baseWin, DDA_PLATFORM: 'windows-desktop' },
    platform: 'win32',
    journalAvailable: true,
    residentAvailable: true
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, 'PLATFORM_IDENTITY_MISMATCH');
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

    const result = await host.exec({ code: 'return 2 + 40;', cellId: 'cell-test-1' });
    assert.equal(result.ok, true);
    assert.equal(result.result, 42);
  } finally {
    await host.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
