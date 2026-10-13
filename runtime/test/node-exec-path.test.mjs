import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxPosixExecutor } from '../src/platform/executor.mjs';
import { nodeSpawnCommand } from '../src/runtime-safety-monitor.mjs';
import { CAPABILITIES, EXECUTION_MODES, RestrictedWindowsExecutor, RuntimeSafetyMonitor } from '../src/safety-executor.mjs';

const shellToken = '$PATH/%PATH%';

const fakeNodeDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-fake-node-'));
  const file = join(directory, process.platform === 'win32' ? 'node.cmd' : 'node');
  const body = process.platform === 'win32'
    ? '@echo off\r\necho FAKE_NODE\r\nexit /b 9\r\n'
    : '#!/bin/sh\necho FAKE_NODE\nexit 9\n';
  await writeFile(file, body, 'utf8');
  await chmod(file, 0o755);
  return directory;
};

const monitorFor = (workspace, commands) => new RuntimeSafetyMonitor({
  mode: EXECUTION_MODES.CONTROLLED,
  workspaceRoot: workspace,
  commandAllowlist: commands
});

test('command allowlist accepts process.execPath as node and still matches bare node', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-execpath-allow-'));
  const monitor = monitorFor(workspace, ['node']);
  const byPath = await monitor.authorize('shell', { command: process.execPath, args: ['-e', ''] }, monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] }));
  assert.ok(['node', 'node.exe'].includes(byPath.command.commandName));
  const byName = await monitor.authorize('shell', { command: 'node', args: ['-v'] }, monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] }));
  assert.equal(byName.command.commandName, 'node');
  const byExe = await monitor.authorize('shell', { command: 'node.exe', args: ['-v'] }, monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] }));
  assert.equal(byExe.command.commandName, 'node.exe');

  const gitOnly = monitorFor(workspace, ['git']);
  await assert.rejects(
    gitOnly.authorize('shell', { command: process.execPath, args: ['-v'] }, gitOnly.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['git'] })),
    /SAFETY_COMMAND_NOT_ALLOWED/u
  );
  await assert.rejects(
    gitOnly.authorize('shell', { command: 'node', args: ['-v'] }, gitOnly.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['git'] })),
    /SAFETY_COMMAND_NOT_ALLOWED/u
  );
});

test('node spawn uses process.execPath with an args array and without a shell', async () => {
  assert.equal(nodeSpawnCommand('node'), process.execPath);
  assert.equal(nodeSpawnCommand('NODE.EXE'), process.execPath);
  assert.equal(nodeSpawnCommand(process.execPath), process.execPath);
  assert.equal(nodeSpawnCommand('git'), 'git');
  assert.equal(nodeSpawnCommand('npm'), 'npm');

  const fake = await fakeNodeDirectory();
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-execpath-spawn-'));
  const env = { PATH: fake, Path: fake };
  const executors = [
    (monitor) => new RestrictedWindowsExecutor({ monitor }),
    (monitor) => new LinuxPosixExecutor({ monitor })
  ];
  for (const create of executors) {
    for (const command of ['node', 'node.exe', process.execPath]) {
      const monitor = monitorFor(workspace, ['node']);
      const executor = create(monitor);
      const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
      const result = await executor.shell({
        command,
        args: ['-e', 'process.stdout.write(process.execPath + "\\n" + process.argv[1])', shellToken],
        env
      }, { lease });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, `${process.execPath}\n${shellToken}`);
      assert.equal(result.stdout.includes('FAKE_NODE'), false);
    }
  }
});

test('a node path containing spaces is spawned directly instead of through a shell', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-execpath-spaces-'));
  const parent = await mkdtemp(join(tmpdir(), 'hmcodex-spaced-node-'));
  const directory = join(parent, 'dir with spaces');
  await mkdir(directory);
  const command = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    await symlink(process.execPath, command);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.code ?? 'unknown'}`);
    return;
  }
  const monitor = monitorFor(workspace, ['node']);
  const executor = new RestrictedWindowsExecutor({ monitor });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['node'] });
  const result = await executor.shell({
    command,
    args: ['-e', 'process.stdout.write(process.execPath)']
  }, { lease });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, process.execPath);
});
