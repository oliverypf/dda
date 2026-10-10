import test from 'node:test';
import assert from 'node:assert/strict';
import { goalRequestCorrelation } from './goal-request-correlation.mjs';

test('upstream inference identifiers remain distinct from charge amounts and private response headers', () => {
  const response = { headers: new Headers({ 'x-request-id': 'gateway-42', 'request-id': 'provider-17',
    authorization: 'private-auth-value', 'set-cookie': 'private-session-cookie' }) };
  const result = goalRequestCorrelation(response, { id: 'chatcmpl-abc', model: 'actual-model', amount: 100 });
  assert.deepEqual(result.upstreamRequestIds, { 'x-request-id': 'gateway-42', 'request-id': 'provider-17' });
  assert.equal(result.upstreamResponseId, 'chatcmpl-abc');
  assert.equal(result.correlationMeasurement, 'UPSTREAM_RETURNED_IDS');
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result.amount, undefined);
  assert.equal(result.actualCost, undefined);
});

test('missing, oversized and free-text identifiers do not become fabricated correlation keys', () => {
  const result = goalRequestCorrelation({ headers: new Headers({ 'x-request-id': 'not an identifier', 'request-id': 'x'.repeat(241) }) }, { id: 42 });
  assert.deepEqual(result, { upstreamRequestIds: {}, upstreamResponseId: null, correlationMeasurement: 'NOT_PROVIDED' });
  assert.deepEqual(goalRequestCorrelation({}, null), result);
});
