import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES, RuntimeSafetyMonitor } from '../src/safety-executor.mjs';
import {
  RestrictedWindowsExecutor,
  SELF_TERMINATION_ERROR,
  parseSelfTerminationRequest
} from '../src/restricted-windows-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

test('self termination parser accepts only the current PID and optional force flag', () => {
  assert.deepEqual(
    parseSelfTerminationRequest({ commandName: 'taskkill.exe', args: ['/PID', '3708'], pid: 3708 }),
    { pid: 3708, force: false }
  );
  assert.deepEqual(
    parseSelfTerminationRequest({ commandName: 'taskkill', args: ['/PID', '3708', '/F'], pid: 3708 }),
    { pid: 3708, force: true }
  );
  assert.deepEqual(
    parseSelfTerminationRequest({ commandName: 'taskkill', args: ['/PID', '3708'], pid: 19112, ownedPids: [19112, 3708] }),
    { pid: 3708, force: false }
  );
  for (const args of [
    ['/PID', '3709'],
    ['/PID', '3708', '/T'],
    ['/PID', '3708', '/F', '/T'],
    ['/IM', 'dda.exe'],
    ['/PID', '3708', '3709']
  ]) {
    assert.equal(parseSelfTerminationRequest({ commandName: 'taskkill', args, pid: 3708 }), undefined, JSON.stringify(args));
  }
});

test('the controlled executor returns a self-termination receipt without spawning taskkill', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-self-termination-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace, commandAllowlist: ['taskkill'] });
  const seen = [];
  const executor = new RestrictedWindowsExecutor({
    monitor,
    onSelfTerminationRequested: request => { seen.push(request); }
  });
  const result = await executor.shell(
    { command: 'taskkill', args: ['/PID', String(process.pid)] },
    { lease: monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['taskkill'] }) }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.selfTermination, { state: 'REQUESTED', pid: process.pid, force: false, owner: 'runtime' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pid, process.pid);
});

test('taskkill for another process is rejected even with a taskkill lease', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-self-termination-reject-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace, commandAllowlist: ['taskkill'] });
  const executor = new RestrictedWindowsExecutor({
    monitor,
    onSelfTerminationRequested: () => { throw new Error('must not be called'); }
  });
  await assert.rejects(
    executor.shell(
      { command: 'taskkill', args: ['/PID', String(process.pid + 1)] },
      { lease: monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['taskkill'] }) }
    ),
    new RegExp(SELF_TERMINATION_ERROR)
  );
});

test('the controlled tool registry preserves the self-termination receipt schema', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-self-termination-tool-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace, commandAllowlist: ['taskkill'] });
  const executor = new RestrictedWindowsExecutor({ monitor, onSelfTerminationRequested: () => {} });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL],
      commands: ['taskkill']
    })
  });
  const result = await registry.invoke('shell.execute', {
    command: 'taskkill',
    args: ['/PID', String(process.pid)]
  });
  assert.equal(result.selfTermination.owner, 'runtime');
});

test('Windows desktop runtime accepts its parent DDA process as the owned target', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-self-termination-parent-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace, commandAllowlist: ['taskkill'] });
  const priorPlatform = process.env.DDA_PLATFORM;
  process.env.DDA_PLATFORM = 'windows-desktop';
  try {
    const executor = new RestrictedWindowsExecutor({ monitor, onSelfTerminationRequested: () => {} });
    const result = await executor.shell(
      { command: 'taskkill', args: ['/PID', String(process.ppid)] },
      { lease: monitor.issueLease({ capabilities: [CAPABILITIES.SHELL], commands: ['taskkill'] }) }
    );
    assert.equal(result.selfTermination.owner, 'desktop');
    assert.equal(result.selfTermination.pid, process.ppid);
  } finally {
    if (priorPlatform === undefined) delete process.env.DDA_PLATFORM;
    else process.env.DDA_PLATFORM = priorPlatform;
  }
});
