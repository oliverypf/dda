import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { toolRegistryPlugin, ToolRegistry } from '../src/tool-registry.mjs';
import { registerExecutorTools, createExplicitLeaseProvider } from '../src/controlled-tools.mjs';
import { RuntimeSafetyMonitor, RestrictedWindowsExecutor, EXECUTION_MODES, CAPABILITIES } from '../src/safety-executor.mjs';

// Supervised project-archive run: two command denials previously returned only
// SAFETY_COMMAND_NOT_ALLOWED. Reproduce a denial with real executor leases and
// verify that the next model round can recover without expanding permissions.
test('command recovery harness exposes host constraints and preserves denied execution', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'dda-command-recovery-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot });
  const registry = new ToolRegistry({ allowSideEffects: true });
  const commands = ['node'];
  const leaseProvider = createExplicitLeaseProvider({ monitor, capabilities: [CAPABILITIES.TEST], commands });
  commands.push('unapproved-command');
  assert.deepEqual(leaseProvider.approvedCommands, ['node']);
  assert.equal(Object.isFrozen(leaseProvider.approvedCommands), true);
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), { leaseProvider });
  const root = new Context(); t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let rounds = 0;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { provider: 'fixture', model: 'command-recovery-fixture', protocol: 'fixture',
    async *stream(request) {
      const tool = request.tools.find(tool => tool.name === 'test.execute');
      assert.match(tool.description, /Lease-approved executables: \["node"\]/u);
      assert.match(tool.description, /argument separately/u);
      rounds++;
      if (rounds === 1) yield { type: 'tool-call', id: 'denied-command', name: 'test.execute',
        arguments: JSON.stringify({ command: 'unapproved-command', args: [], cwd: '.' }) };
      else if (rounds === 2) {
        const message = request.messages.filter(message => message.source?.kind === 'tool').at(-1);
        const result = JSON.parse(message.content[0].content[0].text);
        assert.equal(result.errorCode, 'SAFETY_COMMAND_NOT_ALLOWED');
        assert.equal(result.nextAction, 'USE_APPROVED_COMMAND_OR_WORKSPACE_TOOL');
        assert.deepEqual(result.approvedCommands, ['node']);
        assert.match(result.message, /do not repeat it unchanged or bypass/u);
        yield { type: 'tool-call', id: 'approved-command', name: 'test.execute',
          arguments: JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("verified")'], cwd: '.' }) };
      } else yield { type: 'text-delta', text: 'Verified using the approved command.' };
      yield { type: 'finish', reason: { kind: rounds < 3 ? 'tool-calls' : 'stop' } };
    }
  }), 'command-recovery-fixture'));
  await root.plugin(taskRunnerPlugin);
  const events = [];
  await root.taskRunner.run({ prompt: 'Run an approved verification command.', mode: 'CONTROLLED',
    workspace: { granted: true, rootLabel: 'Fixture', rootPath: workspaceRoot, entries: [], sections: [], snapshotDigest: 'sha256:fixture' },
    onEvent: event => events.push(event) });
  const results = events.filter(event => event.kind === 'tool.result');
  assert.equal(results[0].ok, false);
  assert.equal(results[0].errorCode, 'SAFETY_COMMAND_NOT_ALLOWED');
  assert.equal(results[1].ok, true);
  await assert.rejects(registry.invoke('test.execute', { command: 'unapproved-command', args: [], cwd: '.' }), /SAFETY_COMMAND_NOT_ALLOWED/u);
  await assert.rejects(registry.invoke('file.write', { path: 'denied.txt', content: 'denied' }), /SAFETY_LEASE_REQUIRED/u);
});

test('the model sees only lease-eligible effects; hidden effects still fail closed when guessed', async t => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'hmcodex-tool-availability-'));
  t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), { leaseProvider: createExplicitLeaseProvider({
    monitor, capabilities: [CAPABILITIES.TEST], commands: ['node']
  }) });
  const root = new Context(); t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let requests = 0;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { provider: 'fixture', model: 'availability-fixture', protocol: 'fixture',
    async *stream(request) {
      assert.deepEqual(request.tools.map(tool => tool.name), ['test.execute']);
      if (++requests === 1) yield { type: 'tool-call', id: 'actual-test', name: 'test.execute',
        arguments: JSON.stringify({ command: process.execPath, args: ['-e', 'process.stdout.write("verified")'], cwd: '.' }) };
      else yield { type: 'text-delta', text: 'Test verified.' };
      yield { type: 'finish', reason: { kind: requests === 1 ? 'tool-calls' : 'stop' } };
    }
  }), 'availability-fixture'));
  await root.plugin(taskRunnerPlugin);
  const events = [];
  await root.taskRunner.run({ prompt: 'Run the approved test.', mode: 'CONTROLLED',
    workspace: { granted: true, rootLabel: 'Fixture', rootPath: workspaceRoot, entries: [], sections: [], snapshotDigest: 'sha256:fixture' },
    onEvent: event => events.push(event) });
  assert.equal(events.find(event => event.kind === 'tool.result').ok, true);
  await assert.rejects(registry.invoke('shell.execute', { command: process.execPath, args: ['-e', ''] }), /SAFETY_LEASE_REQUIRED/u);
  await assert.rejects(registry.invoke('file.write', { path: 'denied.txt', content: 'denied' }), /SAFETY_LEASE_REQUIRED/u);
  for (const cwd of ['..', '../outside']) await assert.rejects(registry.invoke('test.execute', {
    command: process.execPath, args: ['-e', ''], cwd
  }), /SAFETY/u);
  await assert.rejects(monitor.canonicalPath('.'), /SAFETY_PATH_INVALID/u);
  assert.equal((await monitor.canonicalPath('.', { allowEmpty: true })).path, '');
});
