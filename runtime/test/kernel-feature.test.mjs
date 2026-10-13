import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKernelSandbox, isResidentKernelEnabled, isSupportedNodeVersion,
  residentKernelAvailability, RESIDENT_KERNEL_FLAG
} from '../src/kernel/feature.mjs';

test('feature is off by default and opt-in by flag', () => {
  assert.equal(isResidentKernelEnabled({}), false);
  assert.equal(isResidentKernelEnabled({ [RESIDENT_KERNEL_FLAG]: 'false' }), false);
  assert.equal(isResidentKernelEnabled({ [RESIDENT_KERNEL_FLAG]: '1' }), true);
  assert.equal(isResidentKernelEnabled({ [RESIDENT_KERNEL_FLAG]: 'true' }), true);
});

test('requires Node 24 or newer', () => {
  assert.equal(isSupportedNodeVersion('v24.0.0'), true);
  assert.equal(isSupportedNodeVersion('v25.1.0'), true);
  assert.equal(isSupportedNodeVersion('v22.14.0'), false);
});

test('sandbox is Linux-only with an explicit override', () => {
  assert.equal(detectKernelSandbox({}, 'linux').available, true);
  assert.equal(detectKernelSandbox({}, 'darwin').available, false);
  assert.equal(detectKernelSandbox({}, 'win32').reason, 'NON_LINUX_PLATFORM');
  assert.equal(detectKernelSandbox({ DDA_RESIDENT_KERNEL_SANDBOX: '1' }, 'darwin').available, true);
  assert.equal(detectKernelSandbox({ DDA_RESIDENT_KERNEL_SANDBOX: '0' }, 'linux').available, false);
});

test('availability requires feature, Linux CLI identity, Node 24 and a sandbox', () => {
  const base = { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' };
  const ok = residentKernelAvailability(base, { platform: 'linux', nodeVersion: 'v24.0.0' });
  assert.equal(ok.available, true);
  assert.equal(ok.reason, 'AVAILABLE');

  assert.equal(residentKernelAvailability({ DDA_PLATFORM: 'linux-cli' }, { platform: 'linux', nodeVersion: 'v24.0.0' }).reason, 'DISABLED');
  assert.equal(residentKernelAvailability(base, { platform: 'linux', nodeVersion: 'v22.0.0' }).reason, 'NODE_TOO_OLD');
  assert.equal(residentKernelAvailability({ DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'windows-desktop' }, { platform: 'linux', nodeVersion: 'v24.0.0' }).reason, 'NON_LINUX_PLATFORM_IDENTITY');
  assert.equal(residentKernelAvailability(base, { platform: 'darwin', nodeVersion: 'v24.0.0' }).reason, 'NON_LINUX_PLATFORM');
});

test('windows-cli on win32 may attach without OS sandbox; sandboxAvailable stays false', () => {
  const avail = residentKernelAvailability(
    { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'windows-cli' },
    { platform: 'win32', nodeVersion: 'v24.0.0' }
  );
  assert.equal(avail.available, true);
  assert.equal(avail.sandboxAvailable, false);
  assert.equal(avail.reason, 'AVAILABLE');

  const desktop = residentKernelAvailability(
    { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'windows-desktop' },
    { platform: 'win32', nodeVersion: 'v24.0.0' }
  );
  assert.equal(desktop.available, true);
  assert.equal(desktop.sandboxAvailable, false);
  assert.equal(desktop.windowsDesktopIdentity, true);
  assert.equal(desktop.windowsCliIdentity, false);
  const desktopWithSandboxOverride = residentKernelAvailability(
    { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'windows-desktop', DDA_RESIDENT_KERNEL_SANDBOX: '1' },
    { platform: 'win32', nodeVersion: 'v24.0.0' }
  );
  assert.equal(desktopWithSandboxOverride.available, true);
  assert.equal(desktopWithSandboxOverride.sandboxAvailable, false);
});
