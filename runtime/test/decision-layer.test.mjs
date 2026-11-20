import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { observedWorkspaceRead, verifiedWorkspaceReadEvidence } from '../src/decision/evidence-claim.mjs';
import { JevClient } from '../src/decision/jev-client.mjs';
import {
  deterministicEvidenceJudge,
  deterministicFailureRouter,
  deterministicStopJudge
} from '../src/decision/rules.mjs';
import { createDecisionState } from '../src/decision/types.mjs';

test('failure router keeps assertion failures in the test failure lane', () => {
  const result = deterministicFailureRouter({
    action: { kind: 'TEST', summary: 'pytest tests/auth' },
    observation: {
      status: 'FAIL',
      summary: 'AssertionError: expected status 200, actual status 401',
      failureCodes: ['ASSERTION']
    }
  });
  assert.equal(result.decision, 'TEST_FAILURE');
  assert.equal(result.source, 'rule');
  assert.equal(result.confidence, 1);
});

test('evidence and stop rules block premature success', () => {
  const state = {
    observation: { status: 'PASS', ok: true },
    requirements: [{ id: 'r1', description: 'targeted test passes', status: 'unknown' }],
    evidence: []
  };
  const evidence = deterministicEvidenceJudge(state);
  assert.equal(evidence.decision, 'MISSING_TEST_EVIDENCE');
  const stop = deterministicStopJudge(state, { decision: 'NONE' }, evidence);
  assert.equal(stop.decision, 'NEED_MORE_EVIDENCE');
});

test('Jev client normalizes finite-choice answers and sends no tool surface', async () => {
  let request;
  const client = new JevClient({
    endpoint: 'https://jev.test/decide',
    apiKey: 'test-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          answers: {
            failureType: { choice: 'TEST_FAILURE', confidence: 0.82, scores: { TEST_FAILURE: 0.82 } }
          }
        })
      };
    }
  });
  const result = await client.decide({
    state: { taskId: 'task-1' },
    questions: { failureType: { type: 'choice', choices: ['TEST_FAILURE', 'UNKNOWN'] } }
  });
  assert.equal(result.answers.failureType.choice, 'TEST_FAILURE');
  assert.deepEqual(request.questions.failureType.criteria, { TEST_FAILURE: null, UNKNOWN: null });
  assert.equal(Object.hasOwn(request.questions.failureType, 'choices'), false);
  assert.equal(Object.hasOwn(request, 'output'), false);
  assert.equal(Object.hasOwn(request, 'tools'), false);
});

test('public network tools ask only for a malicious URL verdict and allow uncertainty', async () => {
  const networkUrl = 'https://public.example.test/docs';
  for (const tool of ['network.request', 'browser.open']) {
    for (const [answer, decision, reasonCode] of [
      [{ choice: 'MALICIOUS', confidence: 0.99 }, 'BLOCK', 'NETWORK_URL_MALICIOUS'],
      [{ choice: 'MALICIOUS' }, 'BLOCK', 'NETWORK_URL_MALICIOUS'],
      [{ choice: 'MALICIOUS', confidence: 0.55 }, 'ALLOW', 'NETWORK_URL_UNKNOWN'],
      [{ choice: 'MALICIOUS', confidence: 99 }, 'ALLOW', 'NETWORK_URL_UNKNOWN'],
      [{ choice: 'UNKNOWN', confidence: 0.99 }, 'ALLOW', 'NETWORK_URL_UNKNOWN'],
      [{ choice: 'BENIGN', confidence: 0.98 }, 'ALLOW', 'NETWORK_URL_BENIGN'],
      [{ choice: 'REQUEST_EVIDENCE' }, 'ALLOW', 'NETWORK_URL_UNKNOWN'],
      [undefined, 'ALLOW', 'NETWORK_URL_UNKNOWN'],
      [new Error('JEV_TIMEOUT'), 'ALLOW', 'NETWORK_URL_REVIEW_UNAVAILABLE']
    ]) {
      let requests = 0;
      const engine = createDecisionEngine({ enabled: true, client: { async decide({ questions, state }) {
        requests++;
        assert.deepEqual(Object.keys(questions), ['networkUrl']);
        assert.deepEqual(questions.networkUrl.context, { url: networkUrl });
        assert.deepEqual(state.evidence, []);
        assert.equal(state.goal, '');
        if (answer instanceof Error) throw answer;
        return { answers: { networkUrl: answer } };
      } } });
      const state = { tool, goal: 'private goal', evidence: [{ id: 'sensitive', claim: 'sensitive' }] };
      const result = await engine.decideActionGate({ state, networkUrl });
      assert.equal(result.decision, decision);
      assert.equal(result.reasonCode, reasonCode);
      assert.equal(requests, 1);
      assert.equal((await engine.decideActionGate({ state })).decision, 'ALLOW');
      assert.equal((await engine.decideActionGate({ state, networkUrl,
        hardDecision: { decision: 'BLOCK', reasonCode: 'HOST_POLICY_BLOCK' } })).reasonCode, 'HOST_POLICY_BLOCK');
      assert.equal(requests, 1);
    }
  }
});

