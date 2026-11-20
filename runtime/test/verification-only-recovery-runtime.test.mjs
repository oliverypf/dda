import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canRetryVerificationOnly } from '../src/decision/verification-retry.mjs';
import { runVerifierRecovery } from '../src/task-recovery-controller.mjs';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { decodeToolName } from '../src/plugins/model-openai.mjs';
import { readRunResponse } from '../src/run-response-store.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';
const stagedRuntime = new URL('..', import.meta.url);

for (const legacyPlan of [false, true]) {
  test(`GLM 5.3 lookup stops on missing external evidence (${legacyPlan ? 'original two-step plan' : 'direct query'})`, async t => {
    const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-glm53-evidence-'));
    const config = join(workspace, 'fixture-provider.json');
    const workspaceConfig = join(workspace, 'model-config.json');
    const trajectory = join(workspace, 'trajectory.jsonl');
    const store = join(workspace, 'harness.db');
    const original = '{"provider":"existing-provider"}\n';
    const partialAnswer = '现有资料不足以核实 GLM 5.3 的性能与基准成绩。';
    await writeFile(workspaceConfig, original);
    await writeFile(join(workspace, 'README.md'), '当前工作区没有 GLM 5.3 基准。');
    const executorTurns = [];
    const verdicts = [];
    const urlReviews = [];
    let genericNetworkGateCalls = 0;
    let plannerCalls = 0;
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (request.url === '/jev') {
        const answers = {};
        const action = body.state?.action;
        for (const [name, question] of Object.entries(body.questions)) {
          const choices = Object.keys(question.criteria);
          let choice = choices[0];
          if (name === 'candidate' && action?.kind === 'SELECT_ROLE_SET') choice = legacyPlan ? 'full-roles' : 'executor-only';
          if (name === 'candidate' && action?.kind === 'SELECT_EXECUTION_PROFILE') choice = legacyPlan ? 'full-executor' : 'external-lookup';
          if (name === 'candidate' && action?.kind === 'CLASSIFY_TASK') choice = legacyPlan ? 'unknown' : 'query';
          if (name === 'actionGate') {
            const external = ['network.request', 'browser.open'].includes(body.state?.tool);
            if (external) genericNetworkGateCalls++;
            choice = external ? 'REQUEST_EVIDENCE' : 'ALLOW';
          }
          if (name === 'actionGateReason') choice = 'TARGET_SCOPE_UNCLEAR';
          if (name === 'networkUrl') {
            urlReviews.push({ tool: body.state.tool, url: question.instructions.context.url, questions: Object.keys(body.questions) });
            choice = body.state.tool === 'browser.open' ? 'MALICIOUS' : 'UNKNOWN';
          }
          if (name === 'verification') {
            verdicts.push({ stepId: action?.stepId, attempt: action?.attempt, evidence: body.state.evidence });
            choice = action?.stepId === 'scan-local-docs' ? 'PASS' : legacyPlan ? 'FAIL' : 'UNCERTAIN';
          }
          if (name === 'verificationReason') {
            if (legacyPlan) continue;
            choice = 'EXTERNAL_EVIDENCE_MISSING';
          }
          if (name === 'stop') choice = 'STOP_SUCCESS';
          answers[name] = { choice, confidence: 0.99 };
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers }));
        return;
      }
      const sendText = text => emitGoalResponse(response, [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]);
      if (/Planner role/iu.test(String(body.instructions ?? ''))) {
        plannerCalls++;
        sendText(JSON.stringify({ planId: 'plan-glm53-workspace-only', steps: [
          { stepId: 'scan-local-docs', summary: '读取本地资料', actionKind: 'READ' },
          { stepId: 'report-local-findings', summary: '汇报本地发现并说明外部资料缺口', actionKind: 'READ', dependencies: ['scan-local-docs'] }
        ] }));
        return;
      }
      const scan = JSON.stringify(body.input).includes('Current validated plan step: scan-local-docs.');
      const outputs = body.input.filter(item => item.type === 'function_call_output');
      executorTurns.push({ scan, tools: (body.tools ?? []).map(tool => decodeToolName(tool.name)), output: outputs.at(-1)?.output });
      if (outputs.length) {
        sendText(scan ? '本地 README 未记录 GLM 5.3 性能。' : partialAnswer);
        return;
      }
      const calls = scan ? [['workspace.read', { path: 'README.md' }]] : [
        ['network.request', { scheme: 'https', host: 'example.invalid', path: '/glm-5.3?q=fixture-query', method: 'GET' }],
        ...(legacyPlan ? [['browser.open', { url: 'https://example.test/fixture-malicious' }]] : []),
        ['file.patch', { path: 'model-config.json', replacements: [{ oldText: 'existing-provider', newText: 'glm-5.3' }] }]
      ];
      emitGoalResponse(response, calls.map(([name, args], index) => ({
        type: 'function_call', id: `call-${executorTurns.length}-${index}`, call_id: `call-${executorTurns.length}-${index}`,
        name, arguments: JSON.stringify(args)
      })));
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = await listenOnFetchablePort(server);
    await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture',
      endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY',
      decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY' } }));
    const env = { GOAL_VERIFY_ONLY_FIX_KEY: 'local-only-key', DDA_DATA_DIR: workspace, DDA_HARNESS_EVENT_STORE: store,
      DDA_CONTEXT_PROVIDER: 'journal', DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1' };
    const args = ['src/index.mjs', 'task', '--config', config, '--workspace', workspace, '--trajectory-store', trajectory,
      '--thread-store', join(workspace, 'threads.json'), '--agent-mode', legacyPlan ? 'multi' : 'single',
      '--execution-mode', 'CONTROLLED', '--lease-capabilities', 'network.request,file.write,filesystem.write.workspace,workspace.write.patch',
      '--network-targets', '[{"host":"example.test"}]',
      '--events', 'stdout', '--max-recovery-attempts', '3', '--prompt', 'glm 5.3的性能怎么样'];
    const run = await runEvidenceProcess(process.execPath, args, { cwd: stagedRuntime, env, timeoutMs: 60000 });
    const lastJson = output => JSON.parse(output.trim().split(/\r?\n/u).at(-1));
    assert.equal(run.timedOut, false, run.stderr);
    const result = lastJson(run.stdout);
    assert.equal(result.ok, false, run.stdout + run.stderr);
    const liveFailure = run.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line)).find(event => event.kind === 'run.failed');
    assert.equal(liveFailure?.payload.nextAction, 'PROVIDE_EXTERNAL_EVIDENCE');
    const history = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list', '--trajectory-store', trajectory,
      '--harness-event-store', store, '--run-id', result.runId, '--limit', '500'], { cwd: stagedRuntime, env, timeoutMs: 30000 });
    const { events } = lastJson(history.stdout);
    const failure = events.find(event => event.kind === 'TaskRunFailed')?.payload;
    assert.equal(failure?.nextAction, 'PROVIDE_EXTERNAL_EVIDENCE', JSON.stringify(failure));
    assert.ok(failure.failureCodes.includes('EXTERNAL_EVIDENCE_MISSING'));
    assert.ok(failure.checks.find(check => check.id === 'external-evidence')?.evidence[0].startsWith('external-lookup-'));
    assert.match(await readRunResponse(store, result.runId, failure.outputDigest), /资料不足以核实 GLM 5\.3/u);
    assert.equal(plannerCalls, legacyPlan ? 1 : 0);
    const lookupTurns = executorTurns.filter(turn => !turn.scan);
    assert.equal(lookupTurns.length, 2, JSON.stringify(executorTurns));
    if (legacyPlan) {
      assert.equal(lookupTurns.at(-1).tools.length, 0, 'the legacy read step concludes on its existing evidence');
    } else {
      assert.ok(lookupTurns.at(-1).tools.includes('web.search') && lookupTurns.at(-1).tools.includes('web.fetch'),
        'the query executor can switch sources after the first request is denied');
    }
    assert.ok(executorTurns.every(turn => !turn.tools.includes('file.patch') && !turn.tools.includes('file.write')));
    assert.equal(genericNetworkGateCalls, 0);
    assert.deepEqual(urlReviews, [
      { tool: 'network.request', url: 'https://example.invalid/glm-5.3', questions: ['networkUrl'] },
      ...(legacyPlan ? [{ tool: 'browser.open', url: 'https://example.test/fixture-malicious', questions: ['networkUrl'] }] : [])
    ]);
    assert.equal(verdicts.length, legacyPlan ? 2 : 1);
    assert.ok(verdicts.every(verdict => verdict.attempt === 1));
    if (legacyPlan) assert.equal(verdicts[0].stepId, 'scan-local-docs');
    const lastVerdict = events.filter(event => event.kind === 'SemanticVerificationCompleted').at(-1)?.payload;
    assert.equal(lastVerdict?.payload?.reasonCode ?? lastVerdict?.reasonCode, legacyPlan ? 'JEV_CHOICE' : 'EXTERNAL_EVIDENCE_MISSING');
    assert.ok(verdicts.at(-1).evidence.some(item => item.id.startsWith('external-lookup-')));
    assert.ok(events.some(event => event.kind === 'ToolActionNotExecuted'
      && event.payload.name === 'file.patch' && event.payload.errorCode === 'TOOL_OUTSIDE_EXECUTION_SCOPE'));
    assert.ok(events.some(event => event.kind === 'ToolInvocationCompleted'
      && event.payload.name === 'network.request' && event.payload.errorCode === 'SAFETY_NETWORK_NOT_ALLOWED'));
    assert.ok(!events.some(event => event.kind === 'ToolActionNotExecuted' && event.payload.name === 'network.request'));
    if (legacyPlan) assert.ok(events.some(event => event.kind === 'ToolActionNotExecuted'
      && event.payload.name === 'browser.open' && event.payload.errorCode === 'NETWORK_URL_MALICIOUS'));
    assert.ok(!events.some(event => event.kind === 'RecoveryStarted' || event.kind === 'TaskFileWritten'
      || (event.kind === 'ToolInvocationCompleted' && ['browser.open', 'file.patch', 'file.write'].includes(event.payload.name))));
    assert.equal(await readFile(workspaceConfig, 'utf8'), original);
  });
}

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

