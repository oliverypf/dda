import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePlannerPlan,
  normalizeSemanticVerdict,
  mergeSemanticVerification,
  runAgentPipeline,
  runExecutorTurn,
  runPlannerTurn,
  runSemanticVerifierTurn
} from '../src/agent-turns.mjs';

// The process verifier's status is derived from the token probability of the
// ordered rating letter, so every fake provider must emit the real logprob
// channel instead of a model-authored status or number.
const scoreChunks = (body, { tag = '<score>', letter = 'A', probability = 0.97 } = {}) => [
  { type: 'text-delta', text: `${body}${tag}${letter}${tag.replace('<', '</')}` },
  { type: 'score-logprobs', positions: [
    { token: tag },
    { token: letter, top_logprobs: [
      { token: letter, logprob: Math.log(probability) },
      { token: letter === 'A' ? 'T' : 'A', logprob: Math.log(1 - probability) }
    ] }
  ] }
];

const providerFor = (chunks, onRequest) => ({
  provider: 'fake',
  protocol: 'responses',
  model: 'fake-model',
  async *stream(request) {
    onRequest?.(request);
    for (const chunk of chunks) yield chunk;
  }
});

test('semantic merging preserves deterministic progress and uncertainty states', () => {
  for (const ruleStatus of ['PASS', 'FAIL', 'CONTINUE', 'STALLED', 'UNCERTAIN', 'UNKNOWN']) {
    for (const semanticStatus of ['PASS', 'FAIL', 'ABSTAIN', 'INVALID', undefined]) {
      const rule = { status: ruleStatus, failureCodes: ['RULE_EVIDENCE'], evidence: { checked: true } };
      const expected = semanticStatus === 'FAIL' ? 'FAIL'
        : ruleStatus === 'PASS' && semanticStatus !== 'PASS' ? 'UNCERTAIN' : ruleStatus;
      const merged = mergeSemanticVerification(rule, { status: semanticStatus });
      assert.equal(merged.status, expected, `${ruleStatus}/${semanticStatus}`);
      assert.ok(merged.failureCodes.includes('RULE_EVIDENCE'));
      assert.deepEqual(rule, { status: ruleStatus, failureCodes: ['RULE_EVIDENCE'], evidence: { checked: true } });
    }
  }
});

test('planner runs an isolated no-tool turn and validates a bounded DAG plan', async () => {
  let request;
  const planner = await runPlannerTurn({
    provider: providerFor([
      { type: 'text-delta', text: '```json\n{"planId":"p1","steps":[{"stepId":"inspect","summary":"Inspect files","actionKind":"READ","dependencies":[]},{"stepId":"report","summary":"Report evidence","dependencies":["inspect"]}],"acceptanceCriteria":["evidence"]}\n```' }
    ], (value) => { request = value; }),
    prompt: '检查项目',
    context: 'workspace snapshot digest=sha256:test',
    contextId: 'role-context-planner'
  });
  assert.equal(request.tools.length, 0);
  assert.match(request.system, /isolated model turn/iu);
  assert.equal(planner.parsed, true);
  assert.deepEqual(planner.plan.steps.map((step) => step.stepId), ['inspect', 'report']);
  assert.equal(planner.plan.steps[1].dependencies[0], 'inspect');
  assert.match(planner.plan.planDigest, /^sha256:/u);
});

test('planner falls back to one bounded step for unstructured output', async () => {
  const result = await runPlannerTurn({
    provider: providerFor([{ type: 'text-delta', text: 'I will inspect the workspace and report findings.' }]),
    prompt: '检查项目'
  });
  assert.equal(result.parsed, false);
  assert.equal(result.plan.source, 'FALLBACK_UNSTRUCTURED');
  assert.equal(result.plan.steps.length, 1);
  assert.equal(result.plan.steps[0].status, 'PENDING');
});

test('planner rejects cyclic plans before they can reach an executor', () => {
  assert.throws(() => normalizePlannerPlan({
    steps: [
      { stepId: 'a', summary: 'a', dependencies: ['b'] },
      { stepId: 'b', summary: 'b', dependencies: ['a'] }
    ]
  }), /PLANNER_PLAN_CYCLE/u);
  assert.throws(() => normalizePlannerPlan({ steps: [] }), /PLANNER_PLAN_INVALID/u);
});

