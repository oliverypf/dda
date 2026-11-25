import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { createRuleVerifier } from '../src/rule-verifier.mjs';
import { RuntimeSafetyMonitor, RestrictedWindowsExecutor } from '../src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { RestrictedNetworkAdapter } from '../src/restricted-network-adapter.mjs';

const workspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [],
  sections: []
};

const repairSource = 'src/normalizer.mjs';
const repairCheck = 'node --test test/normalizer.test.mjs';
const unrelatedCheck = 'node --test test/format.test.mjs';
const fixPrompt = 'Fix the normalizer so it reports the correct record count, then run its tests.';
const initialCount = 'return 1;';
const partialFix = 'return records.length - 1;';
const completeFix = 'return records.length;';
const failedAssertion = 'normalization must retain both records';

function editCount(oldText, newText) {
  return ['file.patch', { path: repairSource, replacements: [{ oldText, newText }] }];
}

function checkCount(command = repairCheck) {
  return ['shell.execute', { command }];
}

async function runRepairFixture(t, { prompt = fixPrompt, originalGoal, requiresWorkspaceMutation, turns }) {
  const registry = new ToolRegistry({ allowSideEffects: true });
  let implementation = initialCount;
  const checks = [];
  registry.register({
    name: 'file.patch', description: 'Edit the normalizer fixture.', readOnly: false,
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, replacements: { type: 'array' } } },
    handler: ({ path, replacements: [{ oldText, newText }] }) => {
      assert.equal(path, repairSource);
      assert.equal(oldText, implementation);
      implementation = newText;
      return { ok: true, action: 'patch_file', path, diff: `-${oldText}\n+${newText}\n` };
    }
  });
  registry.register({
    name: 'shell.execute', description: 'Run a fixture test.', readOnly: false,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    handler: ({ command }) => {
      assert.ok([repairCheck, unrelatedCheck].includes(command));
      const ok = command === unrelatedCheck || implementation === completeFix;
      checks.push({ command, ok });
      return { ok, cwd: '.', exitCode: ok ? 0 : 1, stderr: '', stdout: ok ? 'ok 1\n1..1\n# pass 1\n# fail 0' : [
        'TAP version 13', 'not ok 1 - normalizer counts records', '  ---',
        `  error: '${failedAssertion}'`, '  code: ERR_ASSERTION', '  expected: 2', '  actual: 1', '  ...',
        '1..1', '# pass 0', '# fail 1'
      ].join('\n') };
    }
  });
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let requests = 0;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture',
    async *stream({ messages }) {
      const turn = turns[requests++];
      assert.ok(turn, 'unexpected additional model turn');
      const response = typeof turn === 'function' ? turn(messages) : turn;
      if (typeof response === 'string') {
        yield { type: 'text-delta', text: response };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else {
        const [name, args] = response;
        yield { type: 'tool-call', id: `call-${requests}`, name, arguments: JSON.stringify(args) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
  }), 'repair-fixture'));
  await root.plugin(taskRunnerPlugin);
  const result = await root.taskRunner.run({
    prompt, originalGoal, workspace, requiresWorkspaceMutation, taskClass: 'test', maxToolRounds: 10
  });
  assert.equal(requests, turns.length);
  return { result, checks };
}

for (const otherPasses of [false, true]) {
  const scenario = otherPasses ? ' after an unrelated test passed' : '';
  test(`failed retest resumes repair using the assertion and previous patch${scenario}`, async t => {
    const turns = [editCount(initialCount, partialFix), checkCount()];
    if (otherPasses) turns.push(checkCount(unrelatedCheck));
    turns.push('The normalization test still fails.', messages => {
      const context = messages.at(-1).content.map(part => part.text).join('\n');
      assert.ok(context.includes(failedAssertion), 'continue with the specific failed assertion');
      assert.ok(context.includes(repairSource) || context.includes(partialFix), 'identify the prior patch');
      assert.match(context, /hypothes|different.{0,40}(cause|approach)|revise.{0,40}(cause|approach)|假设/i);
      assert.match(context, /re-?(run|test)|run.{0,45}(again|same)|复测|重跑/i);
      return editCount(partialFix, completeFix);
    }, checkCount(), 'The normalization test now passes.');
    const options = otherPasses
      ? { originalGoal: fixPrompt, prompt: 'Run the normalizer tests and report their results.' }
      : { requiresWorkspaceMutation: true };
    const { result, checks } = await runRepairFixture(t, { turns, ...options });
    assert.equal(result.text, 'The normalization test now passes.');
    assert.deepEqual(checks, [
      { command: repairCheck, ok: false },
      ...(otherPasses ? [{ command: unrelatedCheck, ok: true }] : []),
      { command: repairCheck, ok: true }
    ]);
  });
}

