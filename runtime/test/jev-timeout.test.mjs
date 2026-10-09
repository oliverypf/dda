import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient } from '../src/decision/jev-client.mjs';
import { createDecisionEngine } from '../src/decision/engine.mjs';

const request = { state: {}, questions: { verification: { type: 'choice', choices: ['PASS', 'FAIL', 'UNCERTAIN'] } } };
const delayedFetch = (delay, choice = 'PASS') => async (_url, { signal }) => new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', abort);
    resolve({ ok: true, text: async () => JSON.stringify({ answers: { verification: { choice } } }) });
  }, delay);
  signal.addEventListener('abort', abort, { once: true });
});

test('slow semantic verification uses its own bounded deadline while fast decisions still time out', async () => {
  const client = new JevClient({ apiKey: 'fixture', timeoutMs: 100, verificationTimeoutMs: 2000, fetchImpl: delayedFetch(300) });
  await assert.rejects(client.decide(request), error => error.code === 'JEV_TIMEOUT' && error.timeoutMs === 100);
  const result = await createDecisionEngine({ enabled: true, client }).judgeVerification({ ruleStatus: 'PASS' });
  assert.equal(result.decision, 'PASS');
  assert.equal(result.source, 'jev');
  assert.ok(result.jevLatencyMs >= 250);
});

test('expired semantic verification stays uncertain and reports its real deadline', async () => {
  const client = new JevClient({ apiKey: 'fixture', verificationTimeoutMs: 100, fetchImpl: delayedFetch(1000) });
  const result = await createDecisionEngine({ enabled: true, client }).judgeVerification({ ruleStatus: 'PASS' });
  assert.equal(result.decision, 'UNCERTAIN');
  assert.equal(result.reasonCode, 'JEV_TIMEOUT');
  assert.equal(result.timeoutMs, 100);
  assert.ok(result.jevLatencyMs >= 80);
});

test('cancellation is not a provider timeout and an already cancelled request is not sent', async () => {
  const controller = new AbortController();
  const client = new JevClient({ apiKey: 'fixture', fetchImpl: delayedFetch(1000) });
  const pending = client.decide({ ...request, purpose: 'verification', signal: controller.signal });
  controller.abort(new Error('operator cancelled'));
  await assert.rejects(pending, error => error.code === 'JEV_CANCELLED');
  let called = false;
  const unsent = new JevClient({ apiKey: 'fixture', fetchImpl: async () => { called = true; } });
  await assert.rejects(unsent.decide({ ...request, signal: controller.signal }), /JEV_CANCELLED/);
  assert.equal(called, false);
});

test('a negative semantic answer and deterministic failures remain failures', async () => {
  const client = new JevClient({ apiKey: 'fixture', fetchImpl: delayedFetch(1, 'FAIL') });
  const engine = createDecisionEngine({ enabled: true, client });
  assert.equal((await engine.judgeVerification({ ruleStatus: 'PASS' })).decision, 'FAIL');
  assert.equal((await engine.judgeVerification({ ruleStatus: 'FAIL' })).reasonCode, 'RULE_VERIFIER_FAILED');
});
