import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';
import { runCandidateDraftStage } from '../src/candidate-draft-stage.mjs';
import {
  CandidateSafetyFilter,
  CandidateSelectionPolicy,
  buildCandidateSelectionDecision,
  normalizeCandidateSetSpec,
  planCandidateFanout,
  runCandidateFanout
} from '../src/candidate-fanout.mjs';

const bindings = [
  { bindingId: 'binding-a', modelId: 'model-a', provider: 'openai', expectedCost: 1, expectedLatencyMs: 100 },
  { bindingId: 'binding-b', modelId: 'model-b', provider: 'deepseek', expectedCost: 2, expectedLatencyMs: 50 },
  { bindingId: 'binding-c', modelId: 'model-c', provider: 'openai', expectedCost: 3, expectedLatencyMs: 10 }
];

test('CANDIDATE_SET keeps single-candidate behavior by default', () => {
  const spec = normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: bindings });
  assert.equal(spec.fanout, 1);
  assert.equal(spec.selectionPolicyRef, 'candidate-selection.default');
  const plan = planCandidateFanout({ spec, risk: 'LOW' });
  assert.equal(plan.fanout, 1);
  assert.equal(plan.truncated, false);
  assert.equal(plan.degradedToSingleCandidate, true);
  assert.deepEqual(plan.candidateBindings.map((binding) => binding.bindingId), ['binding-a']);
  assert.equal(plan.maxConcurrency, 1);
});

test('rejects invalid candidate sets instead of silently dropping facts', () => {
  assert.throws(() => normalizeCandidateSetSpec({ mode: 'PINNED', candidateBindings: bindings }), /CANDIDATE_SET_MODE_INVALID/);
  assert.throws(() => normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: [] }), /CANDIDATE_SET_BINDINGS_INVALID/);
  assert.throws(
    () => normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: [bindings[0], { bindingId: 'binding-a', modelId: 'model-z' }] }),
    /CANDIDATE_SET_BINDING_DUPLICATE/
  );
  assert.throws(() => normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: bindings, fanout: 9 }), /CANDIDATE_SET_FANOUT_INVALID/);
  // Over-budget fanout is clamped at planning time instead of rejected.
  const overBudget = normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: bindings, fanout: 3, fanoutBudget: { maxCandidates: 2 } });
  assert.equal(overBudget.fanout, 3);
  assert.equal(planCandidateFanout({ spec: overBudget, risk: 'CRITICAL' }).fanout, 2);
  assert.throws(
    () => normalizeCandidateSetSpec({ mode: 'CANDIDATE_SET', candidateBindings: bindings, fanoutBudget: { maxTokens: 10, surprise: 1 } }),
    /CANDIDATE_SET_BUDGET_INVALID:surprise/
  );
});

test('fanout planning clamps to the risk ceiling and budget with recorded reasons', () => {
  const spec = normalizeCandidateSetSpec({
    mode: 'CANDIDATE_SET',
    candidateBindings: bindings,
    fanout: 3,
    fanoutBudget: { maxCandidates: 3, maxConcurrency: 2 }
  });
  const high = planCandidateFanout({ spec, risk: 'HIGH' });
  assert.equal(high.fanout, 2);
  assert.equal(high.truncated, true);
  assert.deepEqual(high.truncationReasons, ['RISK_POLICY_CEILING']);
  assert.deepEqual(high.droppedBindingIds, ['binding-c']);
  assert.equal(high.maxConcurrency, 2);

  const critical = planCandidateFanout({ spec, risk: 'CRITICAL' });
  assert.equal(critical.fanout, 3);
  assert.equal(critical.truncated, false);
  assert.deepEqual(critical.droppedBindingIds, []);

  const budgeted = normalizeCandidateSetSpec({
    mode: 'CANDIDATE_SET',
    candidateBindings: bindings,
    fanout: 3,
    fanoutBudget: { maxCandidates: 2 }
  });
  const limited = planCandidateFanout({ spec: budgeted, risk: 'CRITICAL' });
  assert.equal(limited.fanout, 2);
  assert.deepEqual(limited.truncationReasons, ['FANOUT_BUDGET_LIMIT']);
});