test('a second early conclusion after an edit prompts a retest of that edit', async t => {
  const resume = /previous answer stopped.*unresolved/i;
  const promptText = messages => messages.at(-1).content.map(part => part.text).join('\n');
  const { result, checks } = await runRepairFixture(t, { turns: [
    editCount(initialCount, partialFix), checkCount(),
    messages => {
      assert.doesNotMatch(promptText(messages), resume);
      return 'The first fix failed.';
    },
    messages => {
      assert.match(promptText(messages), resume);
      return editCount(partialFix, completeFix);
    },
    messages => {
      assert.doesNotMatch(promptText(messages), resume);
      return 'I have now updated the implementation.';
    },
    messages => {
      const text = promptText(messages);
      assert.match(text, resume);
      assert.match(text, /rerun the recorded target/i);
      assert.ok(text.includes('test/normalizer.test.mjs'));
      return checkCount();
    },
    'Verified the new implementation.'
  ] });
  assert.equal(result.text, 'Verified the new implementation.');
  assert.deepEqual(checks, [{ command: repairCheck, ok: false }, { command: repairCheck, ok: true }]);
});

for (const prompt of ['Run the normalizer test and report the observed failure. Do not modify any files.',
  'Run tests for the previous fix and report failures.']) {
  test(`a diagnostic-only test failure can finish with the observed failure: ${prompt}`, async t => {
    const report = 'The normalizer expected two records and observed one.';
    const { result, checks } = await runRepairFixture(t, {
      prompt, requiresWorkspaceMutation: false, turns: [checkCount(), report]
    });
    assert.equal(result.text, report);
    assert.deepEqual(checks, [{ command: repairCheck, ok: false }]);
  });
}

test('consecutive failure reports without new evidence stop after one repair continuation', async t => {
  const finalReport = 'Normalization remains unresolved: the expected count was two and the actual count was one.';
  const { result, checks } = await runRepairFixture(t, { turns: [
    editCount(initialCount, partialFix), checkCount(), 'The test is still failing.', finalReport
  ] });
  assert.equal(result.text, finalReport);
  assert.deepEqual(checks, [{ command: repairCheck, ok: false }]);
});

test('executor receives observed artifact facts separately from native process output', async t => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  const output = { ok: true, cwd: '.', exitCode: 0, stdout: 'builder printed an unverified path: draft.pptx' };
  registry.register({ name: 'shell.execute', description: 'Build fixture', readOnly: false,
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, handler: () => output });
  const root = new Context(); t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let withReceipt = true;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { model: 'fixture', provider: 'fixture',
    async *stream({ messages }) {
      const result = messages.find(message => message.source?.kind === 'tool');
      if (result) {
        assert.deepEqual(JSON.parse(result.content[0].content[0].text), output);
        const context = messages.at(-1).content[0].text;
        if (withReceipt) {
          assert.match(context, /docs\/observed.pptx/);
          assert.match(context, /"slideCount":12/);
          assert.match(context, /opening a desktop application require separate observations/);
          assert.doesNotMatch(context, /draft.pptx|private-root/);
        } else assert.doesNotMatch(context, /observed.pptx|separate observations/);
        yield { type: 'text-delta', text: 'Finished.' };
      } else yield { type: 'tool-call', id: 'call-build', name: 'shell.execute', arguments: JSON.stringify({ command: 'node docs/build-deck.mjs' }) };
      yield { type: 'finish', reason: { kind: result ? 'stop' : 'tool-calls' } };
    }
  }), 'build-facts-fixture'));
  await root.plugin(taskRunnerPlugin);
  const run = () => root.taskRunner.run({ prompt: 'Build the deck and report observations.', workspace,
    onToolResult: ({ buildTest }) => withReceipt ? { ...buildTest, artifacts: [{ path: 'docs/observed.pptx',
      absolutePath: '/private-root/docs/observed.pptx', sizeBytes: 26559, disposition: 'GENERATED',
      sha256: `sha256:${'f'.repeat(64)}`, pptx: { slideCount: 12, entryCount: 35 } }] } : undefined });
  const result = await run();
  assert.equal(result.taskContextFacts.length, 1);
  assert.equal(result.taskContextFacts[0].receipt.artifacts[0].sizeBytes, 26559);
  withReceipt = false;
  assert.equal((await run()).taskContextFacts[0].receipt, undefined);
});

test('fact refresh retains the step prompt and split DSML retries through the provider', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(new ToolRegistry()));
  let requests = 0;
  let repeatMarkup = false;
  const deltas = [];
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture',
    async *stream({ messages }) {
      requests++;
      assert.match(JSON.stringify(messages), /Read the outline/u);
      assert.match(messages.at(-1).content.map(part => part.text).join('\n'), /native tool-call interface|Current step objective: Read the outline/u);
      assert.match(messages.at(-1).content.map(part => part.text).join('\n'), /native tool-call interface|Current user goal: Build the requested presentation/u);
      if (requests === 1 || repeatMarkup) {
        yield { type: 'text-delta', text: repeatMarkup ? '<tool_' : '<｜DS' };
        yield { type: 'text-delta', text: repeatMarkup ? 'call>secret' : 'ML｜ calls><｜DSML｜ invoke' };
      } else {
        assert.match(JSON.stringify(messages), /native tool-call interface/u);
        yield { type: 'text-delta', text: 'Recovered.' };
      }
    }
  }), 'step-fixture'));
  await root.plugin(taskRunnerPlugin);
  const options = {
    workspace, prompt: 'Read the outline', originalGoal: 'Build the requested presentation', stepObjective: 'Read the outline',
    historyContext: 'HOST_TASK_CONTEXT: earlier read results',
    taskContextFacts: [{ key: 'path:docs', path: 'docs', tool: 'workspace.list' }],
    maxToolRounds: 4,
    onEvent(event) { if (event.kind === 'model.text_delta') deltas.push(event.text); }
  };
  assert.equal((await root.taskRunner.run(options)).text, 'Recovered.');
  assert.equal(deltas.join(''), 'Recovered.');
  repeatMarkup = true;
  await assert.rejects(root.taskRunner.run(options), /MODEL_TOOL_CALL_IN_TEXT/u);
  assert.equal(requests, 4);
});

