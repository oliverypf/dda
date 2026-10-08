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
