import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectKernelOsSandbox, normalizeExcludedBodySet, buildCanaryRequiredPaths,
  loadSandboxNative, isKernelSandboxEnabled, CANARY_BUDGET_MS
} from '../src/kernel/sandbox.mjs';
import { persistentJsonDefaults } from '../src/persistent-json-store.mjs';

test('sandbox default OFF; empty canary path set is not a pass', async () => {
  assert.equal(isKernelSandboxEnabled({}), false);
  const off = await detectKernelOsSandbox({});
  assert.equal(off.available, false);
  assert.equal(off.reason, 'SANDBOX_DISABLED');

  const empty = buildCanaryRequiredPaths({});
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'CANARY_PATH_SET_EMPTY');
});

test('excluded body-set strips .lock and never produces .lock.lock', () => {
  const bodies = normalizeExcludedBodySet([
    '/data/a.json', '/data/a.json.lock', '/data/b.json.lock', '/data/c.lock.lock'
  ]);
  assert.deepEqual(bodies.sort(), ['/data/a.json', '/data/b.json'].sort());
  assert.equal(bodies.some((b) => b.endsWith('.lock')), false);
});

test('canary budget is strictly less than PJS lockTimeoutMs (15s)', () => {
  assert.ok(CANARY_BUDGET_MS < persistentJsonDefaults.lockTimeoutMs);
  assert.ok(CANARY_BUDGET_MS <= 12_000);
});

test('native addon emits stage-1 sock_filter[] raw bytes (len%8==0) when built', () => {
  const native = loadSandboxNative();
  if (native.error) {
    // In environments without a rebuilt addon, skip — CI linux-x64 rebuilds on install.
    assert.ok(typeof native.error === 'string');
    return;
  }
  const buf = native.emitStage1Filter();
  assert.equal(Buffer.isBuffer(buf), true);
  assert.equal(buf.length % 8, 0);
  assert.ok(buf.length > 0);
});

test('enabled sandbox prefers bwrap; Landlock incomplete is fail-closed (never silent available)', async () => {
  const detected = await detectKernelOsSandbox({ DDA_KERNEL_SANDBOX: '1' });
  if (!detected.available) {
    assert.ok([
      'NATIVE_ADDON_UNAVAILABLE', 'STAGE1_FILTER_INVALID', 'STAGE1_FILTER_EMIT_FAILED',
      'LANDLOCK_INCOMPLETE', 'NO_SANDBOX_BACKEND', 'NON_LINUX_PLATFORM'
    ].includes(detected.reason), detected.reason);
    assert.equal(detected.backend, null);
    return;
  }
  assert.equal(detected.backend, 'bwrap');
  assert.notEqual(detected.backend, 'landlock');
});