test('semantic verifier is an independent no-tool turn and scores from token probabilities', async () => {
  let request;
  const verifier = await runSemanticVerifierTurn({
    provider: providerFor(scoreChunks('{"summary":"Evidence matches","evidenceRefs":["workspace:snapshot"]}', { letter: 'A', probability: 0.97 }), (value) => { request = value; }),
    contextId: 'role-context-verifier',
    ruleReport: { status: 'PASS', progress: 1, failureCodes: [], evidence: ['workspace:snapshot'] },
    result: { text: 'done', actions: [] },
    plan: normalizePlannerPlan({ steps: [{ stepId: 'step', summary: 'done' }] })
  });
  assert.deepEqual(request.tools, []);
  assert.equal(request.logprobs, true);
  // A near-certain A is a continuous expectation, not a parsed letter.
  assert.equal(verifier.verdict.status, 'PASS');
  assert.equal(verifier.verdict.source, 'TOKEN_LOGPROB_EXPECTATION');
  assert.ok(Math.abs(verifier.verdict.score - 0.97) < 0.01);
  assert.equal(verifier.verdict.progress, verifier.verdict.score);
  assert.deepEqual(verifier.verdict.distribution.map((item) => item.token), ['A', 'T']);
  assert.deepEqual(verifier.verdict.thresholds, { passThreshold: 0.9, failThreshold: 0.5 });
  assert.deepEqual(verifier.verdict.evidenceRefs, ['workspace:snapshot']);
  assert.deepEqual(verifier.verdict.failureCodes, []);
});

test('a text-only process verdict cannot become a score', async () => {
  const verifier = await runSemanticVerifierTurn({
    provider: providerFor([
      { type: 'text-delta', text: '{"status":"PASS","progress":1}<score>A</score>' }
    ]),
    result: { text: 'done', actions: [] }
  });
  assert.equal(verifier.verdict.status, 'ABSTAIN');
  assert.equal(verifier.verdict.source, 'LOGPROBS_MISSING');
  assert.equal(verifier.verdict.score, undefined);
  assert.equal(verifier.verdict.progress, 0);
  assert.ok(verifier.verdict.failureCodes.includes('SEMANTIC_VERIFIER_LOGPROBS_UNAVAILABLE'));
});

test('a low process expectation fails the step and a mid expectation abstains', async () => {
  const failing = await runSemanticVerifierTurn({
    provider: providerFor(scoreChunks('{"summary":"missing evidence"}', { letter: 'T', probability: 0.95 })),
    result: { text: 'done', actions: [] }
  });
  assert.equal(failing.verdict.status, 'FAIL');
  assert.ok(failing.verdict.failureCodes.includes('PROCESS_VERIFICATION_REJECTED'));
  const uncertain = await runSemanticVerifierTurn({
    provider: providerFor(scoreChunks('{"summary":"partly verified"}', { letter: 'D', probability: 0.96 })),
    result: { text: 'done', actions: [] }
  });
  assert.equal(uncertain.verdict.status, 'ABSTAIN');
  assert.ok(uncertain.verdict.failureCodes.includes('PROCESS_VERIFICATION_UNCERTAIN'));
});

test('operator thresholds reclassify the same probability evidence', async () => {
  const strict = await runSemanticVerifierTurn({
    provider: providerFor(scoreChunks('{"summary":"verified"}', { letter: 'A', probability: 0.97 })),
    result: { text: 'done', actions: [] },
    verifierConfig: { passThreshold: 0.99, failThreshold: 0.5 }
  });
  assert.equal(strict.verdict.status, 'ABSTAIN');
  assert.ok(strict.verdict.failureCodes.includes('PROCESS_VERIFICATION_UNCERTAIN'));
  assert.deepEqual(strict.verdict.thresholds, { passThreshold: 0.99, failThreshold: 0.5 });

  const lenient = await runSemanticVerifierTurn({
    provider: providerFor(scoreChunks('{"summary":"partial"}', { letter: 'D', probability: 0.96 })),
    result: { text: 'done', actions: [] },
    verifierConfig: { passThreshold: 0.6, failThreshold: 0.1 }
  });
  assert.equal(lenient.verdict.status, 'PASS');
  assert.deepEqual(lenient.verdict.thresholds, { passThreshold: 0.6, failThreshold: 0.1 });
});

test('a missing probability channel still records the configured thresholds', async () => {
  const verifier = await runSemanticVerifierTurn({
    provider: providerFor([{ type: 'text-delta', text: '{"summary":"no evidence"}' }]),
    result: { text: 'done', actions: [] },
    verifierConfig: { passThreshold: 0.99, failThreshold: 0.5 }
  });
  assert.equal(verifier.verdict.source, 'LOGPROBS_MISSING');
  assert.deepEqual(verifier.verdict.thresholds, { passThreshold: 0.99, failThreshold: 0.5 });
});

test('invalid semantic output fails closed to ABSTAIN', () => {
  const verdict = normalizeSemanticVerdict({ status: 'maybe', summary: 'unclear' });
  assert.equal(verdict.status, 'ABSTAIN');
  assert.deepEqual(verdict.failureCodes, ['SEMANTIC_VERDICT_UNSTRUCTURED']);
});