test('decision engine batches unresolved Jev questions and returns a finite control action', async () => {
  let calls = 0;
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      model: 'jev-test',
      async decide({ questions }) {
        calls += 1;
        assert.ok(questions.failureType);
        return {
          latencyMs: 7,
          answers: {
            failureType: { choice: 'UNKNOWN', confidence: 0.61 },
            escalation: { choice: 'USE_NORMAL_MODEL', confidence: 0.72 }
          }
        };
      }
    }
  });
  const result = await engine.decide({
    taskId: 'task-1',
    goal: 'repair a coding task',
    currentStep: 'execute bounded action',
    action: { kind: 'EXECUTE', summary: 'bounded action' },
    observation: { status: 'FAILED', ok: false, summary: 'opaque failure' },
    requirements: [{ id: 'r1', description: 'code change is valid', status: 'supported' }],
    evidence: [{ id: 'e1', type: 'tool_result', claim: 'tool returned an opaque error', source: 'tool-1', confidence: 0.4 }],
    currentConfidence: 0.4
  });
  assert.equal(calls, 1);
  assert.equal(result.failure.decision, 'UNKNOWN');
  assert.equal(result.escalation.decision, 'USE_NORMAL_MODEL');
  assert.ok(['CONTINUE', 'RETRY', 'ESCALATE'].includes(result.action));
  assert.equal(result.config.model, 'jev-test');
});

test('decision engine fails closed to conservative recovery when Jev is unavailable', async () => {
  const engine = createDecisionEngine({ enabled: false, enforce: false });
  const result = await engine.decide({
    taskId: 'task-2',
    action: { kind: 'EXECUTE' },
    observation: { status: 'FAILED', ok: false, summary: 'unknown failure' },
    requirements: [{ id: 'r1', description: 'finish the task', status: 'unknown' }]
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.failure.decision, 'UNKNOWN');
  assert.equal(result.stop.decision, 'NEED_MORE_EVIDENCE');
});

test('decision engine records fallback when an enabled Jev request fails', async () => {
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      async decide() {
        const error = new Error('missing credential');
        error.code = 'JEV_CREDENTIAL_MISSING';
        throw error;
      }
    }
  });
  const result = await engine.decide({
    taskId: 'task-3',
    action: { kind: 'EXECUTE' },
    observation: { status: 'FAILED', ok: false, summary: 'opaque failure' },
    requirements: [{ id: 'r1', description: 'finish the task', status: 'unknown' }],
    currentConfidence: 0
  });
  assert.equal(result.fallbackUsed, true);
  assert.equal(result.fallbackReason, 'JEV_CREDENTIAL_MISSING');
  assert.equal(result.failure.decision, 'UNKNOWN');
  assert.equal(result.escalation.decision, 'USE_STRONG_MODEL');
});

