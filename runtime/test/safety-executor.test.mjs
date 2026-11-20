import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ACTIONS,
  CAPABILITIES,
  EXECUTION_MODES,
  PolicyLease,
  RestrictedWindowsExecutor,
  RuntimeSafetyMonitor,
  SAFETY_ERROR_CODES
} from '../src/safety-executor.mjs';

const nodeCommand = process.execPath;

test('defaults to CONTROLLED but refuses every side effect without a lease', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-readonly-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace });
  assert.equal(monitor.mode, 'CONTROLLED');
  assert.deepEqual(EXECUTION_MODES, { CONTROLLED: 'CONTROLLED' });
  assert.throws(() => new RuntimeSafetyMonitor({ workspaceRoot: workspace, mode: 'READ_ONLY' }), /SAFETY_INVALID_OPTIONS:mode/);
  const executor = new RestrictedWindowsExecutor({ monitor });
  await assert.rejects(executor.shell({ command: nodeCommand, args: ['-e', 'process.exit(0)'] }), (error) => {
    assert.equal(error.code, SAFETY_ERROR_CODES.LEASE_REQUIRED);
    return true;
  });
  for (const action of Object.values(ACTIONS)) {
    await assert.rejects(monitor.authorize(action, {}), { code: SAFETY_ERROR_CODES.LEASE_REQUIRED });
  }
  await assert.rejects(executor.writeFile({ path: 'must-not-exist.txt', content: 'denied' }), { code: SAFETY_ERROR_CODES.LEASE_REQUIRED });
  await assert.rejects(readFile(join(workspace, 'must-not-exist.txt')), { code: 'ENOENT' });
});

test('authorizes independent commands in the same workspace without a shared lock', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-independent-'));
  const first = new RuntimeSafetyMonitor({ workspaceRoot: workspace });
  const second = new RuntimeSafetyMonitor({ workspaceRoot: workspace });
  const firstLease = first.issueLease({ capabilities: [CAPABILITIES.SHELL] });
  const secondLease = second.issueLease({ capabilities: [CAPABILITIES.SHELL] });
  const request = { command: 'node', args: ['--version'] };

  await assert.rejects(second.authorize(ACTIONS.SHELL, request, firstLease), { code: SAFETY_ERROR_CODES.LEASE_REQUIRED });
  await first.authorize(ACTIONS.SHELL, request, firstLease);
  await second.authorize(ACTIONS.SHELL, request, secondLease);
  await assert.rejects(second.authorize(ACTIONS.SHELL, request, secondLease), { code: SAFETY_ERROR_CODES.LEASE_USED });
});

test('runs an allowlisted command with bounded, redacted output in CONTROLLED mode', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-shell-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['node']
  });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  const result = await executor.shell({
    command: nodeCommand,
    args: ['-e', "console.log('api_key=private-value'); console.log('x'.repeat(1000))"],
    maxOutputChars: 80
  }, { lease });
  assert.equal(result.ok, true);
  assert.equal(result.action, ACTIONS.SHELL);
  assert.match(result.stdout, /api_key=\[REDACTED\]/i);
  assert.equal(result.truncated, true);
  assert.ok(result.stdout.length <= 80);
  assert.equal(result.cwd, '.');
  assert.equal(JSON.stringify(result).includes('private-value'), false);
});

test('binds lease channels and keeps cross-monitor leases fail-closed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-channel-'));
  const issuingMonitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['node'],
    releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED'
  });
  const executingMonitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['node'],
    releaseChannel: 'WINDOWS_FULL_LOCAL'
  });
  const lease = issuingMonitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  const executor = new RestrictedWindowsExecutor({ monitor: executingMonitor });
  assert.equal(lease.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.equal(executingMonitor.releaseChannel, 'WINDOWS_FULL_LOCAL');
  await assert.rejects(executor.shell({ command: nodeCommand }, { lease }), (error) => {
    assert.equal(error.code, 'SAFETY_LEASE_REQUIRED');
    return true;
  });
});

test('requires and consumes a one-shot lease for a non-allowlisted command', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-lease-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: [] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  await assert.rejects(executor.shell({ command: nodeCommand, args: ['-e', ''] }), /SAFETY_LEASE_REQUIRED/);
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'], ttlMs: 5000 });
  const first = await executor.shell({ command: nodeCommand, args: ['-e', 'process.stdout.write("ok")'] }, { lease });
  assert.equal(first.stdout, 'ok');
  await assert.rejects(executor.shell({ command: nodeCommand, args: ['-e', ''] }, { lease }), /SAFETY_LEASE_USED/);
});

test('rejects expired, forged, and cross-monitor leases', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-lease-boundary-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace });
  const otherMonitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace });
  const executor = new RestrictedWindowsExecutor({ monitor });
  assert.throws(() => new PolicyLease({ capabilities: [CAPABILITIES.SHELL], commands: [], expiresAt: Date.now() + 1000 }), /SAFETY_LEASE_INVALID/);
  const expired = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'], ttlMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(executor.shell({ command: nodeCommand, args: ['-e', ''] }, { lease: expired }), /SAFETY_LEASE_EXPIRED/);
  const foreign = otherMonitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  await assert.rejects(executor.shell({ command: nodeCommand, args: ['-e', ''] }, { lease: foreign }), /SAFETY_LEASE_REQUIRED/);
});

test('writes only inside the canonical workspace and records a digest, never content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-write-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] });
  await assert.rejects(executor.writeFile({ path: 'notes/result.txt', content: 'evidence' }, { lease }), /SAFETY_WORKSPACE_PARENT_NOT_FOUND/);
});

