import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExplicitLeaseProvider } from '../src/controlled-tools.mjs';
import { CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor } from '../src/runtime-safety-monitor.mjs';
import { RestrictedWindowsExecutor } from '../src/restricted-windows-executor.mjs';
import {
  DEFAULT_BUILD_TIMEOUT_MS,
  annotateProcessFailure,
  explainLockedExecutable,
  isBuildClassCommand,
  resolveShellTimeout,
  timeoutFailureLine
} from '../src/shell-timeout.mjs';

const fakeSpawn = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  child.pid = 7;
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
};

const executorFor = async (command, spawnImpl = fakeSpawn) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-shell-timeout-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: { shell: [command] }
  });
  const executor = new RestrictedWindowsExecutor({ monitor, platform: 'linux', spawnImpl });
  const lease = () => monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: [command] });
  return { workspace, executor, lease };
};

test('build commands get the configurable limit and other commands stay at 60 seconds', () => {
  assert.equal(isBuildClassCommand('cargo', ['build']), true);
  assert.equal(isBuildClassCommand('cargo', ['test']), true);
  assert.equal(isBuildClassCommand('cargo', ['tauri', 'build']), true);
  assert.equal(isBuildClassCommand('npm', ['install']), true);
  assert.equal(isBuildClassCommand('npm', ['ci']), true);
  assert.equal(isBuildClassCommand('npm', ['run', 'build']), true);
  assert.equal(isBuildClassCommand('npm', ['run', 'build:windows']), true);
  assert.equal(isBuildClassCommand('pnpm', ['install']), true);
  assert.equal(isBuildClassCommand('yarn', ['build']), true);
  assert.equal(isBuildClassCommand('npx', ['tauri', 'build']), true);
  assert.equal(isBuildClassCommand('npm', ['test']), false);
  assert.equal(isBuildClassCommand('npm', ['run', 'test']), false);
  assert.equal(isBuildClassCommand('cargo', ['check']), false);
  assert.equal(isBuildClassCommand('cargo', ['clippy']), false);

  const omitted = resolveShellTimeout({ command: 'cargo', args: ['build'] });
  assert.equal(omitted.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS);
  assert.equal(omitted.build, true);
  const legacy = resolveShellTimeout({ command: 'npm', args: ['run', 'build'], requested: 60 * 1000 });
  assert.equal(legacy.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS);
  assert.equal(legacy.raisedFromLegacyCap, true);
  const chosen = resolveShellTimeout({ command: 'cargo', args: ['test'], requested: 5000 });
  assert.equal(chosen.timeoutMs, 5000);
  const configured = resolveShellTimeout({
    command: 'cargo',
    args: ['build'],
    env: { DDA_BUILD_TIMEOUT_MS: '120000' }
  });
  assert.equal(configured.timeoutMs, 120000);
  assert.equal(configured.maxMs, 120000);
  assert.equal(resolveShellTimeout({ command: 'node', args: ['-v'] }).timeoutMs, 15 * 1000);
  assert.throws(() => resolveShellTimeout({ command: 'node', args: ['-v'], requested: 60 * 1000 + 1 }), /SAFETY_COMMAND_INVALID/);
  assert.match(timeoutFailureLine(120000, { build: true }), /120000/);
  assert.match(timeoutFailureLine(120000, { build: true }), /DDA_BUILD_TIMEOUT_MS/);
  assert.match(timeoutFailureLine(40), /40/);
});

test('a build reports the enforced timeout and a locked output explains the file in use', async () => {
  const { executor, lease } = await executorFor('cargo');
  const built = await executor.shell({ command: 'cargo', args: ['build'] }, { lease: lease() });
  assert.equal(built.timedOut, false);
  assert.equal(built.timeoutMs, DEFAULT_BUILD_TIMEOUT_MS);
  const chosen = await executor.shell({ command: 'cargo', args: ['build'], timeoutMs: 5000 }, { lease: lease() });
  assert.equal(chosen.timeoutMs, 5000);
  await assert.rejects(
    executor.shell({ command: 'cargo', args: ['check'], timeoutMs: 60001 }, { lease: lease() }),
    /SAFETY_COMMAND_INVALID/
  );

  const lockedText = annotateProcessFailure({
    stderr: 'LINK : fatal error LNK1104: cannot open file dda-desktop.exe',
    timedOut: true,
    timeoutMs: DEFAULT_BUILD_TIMEOUT_MS,
    build: true,
    hostPath: 'C:\\app\\dda-desktop.exe'
  });
  assert.match(lockedText, new RegExp(`EXECUTOR_TIMEOUT:[\\s\\S]*${DEFAULT_BUILD_TIMEOUT_MS}`));
  assert.match(lockedText, /EXECUTOR_OUTPUT_LOCKED/);
  assert.match(lockedText, /dda-desktop\.exe/);
  assert.match(lockedText, /CARGO_TARGET_DIR/);
  const sharing = explainLockedExecutable({ stderr: 'os error 32' });
  assert.match(sharing.message, /EXECUTOR_OUTPUT_LOCKED/);
  assert.match(sharing.message, /另一个程序正在使用此文件|正在被其他进程占用|正在使用中|正在被占用/);
});