test('decision state honors the configured size limit', () => {
  const state = createDecisionState({
    taskId: 'task-size',
    goal: 'g'.repeat(1200),
    currentStep: 's'.repeat(600),
    action: { kind: 'EXECUTE', summary: 'a'.repeat(600) },
    observation: {
      status: 'FAILED',
      ok: false,
      summary: 'o'.repeat(1000),
      failureCodes: Array.from({ length: 64 }, (_, index) => `failure-${index}`)
    },
    requirements: Array.from({ length: 64 }, (_, index) => ({
      id: `requirement-${index}`,
      description: 'd'.repeat(500),
      status: 'unknown'
    })),
    availableTests: Array.from({ length: 64 }, (_, index) => ({
      id: `test-${index}`,
      command: 'npm test',
      type: 'targeted'
    }))
  }, { maxStateChars: 1000 });
  assert.ok(JSON.stringify(state).length <= 1000);
});

test('Jev owns candidate selection and action gating without a model verifier role', async () => {
  const calls = [];
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      async decide({ questions }) {
        calls.push(Object.keys(questions));
        if (questions.candidate) return { latencyMs: 3, answers: { candidate: { choice: 'candidate-b', confidence: 0.88 } } };
        if (questions.actionGate) return { latencyMs: 4, answers: { actionGate: { choice: 'BLOCK', confidence: 0.94 } } };
        return { latencyMs: 5, answers: { verification: { choice: 'UNCERTAIN', confidence: 0.8 } } };
      }
    }
  });
  const selected = await engine.selectCandidates({
    state: { taskId: 'task-jev', goal: 'choose a safe draft' },
    evidence: [{ id: 'e1', type: 'tool_result', claim: 'candidate evidence', source: 'tool', confidence: 0.8 }],
    candidates: [{ candidateId: 'candidate-a' }, { candidateId: 'candidate-b' }]
  });
  assert.equal(selected.selectedCandidateId, 'candidate-b');
  const gate = await engine.decideActionGate({ state: {
    taskId: 'task-jev', goal: 'do not write files', tool: 'file.write', toolReadOnly: false
  } });
  assert.equal(gate.decision, 'BLOCK');
  const behavior = await engine.judgeVerification({ ruleStatus: 'PASS', state: { taskId: 'task-jev', goal: 'finish' }, evidence: [] });
  assert.equal(behavior.decision, 'UNCERTAIN');
  assert.deepEqual(calls, [['candidate'], ['actionGate', 'actionGateReason'], ['verification', 'verificationReason']]);
});

test('workspace read verification requires matching successful host observations', () => {
  const definition = { readOnly: true };
  const workspaceRead = observedWorkspaceRead('workspace.read', definition, { path: 'desktop/package.json' });
  assert.deepEqual(workspaceRead, { path: 'desktop/package.json', scope: 'IN_WORKSPACE', readOnly: true });
  assert.equal(observedWorkspaceRead('workspace.read', definition, { path: 'C:/other/package.json' }), undefined);
  assert.equal(observedWorkspaceRead('workspace.read', definition, { path: '/other/package.json' }), undefined);
  assert.equal(observedWorkspaceRead('workspace.read', definition, { path: 'README.md', found: false }), undefined);
  assert.equal(observedWorkspaceRead('shell.execute', definition, { path: 'README.md' }), undefined);
  assert.equal(observedWorkspaceRead('workspace.read', { readOnly: false }, { path: 'README.md' }), undefined);
  const outputDigest = `sha256:${'a'.repeat(64)}`;
  const action = { name: 'workspace.read', state: 'SUCCEEDED', outputDigest, verifiedResult: { workspaceRead, outputDigest } };
  assert.equal(verifiedWorkspaceReadEvidence([action]).completedInvocations, 1);
  assert.equal(verifiedWorkspaceReadEvidence([]), undefined);
  assert.equal(verifiedWorkspaceReadEvidence([{ ...action, state: 'FAILED', invocationAttempted: false }]), undefined);
  assert.equal(verifiedWorkspaceReadEvidence([{ ...action, outputDigest: 'mismatch' }]), undefined);
  assert.equal(verifiedWorkspaceReadEvidence([action, { name: 'file.write', state: 'SUCCEEDED' }]), undefined);
});