test('current-fact lookup switches search engines and reads another page before answering', async t => {
  const networkTargets = [
    { host: 'html.duckduckgo.com' },
    { host: 'mcp.exa.ai', methods: ['POST'] },
    { host: 'pricing.example.com' }
  ];
  const monitor = new RuntimeSafetyMonitor({ mode: 'CONTROLLED', workspaceRoot: process.cwd(), networkTargets });
  const requests = [];
  const adapter = new RestrictedNetworkAdapter({
    monitor,
    lookup: async () => [{ address: '93.184.216.34' }],
    fetch: async (url, request) => {
      requests.push(new URL(url).hostname + new URL(url).pathname);
      if (url.includes('duckduckgo.com')) {
        return new Response('<form id="challenge-form">Verify that you are human</form>', { status: 202 });
      }
      if (url.includes('mcp.exa.ai')) {
        assert.equal(request.method, 'POST');
        assert.equal(JSON.parse(request.body).params.name, 'web_search_exa');
        const result = { content: [{ type: 'text', text: [
          'Title: Market pricing\nURL: https://pricing.example.com/dynamic\nHighlights:\nModel pricing',
          'Title: Pricing reference\nURL: https://pricing.example.com/reference\nHighlights:\nPricing table'
        ].join('\n\n') }] };
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`);
      }
      if (url.endsWith('/dynamic')) return new Response('<html><body><noscript>Enable JavaScript</noscript><div id="app"></div></body></html>');
      return new Response(`<html><body><main><p>${'Unrelated page content. '.repeat(40)}</p><table><tr><td>Model</td><td>Input</td><td>8</td></tr></table></main><script>untrusted-script</script></body></html>`);
    }
  });
  const registry = new ToolRegistry({ allowSideEffects: true });
  let approvalGranted = true;
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), {
    networkAdapter: adapter,
    leaseProvider: createExplicitLeaseProvider({
      monitor, capabilities: ['network.request'], networkTargets, requestApproval: async () => approvalGranted
    })
  });
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  const calls = [
    ['web.search', { query: 'model pricing', engine: 'duckduckgo' }],
    null,
    ['web.search', { query: 'model pricing' }],
    ['web.fetch', { url: 'https://pricing.example.com/dynamic' }]
  ];
  let round = 0;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', protocol: 'fixture', model: 'lookup-fixture',
    async *stream(request) {
      const step = calls[round++];
      const context = JSON.stringify(request.messages);
      if (round < 5) {
        assert.ok(request.tools.some(tool => tool.name === 'web.fetch'));
        assert.ok(!request.tools.some(tool => tool.name === 'shell.execute'));
      }
      if (round === 2) assert.match(context, /WEB_SOURCE_CHALLENGE/u);
      if (round === 3) assert.match(context, /HOST_LOOKUP_FOLLOWUP/u);
      if (round === 4) assert.match(context, /pricing.example.com\/dynamic/u);
      if (round === 5) assert.match(context, /WEB_PAGE_EMPTY/u);
      if (round === 5) {
        assert.equal(request.tools.length, 0);
        assert.match(context, /Input \| 8/u);
        assert.doesNotMatch(context, /untrusted-script/u);
      }
      if (step) yield { type: 'tool-call', id: `lookup-${round}`, name: step[0], arguments: JSON.stringify(step[1]) };
      else yield { type: 'text-delta', text: round === 2 ? 'premature answer' : 'Verified price: 8.' };
      yield { type: 'finish', reason: { kind: step ? 'tool-calls' : 'stop' } };
    }
  }), 'lookup-fixture'));
  await root.plugin(taskRunnerPlugin);

  const reviewedUrls = [];
  const pageEvidence = [];
  const result = await root.taskRunner.run({
    prompt: 'What is the current model price?', workspace, taskClass: 'query', readOnlyStep: true,
    onToolCall: ({ networkUrl }) => { reviewedUrls.push(networkUrl); },
    onToolResult: ({ name, decisionClaim }) => { if (name === 'web.fetch') pageEvidence.push(decisionClaim); }
  });
  assert.equal(result.text, 'Verified price: 8.');
  assert.deepEqual(requests, ['html.duckduckgo.com/html/', 'mcp.exa.ai/mcp', 'pricing.example.com/dynamic', 'pricing.example.com/reference']);
  assert.deepEqual(reviewedUrls, requests.map(url => `https://${url}`));
  assert.match(pageEvidence.at(-1), /pricing.example.com\/reference/u);
  assert.match(pageEvidence.at(-1), /Model \| Input \| 8/u);
  assert.doesNotMatch(pageEvidence.at(-1), /Unrelated page content/u);

  approvalGranted = false;
  await assert.rejects(registry.invoke('web.fetch', { url: 'https://pricing.example.com/reference' }), /SAFETY_LEASE_REQUIRED/u);
  await assert.rejects(registry.invoke('web.fetch', { url: 'http://127.0.0.1/private' }), /SAFETY_NETWORK_INVALID/u);
  assert.equal(requests.length, 4);
});

for (const scenario of [
  { mode: 'CONTROLLED', mutate: false, checkpoints: 1 },
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
  { name: 'test.execute', args: {}, output: { ok: false, exitCode: 1, stdout: 'assertion failed', stderr: '', timedOut: false, aborted: false }, code: 'TEST_CHECK_FAILED', verifierStatus: 'CONTINUE' },
  { name: 'test.execute', args: {}, output: { ok: false, exitCode: 101, stdout: 'partial build log', stderr: '', timedOut: true, aborted: false, timeoutMs: 60000 }, code: 'EXECUTOR_RESULT_FAILED', verifierStatus: 'FAIL' },
  { name: 'shell.execute', args: { command: 'fixture' }, output: { ok: false, exitCode: 1, stdout: '', stderr: 'command failed', timedOut: false, aborted: false }, code: 'EXECUTOR_RESULT_FAILED', verifierStatus: 'FAIL' },
  { name: 'network.request', args: { host: 'example.com' }, output: { ok: false, status: 403, aborted: false, timedOut: false, truncated: false, body: '', durationMs: 12, action: 'network' }, code: 'NETWORK_HTTP_STATUS', verifierStatus: 'FAIL', message: /^HTTP 403$/ }
]) {
  test(`an unsuccessful ${sample.name} result is a failure (${sample.code}) despite a completed invocation`, async () => {
    const registry = new ToolRegistry({ allowSideEffects: true });
    registry.register({ name: sample.name, description: 'Process fixture', readOnly: false,
      inputSchema: sample.name === 'shell.execute'
        ? { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false }
        : sample.name === 'network.request'
          ? { type: 'object', properties: { host: { type: 'string' } }, required: ['host'], additionalProperties: false }
          : { type: 'object', properties: {}, additionalProperties: false },
      handler: () => sample.output });
    const events = [], requests = [];
    const providerPlugin = cordisPlugin(ctx => ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'process-result-fixture',
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) yield { type: 'tool-call', id: 'process-call', name: sample.name, arguments: JSON.stringify(sample.args) };
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
      if (sample.output.timedOut === true) {
        assert.equal(result.timedOut, true, 'timeout fact reaches the model');
        assert.equal(result.timeoutMs, 60000, 'actual deadline reported');
        assert.match(result.message, /execution deadline|Partial filesystem changes/, 'deadline message not a bare exit code');
      }
      if (sample.message) assert.match(result.message, sample.message);
      if (sample.code === 'NETWORK_HTTP_STATUS') assert.doesNotMatch(result.message, /exit code|process returned/i);
      const tool = requests[1].messages.find(message => message.source?.kind === 'tool');
      assert.deepEqual(JSON.parse(tool.content[0].content[0].text), sample.output, 'native output stays unchanged for digest verification');
      const report = createRuleVerifier().verify({ prompt: 'verify', output: 'More evidence required', workspace,
        executionMode: 'CONTROLLED', actions: [{ name: sample.name, state: 'FAILED', errorCode: result.errorCode }] });
      assert.equal(report.status, 'PASS');
      assert.deepEqual(report.failureCodes, []);
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

test('rewrites absolute paths for kernel.workspace_* the same way as workspace.*', async () => {
  const seen = [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'kernel.workspace_read', description: 'Kernel read fixture.', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    handler: ({ path }) => { seen.push(path); return { path, content: 'ok' }; }
  });
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream(request) {
        if (request.messages.some((message) => message.source?.kind === 'tool')) {
          yield { type: 'text-delta', text: 'read done' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        yield {
          type: 'tool-call', id: 'call_abs', name: 'kernel.workspace_read',
          arguments: JSON.stringify({ path: '/workspace/README.md' })
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-kernel-abs-path');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({
      prompt: 'read',
      workspace: { ...workspace, root: '/workspace' },
      mode: 'CONTROLLED'
    });
    assert.equal(result.text, 'read done');
    assert.deepEqual(seen, ['README.md']);
  } finally {
    await root.fiber.dispose();
  }
});

test('default requests advertise available tools while retired modes are rejected', async () => {
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
    await root.taskRunner.run({ prompt: 'inspect', workspace });
    assert.deepEqual(requests[0].tools.map((tool) => tool.name), ['fixture.read', 'shell.execute']);
    await assert.rejects(root.taskRunner.run({ prompt: 'inspect', workspace, mode: 'READ_ONLY' }), /EXECUTION_MODE_INVALID/);
    assert.equal(requests.length, 1);
  } finally {
    await root.fiber.dispose();
  }
});

test('a guessed side-effect tool still requires a host lease in the default mode', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, new RestrictedWindowsExecutor({
    monitor: new RuntimeSafetyMonitor({ workspaceRoot: process.cwd() })
  }));
  const events = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream(request) {
        if (request.messages.some((message) => message.source?.kind === 'tool')) {
          yield { type: 'text-delta', text: '缺少执行租约' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        yield { type: 'tool-call', id: 'call-shell', name: 'shell.execute', arguments: '{"command":"node","args":["-e","process.exit(99)"]}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-hidden-side-effect');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({ prompt: 'inspect', workspace, onEvent: (event) => events.push(event) });
    const failure = events.find((event) => event.kind === 'tool.result');
    assert.equal(result.text, '缺少执行租约');
    assert.equal(failure.errorCode, 'SAFETY_LEASE_REQUIRED');
  } finally {
    await root.fiber.dispose();
  }
});

test('repeated workspace requests without new evidence conclude the turn instead of failing', async () => {
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
    await root.taskRunner.run({ prompt: 'inspect', workspace, onEvent: (event) => events.push(event) });
    // Every 4 no-evidence rounds send one host note; after three notes the
    // turn concludes without tools instead of failing the task.
    assert.equal(events.filter((event) => event.kind === 'harness.focus_vacuum_escape').length, 3);
    assert.equal(events.filter((event) => event.kind === 'tool.result').length, 17);
  } finally {
    await root.fiber.dispose();
  }
});

test('stops at the configured tool-round cap instead of allowing an unbounded loop', async () => {
  // 生产默认不限轮数；此用例显式设置上限来验证熔断行为本身。
  process.env.DDA_MAX_TOOL_ROUNDS = '4';
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
    delete process.env.DDA_MAX_TOOL_ROUNDS;
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
      executionMode: 'CONTROLLED',
      actions
    });
    assert.equal(verification.status, 'PASS');
    assert.deepEqual(verification.failureCodes, []);
  } finally {
    await root.fiber.dispose();
  }
});

for (const outcome of ['APPROVAL_EXPIRED', 'APPROVAL_DENIED']) {
  test(`a ${outcome} tool failure stops the run after one failed tool.result instead of re-planning`, async () => {
    const registry = new ToolRegistry({ allowSideEffects: true });
    const counters = { shell: 0, writeFile: 0, test: 0, approvals: 0, leases: 0 };
    const executor = {
      shell: async () => { counters.shell += 1; return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false }; },
      writeFile: async () => { counters.writeFile += 1; return { ok: true, action: 'write_file', path: 'out.txt', bytesWritten: 1, contentDigest: 'sha256:x' }; },
      test: async () => { counters.test += 1; return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false }; }
    };
    const monitor = new RuntimeSafetyMonitor({ mode: 'CONTROLLED', workspaceRoot: process.cwd() });
    const leaseProvider = createExplicitLeaseProvider({
      monitor,
      capabilities: ['shell.execute', 'file.write'],
      commands: ['node'],
      gateDecisionFor: () => ({ requireApproval: true }),
      onLeaseIssued: () => { counters.leases += 1; },
      requestApproval: async ({ onApprovalFailure }) => {
        counters.approvals += 1;
        onApprovalFailure?.(outcome);
        return false;
      }
    });
    registerExecutorTools(registry, executor, { leaseProvider });
    const root = new Context();
    const requests = [];
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'approval-stop-fixture',
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: 'tool-call', id: 'call-shell', name: 'shell.execute', arguments: JSON.stringify({ command: 'node' }) };
          yield { type: 'tool-call', id: 'call-write', name: 'file.write', arguments: JSON.stringify({ path: 'out.txt', content: 'x' }) };
        } else {
          yield { type: 'tool-call', id: `call-extra-${requests.length}`, name: 'shell.execute', arguments: JSON.stringify({ command: 'node' }) };
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }), 'approval-stop-fixture'));
    await root.plugin(taskRunnerPlugin);
    const events = [];
    const failure = await root.taskRunner.run({
      prompt: 'Perform the requested scoped task.', workspace, mode: 'CONTROLLED',
      onEvent: (e) => events.push(e)
    }).then(() => undefined, (error) => error);
    assert.equal(failure?.code, outcome);
    assert.equal(requests.length, 1, 'no second model turn after a terminal approval outcome');
    assert.equal(counters.approvals, 1, 'exactly one approval request was evaluated');
    const results = events.filter((e) => e.kind === 'tool.result');
    assert.equal(results.length, 1, 'the second tool call is never executed');
    assert.equal(results[0].name, 'shell.execute');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].errorCode, outcome);
    assert.equal(results[0].nextAction, 'WAIT_FOR_USER_APPROVAL');
    assert.match(results[0].message, outcome === 'APPROVAL_EXPIRED' ? /expired before authorization/ : /declined this approval/);
    assert.equal(counters.shell, 0);
    assert.equal(counters.writeFile, 0);
    assert.equal(counters.test, 0);
    assert.equal(counters.leases, 0);
    root.fiber.dispose();
  });
}