for (const [mode, eventual, delayed = false] of [['OBSERVE', 'PASS'], ['CONTROLLED', 'PASS'], ['CONTROLLED', 'FAIL'], ['CONTROLLED', 'SERVICE_FAILURE'], ['CONTROLLED', 'PASS', true]]) {
  test(`native ${mode} workflow verifies without another executor turn (${eventual}, delayed=${delayed})`, async t => {
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
          if (delayed) await new Promise(resolve => setTimeout(resolve, 650));
          else if (verifierCalls === 1 || eventual === 'SERVICE_FAILURE') { response.writeHead(eventual === 'SERVICE_FAILURE' ? 529 : 503).end('{}'); return; }
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
      const calls = mode === 'OBSERVE' ? [['workspace.read', { path: 'README.md' }]]
        : [['file.write', { path: 'value.mjs', content: 'export const value = 1;\n' }], ['test.execute', { command: 'node --test --test-isolation=none' }]];
      const next = calls[outputs.length];
      emitGoalResponse(response, next ? [{ type: 'function_call', id: `call-${modelCalls}`, call_id: `call-${modelCalls}`, name: next[0], arguments: JSON.stringify(next[1]) }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: mode === 'OBSERVE' ? marker : 'Changed only value.mjs; the actual immutable test passed.' }] }]);
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    const port = await listenOnFetchablePort(server);
    const config = join(workspace, 'model-config.json'), trajectory = join(workspace, 'trajectory.jsonl'), store = join(workspace, 'harness.db');
    await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'fixture', endpoint: `http://127.0.0.1:${port}/model`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY',
      decision: { enabled: true, enforce: true, endpoint: `http://127.0.0.1:${port}/jev`, apiKeyEnv: 'GOAL_VERIFY_ONLY_FIX_KEY', timeoutMs: delayed ? 200 : 5000, verificationTimeoutMs: 5000 } }));
    const env = { GOAL_VERIFY_ONLY_FIX_KEY: 'local-only-key', DDA_DATA_DIR: workspace, DDA_HARNESS_EVENT_STORE: store,
      DDA_CONTEXT_PROVIDER: 'journal', DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1' };
    const args = ['src/index.mjs', 'task', '--config', config, '--workspace', workspace, '--trajectory-store', trajectory, '--thread-store', join(workspace, 'threads.json'),
      '--max-recovery-attempts', '2', '--prompt', mode === 'OBSERVE' ? 'Read README.md with a real tool and report its marker.' : 'Change only value.mjs to export value=1, run the immutable tests and report the actual result.'];
    if (mode === 'CONTROLLED') args.push('--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write,test.execute,filesystem.write.workspace,workspace.write.patch', '--lease-commands', 'node');
    const result = await runEvidenceProcess(process.execPath, args, { cwd: stagedRuntime, env, timeoutMs: 60000 });
    const parseLines = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const payload = parseLines(result.stdout).at(-1);
    assert.equal(result.timedOut, false, result.stderr);
    // Promotion requires actual deterministic checks in the report. This
    // runtime delegates the verdict, so a repeated semantic rejection stays failed.
    assert.equal(payload?.ok, eventual === 'PASS', (payload?.error ?? '') + result.stderr);
    // Transport verification recovery must not invoke the executor again. A
    // real FAIL verdict legitimately earns one bounded agent-miss replan after
    // writes landed, so its executor count is two attempts, not one.
    assert.equal(modelCalls, mode === 'OBSERVE' ? 2 : eventual === 'FAIL' ? 6 : 3, 'transport verification recovery must not invoke the executor again');
    assert.equal(verifierCalls, delayed ? 1 : eventual === 'FAIL' ? 3 : 2);
    const eventsResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list', '--trajectory-store', trajectory,
      '--harness-event-store', store, '--run-id', payload.runId, '--limit', '500'], { cwd: stagedRuntime, env, timeoutMs: 30000 });
    const events = parseLines(eventsResult.stdout).at(-1)?.events ?? [];
    assert.equal(events.filter(event => event.kind === 'VerificationRetryStarted').length, delayed ? 0 : 1);
    assert.equal(events.filter(event => event.kind === 'ToolInvocationCompleted').length, mode === 'OBSERVE' ? 1 : eventual === 'FAIL' ? 4 : 2, 'durable native receipts are not duplicated');
    if (!delayed) assert.equal(verificationStates[1].evidence.length, verificationStates[0].evidence.length);
  });
}
