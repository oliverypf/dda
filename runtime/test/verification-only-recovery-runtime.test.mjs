import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRetryVerificationOnly } from '../src/decision/verification-retry.mjs';
import { runVerifierRecovery } from '../src/task-recovery-controller.mjs';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';
const stagedRuntime = new URL('..', import.meta.url);

test('verification transport recovery reuses one execution and does not duplicate action observations', async () => {
  let executes = 0, diagnoses = 0;
  const observations = [], phases = [];
  const result = { text: 'actual result', actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: 'sha256:one-write' }] };
  const output = await runVerifierRecovery({ maxAttempts: 2,
    execute: async () => { executes++; return result; },
    verify: async ({ attempt, result: observed, previousActions }) => {
      assert.equal(observed, result); observations.push(previousActions);
      return attempt === 1 ? { status: 'UNCERTAIN', verificationOnlyRetry: true } : { status: 'PASS' };
    }, diagnose: async () => { diagnoses++; return {}; }, onPhase: ({ phase }) => phases.push(phase) });
  assert.equal(output.ok, true); assert.equal(executes, 1); assert.equal(diagnoses, 0);
  assert.deepEqual(observations, [[], []]);
  assert.deepEqual(phases, ['EXECUTING', 'VERIFYING_RETRY']);
  assert.equal(output.history[1].verificationOnly, true);
});
test('hard failure and unresolved service uncertainty never become successful results', async () => {
  for (const status of ['UNCERTAIN', 'FAIL']) {
    let executes = 0, verifies = 0;
    const result = await runVerifierRecovery({ maxAttempts: 2, execute: async () => { executes++; return {}; },
      verify: async () => { verifies++; return { status, verificationOnlyRetry: true }; } });
    assert.equal(result.ok, false); assert.equal(executes, 1); assert.equal(verifies, status === 'FAIL' ? 1 : 2);
  }
});
test('only deterministic success plus actual transient provider failure qualifies for re-verification', () => {
  const facts = { ruleStatus: 'PASS', behaviorDecision: { source: 'rule', fallbackUsed: true, reasonCode: 'JEV_TIMEOUT' },
    report: { status: 'UNCERTAIN', failureCodes: [], checks: [{ id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'JEV_TIMEOUT' }] } };
  assert.equal(canRetryVerificationOnly(facts), true);
  assert.equal(canRetryVerificationOnly({ ...facts, behaviorDecision: { ...facts.behaviorDecision, reasonCode: 'JEV_HTTP_529' },
    report: { ...facts.report, checks: [{ id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'JEV_HTTP_529' }] } }), true);
  for (const change of [ { ruleStatus: 'FAIL' }, { report: { ...facts.report, status: 'FAIL' } },
    { behaviorDecision: { ...facts.behaviorDecision, source: 'jev' } }, { behaviorDecision: { ...facts.behaviorDecision, reasonCode: 'JEV_CANCELLED' } },
    { behaviorDecision: { ...facts.behaviorDecision, reasonCode: 'JEV_HTTP_401' } }, { behaviorDecision: { ...facts.behaviorDecision, reasonCode: 'JEV_RESPONSE_INVALID_JSON' } },
    { report: { ...facts.report, failureCodes: ['SAFETY_CAPABILITY_DENIED'] } },
    { report: { ...facts.report, checks: [...facts.report.checks, { id: 'paths.scope', status: 'FAIL' }] } },
    { report: { ...facts.report, checks: [{ id: 'evidence.missing', status: 'UNKNOWN' }] } } ]) assert.equal(canRetryVerificationOnly({ ...facts, ...change }), false);
});
test('semantic requests retain evidence once and preserve an actual negative choice', async () => {
  const evidence = [{ id: 'actual-record', type: 'tool_result', claim: 'Actual native result', source: 'host', confidence: 1 }];
  const engine = createDecisionEngine({ enabled: true, enforce: true, client: { async decide({ state, questions }) {
    assert.deepEqual(state.evidence.map(item => item.id), ['actual-record']);
    assert.equal(questions.verification.context.evidence, undefined);
    return { answers: { verification: { choice: 'FAIL', confidence: 0.05 } } };
  } } });
  const actual = await engine.judgeVerification({ ruleStatus: 'PASS', state: { taskId: 'task', goal: 'verify result' }, evidence });
  assert.equal(actual.decision, 'FAIL'); assert.equal(actual.confidence, 0.05);
});