test('a new run with an explicitly approved request still executes once (no sticky approval poison)', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  const counters = { shell: 0, approvals: 0, leases: 0 };
  const executor = {
    shell: async () => { counters.shell += 1; return { ok: true, exitCode: 0, stdout: 'done', stderr: '', timedOut: false, aborted: false }; },
    writeFile: async () => ({ ok: true, action: 'write_file', path: 'out.txt', bytesWritten: 1, contentDigest: 'sha256:x' }),
    test: async () => ({ ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false })
  };
  const monitor = new RuntimeSafetyMonitor({ mode: 'CONTROLLED', workspaceRoot: process.cwd() });
  const leaseProvider = createExplicitLeaseProvider({
    monitor,
    capabilities: ['shell.execute', 'file.write'],
    commands: ['node'],
    gateDecisionFor: () => ({ requireApproval: true }),
    onLeaseIssued: () => { counters.leases += 1; },
    requestApproval: async () => { counters.approvals += 1; return true; }
  });
  registerExecutorTools(registry, executor, { leaseProvider });
  const root = new Context();
  const requests = [];
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', protocol: 'fixture', model: 'approval-pass-fixture',
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'tool-call', id: 'call-shell', name: 'shell.execute', arguments: JSON.stringify({ command: 'node' }) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        yield { type: 'text-delta', text: 'Completed the approved command.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }), 'approval-pass-fixture'));
  await root.plugin(taskRunnerPlugin);
  await root.taskRunner.run({ prompt: 'Run the approved command once.', workspace, mode: 'CONTROLLED' });
  assert.equal(requests.length, 2);
  assert.equal(counters.approvals, 1);
  assert.equal(counters.leases, 1);
  assert.equal(counters.shell, 1, 'the approved executor call ran exactly once');
  root.fiber.dispose();
});

