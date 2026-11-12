import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROLLED_RELEASE_CHANNELS, RETIRED_RELEASE_CHANNELS,
  assertReleaseExecutionMode, assertReleaseHarnessStore, isApprovedRelease, isControlledRelease,
  resolveReleaseChannel, RELEASE_CHANNELS
} from '../src/release-channel.mjs';

test('controlled-only channels approve CONTROLLED and retired channels fail closed (ADR-0026)', () => {
  for (const channel of CONTROLLED_RELEASE_CHANNELS) {
    assert.equal(assertReleaseExecutionMode('CONTROLLED', channel), 'CONTROLLED');
  }
  assert.throws(() => assertReleaseExecutionMode('CONTROLLED', 'WINDOWS_PHASE1_READ_ONLY'), /RELEASE_CHANNEL_RETIRED/);
  assert.throws(() => assertReleaseExecutionMode('CONTROLLED', 'LINUX_CLI_READ_ONLY'), /RELEASE_CHANNEL_RETIRED/);
  assert.throws(() => assertReleaseExecutionMode('READ_ONLY', 'WINDOWS_PHASE1_5_CONTROLLED'), /EXECUTION_MODE_INVALID/);
  for (const mode of ['READ_ONLY', 'UNKNOWN']) {
    for (const channel of CONTROLLED_RELEASE_CHANNELS) {
      assert.throws(() => assertReleaseExecutionMode(mode, channel), /EXECUTION_MODE_INVALID/);
    }
  }
  for (const channel of ['', 'phase1', 'WINDOWS_PHASE1_5_CONTROlLED']) {
    assert.throws(() => resolveReleaseChannel(channel), /RELEASE_CHANNEL_INVALID/);
  }
  assert.throws(() => resolveReleaseChannel('WINDOWS_PHASE1_READ_ONLY'), /RELEASE_CHANNEL_RETIRED/);
  assert.throws(() => resolveReleaseChannel('LINUX_CLI_READ_ONLY'), /RELEASE_CHANNEL_RETIRED/);
  assert.equal(resolveReleaseChannel('LINUX_CLI_CONTROLLED'), 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.equal(resolveReleaseChannel('WINDOWS_PHASE1_5_CONTROLLED'), 'WINDOWS_PHASE1_5_CONTROLLED');
  for (const channel of RELEASE_CHANNELS) assert.equal(resolveReleaseChannel(channel), channel);
  assert.equal(assertReleaseHarnessStore('hmcodex.db', 'WINDOWS_PHASE1_5_CONTROLLED'), 'hmcodex.db');
  assert.equal(isControlledRelease('LINUX_CLI_CONTROLLED'), true);
  assert.equal(isControlledRelease('WINDOWS_PHASE1_5_CONTROLLED'), true);
  assert.equal(isControlledRelease('WINDOWS_PHASE1_READ_ONLY'), false);
  assert.equal(isControlledRelease(undefined), false);
  assert.equal(isApprovedRelease('WINDOWS_PHASE1_5_CONTROLLED'), true);
  assert.equal(isApprovedRelease('WINDOWS_FULL_LOCAL'), true);
  assert.equal(isApprovedRelease('WINDOWS_PHASE1_READ_ONLY'), false);
  for (const channel of RETIRED_RELEASE_CHANNELS) assert.equal(isApprovedRelease(channel), false);
  for (const channel of RELEASE_CHANNELS) assert.equal(isApprovedRelease(channel), true);
});

test('controlled channels require a durable SQLite task store', async () => {
  const channel = 'WINDOWS_PHASE1_5_CONTROLLED';
  for (const path of [undefined, '', 'events.json', 'trajectory.jsonl']) {
    assert.throws(() => assertReleaseHarnessStore(path, channel), /SQLITE_REQUIRED/);
  }
  assert.equal(assertReleaseHarnessStore('hmcodex.db', channel), 'hmcodex.db');
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-storage-gate-'));
  const result = spawnSync(process.execPath, ['src/index.mjs', 'task', '--prompt', 'test', '--harness-event-store', join(directory, 'events.json')], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DDA_RELEASE_CHANNEL: channel, DDA_DATA_DIR: directory },
    encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).error, 'RELEASE_CHANNEL_SQLITE_REQUIRED');
  assert.deepEqual(await readdir(directory), []);
});

test('controlled recovery uses the same scoped SQLite authority as task execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-recovery-storage-'));
  const trajectory = join(directory, 'trajectory.jsonl');
  const storagePath = `${trajectory}.db`;
  await createHarnessEventStore({ storagePath }).append({ runId: 'existing', kind: 'TaskRunCreated' });
  const recoveryEnv = { ...process.env, DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
    DDA_TRAJECTORY_STORE: trajectory, DDA_DATA_DIR: directory };
  delete recoveryEnv.DDA_HARNESS_EVENT_STORE;
  const result = spawnSync(process.execPath, ['src/index.mjs', 'recovery'], {
    cwd: new URL('..', import.meta.url),
    env: recoveryEnv,
    encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = await createHarnessEventStore({ storagePath }).list();
  assert.ok(events.some((event) => event.runId === 'existing'));
  assert.ok(events.some((event) => event.kind === 'RecoveryStarted'));
  await assert.rejects(readFile(trajectory), { code: 'ENOENT' });
});

test('legacy execution-mode inputs are rejected before creating task stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-gate-'));
  const env = { ...process.env, DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
    DDA_TRAJECTORY_STORE: join(directory, 'trajectory.jsonl'), DDA_DATA_DIR: directory };
  for (const args of [
    ['--execution-mode', 'READ_ONLY'], ['--execution-mode=READ_ONLY'],
    ['--mode', 'READ_ONLY'], []
  ]) {
    const result = spawnSync(process.execPath, ['src/index.mjs', 'task', '--prompt', 'test', ...args], {
      cwd: new URL('..', import.meta.url), env: { ...env, DDA_EXECUTION_MODE: 'READ_ONLY' },
      encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const error = JSON.parse(result.stdout.trim()).error;
    assert.ok(['EXECUTION_MODE_INVALID', 'RELEASE_CHANNEL_RETIRED'].includes(error), error);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('health rejects retired and misspelled channels while controlled channels respond', () => {
  for (const channel of ['WINDOWS_PHASE1_5_CONTROLLED', 'LINUX_CLI_CONTROLLED', 'WINDOWS_PHASE1_READ_ONLY', 'LINUX_CLI_READ_ONLY', 'INVALID_CHANNEL']) {
    const result = spawnSync(process.execPath, ['src/index.mjs', 'health'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, DDA_RELEASE_CHANNEL: channel }
    });
    assert.equal(result.error, undefined);
    const payload = JSON.parse(result.stdout.trim());
    if (channel === 'INVALID_CHANNEL') {
      assert.equal(result.status, 1);
      assert.equal(payload.error, 'RELEASE_CHANNEL_INVALID');
    } else if (RETIRED_RELEASE_CHANNELS.includes(channel)) {
      assert.equal(result.status, 1);
      assert.equal(payload.error, 'RELEASE_CHANNEL_RETIRED');
    } else {
      assert.equal(result.status, 0, result.stdout);
      assert.equal(payload.runtime.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
    }
  }
});

test('a baked release channel cannot be downgraded by the runtime environment', () => {
  const result = spawnSync(process.execPath, ['src/index.mjs', 'health'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: {
      ...process.env,
      DDA_BAKED_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
      DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY'
    }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.runtime.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
});