test('refuses to rebuild the executable that is already running', async () => {
  const { workspace, executor, lease } = await executorFor('cargo', () => {
    throw new Error('spawned');
  });
  await writeFile(join(workspace, 'Cargo.toml'), '[package]\nname = "dda-desktop"\nversion = "0.1.0"\n', 'utf8');
  const releaseExe = join(workspace, 'target', 'release', 'dda-desktop.exe');
  const blocked = await executor.shell({
    command: 'cargo',
    args: ['build', '--release']
  }, { lease: lease(), hostExecutables: [releaseExe] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.stderr, /EXECUTOR_OUTPUT_LOCKED/);
  assert.match(blocked.stderr, /dda-desktop\.exe/);
  assert.match(blocked.stderr, /CARGO_TARGET_DIR/);

  let spawned = 0;
  const { workspace: releaseWorkspace, executor: releaseExecutor, lease: releaseLease } = await executorFor('cargo', () => {
    spawned += 1;
    return fakeSpawn();
  });
  await writeFile(join(releaseWorkspace, 'Cargo.toml'), '[package]\nname = "dda-desktop"\nversion = "0.1.0"\n', 'utf8');
  const debugExe = join(releaseWorkspace, 'target', 'debug', 'dda-desktop.exe');
  const built = await releaseExecutor.shell({
    command: 'cargo',
    args: ['build', '--release'],
    cwd: '.'
  }, { lease: releaseLease(), hostExecutables: [debugExe] });
  assert.equal(spawned, 1, built.stderr);
  assert.equal(built.ok, true);
  assert.doesNotMatch(built.stderr, /EXECUTOR_OUTPUT_LOCKED/);
});

test('the shell lease covers a build and the unrelated timeout layers stay put', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-build-lease-'));
  const short = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['cargo', 'node'],
    maxLeaseMs: 5 * 60 * 1000
  });
  const shortProvider = createExplicitLeaseProvider({
    monitor: short,
    capabilities: [CAPABILITIES.SHELL],
    commands: ['cargo', 'node']
  });
  await assert.rejects(
    shortProvider({ capability: CAPABILITIES.SHELL, request: { command: 'cargo', args: ['build'] } }),
    /SAFETY_INVALID_OPTIONS/
  );
  const nodeLease = await shortProvider({ capability: CAPABILITIES.SHELL, request: { command: 'node', args: ['-v'] } });
  const nodeTtl = nodeLease.expiresAt - Date.now();
  assert.ok(nodeTtl <= 61 * 1000 && nodeTtl > 50 * 1000);

  const long = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['cargo'],
    maxLeaseMs: DEFAULT_BUILD_TIMEOUT_MS
  });
  const longProvider = createExplicitLeaseProvider({
    monitor: long,
    capabilities: [CAPABILITIES.SHELL],
    commands: ['cargo']
  });
  const buildLease = await longProvider({ capability: CAPABILITIES.SHELL, request: { command: 'cargo', args: ['build'] } });
  assert.ok(buildLease.expiresAt - Date.now() > 14 * 60 * 1000);

  const root = fileURLToPath(new URL('../..', import.meta.url));
  const rust = await readFile(join(root, 'desktop/src-tauri/src/lib.rs'), 'utf8');
  const index = await readFile(join(root, 'runtime/src/index.mjs'), 'utf8');
  const monitor = await readFile(join(root, 'runtime/src/runtime-safety-monitor.mjs'), 'utf8');
  const tools = await readFile(join(root, 'runtime/src/controlled-tools.mjs'), 'utf8');
  assert.match(rust, /RUNTIME_HEARTBEAT_TIMEOUT_MS:\s*u64\s*=\s*30_000/);
  assert.match(index, /DDA_HEARTBEAT_INTERVAL_MS \?\? '2000'/);
  assert.match(index, /DDA_TASK_TIMEOUT_MS \?\? '0'/);
  assert.match(index, /APPROVAL_TTL_MS = 900_000/);
  assert.match(index, /maxLeaseMs: Math\.max\(5 \* 60 \* 1000, shellTimeoutConfig\(process\.env\)\.buildMaxMs/);
  assert.match(monitor, /options\.ttlMs \?\? options\.expiresInMs \?\? 60 \* 1000/);
  assert.match(tools, /timeoutMs: \{ type: 'integer', minimum: 1, maximum: 60 \* 60 \* 1000 \}/);
  assert.match(tools, /maximum: 60 \* 1000 \}/);
});