test('a clean prerequisite retry retains prior binary-read limitations and blocked proposals without counting them as evidence', () => {
  const outputDigest = 'sha256:' + '1'.repeat(64);
  const current = { name: 'workspace.read', state: 'SUCCEEDED', outputDigest,
    verifiedResult: { outputDigest, workspaceRead: { scope: 'IN_WORKSPACE', path: 'docs/build.mjs', readOnly: true } } };
  const denied = { name: 'shell.execute', state: 'FAILED', invocationAttempted: false,
    gateDecision: 'BLOCK', errorCode: 'TOOL_OUTSIDE_EXECUTION_SCOPE' };
  const binary = { name: 'workspace.read', state: 'FAILED', errorCode: 'WORKSPACE_BINARY_FILE',
    path: 'docs/demo.pptx', errorMessage: 'docs/demo.pptx' };
  const evidence = verifiedWorkspaceReadEvidence([current], [denied, binary, current]);
  assert.equal(evidence.completedInvocations, 1);
  assert.equal(evidence.priorLimitCount, 2);
  assert.deepEqual(evidence.recentResults.map(item => item.path), ['docs/build.mjs']);
  assert.deepEqual(evidence.priorLimits.map(item => item.errorCode), ['TOOL_OUTSIDE_EXECUTION_SCOPE', 'WORKSPACE_BINARY_FILE']);
  assert.equal(verifiedWorkspaceReadEvidence([current, binary], []), undefined);
  assert.equal(verifiedWorkspaceReadEvidence([], [current, denied]), undefined);
  for (const other of [
    { ...denied, invocationAttempted: true }, { ...denied, effectApplied: true },
    { ...denied, errorCode: 'APPROVAL_DENIED' }, { ...binary, errorMessage: 'C:/outside/demo.pptx' },
    { ...binary, errorCode: 'WORKSPACE_SENSITIVE_PATH' }, { ...binary, name: 'file.write' },
    { ...current, name: 'shell.execute' }, { ...current, verifiedResult: undefined }
  ]) assert.equal(verifiedWorkspaceReadEvidence([current], [other]), undefined);
});

test('bounded Jev read verdict honors FAIL and treats an invalid reply as a provider failure', async () => {
  const engine = createDecisionEngine({ enabled: true, client: {
    async decide({ questions }) {
      assert.deepEqual(Object.keys(questions), ['verification']);
      assert.deepEqual(questions.verification.choices, ['PASS', 'FAIL']);
      return { answers: { verification: { choice } } };
    }
  } });
  const input = { state: { action: { kind: 'READ' } }, workspaceRead: {
    completedInvocations: 1, inWorkspaceInvocations: 1, readOnlyInvocations: 1, recentResults: []
  } };
  let choice = 'FAIL';
  const negative = await engine.judgeVerification(input);
  assert.equal(negative.decision, 'FAIL');
  assert.equal(negative.source, 'jev');
  assert.equal(negative.reasonCode, 'JEV_WORKSPACE_READ_REJECTED');
  choice = 'UNCERTAIN';
  const invalid = await engine.judgeVerification(input);
  assert.equal(invalid.decision, 'UNCERTAIN');
  assert.equal(invalid.source, 'rule');
  assert.equal(invalid.fallbackUsed, true);
  assert.equal(invalid.reasonCode, 'JEV_REQUEST_FAILED');
});

