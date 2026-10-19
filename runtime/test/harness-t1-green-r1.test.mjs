import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin, createReadonlyToolRegistry } from '../src/tool-registry.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';

const baseWorkspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [{ path: 'desktop/src/domain/windows-desktop-cells.ts', kind: 'FILE', sizeBytes: 64 }],
  sections: []
};

// T-t1-1: missing path → WORKSPACE_* (not bare TOOL_HANDLER_FAILED)
test('T-t1-1: focus/read missing path returns WORKSPACE_* not TOOL_HANDLER_FAILED', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dda-t1-1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'desktop/src/domain'), { recursive: true });
  await writeFile(join(root, 'desktop/src/domain/windows-desktop-cells.ts'), 'export const finishedRead = () => true;\n');
  const workspace = new ReadonlyWorkspace(root);
  const registry = createReadonlyToolRegistry(workspace);

  await assert.rejects(
    registry.invoke('workspace.focus', { path: 'no/such/file.ts', findText: 'finishedRead' }),
    (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      assert.notEqual(error.code, 'TOOL_HANDLER_FAILED');
      assert.match(error.message, /^WORKSPACE_NOT_FOUND/);
      return true;
    }
  );
  await assert.rejects(
    registry.invoke('workspace.read', { path: 'missing.txt' }),
    (error) => {
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      assert.notEqual(error.code, 'TOOL_HANDLER_FAILED');
      return true;
    }
  );
  // Locator miss must also preserve a structured code (not collapse to TOOL_HANDLER_FAILED).
  await assert.rejects(
    registry.invoke('workspace.focus', {
      path: 'desktop/src/domain/windows-desktop-cells.ts',
      findText: 'DOES_NOT_EXIST_LOCATOR'
    }),
    (error) => {
      assert.equal(error.code, 'EXCERPT_NOT_FOUND');
      assert.notEqual(error.code, 'TOOL_HANDLER_FAILED');
      return true;
    }
  );
});

// T-t1-2: ≥3 WORKSPACE_NOT_FOUND focus → no TOOL_REPEATED_FAILURE; unrecoverable still hard-stops
test('T-t1-2: repeated WORKSPACE_NOT_FOUND focus does not TOOL_REPEATED_FAILURE; crash still does', async () => {
  const registry = new ToolRegistry();
  let focusCalls = 0;
  registry.register({
    name: 'workspace.focus',
    description: 'Focus fixture.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        findText: { type: 'string', minLength: 1 }
      },
      required: ['path', 'findText'],
      additionalProperties: false
    },
    handler: ({ path }) => {
      focusCalls += 1;
      if (path.startsWith('missing/')) throw new Error(`WORKSPACE_NOT_FOUND:${path}`);
      if (path === 'crash.ts') throw new Error('something exploded without a structured code');
      return { path, content: 'ok', found: true, offsetChars: 0, digest: 'sha256:x' };
    }
  });

  // Part A: ≥3× WORKSPACE_NOT_FOUND then succeed — must not hard-stop
  // (TOOL_NO_NEW_EVIDENCE threshold 4 stays unchanged; succeed before that trips.)
  {
    const events = [];
    let round = 0;
    const providerPlugin = cordisPlugin((ctx) => {
      ctx.provide('modelProvider', {
        provider: 'fixture', protocol: 'fixture', model: 't1-2a',
        async *stream(request) {
          round += 1;
          if (round <= 3) {
            yield {
              type: 'tool-call', id: `focus-miss-${round}`, name: 'workspace.focus',
              arguments: JSON.stringify({ path: `missing/file-${round}.ts`, findText: 'x' })
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          if (round === 4) {
            yield {
              type: 'tool-call', id: 'focus-ok', name: 'workspace.focus',
              arguments: JSON.stringify({ path: 'ok.ts', findText: 'x' })
            };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          yield { type: 'text-delta', text: 'recovered after probe misses' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      });
    }, 't1-2a-provider');
    const root = new Context();
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(providerPlugin);
    await root.plugin(taskRunnerPlugin);
    try {
      const result = await root.taskRunner.run({
        prompt: 'probe then recover',
        workspace: baseWorkspace,
        onEvent: (e) => events.push(e)
      });
      assert.equal(result.text, 'recovered after probe misses');
      const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
      assert.equal(fails.length, 3);
      for (const f of fails) assert.equal(f.errorCode, 'WORKSPACE_NOT_FOUND');
      assert.equal(events.some((e) => e.kind === 'run.failed'), false);
      assert.equal(
        events.some((e) => String(e?.error ?? e?.payload?.code ?? e?.payload?.error ?? '').includes('TOOL_REPEATED_FAILURE')),
        false
      );
    } finally {
      await root.fiber.dispose();
    }
  }

  // Part B: unstructured TOOL_HANDLER_FAILED ×3 → still hard-stops
  {
    focusCalls = 0;
    const events = [];
    let round = 0;
    const providerPlugin = cordisPlugin((ctx) => {
      ctx.provide('modelProvider', {
        provider: 'fixture', protocol: 'fixture', model: 't1-2b',
        async *stream() {
          round += 1;
          yield {
            type: 'tool-call', id: `focus-crash-${round}`, name: 'workspace.focus',
            arguments: JSON.stringify({ path: 'crash.ts', findText: 'x' })
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        }
      });
    }, 't1-2b-provider');
    const root = new Context();
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(providerPlugin);
    await root.plugin(taskRunnerPlugin);
    try {
      await assert.rejects(
        root.taskRunner.run({
          prompt: 'crash probe',
          workspace: baseWorkspace,
          onEvent: (e) => events.push(e)
        }),
        /TOOL_REPEATED_FAILURE:workspace\.focus:TOOL_HANDLER_FAILED/
      );
      const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
      assert.ok(fails.length >= 2);
      assert.equal(fails[0].errorCode, 'TOOL_HANDLER_FAILED');
    } finally {
      await root.fiber.dispose();
    }
  }
});