test('recovery continuation keeps the system prompt byte-identical', async () => {
  const { createRecoveryContext } = await import('../src/task-recovery-controller.mjs');
  const recovery = createRecoveryContext({ status: 'CONTINUE' }, {
    previousActions: [{ name: 'shell.execute', state: 'FAILED', argumentsDigest: 'a', errorCode: 'EXECUTOR_RESULT_FAILED', timedOut: true }]
  });
  const captured = [];
  const runOnce = async (rec) => {
    const root = new Context();
    await root.plugin(toolRegistryPlugin(new ToolRegistry({ allowSideEffects: true })));
    await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { provider: 'fixture', protocol: 'fixture', model: 'prompt-fixture',
      async *stream(request) { captured.push({ system: request.system, messages: request.messages }); yield { type: 'text-delta', text: 'done' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    }), 'prompt-fixture'));
    await root.plugin(taskRunnerPlugin);
    await root.taskRunner.run({ prompt: 'work the task', workspace, mode: 'CONTROLLED', recovery: rec, onEvent: () => {} });
    await root.fiber.dispose();
  };
  await runOnce(undefined);
  await runOnce(recovery);
  assert.equal(captured[0].system, captured[1].system, 'system prompt identical with and without recovery');
  const last = captured[1].messages.at(-1);
  const lastText = typeof last?.content?.[0]?.text === 'string' ? last.content[0].text : JSON.stringify(last?.content ?? '');
  assert.ok(lastText.startsWith('The host is continuing verifier recovery of the same task.'), 'instruction is the first line of the recovery message');
  assert.ok(lastText.includes('HOST_VERIFIER_CONTINUATION'), 'continuation facts follow the instruction');
  const plain = captured[0].messages.at(-1);
  const plainText = typeof plain?.content?.[0]?.text === 'string' ? plain.content[0].text : JSON.stringify(plain?.content ?? '');
  assert.ok(!plainText.includes('continuing verifier recovery'), 'no recovery message without recovery');
});

