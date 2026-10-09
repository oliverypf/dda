import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { createRuleVerifier } from '../src/rule-verifier.mjs';

const workspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [],
  sections: []
};

for (const scenario of [
  { mode: 'CONTROLLED', mutate: false, checkpoints: 1 },
  { mode: 'READ_ONLY', mutate: false, checkpoints: 0 },
  { mode: 'CONTROLLED', mutate: true, checkpoints: 0 }
]) {
  test(`inspection harness is advisory and mode-aware (${scenario.mode}, mutation=${scenario.mutate})`, async t => {
    const registry = new ToolRegistry({ allowSideEffects: true });
    const schema = { type: 'object', properties: { page: { type: 'integer' } }, required: ['page'] };
    registry.register({ name: 'workspace.read', description: 'Read a fixture page', readOnly: true,
      inputSchema: schema, handler: ({ page }) => ({ path: 'fixture.txt', content: `page ${page}` }) });
    let mutations = 0;
    registry.register({ name: 'file.write', description: 'Record a simulated mutation', readOnly: false,
      inputSchema: schema, handler: () => { mutations++; return { ok: true }; } });
    const root = new Context(); t.after(() => root.fiber.dispose());
    await root.plugin(toolRegistryPlugin(registry));
    let rounds = 0;
    const toolCount = scenario.mutate ? 9 : 8;
    await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { provider: 'fixture', protocol: 'fixture', model: 'progress-fixture',
      async *stream(request) {
        rounds++;
        if (rounds <= toolCount) yield { type: 'tool-call', id: `call-${rounds}`,
          name: scenario.mutate && rounds === 5 ? 'file.write' : 'workspace.read', arguments: JSON.stringify({ page: rounds }) };
        else {
          const checkpoints = request.messages.filter(message => message.role === 'user'
            && JSON.stringify(message.content).includes('HOST_PROGRESS_CHECKPOINT:'));
          assert.equal(checkpoints.length, scenario.checkpoints);
          if (checkpoints.length) {
            assert.match(JSON.stringify(checkpoints[0].content), /grants no permissions/u);
            assert.match(JSON.stringify(checkpoints[0].content), /analysis-only goals/u);
          }
          assert.equal(request.messages.filter(message => message.source?.kind === 'tool').length, toolCount);
          yield { type: 'text-delta', text: 'Report only the observed results.' };
        }
        yield { type: 'finish', reason: { kind: rounds <= toolCount ? 'tool-calls' : 'stop' } };
      }
    }), 'progress-fixture'));
    await root.plugin(taskRunnerPlugin);
    const events = [];
    await root.taskRunner.run({ prompt: 'Perform the requested scoped task.', workspace, mode: scenario.mode, onEvent: e => events.push(e) });
    assert.equal(events.filter(e => e.kind === 'harness.progress_checkpoint').length, scenario.checkpoints);
    assert.equal(events.filter(e => e.kind === 'tool.result').length, toolCount);
    assert.equal(mutations, scenario.mutate ? 1 : 0, 'checkpoint itself never invokes a mutation');
  });
}

