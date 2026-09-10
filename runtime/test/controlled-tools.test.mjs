import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  EXECUTION_MODES,
  RuntimeSafetyMonitor,
  RestrictedWindowsExecutor
} from '../src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

const nodeCommand = process.execPath;

test('side-effect tools are registered behind the safety monitor and fail closed by default', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-tools-readonly-'));
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: workspace });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor);
  assert.deepEqual(registry.list().map((tool) => [tool.name, tool.readOnly]), [
    ['shell.execute', false],
    ['file.write', false],
    ['test.execute', false]
  ]);
  await assert.rejects(
    registry.invoke('shell.execute', { command: nodeCommand, args: ['-e', ''] }),
    /SAFETY_READ_ONLY/
  );
});

test('explicit capability and command approval issues one lease per tool invocation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-tools-approved-'));
  const target = join(workspace, 'result.txt');
  await writeFile(target, 'old', 'utf8');
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: []
  });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL, CAPABILITIES.WRITE_FILE],
      commands: ['node']
    })
  });
  const written = await registry.invoke('file.write', { path: 'result.txt', content: 'new' });
  assert.equal(written.bytesWritten, 3);
  assert.equal(await readFile(target, 'utf8'), 'new');
  const executed = await registry.invoke('shell.execute', {
    command: nodeCommand,
    args: ['-e', 'process.stdout.write("ok")']
  });
  assert.equal(executed.ok, true);
  assert.equal(executed.stdout, 'ok');
});

test('executor effect starts only after the lease-start durability callback resolves', async () => {
  const calls = [];
  let releaseClaim;
  const claimCommitted = new Promise((resolve) => { releaseClaim = resolve; });
  const executor = {
    async shell() { calls.push('effect'); return { ok: true, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'shell', cwd: '' }; },
    async writeFile() { return {}; },
    async test() { return {}; }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: async () => ({ token: 'lease-order' }),
    onLeaseStarted: async () => {
      calls.push('claim-start');
      await claimCommitted;
      calls.push('claim-committed');
    }
  });
  const invocation = registry.invoke('shell.execute', { command: nodeCommand });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['claim-start']);
  releaseClaim();
  await invocation;
  assert.deepEqual(calls, ['claim-start', 'claim-committed', 'effect']);
});

test('a failed lease-start durability callback prevents the executor effect', async () => {
  const calls = [];
  const executor = { async shell() { calls.push('effect'); return { ok: true }; }, async writeFile() { return {}; }, async test() { return {}; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: async () => ({ token: 'lease-no-effect' }),
    onLeaseStarted: async () => { throw new Error('LEASE_CLAIM_NOT_COMMITTED'); }
  });
  await assert.rejects(() => registry.invoke('shell.execute', { command: nodeCommand }), /TOOL_HANDLER_FAILED/);
  assert.deepEqual(calls, []);
});

test('denied approval creates no lease and executes no effect', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-tools-denied-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: workspace, commandAllowlist: [] });
  const calls = [];
  const executor = { async shell() { calls.push('effect'); return { ok: true }; }, async writeFile() { calls.push('effect'); return {}; }, async test() { calls.push('effect'); return {}; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({ monitor, capabilities: [CAPABILITIES.SHELL], commands: ['node'], requestApproval: async () => false, onLeaseIssued: () => calls.push('lease') })
  });
  await assert.rejects(() => registry.invoke('shell.execute', { command: nodeCommand, args: ['-e', ''] }), /SAFETY_LEASE_REQUIRED/);
  assert.deepEqual(calls, []);
});

test('lease provider failures invoke cleanup without replacing the original error', async () => {
  const calls = [];
  const executor = { async shell() { calls.push('effect'); return { ok: true }; }, async writeFile() { return {}; }, async test() { return {}; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: async () => { throw new Error('APPROVAL_STORAGE_FAILED'); },
    onLeaseFailed: async ({ error, lease }) => calls.push(['failed', error.message, lease])
  });
  await assert.rejects(() => registry.invoke('shell.execute', { command: nodeCommand }), /TOOL_HANDLER_FAILED/);
  assert.deepEqual(calls, [['failed', 'APPROVAL_STORAGE_FAILED', undefined]]);
});

test('lease start failures clean up before the effect runs', async () => {
  const calls = [];
  const executor = { async shell() { calls.push('effect'); return { ok: true }; }, async writeFile() { return {}; }, async test() { return {}; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: async () => ({ token: 'lease-1' }),
    onLeaseStarted: async () => { throw new Error('LEASE_CLAIM_PERSIST_FAILED'); },
    onLeaseFailed: async ({ error, lease }) => calls.push(['failed', error.message, lease?.token])
  });
  await assert.rejects(() => registry.invoke('shell.execute', { command: nodeCommand }), /TOOL_HANDLER_FAILED/);
  assert.deepEqual(calls, [['failed', 'LEASE_CLAIM_PERSIST_FAILED', 'lease-1']]);
});

test('cleanup failures do not replace the original handler failure', async () => {
  const executor = { async shell() { throw new Error('EXECUTOR_ORIGINAL_FAILURE'); }, async writeFile() { return {}; }, async test() { return {}; } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: async () => ({ token: 'lease-2' }),
    onLeaseStarted: async () => { throw new Error('LEASE_START_FAILURE'); },
    onLeaseFailed: async () => { throw new Error('CLEANUP_FAILURE'); }
  });
  await assert.rejects(() => registry.invoke('shell.execute', { command: nodeCommand }), /TOOL_HANDLER_FAILED/);
});

test('executor failures invoke lease cleanup and preserve the original error', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-tools-failure-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace
  });
  const calls = [];
  const executor = {
    async shell() { throw new Error('EXECUTOR_START_FAILED'); },
    async writeFile() { throw new Error('unused'); },
    async test() { throw new Error('unused'); }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL],
      commands: ['node']
    }),
    onLeaseStarted: ({ lease }) => calls.push(['started', Boolean(lease)]),
    onLeaseFailed: ({ error }) => calls.push(['failed', error.message])
  });
  await assert.rejects(
    registry.invoke('shell.execute', { command: nodeCommand }),
    /EXECUTOR_START_FAILED/
  );
  assert.deepEqual(calls, [['started', true], ['failed', 'EXECUTOR_START_FAILED']]);
});

test('workspace mutation lock is released after each controlled tool call', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-lock-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace,
    commandAllowlist: ['node']
  });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL],
      commands: ['node'],
      requestApproval: async () => true
    })
  });
  await registry.invoke('shell.execute', { command: nodeCommand, args: ['-e', 'process.exit(0)'] });
  await assert.doesNotReject(() => registry.invoke('shell.execute', { command: nodeCommand, args: ['-e', 'process.exit(0)'] }));
});