test('candidate safety filter removes rejected candidates from the scoring set', () => {
  const filter = new CandidateSafetyFilter();
  const filtered = filter.filter({
    candidates: [
      { bindingId: 'binding-a', modelId: 'model-a', expectedCost: 1 },
      { bindingId: 'binding-b', modelId: 'model-b', expectedCost: 9 },
      { bindingId: 'binding-c', modelId: 'model-c', eligible: false }
    ],
    precheck: { status: 'ALLOWED' },
    constraints: { allowedModelIds: ['model-a', 'model-b', 'model-c'], requireEligible: true, maxCost: 5 }
  });
  assert.deepEqual(filtered.admitted.map((candidate) => candidate.bindingId), ['binding-a']);
  assert.deepEqual(filtered.rejected.map((candidate) => candidate.bindingId), ['binding-b', 'binding-c']);
  assert.deepEqual(filtered.rejected[0].reasons, ['CANDIDATE_COST_EXCEEDS_BUDGET']);
  assert.deepEqual(filtered.rejected[1].reasons, ['CANDIDATE_NOT_ELIGIBLE']);

  const blocked = filter.filter({ candidates: bindings, precheck: { status: 'BLOCKED' }, constraints: {} });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'CANDIDATE_SET_EMPTY_AFTER_SAFETY');

  const sideEffect = filter.filter({
    candidates: [{ bindingId: 'binding-a', modelId: 'model-a', sideEffectCapable: true }],
    precheck: { status: 'ALLOWED' },
    constraints: {}
  });
  assert.deepEqual(sideEffect.rejected[0].reasons, ['CANDIDATE_SIDE_EFFECT_FORBIDDEN']);
});

test('fanout reports partial failure as a successful logical call and caps concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const outcome = await runCandidateFanout({
    candidates: bindings,
    concurrency: 2,
    invoke: async ({ candidate }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      if (candidate.bindingId === 'binding-b') {
        const error = new Error('RATE_LIMITED');
        error.code = 'RATE_LIMITED';
        throw error;
      }
      return { text: `draft for ${candidate.bindingId}`, outputChars: 12 };
    }
  });
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(outcome.successCount, 2);
  assert.equal(outcome.failureCount, 1);
  assert.ok(maxInFlight <= 2);
  const failed = outcome.failures[0];
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'RATE_LIMITED');
  // Only digests leave the gateway; raw candidate text is never returned, and a
  // failed candidate has no draft digest at all.
  for (const candidate of outcome.successes) {
    assert.equal(typeof candidate.outputDraftDigest, 'string');
    assert.match(candidate.outputDraftDigest, /^sha256:[0-9a-f]{64}$/);
  }
  for (const candidate of outcome.candidates) {
    assert.equal(candidate.text, undefined);
  }
  assert.equal(outcome.failures[0].outputDraftDigest, undefined);
});

test('fanout fails only when every candidate fails and maps timeouts', async () => {
  const allFailed = await runCandidateFanout({
    candidates: bindings.slice(0, 2),
    concurrency: 2,
    invoke: async () => { throw new Error('PROVIDER_DOWN'); }
  });
  assert.equal(allFailed.status, 'FAILED');
  assert.equal(allFailed.reason, 'CANDIDATE_FANOUT_ALL_FAILED');
  assert.equal(allFailed.successCount, 0);

  const timedOut = await runCandidateFanout({
    candidates: [bindings[0]],
    concurrency: 1,
    timeoutMs: 10,
    invoke: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true });
    })
  });
  assert.equal(timedOut.status, 'FAILED');
  assert.equal(timedOut.candidates[0].status, 'TIMED_OUT');
  assert.equal(timedOut.candidates[0].errorCode, 'CANDIDATE_TIMEOUT');
});

