import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTokenExpectation, extractScoreDistribution, compareVerifiedCandidates, rankVerifiedCandidates, normalizeContinuousVerifierConfig } from '../src/continuous-verifier.mjs';

test('continuous verifier normalizes bounded configuration and rejects unsafe budgets', () => {
  const config = normalizeContinuousVerifierConfig({ criteria: [' quality '], repetitions: 3, maxComparisons: 10, pivots: 1, seed: 's', maxPromptChars: 2048 });
  assert.deepEqual(config, { criteria: ['quality'], repetitions: 3, maxComparisons: 10, pivots: 1, seed: 's', maxPromptChars: 2048, passThreshold: 0.9, failThreshold: 0.5 });
  assert.throws(() => normalizeContinuousVerifierConfig({ repetitions: 0 }), /REPETITIONS_INVALID/u);
  assert.throws(() => normalizeContinuousVerifierConfig({ maxPromptChars: 10 }), /PROMPT_LIMIT_INVALID/u);
});

test('process verdict thresholds are operator configuration with a validated window', () => {
  const custom = normalizeContinuousVerifierConfig({ passThreshold: 0.95, failThreshold: 0.2 });
  assert.equal(custom.passThreshold, 0.95);
  assert.equal(custom.failThreshold, 0.2);
  // An inverted or out-of-range window must fail closed rather than fall back.
  assert.throws(() => normalizeContinuousVerifierConfig({ passThreshold: 0.4, failThreshold: 0.6 }), /VERIFIER_THRESHOLD_INVALID/u);
  assert.throws(() => normalizeContinuousVerifierConfig({ passThreshold: 1.2 }), /VERIFIER_THRESHOLD_INVALID/u);
  assert.throws(() => normalizeContinuousVerifierConfig({ failThreshold: -0.1 }), /VERIFIER_THRESHOLD_INVALID/u);
});

test('verifier uses probability expectation rather than the selected integer or letter', () => {
  const result = scoreTokenExpectation([{ token: 'A', logprob: Math.log(0.25) }, { token: 'T', logprob: Math.log(0.75) }]);
  assert.equal(result.score, 0.25);
  assert.equal(result.variance, 0.1875);
  assert.equal(result.method, 'TOKEN_LOGPROB_EXPECTATION');
});

test('verifier normalizes scoring mass and remains stable for tiny probabilities', () => {
  const result = scoreTokenExpectation([{ token: ' A', logprob: -1000 }, { token: '>T', logprob: -1000 }, { token: 'other', logprob: -0.01 }]);
  assert.equal(result.score, 0.5);
  assert.equal(result.distribution.length, 2);
});

test('verifier requires real logprob evidence and never substitutes a literal score', () => {
  assert.throws(() => scoreTokenExpectation([{ token: '20', logprob: 0 }]), /DISTRIBUTION_MISSING/u);
  assert.throws(() => scoreTokenExpectation([{ token: 'A' }]), /LOGPROB_INVALID/u);
  assert.throws(() => extractScoreDistribution([{ token: '<score_A>' }, { token: 'A' }], '<score_A>'), /LOGPROBS_REQUIRED/u);
});

test('verifier reads the final tagged token distribution including fused closing tags', () => {
  const positions = [
    { token: '<score_A>' }, { token: 'T', top_logprobs: [{ token: 'T', logprob: 0 }] },
    { token: '</score_A> analysis <score_A>' },
    { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(0.6) }, { token: 'T', logprob: Math.log(0.4) }] }
  ];
  assert.equal(extractScoreDistribution(positions, '<score_A>').score, 0.6);
  assert.equal(extractScoreDistribution([{ token: '<score_B' }, { token: '>A', top_logprobs: [{ token: '>A', logprob: 0 }] }], '<score_B>').score, 1);
});

test('pair verification averages independent criteria and swaps repeated evaluation slots', async () => {
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    const input = JSON.parse(request.messages[0].content[0].text);
    const probabilityA = input.trajectoryA === 'correct trajectory' ? 0.8 : 0.6;
    const probabilityB = input.trajectoryB === 'correct trajectory' ? 0.8 : 0.6;
    yield { type: 'score-logprobs', positions: [
      { token: '<score_A>' },
      { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(probabilityA) }, { token: 'T', logprob: Math.log(1 - probabilityA) }] },
      { token: '</score_A><score_B>' },
      { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(probabilityB) }, { token: 'T', logprob: Math.log(1 - probabilityB) }] }
    ] };
  } };
  const result = await compareVerifiedCandidates({ provider, objective: 'task', left: 'correct trajectory', right: 'incorrect trajectory', criteria: ['Specification', 'Errors'], repetitions: 2 });
  assert.equal(result.left, 0.8);
  assert.equal(result.right, 0.6);
  assert.equal(requests.length, 4);
  assert.notEqual(requests[0].messages, requests[1].messages);
  assert.deepEqual(result.samples.map((sample) => sample.swapped), [false, true, false, true]);
  assert.ok(requests.every((request) => request.logprobs === true && request.tools.length === 0));
});

test('a text-only numeric judge cannot satisfy continuous verification', async () => {
  const provider = { async *stream() { yield { type: 'text-delta', text: '{"score":0.9}' }; } };
  await assert.rejects(compareVerifiedCandidates({ provider, objective: 'task', left: 'a', right: 'b', criteria: ['Specification'] }), /VERIFIER_LOGPROBS_REQUIRED/u);
});

test('verifier audits failed and cancelled calls once without raw provider errors', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const invocations = [];
    const samples = [];
    const provider = { async *stream() {
      if (cancelled) controller.abort();
      throw new Error('private provider response');
    } };
    await assert.rejects(compareVerifiedCandidates({ provider, left: { candidateId: 'a' }, right: { candidateId: 'b' },
      criteria: ['Specification'], signal: controller.signal, onInvocation: (fact) => invocations.push(fact), onSample: (sample) => samples.push(sample)
    }));
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].status, cancelled ? 'CANCELLED' : 'FAILED');
    assert.match(invocations[0].promptDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(invocations[0].latencyMs >= 0);
    assert.equal(JSON.stringify(invocations).includes('private provider response'), false);
    assert.equal(samples.length, 0);
  }
});

test('pre-cancelled verification creates no outbound invocation fact', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(compareVerifiedCandidates({ provider: { async *stream() { calls += 1; } },
    criteria: ['Specification'], signal: controller.signal, onInvocation: () => { calls += 1; }
  }), /VERIFIER_CANCELLED/u);
  assert.equal(calls, 0);
});

test('pivot tournament balances ring slots and enforces comparison budget before invoking', async () => {
  const candidates = [0.1, 0.3, 0.6, 0.9].map((reward, index) => ({ candidateId: `candidate-${index}`, reward }));
  const pairs = [];
  const compare = async (left, right) => {
    pairs.push([left.candidateId, right.candidateId]);
    return { left: left.reward, right: right.reward };
  };
  await assert.rejects(rankVerifiedCandidates({ candidates, compare, maxComparisons: 8 }), /BUDGET_EXCEEDED/u);
  assert.equal(pairs.length, 0);
  const result = await rankVerifiedCandidates({ candidates, compare, maxComparisons: 9 });
  assert.equal(result.comparisons.length, 9);
  assert.equal(result.ranking[0].candidateId, 'candidate-3');
  assert.equal(new Set(pairs.slice(0, 4).map((pair) => pair[0])).size, 4);
  assert.equal(new Set(pairs.slice(0, 4).map((pair) => pair[1])).size, 4);
});
