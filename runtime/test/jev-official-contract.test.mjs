import test from 'node:test';
import assert from 'node:assert/strict';
import { JevClient, jevDefaults } from '../src/decision/jev-client.mjs';
import { resolveDecisionConfig } from '../src/model-config.mjs';

test('default Jev route and translated finite questions satisfy the current official API contract', async () => {
  const client = new JevClient({ apiKey: 'fixture', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    const question = body.questions.next;
    assert.deepEqual(question.criteria, { RETRY: null, STOP: null });
    assert.deepEqual(question.instructions, { question: 'Choose the next step.', context: { permission: 'bounded' } });
    assert.equal(question.type, 'choice');
    assert.equal(Object.hasOwn(question, 'choices'), false);
    return { ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 400, output_tokens: 41 },
      answers: { next: { type: 'choice', choice: 'RETRY', confidence: 0.9, probabilities: { RETRY: 0.9, STOP: 0.1 } } } }) };
  } });
  const result = await client.decide({ state: { task: 'safe probe' }, questions: {
    next: { type: 'choice', choices: ['RETRY', 'STOP'], prompt: 'Choose the next step.', context: { permission: 'bounded' } }
  } });
  assert.deepEqual(result.answers.next.scores, { RETRY: 0.9, STOP: 0.1 });
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.requestedModel, 'jev-latest');
  assert.deepEqual(result.usage, { inputTokens: 400, outputTokens: 41, source: 'PROVIDER_USAGE' });
  assert.equal(resolveDecisionConfig({ env: {} }).endpoint, jevDefaults.endpoint);
});

test('an empty or ambiguous internal choice set is rejected without sending a request', async () => {
  let calls = 0;
  const client = new JevClient({ apiKey: 'fixture', fetchImpl: async () => { calls++; assert.fail('must not send'); } });
  for (const choices of [[], ['SAME', 'SAME'], ['OK', 1]]) {
    await assert.rejects(client.decide({ state: {}, questions: { next: { type: 'choice', choices } } }), /JEV_QUESTIONS_INVALID/u);
  }
  assert.equal(calls, 0);
});

test('finite option descriptions are forwarded only for supplied choices', async () => {
  const client = new JevClient({ apiKey: 'fixture', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.questions.gate.criteria, { ALLOW: 'A permitted current action.', BLOCK: 'An unsafe current action.' });
    return { ok: true, text: async () => JSON.stringify({ answers: { gate: { choice: 'ALLOW' } } }) };
  } });
  await client.decide({ state: {}, questions: { gate: { type: 'choice', choices: ['ALLOW', 'BLOCK'],
    criteria: { ALLOW: 'A permitted current action.', BLOCK: 'An unsafe current action.', UNSUPPLIED: 'must not create another option' } } } });
});
