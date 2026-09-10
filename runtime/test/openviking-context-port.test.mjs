import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenVikingContextPort } from '../src/openviking-context-port.mjs';

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers }
});

test('OpenViking ContextPort uses bounded session recall, usage, record, and commit requests', async () => {
  const requests = [];
  const privateWorkspace = 'Z:\\private\\customer-project';
  const fetchImpl = async (url, options) => {
    const request = {
      url: String(url),
      method: options.method,
      headers: Object.fromEntries(Object.entries(options.headers)),
      body: options.body ? JSON.parse(options.body) : undefined
    };
    requests.push(request);
    const path = new URL(url).pathname;
    if (path === '/ready') return jsonResponse({ status: 'ok', result: { ready: true } });
    if (path === '/api/v1/sessions') {
      return jsonResponse({ status: 'ok', result: { session_id: request.body.session_id } });
    }
    if (path === '/api/v1/search/search') {
      return jsonResponse({
        status: 'ok',
        result: {
          entries: [
            { uri: 'viking://user/test/memories/entities/project.md', category: 'entities', score: 0.91, text: 'Use the bounded workspace reader.' },
            { uri: 'https://invalid.example/context', category: 'resources', score: 1, text: 'must be ignored' }
          ],
          rendered: '<memory>bounded</memory>',
          stats: { used_tokens: 42 }
        }
      });
    }
    if (path.endsWith('/used')) return jsonResponse({ status: 'ok', result: { contexts_used: 1 } });
    if (path.endsWith('/messages/batch')) return jsonResponse({ status: 'ok', result: { added: 1 } });
    if (path.endsWith('/commit')) return jsonResponse({ status: 'ok', result: { status: 'accepted', task_id: 'task-1' } });
    throw new Error(`unexpected request ${path}`);
  };
  const port = createOpenVikingContextPort({
    baseURL: 'http://127.0.0.1:1933',
    apiKey: 'test-secret',
    workspaceRoot: privateWorkspace,
    fetchImpl
  });

  assert.deepEqual(await port.health(), { status: 'AVAILABLE', provider: 'openviking' });
  const recalled = await port.recall({ runId: 'run-1', query: 'workspace reader', scope: 'workspace', limit: 4, maxChars: 1000 });
  assert.equal(recalled.provider, 'openviking');
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].statement, 'Use the bounded workspace reader.');
  assert.equal(recalled.usedTokens, 42);
  const used = await port.used({ runId: 'run-1', memoryIds: recalled.items.map((item) => item.memoryId) });
  assert.equal(used.used.length, 1);
  const recorded = await port.record({
    runId: 'run-1',
    statement: 'Verified task outcome: outputDigest=sha256:1234',
    sourceEventIds: ['event-1'],
    scope: 'workspace',
    kind: 'TASK_OUTCOME',
    confidence: 0.8
  });
  assert.match(recorded.memory.memoryId, /^openviking-session:hmcodex-[a-f0-9]{32}$/u);
  const committed = await port.commit({
    runId: 'run-1',
    memoryIds: [recalled.items[0].memoryId, recorded.memory.memoryId]
  });
  assert.equal(committed.count, 1);
  assert.deepEqual(committed.taskIds, ['task-1']);

  const sessionId = requests.find((request) => new URL(request.url).pathname === '/api/v1/sessions').body.session_id;
  assert.match(sessionId, /^hmcodex-[a-f0-9]{32}$/u);
  assert.deepEqual(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`), [
    'GET /ready',
    'POST /api/v1/sessions',
    'POST /api/v1/search/search',
    `POST /api/v1/sessions/${sessionId}/used`,
    `POST /api/v1/sessions/${sessionId}/messages/batch`,
    `POST /api/v1/sessions/${sessionId}/commit`
  ]);
  const search = requests.find((request) => new URL(request.url).pathname.endsWith('/search/search'));
  assert.deepEqual(search.body, {
    query: 'workspace reader',
    mode: 'context',
    purpose: 'coding',
    peer_scope: 'actor',
    session_id: sessionId,
    max_tokens: 1500
  });
  const usedRequest = requests.find((request) => new URL(request.url).pathname.endsWith('/used'));
  assert.deepEqual(usedRequest.body, { contexts: ['viking://user/test/memories/entities/project.md'] });
  const batch = requests.find((request) => new URL(request.url).pathname.endsWith('/messages/batch'));
  assert.deepEqual(batch.body, { messages: [{ role: 'assistant', content: 'Verified task outcome: outputDigest=sha256:1234' }] });
  assert.equal(requests[0].headers.authorization, undefined);
  assert.ok(requests.slice(1).every((request) => request.headers.authorization === 'Bearer test-secret'));
  assert.ok(requests.every((request) => /^hmcodex-workspace-[a-f0-9]{32}$/u.test(request.headers['x-openviking-actor-peer'])));
  assert.doesNotMatch(JSON.stringify(requests), /customer-project/u);
});

test('OpenViking ContextPort retries transient reads once and never retries writes', async () => {
  let searchCalls = 0;
  let batchCalls = 0;
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/api/v1/sessions') {
      const body = JSON.parse(options.body);
      return jsonResponse({ status: 'ok', result: { session_id: body.session_id } });
    }
    if (path === '/api/v1/search/search') {
      searchCalls += 1;
      if (searchCalls === 1) return jsonResponse({ status: 'error', error: { code: 'UNAVAILABLE', message: 'private server detail' } }, 503);
      return jsonResponse({ status: 'ok', result: { entries: [], rendered: '', stats: {} } });
    }
    if (path.endsWith('/messages/batch')) {
      batchCalls += 1;
      return jsonResponse({ status: 'error', error: { code: 'UNAVAILABLE', message: 'do not leak me' } }, 503);
    }
    throw new Error(`unexpected request ${path}`);
  };
  const port = createOpenVikingContextPort({ fetchImpl });
  const recalled = await port.recall({ runId: 'retry-run', query: 'retry search' });
  assert.equal(recalled.items.length, 0);
  assert.equal(searchCalls, 2);
  await assert.rejects(
    () => port.record({ runId: 'retry-run', statement: 'verified digest only' }),
    (error) => error.message === 'OPENVIKING_UNAVAILABLE' && !/private|leak/u.test(error.message)
  );
  assert.equal(batchCalls, 1);
});

test('OpenViking ContextPort rejects unsafe URLs and oversized responses', async () => {
  assert.throws(() => createOpenVikingContextPort({ baseURL: 'https://example.com' }), /OPENVIKING_BASE_URL_INVALID/u);
  assert.throws(() => createOpenVikingContextPort({ baseURL: 'http://127.0.0.1:1933/api' }), /OPENVIKING_BASE_URL_INVALID/u);
  assert.throws(() => createOpenVikingContextPort({ timeoutMs: 20 }), /OPENVIKING_TIMEOUT_INVALID/u);
  let calls = 0;
  const port = createOpenVikingContextPort({
    maxResponseBytes: 1024,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ status: 'ok', result: { ready: true } }, 200, { 'content-length': '2048' });
    }
  });
  await assert.rejects(() => port.health(), /OPENVIKING_RESPONSE_TOO_LARGE/u);
  assert.equal(calls, 1);
});