for (const sample of [
  { name: 'test.execute', output: { ok: false, exitCode: 1, stdout: 'assertion failed', stderr: '', timedOut: false, aborted: false }, code: 'TEST_CHECK_FAILED', verifierStatus: 'CONTINUE' },
  { name: 'test.execute', output: { ok: false, exitCode: null, stdout: '', stderr: '', timedOut: true, aborted: false }, code: 'EXECUTOR_RESULT_FAILED', verifierStatus: 'FAIL' },
  { name: 'shell.execute', output: { ok: false, exitCode: 1, stdout: '', stderr: 'command failed', timedOut: false, aborted: false }, code: 'EXECUTOR_RESULT_FAILED', verifierStatus: 'FAIL' }
]) {
  test(`an unsuccessful ${sample.name} result is a failure (${sample.code}) despite a completed invocation`, async () => {
    const registry = new ToolRegistry({ allowSideEffects: true });
    registry.register({ name: sample.name, description: 'Process fixture', readOnly: false,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => sample.output });
    const events = [], requests = [];
    const providerPlugin = cordisPlugin(ctx => ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'process-result-fixture',
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) yield { type: 'tool-call', id: 'process-call', name: sample.name, arguments: '{}' };
        else yield { type: 'text-delta', text: 'The process failed; more work is required.' };
        yield { type: 'finish', reason: { kind: requests.length === 1 ? 'tool-calls' : 'stop' } };
      }
    }), 'process-result-fixture');
    const root = new Context();
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(providerPlugin);
    await root.plugin(taskRunnerPlugin);
    try {
      await root.taskRunner.run({ prompt: 'verify the actual process result', workspace, mode: 'CONTROLLED', onEvent: event => events.push(event) });
      const result = events.find(event => event.kind === 'tool.result');
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, sample.code);
      const tool = requests[1].messages.find(message => message.source?.kind === 'tool');
      assert.deepEqual(JSON.parse(tool.content[0].content[0].text), sample.output, 'native output stays unchanged for digest verification');
      const report = createRuleVerifier().verify({ prompt: 'verify', output: 'More evidence required', workspace,
        executionMode: 'CONTROLLED', actions: [{ name: sample.name, state: 'FAILED', errorCode: result.errorCode }] });
      assert.equal(report.status, sample.verifierStatus);
    } finally { await root.fiber.dispose(); }
  });
}

test('runs a model-requested tool and sends its result into the next round', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'fixture.echo',
    description: 'Echo fixture input.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 20 } },
      required: ['text'],
      additionalProperties: false
    },
    handler: ({ text }) => ({ text: text.toUpperCase() })
  });
  const requests = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture',
      protocol: 'fixture',
      model: 'fixture-model',
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool-call', id: 'call_fixture', name: 'fixture.echo', arguments: '{"text":"hello"}' };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', text: '工具结果已处理' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    });
  }, 'fixture-model');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({ prompt: 'run fixture', workspace });
    assert.equal(result.text, '工具结果已处理');
    assert.equal(result.toolRounds, 1);
    assert.equal(result.toolCallCount, 1);
    assert.equal(requests.length, 2);
    const assistant = requests[1].messages.find((message) => message.role === 'assistant');
    assert.equal(assistant.content.some((block) => block.type === 'tool-call' && block.id === 'call_fixture'), true);
    const toolResult = requests[1].messages.find((message) => message.source?.kind === 'tool');
    assert.equal(toolResult.content[0].toolCallId, 'call_fixture');
    assert.match(toolResult.content[0].content[0].text, /HELLO/);
  } finally {
    await root.fiber.dispose();
  }
});

test('READ_ONLY requests expose only read-only tools', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'fixture.read', description: 'Read-only fixture.', readOnly: true,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: () => ({ ok: true })
  });
  registry.register({
    name: 'shell.execute', description: 'Controlled fixture.', readOnly: false,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: () => ({ ok: true })
  });
  const requests = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream(request) {
        requests.push(request);
        yield { type: 'text-delta', text: '只读完成' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    });
  }, 'fixture-read-only-tools');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({ prompt: 'inspect', workspace, mode: 'READ_ONLY' });
    assert.deepEqual(requests[0].tools.map((tool) => tool.name), ['fixture.read']);
  } finally {
    await root.fiber.dispose();
  }
});

test('rejects a hidden side-effect tool call with an actionable mode error', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  let invoked = false;
  registry.register({
    name: 'shell.execute', description: 'Controlled fixture.', readOnly: false,
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: () => { invoked = true; return { ok: true }; }
  });
  const events = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream(request) {
        if (request.messages.some((message) => message.source?.kind === 'tool')) {
          yield { type: 'text-delta', text: '已收到只读模式限制' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        yield { type: 'tool-call', id: 'call-shell', name: 'shell.execute', arguments: '{}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-hidden-side-effect');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({ prompt: 'inspect', workspace, mode: 'READ_ONLY', onEvent: (event) => events.push(event) });
    const failure = events.find((event) => event.kind === 'tool.result');
    assert.equal(result.text, '已收到只读模式限制');
    assert.equal(failure.errorCode, 'TOOL_NOT_ALLOWED_IN_MODE');
    assert.equal(failure.mode, 'READ_ONLY');
    assert.match(failure.message, /shell\.execute.*READ_ONLY/);
    assert.equal(invoked, false);
  } finally {
    await root.fiber.dispose();
  }
});

test('stops repeated workspace requests after four rounds without new evidence', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.list', description: 'List fixture.', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [], additionalProperties: false },
    handler: ({ path = '' }) => ({ path, entries: [] })
  });
  const events = [];
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream() {
        round += 1;
        yield { type: 'tool-call', id: `call-list-${round}`, name: 'workspace.list', arguments: JSON.stringify({ path: `dir-${round}` }) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-no-new-evidence');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await assert.rejects(root.taskRunner.run({ prompt: 'inspect', workspace, onEvent: (event) => events.push(event) }), /TOOL_NO_NEW_EVIDENCE/);
    assert.equal(events.filter((event) => event.kind === 'tool.result').length, 5);
  } finally {
    await root.fiber.dispose();
  }
});