test('fanout does not invoke candidates after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runCandidateFanout({
    candidates: bindings,
    signal: controller.signal,
    invoke: async () => { calls += 1; return { text: 'unexpected' }; }
  });
  assert.equal(calls, 0);
  assert.equal(result.successCount, 0);
  assert.ok(result.failures.every((candidate) => candidate.errorCode === 'CANDIDATE_CANCELLED'));
});

test('fanout timeout bounds a provider that ignores its abort signal', { timeout: 2000 }, async () => {
  const result = await runCandidateFanout({
    candidates: [bindings[0]],
    timeoutMs: 10,
    invoke: () => new Promise(() => {})
  });
  assert.equal(result.failures[0].status, 'TIMED_OUT');
  assert.equal(result.failures[0].errorCode, 'CANDIDATE_TIMEOUT');
});

test('fanout cancellation stops queued calls when an active provider ignores abort', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runCandidateFanout({
    candidates: bindings,
    signal: controller.signal,
    invoke: () => {
      calls += 1;
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.successCount, 0);
  assert.ok(result.failures.every((candidate) => candidate.errorCode === 'CANDIDATE_CANCELLED'));
});

test('fanout deduplicates repeated bindings before spending budget', async () => {
  let invocations = 0;
  const outcome = await runCandidateFanout({
    candidates: [bindings[0], { ...bindings[0] }],
    concurrency: 2,
    invoke: async () => { invocations += 1; return { text: 'draft' }; }
  });
  assert.equal(invocations, 1);
  assert.equal(outcome.candidateCount, 1);
  assert.equal(outcome.duplicates.length, 1);
});

test('selection degrades deterministically when no independent judge exists', async () => {
  const policy = new CandidateSelectionPolicy();
  const candidates = [
    { candidateId: 'binding-a', bindingId: 'binding-a', status: 'SUCCEEDED', expectedCost: 3, latencyMs: 100 },
    { candidateId: 'binding-b', bindingId: 'binding-b', status: 'SUCCEEDED', expectedCost: 1, latencyMs: 400 }
  ];
  const noJudge = await policy.select({ candidates });
  assert.equal(noJudge.status, 'SELECTED');
  assert.equal(noJudge.degraded, true);
  assert.equal(noJudge.degradationReason, 'INDEPENDENT_JUDGE_UNAVAILABLE');
  assert.equal(noJudge.selectedCandidateId, 'binding-b');

  const selfJudge = await policy.select({ candidates, judge: { bindingId: 'binding-a', score: async () => [] } });
  assert.equal(selfJudge.degraded, true);
  assert.equal(selfJudge.degradationReason, 'JUDGE_SHARES_CANDIDATE_BINDING');
  assert.equal(selfJudge.selectedCandidateId, 'binding-b');
});

test('judge ranking orders survivors but cannot resurrect a hard failure', async () => {
  const policy = new CandidateSelectionPolicy();
  const candidates = [
    { candidateId: 'binding-a', bindingId: 'binding-a', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'a'.repeat(64)}` },
    { candidateId: 'binding-b', bindingId: 'binding-b', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'b'.repeat(64)}` },
    { candidateId: 'binding-c', bindingId: 'binding-c', status: 'SUCCEEDED', hardFailureCodes: ['TEST_FAILED'] }
  ];
  const judge = {
    bindingId: 'judge-1',
    score: async ({ candidates: pool }) => pool.map((candidate) => ({
      candidateId: candidate.candidateId,
      score: candidate.candidateId === 'binding-a' ? 0.4 : 0.9,
      components: { evidenceStrength: candidate.candidateId === 'binding-a' ? 0.2 : 0.8 }
    }))
  };
  // A judge that also tries to score the hard-failed candidate is rejected.
  const tampered = await policy.select({
    candidates,
    judge: { bindingId: 'judge-1', score: async () => [{ candidateId: 'binding-c', score: 1 }] }
  });
  assert.equal(tampered.degraded, true);
  assert.equal(tampered.degradationReason, 'JUDGE_RETURNED_UNKNOWN_CANDIDATE');
  assert.equal(tampered.selectedCandidateId, 'binding-a');

  const ranked = await policy.select({ candidates, judge });
  assert.deepEqual(ranked.eliminated, [{ candidateId: 'binding-c', reasons: ['TEST_FAILED'] }]);
  assert.equal(ranked.degraded, false);
  assert.equal(ranked.selectedCandidateId, 'binding-b');
  assert.equal(ranked.judgeBindingId, 'judge-1');
  assert.deepEqual(ranked.ranking.map((entry) => entry.candidateId), ['binding-b', 'binding-a']);
  assert.equal(ranked.ranking[0].source, 'JUDGE');
});

