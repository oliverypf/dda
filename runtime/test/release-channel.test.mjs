import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertReleaseExecutionMode, assertReleaseHarnessStore, resolveReleaseChannel, RELEASE_CHANNELS } from '../src/release-channel.mjs';

test('Phase 1 denies controlled modes and unknown channels fail closed', () => {
  assert.equal(assertReleaseExecutionMode('READ_ONLY', 'WINDOWS_PHASE1_READ_ONLY'), 'READ_ONLY');
  for (const mode of ['CONTROLLED', 'CONTROLLED_WRITE', 'unknown']) {
    assert.throws(() => assertReleaseExecutionMode(mode, 'WINDOWS_PHASE1_READ_ONLY'), /RELEASE_CHANNEL_READ_ONLY/);
  }
  for (const channel of ['', 'phase1', 'WINDOWS_PHASE1_READ_ONlY']) {
    assert.throws(() => resolveReleaseChannel(channel), /RELEASE_CHANNEL_INVALID/);
    assert.throws(() => assertReleaseExecutionMode('READ_ONLY', channel), /RELEASE_CHANNEL_INVALID/);
  }
  for (const channel of RELEASE_CHANNELS) assert.equal(resolveReleaseChannel(channel), channel);
  assert.equal(resolveReleaseChannel('LINUX_CLI_READ_ONLY'), 'WINDOWS_PHASE1_READ_ONLY');
  assert.equal(resolveReleaseChannel('LINUX_CLI_CONTROLLED'), 'WINDOWS_FULL_LOCAL');
  assert.throws(() => assertReleaseExecutionMode('CONTROLLED', 'LINUX_CLI_READ_ONLY'), /RELEASE_CHANNEL_READ_ONLY/);
  assert.equal(assertReleaseHarnessStore('hmcodex.db', 'LINUX_CLI_READ_ONLY'), 'hmcodex.db');
});

test('Phase 1 requires a durable SQLite task store', async () => {
  const channel = 'WINDOWS_PHASE1_READ_ONLY';
  for (const path of [undefined, '', 'events.json', 'trajectory.jsonl']) {
    assert.throws(() => assertReleaseHarnessStore(path, channel), /SQLITE_REQUIRED/);
  }
  assert.equal(assertReleaseHarnessStore('hmcodex.db', channel), 'hmcodex.db');
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-storage-gate-'));
  const result = spawnSync(process.execPath, ['src/index.mjs', 'task', '--prompt', 'test', '--harness-event-store', join(directory, 'events.json')], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HMCODEX_RELEASE_CHANNEL: channel, HMCODEX_EXECUTION_MODE: 'READ_ONLY', HMCODEX_DATA_DIR: directory },
    encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).error, 'RELEASE_CHANNEL_SQLITE_REQUIRED');
  assert.deepEqual(await readdir(directory), []);
});

test('Phase 1 recovery uses the same scoped SQLite authority as task execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-recovery-storage-'));
  const trajectory = join(directory, 'trajectory.jsonl');
  const storagePath = `${trajectory}.db`;
  await createHarnessEventStore({ storagePath }).append({ runId: 'existing', kind: 'TaskRunCreated' });
  const recoveryEnv = { ...process.env, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_TRAJECTORY_STORE: trajectory, HMCODEX_DATA_DIR: directory };
  delete recoveryEnv.HMCODEX_HARNESS_EVENT_STORE;
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

test('Phase 1 CLI denies all controlled entry forms before creating task stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-gate-'));
  const env = { ...process.env, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_TRAJECTORY_STORE: join(directory, 'trajectory.jsonl'), HMCODEX_DATA_DIR: directory };
  for (const args of [
    ['--execution-mode', 'CONTROLLED'], ['--execution-mode=CONTROLLED'],
    ['--mode', 'CONTROLLED_WRITE'], []
  ]) {
    const result = spawnSync(process.execPath, ['src/index.mjs', 'task', '--prompt', 'test', ...args], {
      cwd: new URL('..', import.meta.url), env: { ...env, HMCODEX_EXECUTION_MODE: 'CONTROLLED' },
      encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).error, 'RELEASE_CHANNEL_READ_ONLY');
    assert.deepEqual(await readdir(directory), []);
  }
});

test('health exposes Phase 1 channel and rejects misspelled channels', () => {
  for (const channel of ['WINDOWS_PHASE1_READ_ONLY', 'INVALID_CHANNEL']) {
    const result = spawnSync(process.execPath, ['src/index.mjs', 'health'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 30000,
      env: { ...process.env, HMCODEX_RELEASE_CHANNEL: channel }
    });
    assert.equal(result.error, undefined);
    const payload = JSON.parse(result.stdout.trim());
    if (channel === 'INVALID_CHANNEL') {
      assert.equal(result.status, 1);
      assert.equal(payload.error, 'RELEASE_CHANNEL_INVALID');
    } else {
      assert.equal(result.status, 0, result.stdout);
      assert.equal(payload.runtime.releaseChannel, channel);
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
      HMCODEX_BAKED_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY'
    }
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.runtime.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
});
