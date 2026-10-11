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
  assert.equal(detectKernelSandbox({ HMCODEX_RESIDENT_KERNEL_SANDBOX: '1' }, 'darwin').available, true);
  assert.equal(detectKernelSandbox({ HMCODEX_RESIDENT_KERNEL_SANDBOX: '0' }, 'linux').available, false);
});

test('availability requires feature, Linux CLI identity, Node 24 and a sandbox', () => {
  const base = { HMCODEX_RESIDENT_KERNEL: '1', HMCODEX_PLATFORM: 'linux-cli' };
  const ok = residentKernelAvailability(base, { platform: 'linux', nodeVersion: 'v24.0.0' });
  assert.equal(ok.available, true);
  assert.equal(ok.reason, 'AVAILABLE');

  assert.equal(residentKernelAvailability({ HMCODEX_PLATFORM: 'linux-cli' }, { platform: 'linux', nodeVersion: 'v24.0.0' }).reason, 'DISABLED');
  assert.equal(residentKernelAvailability(base, { platform: 'linux', nodeVersion: 'v22.0.0' }).reason, 'NODE_TOO_OLD');
  assert.equal(residentKernelAvailability({ HMCODEX_RESIDENT_KERNEL: '1', HMCODEX_PLATFORM: 'windows-desktop' }, { platform: 'linux', nodeVersion: 'v24.0.0' }).reason, 'NON_LINUX_PLATFORM_IDENTITY');
  assert.equal(residentKernelAvailability(base, { platform: 'darwin', nodeVersion: 'v24.0.0' }).reason, 'NON_LINUX_PLATFORM');
});