test('stops at the configured tool-round cap instead of allowing an unbounded loop', async () => {
  // 生产默认不限轮数；此用例显式设置上限来验证熔断行为本身。
  process.env.HMCODEX_MAX_TOOL_ROUNDS = '4';
  const registry = new ToolRegistry();
  registry.register({
    name: 'fixture.noop',
    description: 'No-op fixture.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    handler: () => ({ ok: true })
  });
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream() {
        yield { type: 'tool-call', id: `call_${Date.now()}_${Math.random()}`, name: 'fixture.noop', arguments: '{}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-loop');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await assert.rejects(root.taskRunner.run({ prompt: 'loop', workspace }), /TOOL_LOOP_LIMIT/);
  } finally {
    delete process.env.HMCODEX_MAX_TOOL_ROUNDS;
    await root.fiber.dispose();
  }
});

test('preserves recoverable tool error codes and lets the model switch paths', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'fixture.read',
    description: 'Read a fixture path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    },
    handler: ({ path }) => {
      if (path === 'unsupported.txt') {
        const error = new Error('WORKSPACE_UNSUPPORTED_FILE');
        error.code = 'WORKSPACE_UNSUPPORTED_FILE';
        throw error;
      }
      return { path, text: 'fixture content' };
    }
  });
  const events = [];
  const requests = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture',
      protocol: 'fixture',
      model: 'fixture-model',
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool-call', id: 'call_bad', name: 'fixture.read', arguments: '{"path":"unsupported.txt"}' };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        if (requests.length === 2) {
          yield { type: 'tool-call', id: 'call_good', name: 'fixture.read', arguments: '{"path":"README.md"}' };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', text: '已换用可读文件' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    });
  }, 'fixture-recoverable');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({
      prompt: 'recover from an unsupported file',
      workspace,
      onEvent: (event) => events.push(event)
    });
    assert.equal(result.text, '已换用可读文件');
    assert.equal(result.toolRounds, 2);
    const failedResult = events.find((event) => event.kind === 'tool.result' && event.id === 'call_bad');
    assert.equal(failedResult.ok, false);
    assert.equal(failedResult.errorCode, 'WORKSPACE_UNSUPPORTED_FILE');
    assert.match(failedResult.message, /WORKSPACE_UNSUPPORTED_FILE/);
    const goodResult = events.find((event) => event.kind === 'tool.result' && event.id === 'call_good');
    assert.equal(goodResult.ok, true);
    const actions = [
      { id: 'call_bad', name: 'fixture.read', state: 'FAILED', errorCode: failedResult.errorCode, argumentsDigest: `sha256:${'1'.repeat(64)}` },
      { id: 'call_good', name: 'fixture.read', state: 'SUCCEEDED', outputDigest: goodResult.outputDigest, argumentsDigest: `sha256:${'2'.repeat(64)}` }
    ];
    const verification = createRuleVerifier().verify({
      prompt: 'recover from an unsupported file',
      output: result.text,
      workspace,
      toolRounds: result.toolRounds,
      toolCallCount: result.toolCallCount,
      executionMode: 'READ_ONLY',
      actions
    });
    assert.equal(verification.status, 'CONTINUE');
    assert.equal(verification.failureCodes.includes('ACTION_FAILED'), false);
  } finally {
    await root.fiber.dispose();
  }
});
