import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import { createOpenAICompatiblePlugin } from '../src/plugins/model-openai.mjs';

const tool = {
  name: 'workspace.read',
  description: 'Read a text file.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false
  }
};

const readChunks = async (provider, request) => {
  const chunks = [];
  for await (const chunk of provider.stream(request)) chunks.push(chunk);
  return chunks;
};

test('passes Responses function definitions and assembles argument deltas', async (t) => {
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    assert.deepEqual(payload.tools, [{
      type: 'function',
      name: 'hmc_workspace_x2e_read',
      description: tool.description,
      parameters: tool.inputSchema
    }]);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"workspace.read","arguments":""}}\n\n');
    response.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"path":"READ' })}\n\n`);
    response.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: 'ME.md"}' })}\n\n`);
    response.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: 'fc_1', output_index: 0, arguments: '{"path":"README.md"}' })}\n\n`);
    response.write('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    response.end();
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'responses',
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    apiKeyEnv: 'HMCODEX_TEST_OPENAI_TOOL_KEY'
  }));
  t.after(() => root.fiber.dispose());
  process.env.HMCODEX_TEST_OPENAI_TOOL_KEY = 'key';
  const chunks = await readChunks(root.modelProvider, {
    system: 'Use tools.',
    messages: [{ role: 'user', content: 'read README' }],
    tools: [tool]
  });
  delete process.env.HMCODEX_TEST_OPENAI_TOOL_KEY;
  assert.deepEqual(chunks, [
    { type: 'tool-call', id: 'call_1', name: 'workspace.read', arguments: '{"path":"README.md"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]);
});

test('passes Chat Completions function definitions and assembles tool-call deltas', async (t) => {
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    assert.deepEqual(payload.tools, [{
      type: 'function',
      function: {
          name: 'hmc_workspace_x2e_read',
        description: tool.description,
        parameters: tool.inputSchema
      }
    }]);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'workspace.read', arguments: '{"path":"REA' } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'DME.md"}' } }] }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'chat-completions',
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    apiKeyEnv: 'HMCODEX_TEST_OPENAI_CHAT_TOOL_KEY'
  }));
  t.after(() => root.fiber.dispose());
  process.env.HMCODEX_TEST_OPENAI_CHAT_TOOL_KEY = 'key';
  const chunks = await readChunks(root.modelProvider, {
    messages: [{ role: 'user', content: 'read README' }],
    tools: [tool]
  });
  delete process.env.HMCODEX_TEST_OPENAI_CHAT_TOOL_KEY;
  assert.deepEqual(chunks, [
    { type: 'tool-call', id: 'call_2', name: 'workspace.read', arguments: '{"path":"README.md"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]);
});

test('keeps a valid tool-call id and name when later deltas send null fields', async (t) => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // OpenCode Go sends the id/name once, then repeats the tool call with
    // `id: null` and `function.name: null` on the argument fragment.
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_null', type: 'function', function: { name: 'workspace.read', arguments: '' } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: null, type: 'function', function: { name: null, arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'chat-completions',
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    apiKeyEnv: 'HMCODEX_TEST_OPENCODE_NULL_KEY'
  }));
  t.after(() => root.fiber.dispose());
  process.env.HMCODEX_TEST_OPENCODE_NULL_KEY = 'key';
  const chunks = await readChunks(root.modelProvider, {
    messages: [{ role: 'user', content: 'read README' }],
    tools: [tool]
  });
  delete process.env.HMCODEX_TEST_OPENCODE_NULL_KEY;
  assert.deepEqual(chunks, [
    { type: 'tool-call', id: 'call_null', name: 'workspace.read', arguments: '{"path":"README.md"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]);
});

test('serializes Responses assistant tool calls and function outputs for a follow-up turn', async (t) => {
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    assert.deepEqual(payload.input, [
      { role: 'user', content: [{ type: 'input_text', text: 'read README' }] },
      { type: 'function_call', call_id: 'call_3', name: 'hmc_workspace_x2e_read', arguments: '{"path":"README.md"}' },
      { type: 'function_call_output', call_id: 'call_3', output: '{"path":"README.md","content":"ok"}' }
    ]);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"done"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'responses',
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    apiKeyEnv: 'HMCODEX_TEST_OPENAI_HISTORY_KEY'
  }));
  t.after(() => root.fiber.dispose());
  process.env.HMCODEX_TEST_OPENAI_HISTORY_KEY = 'key';
  const chunks = await readChunks(root.modelProvider, {
    messages: [
      { role: 'user', content: 'read README' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_3', name: 'workspace.read', arguments: '{"path":"README.md"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_3', content: [{ type: 'text', text: '{"path":"README.md","content":"ok"}' }] }] }
    ]
  });
  delete process.env.HMCODEX_TEST_OPENAI_HISTORY_KEY;
  assert.deepEqual(chunks, [
    { type: 'text-delta', text: 'done' },
    { type: 'finish', reason: { kind: 'stop' } }
  ]);
});

test('serializes Chat Completions assistant tool calls and tool messages for a follow-up turn', async (t) => {
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    assert.deepEqual(payload.messages, [
      { role: 'user', content: 'read README' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_4', type: 'function', function: { name: 'hmc_workspace_x2e_read', arguments: '{"path":"README.md"}' }
      }] },
      { role: 'tool', tool_call_id: 'call_4', content: '{"path":"README.md","content":"ok"}' }
    ]);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'chat-completions',
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    apiKeyEnv: 'HMCODEX_TEST_OPENAI_HISTORY_CHAT_KEY'
  }));
  t.after(() => root.fiber.dispose());
  process.env.HMCODEX_TEST_OPENAI_HISTORY_CHAT_KEY = 'key';
  const chunks = await readChunks(root.modelProvider, {
    messages: [
      { role: 'user', content: 'read README' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_4', name: 'workspace.read', arguments: '{"path":"README.md"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_4', content: [{ type: 'text', text: '{"path":"README.md","content":"ok"}' }] }] }
    ]
  });
  delete process.env.HMCODEX_TEST_OPENAI_HISTORY_CHAT_KEY;
  assert.deepEqual(chunks, [
    { type: 'text-delta', text: 'done' },
    { type: 'finish', reason: { kind: 'stop' } }
  ]);
});
