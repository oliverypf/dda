import test from 'node:test';
import assert from 'node:assert/strict';
import { startGoalLiveJev } from './goal-live-jev.mjs';

test('live decision recording forwards real answers and never records credentials', async t => {
  const name = 'HMCODEX_GOAL_JEV_PROXY_TEST_KEY';
  const previous = process.env[name];
  process.env[name] = 'private-upstream-test-key';
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const answer = { id: 'decision-response-1', model: 'real-response-model', answers: { escalation: { choice: 'COLLECT_EVIDENCE', confidence: 0.88 } },
    usage: { input_tokens: 123, output_tokens: 9 } };
  let upstreamCalls = 0;
  const service = await startGoalLiveJev({ apiKeyEnv: name, endpoint: 'https://decision.test/v1/systemone', fetchImpl: async (url, options) => {
    upstreamCalls++;
    assert.equal(url, 'https://decision.test/v1/systemone');
    assert.equal(options.headers.authorization, 'Bearer private-upstream-test-key');
    return { status: 200, headers: new Headers({ 'x-request-id': 'decision-request-1', 'set-cookie': 'private-session-cookie' }), text: async () => JSON.stringify(answer) };
  } });
  t.after(() => service.close());
  const first = service.begin();
  const body = { model: 'jev-latest', state: { taskId: 'actual-case' }, questions: { escalation: { type: 'choice', criteria: { COLLECT_EVIDENCE: null } } } };
  const response = await fetch(service.endpoint, { method: 'POST', headers: { authorization: 'Bearer goal-jev-local-key' }, body: JSON.stringify(body) });
  assert.deepEqual(await response.json(), answer);
  assert.equal(upstreamCalls, 1);
  assert.deepEqual(first.requests[0].body, body);
  assert.deepEqual(first.requests[0].rawUsage, answer.usage);
  assert.equal(first.requests[0].upstreamResponseId, 'decision-response-1');
  assert.deepEqual(first.requests[0].upstreamRequestIds, { 'x-request-id': 'decision-request-1' });
  assert.equal(first.requests[0].estimatedCost, 123 * 0.042 / 1e6);
  assert.equal(first.requests[0].pricing.basis, 'API_PRICE');
  assert.equal(first.requests[0].actualCost, null);
  assert.ok(Number.isFinite(first.requests[0].wallMs) && first.requests[0].wallMs >= 0);
  assert.ok(!JSON.stringify(first).includes('private-upstream-test-key'));
  assert.ok(!JSON.stringify(first).includes('private-session-cookie'));
  const second = service.begin();
  assert.equal(second.requests.length, 0);
  assert.equal(first.requests.length, 1, 'case observations retain their own request identity');
  const unauthorized = await fetch(service.endpoint, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(unauthorized.status, 502);
  assert.equal(upstreamCalls, 1, 'missing local authorization never spends provider usage');
});