for (const [mode, eventual] of [['READ_ONLY', 'PASS'], ['CONTROLLED', 'PASS'], ['CONTROLLED', 'FAIL'], ['CONTROLLED', 'SERVICE_FAILURE']]) {
  test(`native ${mode} workflow re-verifies after HTTP503 without another executor turn (${eventual})`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-verification-only-proof-'));
    const marker = 'GOAL_VERIFICATION_ONLY_ACTUAL_EVIDENCE';
    await writeFile(join(workspace, 'README.md'), marker);
    await writeFile(join(workspace, 'value.mjs'), 'export const value = 0;\n');
    await writeFile(join(workspace, 'value.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.mjs'; test('native value',()=>assert.equal(value,1));\n");
    let modelCalls = 0, verifierCalls = 0;
    const verificationStates = [];
    const server = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/jev') {
        if (body.questions.verification) {
          verifierCalls++; verificationStates.push(body.state);
          assert.equal(body.questions.verification.instructions.context.evidence, undefined);
          if (verifierCalls === 1 || eventual === 'SERVICE_FAILURE') { response.writeHead(eventual === 'SERVICE_FAILURE' ? 529 : 503).end('{}'); return; }
        }
        const answers = {};
        for (const [name, question] of Object.entries(body.questions)) {
          const criteria = Object.keys(question.criteria);
          let choice = criteria[0];
          if (name === 'actionGate') choice = 'ALLOW';
          if (name === 'verification') choice = eventual;
          if (name === 'failureType') choice = 'TIMEOUT';
          if (name === 'evidence') choice = 'MISSING_EXECUTION_EVIDENCE';
          if (name === 'stop') choice = 'CONTINUE_EXECUTION';
          if (name === 'escalation') choice = 'LOCAL_CONTINUE';
          if (name === 'test') choice = 'NONE';
          answers[name] = { choice, confidence: 0.99 };
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers })); return;
      }
      modelCalls++;
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      const calls = mode === 'READ_ONLY' ? [['workspace.read', { path: 'README.md' }]]
        : [['file.write', { path: 'value.mjs', content: 'export const value = 1;\n' }], ['test.execute', { command: 'node --test --test-isolation=none' }]];
      const next = calls[outputs.length];
      emitGoalResponse(response, next ? [{ type: 'function_call', id: `call-${modelCalls}`, call_id: `call-${modelCalls}`, name: next[0], arguments: JSON.stringify(next[1]) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: mode === 'READ_ONLY' ? marker : 'Changed only value.mjs; the actual immutable test passed.' }] }]);
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = await listenOnFetchablePort(server);
    const config = join(workspace, 'model-config.json'), trajectory = join(workspace, 'trajectory.jsonl'), store = join(workspace, 'harness.db');
    await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture', endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY',
      decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY', timeoutMs: 5000 } }));
    const env = { GOAL_VERIFY_ONLY_FIX_KEY: 'local-only-key', HMCODEX_DATA_DIR: workspace, HMCODEX_HARNESS_EVENT_STORE: store,
      HMCODEX_CONTEXT_PROVIDER: 'journal', HMCODEX_RELEASE_CHANNEL: mode === 'CONTROLLED' ? 'WINDOWS_FULL_LOCAL' : 'WINDOWS_PHASE1_READ_ONLY', HMCODEX_JEV_ENABLED: '1', HMCODEX_JEV_ENFORCE: '1' };
    const args = ['src/index.mjs', 'task', '--config', config, '--workspace', workspace, '--trajectory-store', trajectory, '--thread-store', join(workspace, 'threads.json'),
      '--max-recovery-attempts', '2', '--prompt', mode === 'READ_ONLY' ? 'Read README.md with a real tool and report its marker.' : 'Change only value.mjs to export value=1, run the immutable tests and report the actual result.'];
    if (mode === 'CONTROLLED') args.push('--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write,test.execute', '--lease-commands', 'node');
    const result = await runEvidenceProcess(process.execPath, args, { cwd: stagedRuntime, env, timeoutMs: 60000 });
    const parseLines = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const payload = parseLines(result.stdout).at(-1);
    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(payload?.ok, eventual === 'PASS', result.stdout.slice(-1000) + result.stderr);
    assert.equal(modelCalls, mode === 'READ_ONLY' ? 2 : 3, 'transport verification recovery must not invoke the executor again');
    assert.equal(verifierCalls, 2);
    const eventsResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list', '--trajectory-store', trajectory,
      '--harness-event-store', store, '--run-id', payload.runId, '--limit', '500'], { cwd: stagedRuntime, env, timeoutMs: 30000 });
    const events = parseLines(eventsResult.stdout).at(-1)?.events ?? [];
    assert.equal(events.filter(event => event.kind === 'VerificationRetryStarted').length, 1);
    assert.equal(events.filter(event => event.kind === 'ToolInvocationCompleted').length, mode === 'READ_ONLY' ? 1 : 2, 'durable native receipts are not duplicated');
    assert.equal(verificationStates[1].evidence.length, verificationStates[0].evidence.length);
  });
}