test('writes an existing workspace file and blocks traversal and sensitive paths', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-write-existing-'));
  const target = join(workspace, 'result.txt');
  await writeFile(target, 'old', 'utf8');
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] });
  const result = await executor.writeFile({ path: 'result.txt', content: 'new' }, { lease });
  assert.equal(result.ok, true);
  assert.equal(result.path, 'result.txt');
  assert.equal(result.bytesWritten, 3);
  assert.equal(await readFile(target, 'utf8'), 'new');
  await assert.rejects(executor.writeFile({ path: '../outside.txt', content: 'x' }, { lease: monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] }) }), /SAFETY_PATH_INVALID/);
  await assert.rejects(executor.writeFile({ path: '.env', content: 'x' }, { lease: monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] }) }), /SAFETY_WORKSPACE_SENSITIVE_PATH/);
});

test('rejects Git metadata and symlinked workspace paths before lease consumption', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-path-boundary-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace });
  const executor = new RestrictedWindowsExecutor({ monitor });
  await assert.rejects(
    executor.writeFile({ path: '.git/config', content: 'blocked' }, { lease: monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] }) }),
    /SAFETY_WORKSPACE_GIT_METADATA/
  );
  const outside = await mkdtemp(join(tmpdir(), 'hmcodex-safety-link-target-'));
  const link = join(workspace, 'linked');
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip('symlink creation unavailable: ' + (error.code ?? 'unknown'));
    return;
  }
  await assert.rejects(
    executor.writeFile({ path: 'linked/result.txt', content: 'blocked' }, { lease: monitor.issueLease({ capabilities: [CAPABILITIES.WRITE_FILE] }) }),
    /SAFETY_WORKSPACE_LINK_FORBIDDEN/
  );
});

test('test execution is scoped to a child directory and timeout is bounded', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-test-'));
  const child = await mkdtemp(join(workspace, 'child-'));
  const childName = child.slice(workspace.length + 1);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: { test: ['node'] } });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
  const result = await executor.test({ command: nodeCommand, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: childName }, { lease });
  assert.equal(result.ok, true);
  assert.equal(result.action, ACTIONS.TEST);
  assert.equal(result.cwd, childName);
  assert.match(result.stdout, /child-/i);
  const timeoutLease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
  const timed = await executor.test({ command: nodeCommand, args: ['-e', 'setTimeout(() => {}, 1000)'], timeoutMs: 40 }, { lease: timeoutLease });
  assert.equal(timed.ok, false);
  assert.equal(timed.timedOut, true);

  const abortController = new AbortController();
  const abortLease = monitor.issueLease({ capabilities: [CAPABILITIES.TEST], commands: ['node'] });
  const pending = executor.test({ command: nodeCommand, args: ['-e', 'setTimeout(() => {}, 1000)'] }, {
    lease: abortLease,
    signal: abortController.signal
  });
  setTimeout(() => abortController.abort(), 20);
  const aborted = await pending;
  assert.equal(aborted.ok, false);
  assert.equal(aborted.aborted, true);
});

test('timeout clears a detached grandchild process tree', { skip: process.platform !== 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-process-tree-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: { shell: ['node'] }
  });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  const childSource = `
    import { spawn } from 'node:child_process';
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    grandchild.unref();
    console.log(grandchild.pid);
  `;
  const result = await executor.shell({
    command: nodeCommand,
    args: ['--input-type=module', '-e', childSource],
    timeoutMs: 60
  }, { lease });
  assert.equal(result.timedOut, true);
  const grandchildPid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, 'grandchild pid was reported');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    let stillAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      stillAlive = false;
    }
    if (!stillAlive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('detached grandchild survived the Windows process-tree cleanup');
});

const provisionedCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const provisionedNpxCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const hostCliAvailable = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const windowsCliTest = { skip: process.platform !== 'win32' || !hostCliAvailable(provisionedCli) || !hostCliAvailable(provisionedNpxCli) };

test('maps bare npm/npx commands to the provisioned Node CLI on Windows', windowsCliTest, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-npm-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: ['node'] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  for (const [command, leaseCommands] of [['npm', ['npm']], ['npm.cmd', ['npm']], ['npx.cmd', ['npx']]]) {
    const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: leaseCommands });
    const result = await executor.shell({ command, args: ['--version'], timeoutMs: 15000 }, { lease });
    assert.equal(result.ok, true, command);
    assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/u, command);
    // One-shot lease is consumed by the first authorized execution.
    await assert.rejects(executor.shell({ command, args: ['--version'] }, { lease }), /SAFETY_LEASE_USED/);
  }
});

test('a node-scoped lease cannot authorize npm before the CLI mapping', windowsCliTest, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-npm-deny-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: ['node'] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  await assert.rejects(executor.shell({ command: 'npm', args: ['--version'] }, { lease }), { code: 'SAFETY_COMMAND_NOT_ALLOWED' });
});

test('spawn failures keep the generic code with a bounded OS reason only', { skip: process.platform !== 'win32' }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-safety-spawn-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: [] });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const missing = 'dda-missing-tool-zz42';
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: [missing] });
  await assert.rejects(executor.shell({ command: missing, args: ['--secret-arg', 'api_key=private-value'] }, { lease }), (error) => {
    assert.equal(error.code, 'EXECUTOR_SPAWN_FAILED');
    assert.equal(error.message, 'EXECUTOR_SPAWN_FAILED:ENOENT');
    assert.equal(error.message.includes(workspace), false);
    assert.equal(error.message.includes('private-value'), false);
    return true;
  });
});
