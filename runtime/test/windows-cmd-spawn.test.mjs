import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor } from '../src/runtime-safety-monitor.mjs';
import { RestrictedWindowsExecutor } from '../src/restricted-windows-executor.mjs';
import { buildCmdCommandLine, escapeCmdArgument, planChildSpawn } from '../src/windows-cmd-spawn.mjs';

const found = (hits) => (candidate) => hits.has(candidate);

test('PATHEXT resolves npm.cmd and runs it through escaped cmd.exe argv', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD;.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
  const hits = new Set(['C:\\tools\\npm.CMD']);
  const plan = planChildSpawn({
    command: 'npm',
    args: ['install', 'left-pad'],
    platform: 'win32',
    env,
    fileExists: found(hits)
  });
  assert.equal(plan.shell, false);
  assert.equal(plan.viaCmd, true);
  assert.equal(plan.windowsVerbatimArguments, true);
  assert.equal(plan.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(plan.args[3], /npm\.CMD/);
  assert.match(plan.args[3], /left-pad/);
  assert.equal(plan.args[3].includes('&'), false);
});

test('PATHEXT order prefers an exe over a cmd shim', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.EXE;.CMD' };
  const hits = new Set(['C:\\tools\\npm.EXE', 'C:\\tools\\npm.CMD']);
  const plan = planChildSpawn({ command: 'npm', args: ['install'], platform: 'win32', env, fileExists: found(hits) });
  assert.equal(plan.viaCmd, false);
  assert.equal(plan.shell, false);
  assert.equal(plan.windowsVerbatimArguments, false);
  assert.equal(plan.file, 'C:\\tools\\npm.EXE');
  assert.deepEqual(plan.args, ['install']);
});

test('reversed PATHEXT selects the cmd shim', () => {
  const env = { PATH: 'C:\\tools', PATHEXT: '.CMD;.EXE' };
  const hits = new Set(['C:\\tools\\npm.EXE', 'C:\\tools\\npm.CMD']);
  const plan = planChildSpawn({ command: 'npm', args: ['-v'], platform: 'win32', env, fileExists: found(hits) });
  assert.equal(plan.viaCmd, true);
  assert.match(plan.args[3], /npm\.CMD/);
  assert.equal(plan.shell, false);
});

test('a missing npm shim still goes through cmd.exe instead of a direct spawn', () => {
  const plan = planChildSpawn({
    command: 'npm',
    args: ['install'],
    platform: 'win32',
    env: { PATH: 'C:\\empty', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    fileExists: () => false
  });
  assert.equal(plan.viaCmd, true);
  assert.equal(plan.shell, false);
  assert.match(plan.file, /cmd\.exe$/i);
  assert.match(plan.args[3], /"npm"/);
});

test('non-windows plans stay a direct argv spawn', () => {
  const plan = planChildSpawn({
    command: 'npm',
    args: ['install'],
    platform: 'linux',
    env: { PATH: '/usr/bin', PATHEXT: '.CMD' },
    fileExists: () => true
  });
  assert.deepEqual(plan, {
    file: 'npm',
    args: ['install'],
    shell: false,
    windowsVerbatimArguments: false,
    viaCmd: false,
    resolvedPath: null
  });
});

test('cmd metacharacters are caret-escaped and control characters are rejected', () => {
  assert.equal(escapeCmdArgument('a&b'), '"a"^&"b"');
  const line = buildCmdCommandLine('C:\\tools\\npm.cmd', ['a&b', '%PATH%', 'say "hi"']);
  assert.equal(line.includes('%PATH%'), false);
  assert.match(line, /\^%/);
  assert.match(line, /\^&/);
  assert.match(line, /""/);
  assert.equal(line.startsWith('"'), true);
  assert.equal(line.endsWith('"'), true);
  assert.throws(() => escapeCmdArgument('line\nbreak'), /SAFETY_COMMAND_INVALID/);
  assert.throws(() => planChildSpawn({ command: 'npm', args: ['ok\u0000'], platform: 'win32' }), /SAFETY_COMMAND_INVALID/);
});

test('the windows executor spawns the planned cmd.exe line with shell false', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-cmd-spawn-'));
  const seen = [];
  const spawnImpl = (file, args, options) => {
    seen.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.pid = 4242;
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: { shell: ['npm'] }
  });
  const executor = new RestrictedWindowsExecutor({
    monitor,
    platform: 'win32',
    spawnImpl,
    fileExists: (candidate) => candidate === 'C:\\tools\\npm.CMD'
  });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['npm'] });
  const result = await executor.shell({
    command: 'npm',
    args: ['install'],
    env: { PATH: 'C:\\tools', PATHEXT: '.CMD;.EXE', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
  }, { lease });
  assert.equal(result.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].file, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(seen[0].args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(seen[0].args[3], /npm\.CMD/);
  assert.match(seen[0].args[3], /install/);
  assert.equal(seen[0].options.shell, false);
  assert.equal(seen[0].options.windowsVerbatimArguments, true);
  assert.equal(JSON.stringify(seen[0].options).includes('"shell":true'), false);
});

test('the executor gives caller PATH and PATHEXT values precedence regardless of casing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-cmd-path-merge-'));
  const seen = [];
  const spawnImpl = (file, args, options) => {
    seen.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    child.pid = 4243;
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: { shell: ['npm'] }
  });
  const executor = new RestrictedWindowsExecutor({
    monitor,
    platform: 'win32',
    spawnImpl,
    fileExists: (candidate) => candidate === 'C:\\caller-tools\\npm.CMD'
  });
  const lease = monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['npm'] });
  const result = await executor.shell({
    command: 'npm',
    args: ['install'],
    env: {
      Path: 'C:\\inherited-tools',
      PATH: 'C:\\caller-tools',
      Pathext: '.EXE',
      PATHEXT: '.CMD',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe'
    }
  }, { lease });
  assert.equal(result.ok, true);
  assert.equal(seen[0].file, 'C:\\Windows\\System32\\cmd.exe');
  assert.match(seen[0].args[3], /npm\.CMD/);
  assert.equal(seen[0].options.env.PATH, 'C:\\caller-tools');
  assert.equal(seen[0].options.env.PATHEXT, '.CMD');
  assert.equal(Object.keys(seen[0].options.env).filter((key) => key.toLowerCase() === 'path').length, 1);
  assert.equal(Object.keys(seen[0].options.env).filter((key) => key.toLowerCase() === 'pathext').length, 1);
});
