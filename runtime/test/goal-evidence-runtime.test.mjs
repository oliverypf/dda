import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const emit = (response, text) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end([
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n`,
    'event: response.completed\ndata: {"type":"response.completed"}\n\n'
  ].join('\n'));
};

const emitWorkspaceRead = (response, path, callId) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    {
      type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: callId, call_id: callId, name: 'workspace.read', arguments: '' }
    },
    {
      type: 'response.function_call_arguments.done', item_id: callId, output_index: 0,
      arguments: JSON.stringify({ path })
    },
    { type: 'response.completed' }
  ];
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
};

const inputTextOf = (body) => [
  JSON.stringify(body.input ?? []),
  ...(Array.isArray(body.input)
    ? body.input.flatMap((item) => Array.isArray(item?.content) ? item.content.map((block) => block?.text ?? '') : [])
    : [])
].join('\n');

test('verifier recovery continues past the already observed initial failure instead of replaying it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-goal-continuation-'));
  const workspace = join(root, 'workspace');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const marker = 'GOAL_VERIFIED_CONTINUATION';
  await writeFile(join(workspace, 'README.md'), `${marker}\n`);
  const trajectory = join(root, 'trajectory.jsonl');
  const requests = [];
  let missingReads = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output');
    if (outputs.some(item => String(item.output).includes(marker))) {
      emit(response, marker);
    } else if (outputs.length) {
      emitWorkspaceRead(response, 'README.md', `read-${requests.length}`);
    } else {
      // A model receiving only the original ordered prompt restarts its first
      // step. It continues only when the host supplies prior terminal facts.
      const facts = inputTextOf(body);
      const continuation = /continuing verifier recovery/iu.test(String(body.instructions ?? ''))
        && facts.includes('HOST_VERIFIER_CONTINUATION')
        && facts.includes('WORKSPACE_NOT_FOUND') && facts.includes('SUCCEEDED');
      if (!continuation) missingReads++;
      emitWorkspaceRead(response, continuation ? 'README.md' : 'missing-evidence.txt', `read-${requests.length}`);
    }
  });
  t.after(() => server.close());
  const port = await listenOnFetchablePort(server);
  const config = join(root, 'model-config.json');
  await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses', model: 'continuation-model',
    endpoint: `http://127.0.0.1:${port}`, apiKeyEnv: 'HMCODEX_CONTINUATION_KEY' }));
  const result = await run(['task', '--config', config, '--workspace', workspace,
    '--prompt', 'First read missing-evidence.txt and receive its error. Only afterwards read README.md and report its marker.',
    '--trajectory-store', trajectory, '--max-recovery-attempts', '2'], { HMCODEX_CONTINUATION_KEY: 'local-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout.trim()).ok, true);
  assert.equal(missingReads, 1, 'recovery does not repeat the original deliberately failing first step');
  const events = (await readFile(trajectory, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const outcomes = events.filter(event => event.kind === 'VerificationCompleted' && event.payload?.schemaVersion !== '1.0')
    .map(event => event.payload?.status ?? event.payload?.payload?.status).filter(Boolean);
  assert.deepEqual(outcomes, ['CONTINUE', 'PASS'], 'verification stays authoritative after fresh successful evidence');
  const recovery = events.find(event => event.kind === 'RecoveryStarted')?.payload?.recovery;
  assert.deepEqual(recovery.previousActionObservations.map(action => action.state), ['FAILED', 'SUCCEEDED']);
  assert.equal(events.some(event => event.kind === 'TaskRunFailed'), false);
});

test('definite failure retries through Jev and upgrades to the bound strong model', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-goal-upgrade-'));
  await writeFile(join(workspace, 'README.md'), 'Bounded workspace evidence for the upgraded executor.\n', 'utf8');
  const trajectory = join(workspace, 'trajectory.jsonl');
  const configPath = join(workspace, 'model-config.json');
  const keyName = 'HMCODEX_GOAL_UPGRADE_KEY';
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: request.url, body });

    if (request.url === '/jev') {
      const answers = {};
      for (const [id, question] of Object.entries(body.questions ?? {})) {
        assert.equal(question.type, 'choice');
        assert.ok(question.criteria, 'the fixture accepts only the official Jev choice schema');
        const choices = Object.keys(question.criteria);
        let choice = choices[0];
        if (id === 'escalation' && choices.includes('USE_STRONG_MODEL')) choice = 'USE_STRONG_MODEL';
        if (id === 'candidate' && choices.includes('strong-model')) choice = 'strong-model';
        if (id === 'verification' && choices.includes('PASS')) choice = 'PASS';
        if (id === 'failureType' && choices.includes('UNKNOWN')) choice = 'UNKNOWN';
        if (id === 'evidence' && choices.includes('MISSING_EXECUTION_EVIDENCE')) choice = 'MISSING_EXECUTION_EVIDENCE';
        if (id === 'stop' && choices.includes('CONTINUE_EXECUTION')) choice = 'CONTINUE_EXECUTION';
        if (choice) answers[id] = { choice, confidence: 0.96, reasonCode: 'GOAL_UPGRADE_FIXTURE' };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ answers }));
      return;
    }

    const instructions = String(body.instructions ?? '');
    if (request.url === '/active' && /Planner role/iu.test(instructions)) {
      emit(response, JSON.stringify({
        planId: 'goal-upgrade-plan',
        steps: [{ stepId: 'inspect', summary: 'inspect the bounded workspace evidence', actionKind: 'READ' }],
        assumptions: [],
        acceptanceCriteria: ['the workspace evidence is inspected']
      }));
      return;
    }
    if (request.url === '/active') {
      const executorAttempt = requests.filter((item) => item.url === '/active' && !/Planner role/iu.test(String(item.body.instructions ?? ''))).length;
      // The ordinary model emits a real, reproducible tool failure. The
      // runtime can therefore verify and diagnose it; recovery must not
      // silently retry the same provider: Jev selects the bound strong model.
      if (executorAttempt === 1) emitWorkspaceRead(response, 'missing-evidence.txt', 'goal-failure-call');
      else emit(response, 'ordinary model reported a failed workspace read');
      return;
    }
    if (request.url === '/strong') {
      const hasToolResult = (body.input ?? []).some(item => item.type === 'function_call_output');
      if (!hasToolResult) emitWorkspaceRead(response, 'README.md', 'goal-success-call');
      else emit(response, 'strong-model verified workspace evidence');
      return;
    }
    emit(response, 'unexpected fixture request');
  });
  t.after(() => server.close());
  const port = await listenOnFetchablePort(server);
  await writeFile(configPath, JSON.stringify({
    schemaVersion: '1.0',
    provider: 'openai',
    protocol: 'responses',
    model: 'active-model',
    endpoint: `http://127.0.0.1:${port}/active`,
    apiKeyEnv: keyName,
    models: [
      { id: 'active-model', provider: 'openai', protocol: 'responses', model: 'active-model', endpoint: `http://127.0.0.1:${port}/active`, apiKeyEnv: keyName },
      { id: 'strong-model', provider: 'openai', protocol: 'responses', model: 'strong-model', endpoint: `http://127.0.0.1:${port}/strong`, apiKeyEnv: keyName }
    ],
    roleBindings: {
      planner: { selector: 'PINNED', modelId: 'active-model' },
      executor: { selector: 'PINNED', modelId: 'active-model' },
      critic: { selector: 'PINNED', modelId: 'strong-model' }
    },
    decision: {
      enabled: true,
      enforce: true,
      endpoint: `http://127.0.0.1:${port}/jev`,
      apiKeyEnv: keyName,
      model: 'jev-goal-upgrade',
      diagnosisEnabled: true,
      recoveryDirectionEnabled: true
    }
  }), 'utf8');

  const result = await run([
    'task', '--agent-mode', 'multi', '--config', configPath,
    '--prompt', '检查工作区并给出可验证结果', '--workspace', workspace,
    '--trajectory-store', trajectory, '--max-recovery-attempts', '2'
  ], { [keyName]: 'goal-upgrade-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}\nrequests=${JSON.stringify(requests.map((item) => ({ url: item.url, model: item.body.model, instructions: String(item.body.instructions ?? '').slice(0, 120) })))}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);

  const activePlanner = requests.filter((item) => item.url === '/active' && /Planner role/iu.test(String(item.body.instructions ?? '')));
  const activeExecutors = requests.filter((item) => item.url === '/active' && !/Planner role/iu.test(String(item.body.instructions ?? '')));
  const strongExecutors = requests.filter((item) => item.url === '/strong');
  assert.equal(activePlanner.length, 1, 'planner uses the ordinary model once');
  assert.equal(activeExecutors.length, 2, 'ordinary executor fails once and receives the failed tool result');
  assert.equal(strongExecutors.length, 2, `strong executor reads evidence and receives its result; stderr=${result.stderr}`);
  assert.ok(inputTextOf(strongExecutors[1].body).includes('Bounded workspace evidence'), 'strong model receives real workspace content');

  const events = (await readFile(trajectory, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const verification = events.filter((event) => event.kind === 'VerificationCompleted' && event.payload?.schemaVersion !== '1.0')
    .map((event) => event.payload?.status ?? event.payload?.payload?.status)
    .filter(Boolean);
  assert.deepEqual(verification, ['CONTINUE', 'PASS']);
  const toolFailure = events.find((event) => event.kind === 'ToolInvocationCompleted' && event.payload?.ok === false);
  assert.equal(toolFailure?.payload?.errorCode, 'WORKSPACE_NOT_FOUND');
  assert.ok(events.some((event) => event.kind === 'ToolInvocationCompleted'
    && event.payload?.ok === true && event.payload?.name === 'workspace.read'), 'upgraded execution includes a successful workspace read');
  const layer = events.find((event) => event.kind === 'DecisionLayerEvaluated' && event.payload?.action === 'ESCALATE');
  assert.ok(layer, 'Jev selected escalation after the definite failure');
  assert.equal(layer.payload.source, 'jev');
  assert.equal(layer.payload.escalation, 'USE_STRONG_MODEL');
  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const fallback = decisionTrace.decisions.find((decision) => decision.decisionType === 'SELECT_SAFE_MODEL_FALLBACK');
  assert.equal(fallback?.selectedOptionId, 'strong-model');
  assert.ok(events.some((event) => event.kind === 'RecoveryStarted'));
  assert.equal(events.some((event) => event.kind === 'TaskRunFailed'), false);

  // An explicit desktop retry choice must override the configured executor
  // binding without changing the planner's model or bypassing the resolver.
  const before = requests.length;
  const manualRetry = await run([
    'task', '--agent-mode', 'multi', '--config', configPath, '--executor-model', 'strong-model',
    '--prompt', '检查工作区并给出可验证结果', '--workspace', workspace,
    '--trajectory-store', join(workspace, 'manual-retry.jsonl'), '--max-recovery-attempts', '2'
  ], { [keyName]: 'goal-upgrade-key' });
  assert.equal(manualRetry.code, 0, `${manualRetry.stderr}\n${manualRetry.stdout}`);
  assert.equal(JSON.parse(manualRetry.stdout.trim()).ok, true);
  const retryRequests = requests.slice(before);
  assert.equal(retryRequests.filter(item => item.url === '/active' && !/Planner role/iu.test(String(item.body.instructions ?? ''))).length, 0);
  assert.equal(retryRequests.filter(item => item.url === '/strong').length, 2);
  assert.equal(retryRequests.filter(item => item.url === '/active' && /Planner role/iu.test(String(item.body.instructions ?? ''))).length, 1);

  const constrainedConfig = JSON.parse(await readFile(configPath, 'utf8'));
  constrainedConfig.roleBindings.executor.allowList = ['active-model'];
  const constrainedPath = join(workspace, 'constrained-model-config.json');
  await writeFile(constrainedPath, JSON.stringify(constrainedConfig));
  const requestsBeforeRejectedChoice = requests.length;
  const rejected = await run([
    'task', '--agent-mode', 'multi', '--config', constrainedPath, '--executor-model', 'strong-model',
    '--prompt', '检查工作区', '--workspace', workspace, '--trajectory-store', join(workspace, 'rejected-choice.jsonl')
  ], { [keyName]: 'goal-upgrade-key' });
  assert.notEqual(rejected.code, 0, 'explicit retry selection cannot bypass the configured executor allowlist');
  assert.equal(requests.length, requestsBeforeRejectedChoice, 'rejected selection makes no model call');
});