test('shell.execute events carry bounded command fields and failure outputTail', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'shell.execute',
    description: 'Fixture process tool.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' }
      },
      required: ['command'],
      additionalProperties: false
    },
    handler: ({ command }) => ({
      ok: false, exitCode: 1, timedOut: false, aborted: false,
      stdout: `ran ${command}`, stderr: `BUILD FAILURE\n${'stack '.repeat(300)}tail-marker`
    })
  });
  const events = [];
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
      async *stream(request) {
        if (request.messages.some((message) => message.source?.kind === 'tool')) {
          yield { type: 'text-delta', text: 'The command failed.' };
          yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        yield {
          type: 'tool-call', id: 'call_shell', name: 'shell.execute',
          arguments: JSON.stringify({ command: 'npm', args: ['run', 'build'], cwd: 'C:/work/app' })
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fixture-model');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({ prompt: 'build it', workspace, onEvent: (event) => events.push(event) });
    const requested = events.find((event) => event.kind === 'tool.call_requested' && event.name === 'shell.execute');
    assert.equal(requested.command, 'npm');
    assert.deepEqual(requested.args, ['run', 'build']);
    assert.equal(requested.cwd, 'C:/work/app');
    const result = events.find((event) => event.kind === 'tool.result' && event.name === 'shell.execute');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.equal(result.command, 'npm');
    assert.deepEqual(result.args, ['run', 'build']);
    assert.equal(result.cwd, 'C:/work/app');
    // Both streams are preserved in a labeled, bounded tail: the stderr
    // marker survives its section and the stdout tail ends the block.
    assert.ok(result.outputTail.includes('[stderr]'));
    assert.ok(result.outputTail.includes('tail-marker'));
    assert.ok(result.outputTail.includes('[stdout]'));
    assert.ok(result.outputTail.length <= 800);
  } finally {
    await root.fiber.dispose();
  }
});