test('selection reports no eligible candidate when every candidate failed', async () => {
  const policy = new CandidateSelectionPolicy();
  const result = await policy.select({
    candidates: [{ candidateId: 'binding-a', bindingId: 'binding-a', status: 'FAILED' }]
  });
  assert.equal(result.status, 'NO_ELIGIBLE_CANDIDATE');
  assert.equal(result.selectedCandidateId, undefined);
  assert.deepEqual(result.eliminated[0].reasons, ['CANDIDATE_NOT_SUCCEEDED']);
});

test('selection decision maps每 candidate to an option with per-source attribution', async () => {
  const policy = new CandidateSelectionPolicy();
  const candidates = [
    { candidateId: 'binding-a', bindingId: 'binding-a', modelId: 'model-a', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'a'.repeat(64)}`, expectedCost: 1, latencyMs: 90 },
    { candidateId: 'binding-b', bindingId: 'binding-b', modelId: 'model-b', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'b'.repeat(64)}`, expectedCost: 2, latencyMs: 40 },
    { candidateId: 'binding-c', bindingId: 'binding-c', modelId: 'model-c', status: 'FAILED', errorCode: 'PROVIDER_DOWN' }
  ];
  const selection = await policy.select({
    candidates,
    judge: { bindingId: 'judge-1', score: async () => [{ candidateId: 'binding-a', score: 0.8 }, { candidateId: 'binding-b', score: 0.3 }] }
  });
  const built = buildCandidateSelectionDecision({
    candidates,
    selection,
    selectionPolicyRef: 'candidate-selection.default',
    fanout: 3,
    risk: 'CRITICAL',
    truncation: { requestedFanout: 4, truncated: true, truncationReasons: ['RISK_POLICY_CEILING'], droppedBindingIds: ['binding-d'] }
  });
  assert.equal(built.decisionType, 'SELECT_CANDIDATE');
  assert.equal(built.decisionSnapshot.selectedOptionId, 'binding-a');
  assert.deepEqual(built.decisionSnapshot.options.map((option) => option.optionId), ['binding-a', 'binding-b', 'binding-c']);
  // Score attribution is per candidate, not copied from the winner.
  assert.equal(built.decisionSnapshot.options[0].expectedQuality, 0.8);
  assert.equal(built.decisionSnapshot.options[1].expectedQuality, 0.3);
  assert.equal(built.decisionSnapshot.options[2].expectedQuality, undefined);
  assert.deepEqual(built.decisionSnapshot.options[2].rejectionReasonCodes, ['CANDIDATE_NOT_SUCCEEDED']);
  assert.deepEqual(built.optionStates, { 'binding-a': 'SELECTED', 'binding-b': 'NOT_EXECUTED', 'binding-c': 'ELIMINATED' });
  assert.equal(built.fanout.truncated, true);
  assert.deepEqual(built.fanout.truncationReasons, ['RISK_POLICY_CEILING']);
  assert.equal(built.decisionSnapshot.reasonCodes.includes('CANDIDATE_SET_TRUNCATED'), true);
  // Only digests and bounded scores reach the decision record.
  assert.equal(JSON.stringify(built).includes('draft for'), false);
});

