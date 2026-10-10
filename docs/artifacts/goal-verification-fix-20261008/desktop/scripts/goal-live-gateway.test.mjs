import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChat, startGoalLiveGateway } from './goal-live-gateway.mjs';

test('Responses tool calls and results preserve their identities in the shared live adapter', () => {
  const request = responsesToChat({ model: 'same-model', instructions: 'bounded task', input: [
    { role: 'user', content: [{ type: 'input_text', text: 'read evidence' }] },
    { type: 'function_call', call_id: 'call-a', name: 'read', arguments: '{"path":"README.md"}' },
    { type: 'function_call', call_id: 'call-b', name: 'list', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-a', output: 'marker' },
    { type: 'function_call_output', call_id: 'call-b', output: 'README.md' }
  ], tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
  assert.equal(request.model, 'same-model');
  assert.equal(request.messages[2].tool_calls.length, 2);
  assert.deepEqual(request.messages.slice(3).map(item => [item.tool_call_id, item.content]), [['call-a', 'marker'], ['call-b', 'README.md']]);
  assert.equal(request.tools[0].function.name, 'read');
  assert.equal(request.stream, false);
  assert.equal(request.max_tokens, 4096);
});

test('both clients use the same text and developer instruction conversion', () => {
  const request = responsesToChat({ model: 'same-model', input: [{ role: 'developer', content: 'workspace boundary' }, { role: 'user', content: 'task' }] });
  assert.deepEqual(request.messages, [{ role: 'system', content: 'workspace boundary' }, { role: 'user', content: 'task' }]);
});

test('live model records returned inference IDs for success and HTTP failure without inventing charges', async t => {
  const name = 'HMCODEX_GOAL_CORRELATION_TEST_KEY';
  const previous = process.env[name]; process.env[name] = 'private-gateway-test-key';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  let calls = 0;
  const service = await startGoalLiveGateway({ protocol: 'chat-completions', model: 'same-model', apiKeyEnv: name,
    endpoint: 'https://model.test/v1/chat/completions' }, {}, { fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://model.test/v1/chat/completions');
      assert.equal(options.headers.authorization, 'Bearer private-gateway-test-key');
      if (calls > 1) return new Response('{}', { status: 503, headers: { 'x-request-id': 'failed-upstream-2' } });
      return new Response(JSON.stringify({ id: 'chatcmpl-upstream-1', model: 'same-model',
        choices: [{ message: { content: 'actual returned answer' } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }),
        { status: 200, headers: { 'x-request-id': 'upstream-1', 'set-cookie': 'private-cookie' } });
    } });
  t.after(() => service.close());
  const observations = service.begin({ taskId: 'correlation-case' });
  const invoke = () => fetch(service.endpoint, { method: 'POST', headers: { authorization: 'Bearer local-fixture-key' },
    body: JSON.stringify({ model: 'same-model', input: 'task' }) });
  const success = await invoke(); await success.text();
  const failure = await invoke(); await failure.text();
  assert.equal(success.status, 200); assert.equal(failure.status, 503);
  assert.equal(observations.requests[0].upstreamResponseId, 'chatcmpl-upstream-1');
  assert.deepEqual(observations.requests[0].upstreamRequestIds, { 'x-request-id': 'upstream-1' });
  assert.deepEqual(observations.requests[1].upstreamRequestIds, { 'x-request-id': 'failed-upstream-2' });
  assert.equal(observations.requests[1].upstreamResponseId, null);
  assert.equal(observations.requests[1].actualCost, null);
  assert.ok(!JSON.stringify(observations).includes('private-gateway-test-key'));
  assert.ok(!JSON.stringify(observations).includes('private-cookie'));
});
