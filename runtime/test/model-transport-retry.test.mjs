import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Context } from '@deepseek-ai/cordis';
import { createOpenAICompatiblePlugin } from '../src/plugins/model-openai.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const setup = async (t, handler, options = {}) => {
  const server = createServer(handler);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await listenOnFetchablePort(server);
  const root = new Context();
  const apiKeyEnv = 'HMCODEX_TEST_RETRY_KEY';
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = 'local-test-key';
  t.after(async () => { await root.fiber.dispose(); if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous; });
  await root.plugin(createOpenAICompatiblePlugin({ endpoint: `http://127.0.0.1:${server.address().port}/responses`,
    apiKeyEnv, transportRetryDelayMs: 1, ...options }));
  return root.modelProvider;
};
const request = { messages: [{ role: 'user', content: 'test' }] };
const collect = async (provider, input = request) => {
  const chunks = [];
  for await (const chunk of provider.stream(input)) chunks.push(chunk);
  return chunks;
};
const success = response => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"done"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n');
};

test('transient HTTP errors retry the same model request then deliver one stream', async t => {
  const bodies = [];
  const provider = await setup(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; bodies.push(body);
    if (bodies.length < 3) { res.writeHead(bodies.length === 1 ? 502 : 503); res.end('{"error":{"message":"temporary"}}'); }
    else success(res);
  });
  const chunks = await collect(provider);
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(chunks, [{ type: 'text-delta', text: 'done' }, { type: 'finish', reason: { kind: 'stop' } }]);
});

test('a disconnected request can retry but exhausted transient errors remain failures', async t => {
  let calls = 0;
  const provider = await setup(t, (req, res) => { if (++calls === 1) req.socket.destroy(); else success(res); });
  assert.equal((await collect(provider))[0].text, 'done');
  assert.equal(calls, 2);
  let failedCalls = 0;
  const failing = await setup(t, (_req, res) => { failedCalls++; res.writeHead(502); res.end('{}'); });
  await assert.rejects(collect(failing), /MODEL_HTTP_ERROR:502/u);
  assert.equal(failedCalls, 3);
});

test('bad requests, authentication failures and long Retry-After do not retry', async t => {
  for (const status of [400, 401, 403, 429]) {
    let calls = 0;
    const provider = await setup(t, (_req, res) => { calls++; res.writeHead(status, status === 429 ? { 'retry-after': '120' } : {}); res.end('{}'); });
    await assert.rejects(collect(provider), new RegExp(`MODEL_HTTP_ERROR:${status}`));
    assert.equal(calls, 1);
  }
});

test('abort during backoff prevents subsequent attempts', async t => {
  const controller = new AbortController();
  let calls = 0;
  const provider = await setup(t, (_req, res) => { calls++; res.writeHead(503); res.end('{}'); setTimeout(() => controller.abort(), 10); }, { transportRetryDelayMs: 100 });
  await assert.rejects(collect(provider, { ...request, signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('partial streams are never replayed after a disconnect', async t => {
  let calls = 0;
  const provider = await setup(t, (_req, res) => {
    calls++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n');
    setTimeout(() => res.destroy(), 20);
  });
  const chunks = [];
  await assert.rejects(async () => { for await (const chunk of provider.stream(request)) chunks.push(chunk); });
  assert.equal(calls, 1);
  assert.equal(chunks[0].text, 'partial');
});