test('built SELECT_CANDIDATE decision commits through the real Decision Trace', async () => {
  const policy = new CandidateSelectionPolicy();
  const candidates = [
    { candidateId: 'binding-a', bindingId: 'binding-a', modelId: 'model-a', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'a'.repeat(64)}`, expectedCost: 1, latencyMs: 90 },
    { candidateId: 'binding-b', bindingId: 'binding-b', modelId: 'model-b', status: 'SUCCEEDED', outputDraftDigest: `sha256:${'b'.repeat(64)}`, expectedCost: 2, latencyMs: 40 }
  ];
  const selection = await policy.select({
    candidates,
    judge: { bindingId: 'judge-1', score: async () => [{ candidateId: 'binding-a', score: 0.7 }, { candidateId: 'binding-b', score: 0.2 }] }
  });
  const built = buildCandidateSelectionDecision({
    candidates,
    selection,
    selectionPolicyRef: 'candidate-selection.default',
    fanout: 2,
    risk: 'HIGH',
    evidenceRefs: [
      { evidenceId: 'evidence-a', eventId: 'event-a', evidenceType: 'candidate-invocation', stance: 'SUPPORTS', freshnessAtMs: 10 },
      { evidenceId: 'evidence-b', eventId: 'event-b', evidenceType: 'candidate-invocation', stance: 'SUPPORTS', freshnessAtMs: 11 }
    ],
    evidenceByCandidate: { 'binding-a': ['evidence-a'], 'binding-b': ['evidence-b'] }
  });
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-candidate-decision-'));
  const trace = new AgentDecisionTrace({ storagePath: join(directory, 'decision-trace.json'), now: () => 100 });
  const proposed = await trace.propose({
    runId: 'run-candidates',
    stepId: 'step-1',
    agentInstanceId: 'agent-1',
    role: 'planner',
    roleContextId: 'role-context-1',
    bindingSnapshotId: 'binding-1',
    objectiveRef: 'objective-1',
    constraintSnapshotId: 'constraints-1',
    featureSnapshotId: 'features-1',
    assumptions: [{ assumptionId: 'assumption-1', statement: 'candidates were produced by independent bindings', source: 'POLICY', testable: true }],
    decisionSummary: 'Select one candidate draft for execution.',
    expectedOutcome: { successCriteriaRefs: ['criterion-1'], predictedOutcomeCode: 'CANDIDATE_SELECTED', predictedProgress: 0.2, predictedRiskCodes: [] },
    outputRefs: ['candidate-draft-1'],
    sensitivity: 'INTERNAL',
    ...built.decisionSnapshot
  });
  assert.equal(proposed.decisionType, 'SELECT_CANDIDATE');
  assert.equal(proposed.selectedOptionId, 'binding-a');
  assert.deepEqual(proposed.options.map((option) => option.optionId), ['binding-a', 'binding-b']);
  assert.deepEqual(proposed.options[0].evidenceRefs, ['evidence-a']);
  assert.deepEqual(proposed.options[1].evidenceRefs, ['evidence-b']);
  const committed = await trace.commit(proposed.decisionId);
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(JSON.stringify(committed).includes('candidate:draft'), false);
});

const draftSpec = () => normalizeCandidateSetSpec({
  mode: 'CANDIDATE_SET',
  fanout: 2,
  fanoutBudget: { maxCandidates: 3, maxConcurrency: 2 },
  candidateBindings: [
    { bindingId: 'binding-a', modelId: 'model-a', provider: 'openai', expectedCost: 1 },
    { bindingId: 'binding-b', modelId: 'model-b', provider: 'deepseek', expectedCost: 2 }
  ]
});

test('draft stage never invokes a candidate that safety rejected', async () => {
  let invoked = 0;
  const blocked = await runCandidateDraftStage({
    spec: draftSpec(),
    risk: 'HIGH',
    precheck: { status: 'BLOCKED', reason: 'PROMPT_EMPTY_OR_TOO_LARGE' },
    draftPrompt: 'x',
    invokeCandidate: async () => { invoked += 1; return { text: 'draft' }; }
  });
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.reason, 'CANDIDATE_SET_EMPTY_AFTER_SAFETY');
  assert.equal(invoked, 0);
  assert.equal(blocked.selectedDraft, undefined);
  assert.equal(blocked.decision, undefined);
});

test('draft stage returns only the selected draft and accounts per candidate', async () => {
  let judgedDrafts;
  const stage = await runCandidateDraftStage({
    spec: draftSpec(),
    risk: 'HIGH',
    precheck: { status: 'ALLOWED' },
    draftPrompt: 'Draft the next bounded action.',
    draftContext: 'plan step 1',
    invokeCandidate: async ({ binding }) => ({
      text: `draft from ${binding.bindingId}`,
      outputChars: 20
    }),
    judge: {
      bindingId: 'judge-independent',
      score: async ({ candidates: pool }) => {
        judgedDrafts = pool.map((candidate) => candidate.draftText);
        return pool.map((candidate) => ({
        candidateId: candidate.candidateId,
        score: candidate.candidateId === 'binding-b' ? 0.8 : 0.2,
        components: { evidenceStrength: 0.5 }
        }));
      }
    }
  });
  assert.equal(stage.status, 'SELECTED');
  assert.deepEqual(judgedDrafts, ['draft from binding-a', 'draft from binding-b']);
  assert.equal(stage.fanout.successCount, 2);
  assert.equal(stage.selection.selectedCandidateId, 'binding-b');
  assert.equal(stage.selectedDraft, 'draft from binding-b');
  assert.deepEqual(stage.optionStates, { 'binding-a': 'NOT_EXECUTED', 'binding-b': 'SELECTED' });
  assert.equal(stage.decision.decisionType, 'SELECT_CANDIDATE');
  // Unselected draft text never leaves the stage.
  assert.equal(JSON.stringify(stage).includes('draft from binding-a'), false);
  assert.deepEqual(stage.egress.map((entry) => entry.candidateId), ['binding-a', 'binding-b']);
  assert.deepEqual(stage.egress.map((entry) => entry.provider), ['openai', 'deepseek']);
});

test('draft stage still selects when one candidate fails and never executes the loser', async () => {
  const stage = await runCandidateDraftStage({
    spec: draftSpec(),
    risk: 'HIGH',
    precheck: { status: 'ALLOWED' },
    draftPrompt: 'Draft the next bounded action.',
    invokeCandidate: async ({ binding }) => {
      if (binding.bindingId === 'binding-a') {
        const error = new Error('PROVIDER_DOWN');
        error.code = 'PROVIDER_DOWN';
        throw error;
      }
      return { text: 'draft from binding-b' };
    }
  });
  assert.equal(stage.status, 'SELECTED');
  assert.equal(stage.fanout.successCount, 1);
  assert.equal(stage.fanout.failureCount, 1);
  assert.equal(stage.selection.selectedCandidateId, 'binding-b');
  assert.equal(stage.selectedDraft, 'draft from binding-b');
  assert.deepEqual(stage.selection.eliminated, [{ candidateId: 'binding-a', reasons: ['CANDIDATE_NOT_SUCCEEDED'] }]);
  assert.equal(stage.optionStates['binding-a'], 'ELIMINATED');
  assert.deepEqual(stage.decision.decisionSnapshot.options[0].rejectionReasonCodes, ['CANDIDATE_NOT_SUCCEEDED']);
});

test('draft stage reports no eligible candidate instead of inventing a winner', async () => {
  const stage = await runCandidateDraftStage({
    spec: draftSpec(),
    risk: 'HIGH',
    precheck: { status: 'ALLOWED' },
    draftPrompt: 'Draft the next bounded action.',
    invokeCandidate: async () => { throw new Error('PROVIDER_DOWN'); }
  });
  assert.equal(stage.status, 'NO_ELIGIBLE_CANDIDATE');
  assert.equal(stage.selection.selectedCandidateId, undefined);
  assert.equal(stage.selectedDraft, undefined);
  assert.equal(stage.decision.decisionSnapshot.selectedOptionId, undefined);
  assert.equal(stage.optionStates['binding-a'], 'ELIMINATED');
  assert.equal(stage.optionStates['binding-b'], 'ELIMINATED');
});