test('action gates retain host hard blocks and actual Jev refusals while avoiding duplicate instruction evidence', async () => {
  let calls = 0;
  const evidence = [{ id: 'actual-test', type: 'tool_result', claim: '{"name":"test.execute","ok":false,"exitCode":1}', source: 'host-test', confidence: 1 }];
  const engine = createDecisionEngine({ enabled: true, enforce: true, client: {
    async decide({ state, questions }) {
      calls += 1;
      assert.deepEqual(state.evidence.map(item => item.id), ['actual-test']);
      assert.equal(questions.actionGate.context.evidence, undefined, 'execution data is supplied once in state');
      return { answers: { actionGate: { choice: 'BLOCK', confidence: 0.05 } } };
    }
  } });
  const state = { taskId: 'task', goal: 'observe a diagnostic failure', tool: 'test.execute', evidence };
  const hard = await engine.decideActionGate({ state, hardDecision: { decision: 'BLOCK', source: 'rule', confidence: 1, reasonCode: 'TOOL_NOT_ALLOWED_IN_MODE' } });
  assert.equal(hard.decision, 'BLOCK');
  assert.equal(calls, 0, 'a semantic provider never overrides the host hard policy');
  const actual = await engine.decideActionGate({ state });
  assert.equal(actual.decision, 'BLOCK', 'low confidence does not silently convert an actual refusal into permission');
  assert.equal(actual.confidence, 0.05);
  assert.equal(calls, 1);
});

test('control judgments ask Jev even when a keyword rule already matches', async () => {
  let asked;
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      async decide({ questions }) {
        asked = Object.keys(questions).sort();
        return { latencyMs: 3, answers: { failureType: { choice: 'CODE_ERROR', confidence: 0.9 } } };
      }
    }
  });
  const result = await engine.decide({
    taskId: 'task-jev-first',
    action: { kind: 'EXECUTE', summary: 'read a file' },
    observation: { status: 'FAIL', ok: false, summary: 'permission denied' }
  });
  assert.deepEqual(asked, ['escalation', 'evidence', 'failureType', 'stop', 'test']);
  assert.equal(result.failure.decision, 'CODE_ERROR');
  assert.equal(result.failure.source, 'jev');
});

test('a missed control answer falls back to the keyword rule', async () => {
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      async decide() {
        const error = new Error('down');
        error.code = 'JEV_TIMEOUT';
        throw error;
      }
    }
  });
  const result = await engine.decide({
    taskId: 'task-rule-fallback',
    action: { kind: 'EXECUTE', summary: 'read a file' },
    observation: { status: 'FAIL', ok: false, summary: 'permission denied' }
  });
  assert.equal(result.failure.decision, 'PERMISSION');
  assert.equal(result.failure.source, 'rule');
  assert.equal(result.fallbackReason, 'JEV_TIMEOUT');
});

test('explicit controlJudgmentsEnabled false keeps a matched failure rule', async () => {
  let asked = [];
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    config: { controlJudgmentsEnabled: false },
    client: {
      async decide({ questions }) {
        asked = Object.keys(questions);
        return { answers: { failureType: { choice: 'CODE_ERROR', confidence: 1 } } };
      }
    }
  });
  const result = await engine.decide({
    taskId: 'task-rule-first',
    action: { kind: 'EXECUTE' },
    observation: { status: 'FAIL', ok: false, summary: 'permission denied' }
  });
  assert.equal(asked.includes('failureType'), false);
  assert.equal(result.failure.decision, 'PERMISSION');
  assert.equal(result.failure.source, 'rule');
});

test('candidate ranking follows Jev scores after the chosen id', async () => {
  const engine = createDecisionEngine({
    enabled: true,
    enforce: true,
    client: {
      async decide() {
        return {
          latencyMs: 2,
          answers: {
            candidate: {
              choice: 'full-roles',
              confidence: 0.7,
              scores: { 'executor-only': 0.2, 'full-roles': 0.7, 'unused': 1 }
            }
          }
        };
      }
    }
  });
  const selected = await engine.selectCandidates({
    prompt: 'Choose the role set.',
    criteria: { 'full-roles': 'plan', 'executor-only': 'one turn' },
    candidates: [
      { candidateId: 'executor-only', expectedCost: 0 },
      { candidateId: 'full-roles', expectedCost: 1 }
    ]
  });
  assert.equal(selected.selectedCandidateId, 'full-roles');
  assert.deepEqual(selected.ranking.map((item) => item.candidateId), ['full-roles', 'executor-only']);
});