test('failure lesson suggestedPath only surfaces evidence-backed snapshot matches', async () => {
  const { mkdtemp: mktmp } = await import('node:fs/promises');
  const { tmpdir: osTmpdir } = await import('node:os');
  const { join: pathJoin } = await import('node:path');
  const lessonStore = pathJoin(await mktmp(pathJoin(osTmpdir(), 'hmcodex-lessons-')), 'lessons.json');
  const snapshotWorkspace = {
    ...workspace,
    entries: [
      { path: 'desktop/package.json', kind: 'FILE', sizeBytes: 1 },
      { path: 'runtime/package.json', kind: 'FILE', sizeBytes: 1 },
      { path: 'desktop/src/main.ts', kind: 'FILE', sizeBytes: 1 }
    ]
  };
  const runRead = async (requestedPath) => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'workspace.read', description: 'fixture read', readOnly: true,
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      handler: ({ path }) => { throw new Error(`WORKSPACE_NOT_FOUND:${path}`); }
    });
    const requests = [];
    const root = new Context();
    await root.plugin(toolRegistryPlugin(registry));
    await root.plugin(cordisPlugin((ctx) => {
      ctx.provide('modelProvider', {
        provider: 'fixture', protocol: 'fixture', model: 'fixture-model',
        async *stream(request) {
          requests.push(request);
          if (requests.length === 1) {
            yield { type: 'tool-call', id: 'call_read', name: 'workspace.read', arguments: JSON.stringify({ path: requestedPath }) };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
            return;
          }
          yield { type: 'text-delta', text: 'done' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      });
    }, 'fixture-model'));
    await root.plugin(taskRunnerPlugin);
    const events = [];
    try {
      await root.taskRunner.run({ prompt: 'read it', workspace: snapshotWorkspace, onEvent: (event) => events.push(event) });
      const toolMessage = requests[1].messages.find((message) => message.source?.kind === 'tool');
      const output = JSON.parse(toolMessage.content[0].content[0].text);
      const requested = events.find((event) => event.kind === 'tool.call_requested');
      const resultEvent = events.find((event) => event.kind === 'tool.result');
      output.__requestedPath = requested?.path;
      output.__resultPath = resultEvent?.path;
      output.__prompt = JSON.stringify(requests[0].messages);
      return output;
    } finally {
      await root.fiber.dispose();
    }
  };
  const prevStore = process.env.DDA_FAILURE_LESSON_STORE;
  process.env.DDA_FAILURE_LESSON_STORE = lessonStore;
  try {
    // repeated root label in the request resolves to the unique suffix match
    const suffix = await runRead('hmCodex-local/desktop/package.json');
    assert.equal(suffix.suggestedPath, 'desktop/package.json');
    // bare basename resolves only when the snapshot has exactly one such file
    const basename = await runRead('main.ts');
    assert.equal(basename.suggestedPath, 'desktop/src/main.ts');
    const ambiguous = await runRead('package.json');
    assert.equal(ambiguous.suggestedPath, undefined);
    // nothing in the snapshot → no synthesized path
    const missing = await runRead('totally/missing/file.txt');
    assert.equal(missing.suggestedPath, undefined);
    assert.ok((missing.matchingPaths ?? []).every((p) => snapshotWorkspace.entries.some((e) => e.path === p)));
    snapshotWorkspace.omittedDirectories = ['desktop/node_modules', 'desktop/src-tauri/target', 'desktop/dist'];
    const generatedChild = await runRead('desktop/node_modules/playwright');
    assert.equal(generatedChild.suggestedPath, 'desktop/node_modules');
    assert.match(generatedChild.message, /desktop\/node_modules/);
    assert.match(generatedChild.message, /do not treat them as missing/);
    assert.match(generatedChild.__prompt, /directory desktop\/node_modules \(exists; contents omitted\)/);
    assert.match(generatedChild.__prompt, /Do not call it missing/);
    const generatedExact = await runRead('desktop/src-tauri/target/release/dda-desktop.exe');
    assert.equal(generatedExact.suggestedPath, 'desktop/src-tauri/target');
    // structured path flows on both the request and the result events
    assert.equal(missing.__requestedPath, 'totally/missing/file.txt');
    assert.equal(missing.__resultPath, 'totally/missing/file.txt');
  } finally {
    if (prevStore === undefined) delete process.env.DDA_FAILURE_LESSON_STORE;
    else process.env.DDA_FAILURE_LESSON_STORE = prevStore;
  }
});

