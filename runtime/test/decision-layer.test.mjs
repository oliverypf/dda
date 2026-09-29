import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionEngine } from '../src/decision/engine.mjs';
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
  assert.equal(request.output, 'finite_choice_distribution');
  assert.equal(Object.hasOwn(request, 'tools'), false);
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
  assert.deepEqual(calls, [['candidate'], ['actionGate'], ['verification']]);
});