test('executor adapter delegates to the existing safety-aware task runner', async () => {
  let call;
  const taskRunner = {
    async run(value) {
      call = value;
      return { text: 'done', toolRounds: 0, toolCallCount: 0, actions: [] };
    }
  };
  const provider = { provider: 'fake', model: 'fake' };
  const plan = normalizePlannerPlan({ steps: [{ stepId: 'step', summary: 'inspect' }] });
  const result = await runExecutorTurn({
    taskRunner,
    provider,
    contextId: 'role-context-executor',
    plan,
    prompt: '检查项目',
    workspace: { granted: true },
    historyContext: 'prior context'
  });
  assert.equal(call.role, 'executor');
  assert.equal(call.roleContextId, 'role-context-executor');
  assert.equal(call.modelProvider, provider);
  assert.match(call.historyContext, /Validated planner output/iu);
  assert.equal(result.planDigest, plan.planDigest);
});

test('isolated turns reject a provider-produced tool call', async () => {
  await assert.rejects(() => runPlannerTurn({
    provider: providerFor([{ type: 'tool-call', id: 'x', name: 'workspace.read', arguments: '{}' }]),
    prompt: '检查项目'
  }), /AGENT_TURN_TOOLS_FORBIDDEN/u);
});

test('each role turn receives a fresh message list and bounded role context', async () => {
  const requests = [];
  const provider = providerFor([
    { type: 'text-delta', text: '{"status":"ABSTAIN"}' }
  ], (request) => { requests.push(request); });
  await runPlannerTurn({ provider, prompt: 'planner prompt', context: 'planner-only', contextId: 'planner-context' });
  await runSemanticVerifierTurn({ provider, result: { text: 'executor result' }, contextId: 'verifier-context' });
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].messages, requests[1].messages);
  assert.match(requests[0].messages[0].content[0].text, /planner-only/u);
  assert.doesNotMatch(requests[1].messages[0].content[0].text, /planner-only/u);
  assert.match(requests[0].system, /Planner role/iu);
  assert.match(requests[1].system, /Semantic Verifier role/iu);
});

test('pipeline executes three role boundaries and keeps semantic ABSTAIN non-authoritative', async () => {
  const phases = [];
  const calls = [];
  const provider = {
    async *stream(request) {
      calls.push(request);
      if (/Planner role/iu.test(request.system)) {
        yield { type: 'text-delta', text: '{"steps":[{"stepId":"execute","summary":"inspect"}]}' };
      } else {
        yield { type: 'text-delta', text: 'not structured' };
      }
    }
  };
  const output = await runAgentPipeline({
    prompt: 'inspect',
    workspace: { granted: true },
    plannerProvider: provider,
    executorProvider: provider,
    verifierProvider: provider,
    executorRunner: {
      async run({ modelProvider, role, roleContextId, historyContext }) {
        assert.equal(modelProvider, provider);
        assert.equal(role, 'executor');
        assert.equal(roleContextId, 'executor-context');
        assert.match(historyContext, /Validated planner output/iu);
        return { text: 'done', actions: [], toolRounds: 0, toolCallCount: 0 };
      }
    },
    contextIds: { planner: 'planner-context', executor: 'executor-context', verifier: 'verifier-context' },
    ruleVerify: async () => ({ status: 'PASS', progress: 1, failureCodes: [] }),
    onPhase: ({ phase }) => phases.push(phase)
  });
  assert.deepEqual(phases, ['PLANNING', 'EXECUTING', 'VERIFYING', 'COMPLETED']);
  assert.equal(calls.length, 2);
  assert.equal(output.status, 'UNCERTAIN');
  assert.ok(output.verification.failureCodes.includes('SEMANTIC_VERIFIER_ABSTAINED'));
  assert.equal(output.semantic.verdict.status, 'ABSTAIN');
});

test('pipeline preserves a hard rule failure even if semantic verifier says pass', async () => {
  const provider = {
    async *stream(request) {
      if (/Planner role/iu.test(request.system)) {
        yield { type: 'text-delta', text: '{"steps":[{"stepId":"execute","summary":"inspect"}]}' };
      } else {
        yield* scoreChunks('{"summary":"verified"}', { letter: 'A', probability: 0.98 });
      }
    }
  };
  const output = await runAgentPipeline({
    prompt: 'inspect',
    plannerProvider: provider,
    executorProvider: provider,
    verifierProvider: provider,
    executorRunner: { async run() { return { text: 'done', actions: [] }; } },
    ruleVerify: async () => ({ status: 'FAIL', failureCodes: ['PATH_OUT_OF_SCOPE'] })
  });
  assert.equal(output.semantic.verdict.status, 'PASS');
  assert.equal(output.status, 'FAIL');
});
