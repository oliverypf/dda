import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  EXECUTION_MODES,
  RuntimeSafetyMonitor
} from '../src/safety-executor.mjs';
import { createExplicitLeaseProvider } from '../src/controlled-tools.mjs';
import { executorToolsPlugin } from '../src/plugins/executor.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

test('executor plugin forwards lease failure cleanup to registered tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-executor-plugin-'));
  const monitor = new RuntimeSafetyMonitor({
    mode: EXECUTION_MODES.CONTROLLED,
    workspaceRoot: workspace
  });
  const calls = [];
  const executor = {
    monitor,
    async shell() { throw new Error('PLUGIN_EXECUTOR_FAILED'); },
    async writeFile() { throw new Error('unused'); },
    async test() { throw new Error('unused'); }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  const plugin = executorToolsPlugin({
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL],
      commands: ['node']
    }),
    onLeaseFailed: ({ error }) => calls.push(error.message)
  });

  plugin({ toolRegistry: registry, executor });
  await assert.rejects(
    registry.invoke('shell.execute', { command: process.execPath }),
    /TOOL_HANDLER_FAILED/
  );
  assert.deepEqual(calls, ['PLUGIN_EXECUTOR_FAILED']);
});
