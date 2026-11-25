import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';

const baseWorkspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [
    { path: 'desktop/src/main.ts', kind: 'FILE', sizeBytes: 64 },
    { path: 'desktop/src/domain', kind: 'DIR', sizeBytes: 0 }
  ],
  sections: []
};

async function withRunner(registry, providerPlugin, runOpts = {}) {
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({
      prompt: runOpts.prompt ?? 'focus escape fixture',
      workspace: baseWorkspace,
      onEvent: (e) => events.push(e),
      ...(runOpts.mode ? { mode: runOpts.mode } : {})
    });
    return { result, events };
  } finally {
    await root.fiber.dispose();
  }
}

function focusTool(handler) {
  const registry = new ToolRegistry();
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
    handler
  });
  return registry;
}

function infiniteFocusProvider(id, name = 'workspace.focus', argsForRound = (round) => ({
  path: `alias-${round}.ts`,
  findText: 'x'
})) {
  let round = 0;
  return cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: id,
      async *stream() {
        round += 1;
        yield {
          type: 'tool-call',
          id: `${id}-${round}`,
          name,
          arguments: JSON.stringify(argsForRound(round))
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, `${id}-provider`);
}

// T-fe-1: vacuum → every 4 rounds one host note (3×), then the turn concludes without failing
test('T-fe-1: vacuum budget sends three host notes then concludes without failing', async () => {
  const registry = focusTool(() => ({
    content: 'unchanging-window',
    found: true,
    offsetChars: 0,
    digest: 'sha256:same'
  }));
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(infiniteFocusProvider('fe-vacuum'));
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({
        prompt: 'vacuum until kill',
        workspace: baseWorkspace,
        onEvent: (e) => events.push(e)
      });
    const escapes = events.filter((e) => e.kind === 'harness.focus_vacuum_escape');
    assert.equal(escapes.length, 3);
    assert.equal(escapes[0].rounds, 4);
    assert.equal(events.filter((e) => e.kind === 'harness.focus_probe_escape').length, 0);
    assert.equal(events.filter((e) => e.kind === 'tool.result' && e.ok === true).length, 17);
  } finally {
    await root.fiber.dispose();
  }
});

// T-fe-2: probe → every 8 rounds one host note (3×), then the turn concludes without failing
test('T-fe-2: probe budget sends three host notes then concludes without failing', async () => {
  const registry = focusTool(() => {
    const err = new Error('EXCERPT_NOT_FOUND:locator');
    err.code = 'EXCERPT_NOT_FOUND';
    throw err;
  });
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(infiniteFocusProvider('fe-probe', 'workspace.focus', (round) => ({
    path: 'desktop/src/main.ts',
    findText: `miss-${round}`
  })));
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({
        prompt: 'probe until kill',
        workspace: baseWorkspace,
        onEvent: (e) => events.push(e)
      });
    const escapes = events.filter((e) => e.kind === 'harness.focus_probe_escape');
    assert.equal(escapes.length, 3);
    assert.equal(escapes[0].rounds, 8);
    assert.ok(Array.isArray(escapes[0].recentExcerptCodes));
    assert.ok(escapes[0].recentExcerptCodes.includes('EXCERPT_NOT_FOUND'));
    assert.equal(events.filter((e) => e.kind === 'harness.focus_vacuum_escape').length, 0);
    const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
    assert.equal(fails.length, 32);
    assert.equal(fails.every((f) => f.nextAction === 'RETRY_WITH_UNIQUE_LOCATOR_OR_LIST'), true);
  } finally {
    await root.fiber.dispose();
  }
});

// T-fe-3: an earlier write does not turn a read loop into a task failure
test('T-fe-3a: writes≥1 vacuum loop gets the same host notes and concludes', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'file.write',
    description: 'Write fixture.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    handler: ({ path, content }) => ({ ok: true, path, contentDigest: 'sha256:written' })
  });
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
    handler: () => ({
      content: 'unchanging-window',
      found: true,
      offsetChars: 0,
      digest: 'sha256:same'
    })
  });
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fe-write-vacuum',
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call',
            id: 'write-1',
            name: 'file.write',
            arguments: JSON.stringify({ path: 'desktop/src/main.ts', content: 'x' })
          };
        } else {
          yield {
            type: 'tool-call',
            id: `focus-${round}`,
            name: 'workspace.focus',
            arguments: JSON.stringify({ path: `alias-${round}.ts`, findText: 'x' })
          };
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fe-write-vacuum-provider');
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({
        prompt: 'write then vacuum',
        workspace: baseWorkspace,
        mode: 'CONTROLLED',
        onEvent: (e) => events.push(e)
      });
    assert.equal(events.filter((e) => e.kind === 'harness.focus_vacuum_escape').length, 3);
    assert.equal(events.filter((e) => e.kind === 'harness.focus_probe_escape').length, 0);
    assert.ok(events.some((e) => e.kind === 'tool.result' && e.name === 'file.write' && e.ok === true));
  } finally {
    await root.fiber.dispose();
  }
});

test('T-fe-3b: writes≥1 probe loop gets the same host notes and concludes', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'file.write',
    description: 'Write fixture.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    handler: ({ path }) => ({ ok: true, path, contentDigest: 'sha256:written' })
  });
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
    handler: () => {
      const err = new Error('EXCERPT_AMBIGUOUS:many');
      err.code = 'EXCERPT_AMBIGUOUS';
      throw err;
    }
  });
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fe-write-probe',
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call',
            id: 'write-1',
            name: 'file.write',
            arguments: JSON.stringify({ path: 'desktop/src/main.ts', content: 'x' })
          };
        } else {
          yield {
            type: 'tool-call',
            id: `focus-${round}`,
            name: 'workspace.focus',
            arguments: JSON.stringify({ path: 'desktop/src/main.ts', findText: `amb-${round}` })
          };
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fe-write-probe-provider');
  const events = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({
        prompt: 'write then probe',
        workspace: baseWorkspace,
        mode: 'CONTROLLED',
        onEvent: (e) => events.push(e)
      });
    assert.equal(events.filter((e) => e.kind === 'harness.focus_probe_escape').length, 3);
    assert.equal(events.filter((e) => e.kind === 'harness.focus_vacuum_escape').length, 0);
    const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
    assert.equal(fails.length, 32);
  } finally {
    await root.fiber.dispose();
  }
});

// T-fe-4 is covered by running focus-agent-miss / stalled-agent-miss / harness-t1-green suites.
test('T-fe-4 placeholder documents regression suite location', () => {
  assert.ok(true);
});
