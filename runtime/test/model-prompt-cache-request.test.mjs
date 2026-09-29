import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createOpenAICompatiblePlugin } from '../src/plugins/model-openai.mjs';

const tools = [
  { name: 'z_tool', description: 'z', inputSchema: { type: 'object', properties: { z: { type: 'string' } } } },
  { name: 'a_tool', description: 'a', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }
];

const drain = async (provider, request) => {
  const chunks = [];
  for await (const chunk of provider.stream(request)) chunks.push(chunk);
  return chunks;
};

const restoreEnv = (name, value) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

test('official OpenAI requests use stable role-scoped cache keys and deterministic tools', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.HMCODEX_TEST_PROMPT_CACHE_KEY;
  const previousCache = process.env.HMCODEX_PROMPT_CACHE;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response('event: response.completed\ndata: {"type":"response.completed"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };
  process.env.HMCODEX_TEST_PROMPT_CACHE_KEY = 'test-key';
  delete process.env.HMCODEX_PROMPT_CACHE;
  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnv('HMCODEX_TEST_PROMPT_CACHE_KEY', previousKey);
    restoreEnv('HMCODEX_PROMPT_CACHE', previousCache);
  });

  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'responses',
    endpoint: 'https://api.openai.com/v1/responses',
    model: 'cache-model',
    apiKeyEnv: 'HMCODEX_TEST_PROMPT_CACHE_KEY'
  }));
  t.after(() => root.fiber.dispose());

  const base = { system: 'stable system', messages: [{ role: 'user', content: 'dynamic prompt' }], cacheScope: 'workspace-digest' };
  await drain(root.modelProvider, { ...base, cacheRole: 'executor', tools });
  await drain(root.modelProvider, { ...base, cacheRole: 'executor', tools: [...tools].reverse() });
  await drain(root.modelProvider, { ...base, cacheRole: 'planner', tools });

  assert.deepEqual(bodies[0].tools.map((tool) => tool.name), ['a_tool', 'z_tool']);
  assert.deepEqual(bodies[1].tools, bodies[0].tools);
  assert.equal(bodies[1].prompt_cache_key, bodies[0].prompt_cache_key);
  assert.notEqual(bodies[2].prompt_cache_key, bodies[0].prompt_cache_key);
  assert.match(bodies[0].prompt_cache_key, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);

  process.env.HMCODEX_PROMPT_CACHE = 'off';
  await drain(root.modelProvider, { ...base, cacheRole: 'executor', tools });
  assert.equal(Object.hasOwn(bodies[3], 'prompt_cache_key'), false);
  assert.deepEqual(bodies[3].tools.map((tool) => tool.name), ['z_tool', 'a_tool']);
});

test('Chat Completions usage streaming can be disabled for incompatible gateways', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.HMCODEX_TEST_STREAM_USAGE_KEY;
  const previousStreamUsage = process.env.HMCODEX_STREAM_USAGE;
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  process.env.HMCODEX_TEST_STREAM_USAGE_KEY = 'test-key';
  process.env.HMCODEX_STREAM_USAGE = 'off';
  t.after(() => {
    globalThis.fetch = previousFetch;
    restoreEnv('HMCODEX_TEST_STREAM_USAGE_KEY', previousKey);
    restoreEnv('HMCODEX_STREAM_USAGE', previousStreamUsage);
  });

  const root = new Context();
  await root.plugin(createOpenAICompatiblePlugin({
    protocol: 'chat-completions',
    endpoint: 'https://compatible.example.test/v1/chat/completions',
    model: 'gateway-model',
    apiKeyEnv: 'HMCODEX_TEST_STREAM_USAGE_KEY'
  }));
  t.after(() => root.fiber.dispose());
  await drain(root.modelProvider, { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(Object.hasOwn(body, 'stream_options'), false);
});