test('a bound executor hides undeclared tools and rejects provider requests for them', async t => {
  const registry = new ToolRegistry();
  let calls = 0;
  for (const name of ['workspace.read', 'other.read']) {
    registry.register({ name, description: name, readOnly: true, inputSchema: { type: 'object', properties: {} },
      handler() { calls++; return { ok: true }; } });
  }
  const root = new Context(); t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(registry));
  let round = 0;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', { provider: 'fixture', model: 'fixture',
    async *stream({ tools }) {
      if (round++ === 0) {
        assert.deepEqual(tools.map(tool => tool.name), ['workspace.read']);
        yield { type: 'tool-call', id: 'call-outside', name: 'other.read', arguments: '{}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else yield { type: 'text-delta', text: 'Access was blocked.' };
    }
  }), 'bound-executor-fixture'));
  await root.plugin(taskRunnerPlugin);
  const events = [];
  await root.taskRunner.run({ workspace, prompt: 'Inspect the source', executorTools: ['workspace.read'], onEvent: event => events.push(event) });
  assert.equal(calls, 0);
  assert.equal(events.find(event => event.kind === 'tool.result').errorCode, 'TOOL_OUTSIDE_EXECUTION_SCOPE');
});

test('a repair loads source through tools while retaining the file index and prior findings', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const registry = new ToolRegistry();
  registry.register({ name: 'workspace.read', description: 'Read a file', readOnly: true,
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: ({ path }) => ({ path, content: 'requested source marker' }) });
  await root.plugin(toolRegistryPlugin(registry));
  const requests = [];
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture', async *stream({ messages }) {
      requests.push(JSON.stringify(messages));
      if (requests.length === 1) yield { type: 'tool-call', id: 'read-source', name: 'workspace.read', arguments: '{"path":"src/target.mjs"}' };
      else yield { type: 'text-delta', text: 'Inspected source.' };
      yield { type: 'finish', reason: { kind: requests.length === 1 ? 'tool-calls' : 'stop' } };
    }
  }), 'repair-source-fixture'));
  await root.plugin(taskRunnerPlugin);
  for (const intent of [{ originalGoal: 'Fix the failing test.' }, { requiresWorkspaceMutation: true }]) {
    requests.length = 0;
    await root.taskRunner.run({ prompt: 'Locate the failure', ...intent,
      workspace: { ...workspace, entries: [{ path: 'src/target.mjs', kind: 'FILE' }],
        sections: [{ path: 'unrelated.mjs', digest: 'sha256:fixture', content: 'unsolicited source marker' }] },
      historyContext: 'prior test result marker' });
    assert.equal(requests.length, 2);
    assert.match(requests[0], /src\/target\.mjs/u);
    assert.match(requests[0], /prior test result marker/u);
    assert.doesNotMatch(requests[0], /unsolicited source marker|requested source marker/u);
    assert.match(requests[1], /requested source marker/u);
  }
});

test('a normal task does not receive unsolicited workspace file contents', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(new ToolRegistry()));
  let request;
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture', async *stream({ messages }) {
      request = JSON.stringify(messages);
      yield { type: 'text-delta', text: 'Acknowledged.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }), 'no-unsolicited-workspace-context-fixture'));
  await root.plugin(taskRunnerPlugin);
  await root.taskRunner.run({
    prompt: '关闭 QQ 的开机启动',
    workspace: {
      ...workspace,
      entries: [{ path: 'docs/WINDOWS_TESTING_WORKFLOW.md', kind: 'FILE' }],
      sections: [{ path: 'docs/WINDOWS_TESTING_WORKFLOW.md', digest: 'sha256:fixture', content: 'project build instructions' }]
    }
  });
  assert.match(request, /Workspace file contents are withheld from the initial prompt/u);
  assert.doesNotMatch(request, /project build instructions/u);
});

test('long bound workflows preserve authenticated prerequisite findings in the executor request', async t => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(toolRegistryPlugin(new ToolRegistry()));
  await root.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture', async *stream({ messages }) {
      const request = JSON.stringify(messages);
      assert.match(request, /last-skill-instruction/u);
      assert.match(request, /dependency-marker-712/u);
      yield { type: 'text-delta', text: 'Confirmed.' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }), 'workflow-context-fixture'));
  await root.plugin(taskRunnerPlugin);
  await root.taskRunner.run({ prompt: 'Report the evidence', workspace,
    workflowInstructions: 'Method. '.repeat(900) + 'last-skill-instruction',
    historyContext: 'Evidence from prerequisite reads: dependency-marker-712' });
});
