import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  COMPACTION_MARKER,
  createContextCompactor,
  estimateMessagesChars,
  isCompactionSummaryMessage
} from '../src/context-compaction.mjs';
import { ToolRegistry, toolRegistryPlugin, registerReadonlyWorkspaceTools } from '../src/tool-registry.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { createOpenAICompatiblePlugin } from '../src/plugins/model-openai.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const makeRound = (n, payloadSize = 2000) => {
  const callId = `call_${n}`;
  const assistant = createAssistantMessage({
    content: [
      { type: 'text', text: `Inspecting target ${n}` },
      { type: 'tool-call', id: callId, name: 'workspace.read', arguments: JSON.stringify({ path: `src/mod-${n}.js` }) }
    ],
    source: { provider: 'fixture', model: 'fixture' }
  });
  const toolResult = createToolResultMessage({
    callId,
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify({
        path: `src/mod-${n}.js`,
        digest: `sha256:${String(n).padStart(64, '0')}`,
        content: 'x'.repeat(payloadSize)
      })
    }]
  });
  return [assistant, toolResult];
};

test('leaves messages untouched below high watermark and compacts older rounds into one cumulative summary above watermark', () => {
  const head0 = createUserMessage({ content: [{ type: 'text', text: 'Read-only workspace context' }], source: { kind: 'user' } });
  const head1 = createUserMessage({ content: [{ type: 'text', text: 'User goal: fix issue' }], source: { kind: 'user' } });
  const messages = [head0, head1, ...makeRound(1, 500), ...makeRound(2, 500)];

  const compactor = createContextCompactor({ maxChars: 12_000, keepRecentRounds: 2 });
  const untouched = compactor.compact(messages);
  assert.equal(untouched.compacted, false);
  assert.equal(messages.length, 6);

  // Push 4 more large rounds so total exceeds 12,000 chars.
  for (let i = 3; i <= 6; i += 1) {
    messages.push(...makeRound(i, 3500));
  }
  const writeCallId = 'call_write_4';
  messages.splice(6, 0,
    createAssistantMessage({
      content: [{ type: 'tool-call', id: writeCallId, name: 'file.patch', arguments: JSON.stringify({ path: 'src/fixed.ts' }) }],
      source: { provider: 'fixture', model: 'fixture' }
    }),
    createToolResultMessage({
      callId: writeCallId,
      isError: false,
      content: [{ type: 'text', text: JSON.stringify({ ok: true, path: 'src/fixed.ts', afterDigest: `sha256:${'a'.repeat(64)}` }) }]
    })
  );

  const first = compactor.compact(messages);
  assert.equal(first.compacted, true);
  assert.ok(first.savedChars > 8_000);
  // Head messages preserve object identity for prefix prompt caching.
  assert.equal(messages[0], head0);
  assert.equal(messages[1], head1);
  assert.equal(isCompactionSummaryMessage(messages[2]), true);
  const summaryText = messages[2].content[0].text;
  assert.ok(summaryText.startsWith(COMPACTION_MARKER));
  assert.ok(summaryText.includes('src/fixed.ts'));
  assert.ok(summaryText.includes(`sha256:${'a'.repeat(64)}`));
  assert.ok(summaryText.includes('src/mod-1.js'));

  // Kept tail rounds retain exact assistant -> tool-result pairing.
  const tail = messages.slice(3);
  assert.equal(tail.length, 4); // 2 kept rounds * 2 messages
  assert.equal(tail[0].role, 'assistant');
  assert.equal(tail[1].content[0].toolCallId, tail[0].content.find((b) => b.type === 'tool-call').id);

  // A second compaction merges into a single summary message (never stacks multiple summaries).
  for (let i = 7; i <= 10; i += 1) {
    messages.push(...makeRound(i, 3500));
  }
  const second = compactor.compact(messages);
  assert.equal(second.compacted, true);
  assert.equal(messages.filter(isCompactionSummaryMessage).length, 1);
  assert.ok(estimateMessagesChars(messages) < 16_000);
});

test('per-call maxChars replaces the default character ceiling', () => {
  const head = () => createUserMessage({ content: [{ type: 'text', text: 'goal' }], source: { kind: 'user' } });
  const transcript = (payload) => [head(), ...makeRound(1, payload), ...makeRound(2, payload), ...makeRound(3, payload)];
  const aboveDefaultCeiling = transcript(120_000);
  assert.equal(createContextCompactor({ keepRecentRounds: 1 }).compact(aboveDefaultCeiling).compacted, true);

  const sameSizeForLargeWindow = transcript(120_000);
  assert.equal(createContextCompactor({ keepRecentRounds: 1 }).compact(sameSizeForLargeWindow, { maxChars: 2_000_000 }).compacted, false);
  assert.equal(sameSizeForLargeWindow.length, 7);

  const overSmallCeiling = transcript(20_000);
  const compacted = createContextCompactor({ keepRecentRounds: 1 }).compact(overSmallCeiling, { maxChars: 8_000 });
  assert.equal(compacted.compacted, true);
  assert.ok(compacted.afterChars < compacted.beforeChars);
  assert.equal(overSmallCeiling.filter(isCompactionSummaryMessage).length, 1);
});

test('taskRunner recovers automatically from HTTP 400 context_length_exceeded by emergency compacting and retrying', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hmcodex-compact-overflow-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'big.js'), `const payload = "${'z'.repeat(24_000)}";\n`, 'utf8');

  let requestNum = 0;
  const observedCharLengths = [];
  const server = createServer(async (req, res) => {
    requestNum += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    observedCharLengths.push(bodyText.length);

    if (requestNum === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'hmc_workspace_x2e_read', arguments: JSON.stringify({ path: 'big.js' }) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    if (requestNum === 2) {
      // Simulate gateway rejecting uncompacted 24KB round on a small-window model.
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'context_length_exceeded',
          message: "This model's maximum context length is 8192 tokens."
        }
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '压缩恢复后顺利完成分析。' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const port = server.address().port;

  process.env.TEST_COMPACT_KEY = 'compact-key';
  t.after(() => { delete process.env.TEST_COMPACT_KEY; });

  const root = new Context();
  t.after(() => root.fiber.dispose());
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, new ReadonlyWorkspace(dir));
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(createOpenAICompatiblePlugin({
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'small-window-model',
    endpoint: `http://127.0.0.1:${port}/chat/completions`,
    apiKeyEnv: 'TEST_COMPACT_KEY'
  }));
  await root.plugin(taskRunnerPlugin);

  const events = [];
  const result = await root.taskRunner.run({
    prompt: 'inspect big.js',
    mode: 'CONTROLLED',
    workspace: { granted: true, root: dir, rootLabel: 'proj', snapshotDigest: `sha256:${'b'.repeat(64)}`, entries: [], sections: [] },
    onEvent: (ev) => events.push(ev)
  });

  assert.equal(result.text, '压缩恢复后顺利完成分析。');
  assert.equal(requestNum, 3, 'retried automatically after emergency compaction');
  assert.ok(observedCharLengths[2] < observedCharLengths[1], 'retried request payload is smaller after compaction');
  const compactEvent = events.find((ev) => ev.kind === 'harness.context_compacted');
  assert.ok(compactEvent, 'emits harness.context_compacted event');
  assert.equal(compactEvent.reason, 'CONTEXT_LENGTH_EXCEEDED');
});
