import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { createTaskProgress, planRequiresWorkspaceMutation } from '../src/task-harness.mjs';

const workspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [{ path: 'runtime/src/index.mjs', kind: 'FILE', sizeBytes: 10 }],
  sections: []
};

const readSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    offset: { type: 'integer' }
  },
  required: ['path'],
  additionalProperties: false
};

function readRegistry(handler) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'kernel.workspace_read',
    description: 'Read fixture.',
    readOnly: true,
    inputSchema: readSchema,
    handler
  });
  return registry;
}

function scriptedProvider(id, calls) {
  let round = 0;
  return cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: id,
      async *stream() {
        const call = calls[round];
        round += 1;
        if (!call) {
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        yield { type: 'tool-call', id: `${id}-${round}`, name: call.name, arguments: JSON.stringify(call.arguments) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, `${id}-provider`);
}

async function runScripted({ id, registry, calls, requiresWorkspaceMutation = false }) {
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(scriptedProvider(id, calls));
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({
      prompt: 'inspect the resume failure',
      workspace,
      requiresWorkspaceMutation,
      onEvent: (event) => events.push(event)
    });
    return { result, events };
  } finally {
    await root.fiber.dispose();
  }
}

test('planRequiresWorkspaceMutation is true only when a later step must change files', () => {
  assert.equal(planRequiresWorkspaceMutation({
    steps: [
      { actionKind: 'DIAGNOSE' },
      { actionKind: 'IMPLEMENT' },
      { actionKind: 'VERIFY' }
    ]
  }), true);
  assert.equal(planRequiresWorkspaceMutation({
    steps: [{ actionKind: 'diagnose' }, { actionKind: 'inspect' }]
  }), false);
  assert.equal(planRequiresWorkspaceMutation(undefined), false);
});

test('kernel workspace reads count toward inspections since the last write', () => {
  const progress = createTaskProgress();
  for (let i = 0; i < 3; i += 1) {
    progress.observe({ kind: 'tool.result', payload: { name: 'kernel.workspace_read', ok: true } });
  }
  progress.observe({ kind: 'tool.result', payload: { name: 'kernel.workspace_list', ok: true } });
  progress.observe({ kind: 'tool.result', payload: { name: 'kernel.workspace_focus', ok: true } });
  assert.equal(progress.snapshot().inspectionsSinceWrite, 5);
  progress.observe({ kind: 'tool.result', payload: { name: 'file.write', ok: true } });
  assert.equal(progress.snapshot().inspectionsSinceWrite, 0);
});

test('repeated content is kept in task context and the task finishes instead of failing', async () => {
  const calls = [];
  for (let i = 0; i < 3; i += 1) {
    calls.push({ name: 'kernel.workspace_read', arguments: { path: 'runtime/src/index.mjs' } });
    if (i < 2) calls.push({ name: 'kernel.workspace_read', arguments: { path: `runtime/src/other-${i}.mjs` } });
  }
  const registry = readRegistry(({ path }) => ({
    path,
    content: path.endsWith('index.mjs') ? 'same-window' : `fresh-${path}`,
    found: true
  }));
  const { result, events } = await runScripted({ id: 'repeat-window', registry, calls });
  assert.match(result.text, /done|HOST_TASK_CONTEXT/);
  assert.ok(result.taskContextFacts.some((fact) => fact.path === 'runtime/src/index.mjs'));
  assert.equal(events.some((event) => String(event?.message ?? '').includes('TOOL_NO_NEW_EVIDENCE')), false);
});

test('different windows of the same file are not treated as a repeated read', async () => {
  const calls = [0, 1, 2, 3, 4].map((offset) => ({
    name: 'kernel.workspace_read',
    arguments: { path: 'runtime/src/index.mjs', offset }
  }));
  const registry = readRegistry(({ path, offset = 0 }) => ({
    path,
    content: `${path}#${offset}`,
    found: true
  }));
  const { events } = await runScripted({ id: 'new-windows', registry, calls });
  const results = events.filter((event) => event.kind === 'tool.result' && event.ok === true);
  assert.equal(results.length, 5);
  assert.equal(events.some((event) => String(event?.message ?? '').includes('TOOL_NO_NEW_EVIDENCE')), false);
});

test('a mutation plan finishes from recorded facts after 40 content reads with no write', async () => {
  const calls = Array.from({ length: 45 }, (_, index) => ({
    name: 'kernel.workspace_read',
    arguments: { path: `runtime/src/file-${index}.mjs` }
  }));
  const registry = readRegistry(({ path }) => ({ path, content: `body-${path}`, found: true }));
  const { result } = await runScripted({ id: 'zero-write', registry, calls, requiresWorkspaceMutation: true });
  assert.match(result.text, /HOST_TASK_CONTEXT|done/);
  assert.ok(result.taskContextFacts.length >= 24);
});

test('an analysis plan can keep reading new files past 40 without a write', async () => {
  const calls = Array.from({ length: 41 }, (_, index) => ({
    name: 'kernel.workspace_read',
    arguments: { path: `runtime/src/file-${index}.mjs` }
  }));
  const registry = readRegistry(({ path }) => ({ path, content: `body-${path}`, found: true }));
  const { events } = await runScripted({ id: 'analysis', registry, calls, requiresWorkspaceMutation: false });
  assert.equal(events.filter((event) => event.kind === 'tool.result' && event.ok === true).length, 41);
});

test('a mutation plan that already wrote a file is not stopped for later reads', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'file.write',
    description: 'Write fixture.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    },
    handler: ({ path }) => ({ ok: true, path, contentDigest: 'sha256:written' })
  });
  registry.register({
    name: 'kernel.workspace_read',
    description: 'Read fixture.',
    readOnly: true,
    inputSchema: readSchema,
    handler: ({ path }) => ({ path, content: `body-${path}`, found: true })
  });
  const calls = [
    { name: 'file.write', arguments: { path: 'runtime/src/index.mjs', content: 'fix' } },
    ...Array.from({ length: 41 }, (_, index) => ({
      name: 'kernel.workspace_read',
      arguments: { path: `runtime/src/file-${index}.mjs` }
    }))
  ];
  const { events } = await runScripted({ id: 'after-write', registry, calls, requiresWorkspaceMutation: true });
  assert.equal(events.filter((event) => event.kind === 'tool.result' && event.name === 'file.write' && event.ok === true).length, 1);
  assert.equal(events.filter((event) => event.kind === 'tool.result' && event.name === 'kernel.workspace_read' && event.ok === true).length, 41);
});
