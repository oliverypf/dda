import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

// End-to-end contract for the Jev speed MVP with a fixture Jev endpoint and a
// scripted chat-completions model. Every speed flag is default OFF.

const MARKER = 'JEV_SPEED_MARKER';

const run = (args, env) => new Promise((resolve, reject) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DDA_') && name !== 'JEV_API_KEY'));
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url), env: { ...base, ...env }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const emitChat = (response, frames) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frames.join('\n\n') + '\n\n');
};
const toolCallFrames = (calls) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
  'data: [DONE]'
];
const textFrames = (text) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  'data: [DONE]'
];
const lastJsonLine = (stdout) => {
  const line = stdout.trim().split(/\r?\n/).filter((item) => item.startsWith('{')).at(-1);
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
};

const THREE_STEP_PLAN = JSON.stringify({
  planId: 'speed-plan',
  steps: [
    { stepId: 'read-a', summary: 'read README marker', actionKind: 'READ' },
    { stepId: 'read-b', summary: 're-check README marker', actionKind: 'READ', dependencies: ['read-a'] },
    { stepId: 'report', summary: 'report README marker', actionKind: 'REPORT', dependencies: ['read-b'] }
  ],
  assumptions: [], acceptanceCriteria: ['report the README marker']
});

/**
 * toolCalls: list of [name, args] the executor proposes in its first turn.
 * tierChoice: answer for SELECT_PLAN_TIER (string or a function of choices).
 */
const scenario = async (t, { env = {}, agentMode = 'single', toolCalls = [['workspace.read', { path: 'README.md' }]], tierChoice = 'DIRECT', kernel = false, prompt = 'Read README.md and report its marker.' } = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-jev-speed-'));
  await writeFile(join(workspace, 'README.md'), `${MARKER}\n`, 'utf8');
  const jev = { actionGateTools: [], candidateKinds: [], tierChoices: undefined, order: [] };
  const model = { planner: 0, council: 0, executor: 0, order: [], toolContents: [] };
  const plannedCalls = typeof toolCalls === 'function' ? toolCalls(workspace) : toolCalls;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (request.url === '/jev') {
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const choices = Object.keys(question.criteria ?? {});
        let choice = choices[0];
        if (id === 'candidate') {
          const kind = body.state?.action?.kind;
          jev.candidateKinds.push(kind);
          jev.order.push(kind);
          if (kind === 'SELECT_PLAN_TIER') {
            jev.tierChoices = choices;
            choice = typeof tierChoice === 'function' ? tierChoice(choices) : tierChoice;
          } else if (kind === 'SELECT_TOPOLOGY') choice = 'DELIBERATE_THEN_EXECUTE';
        }
        if (id === 'actionGate') { choice = 'ALLOW'; jev.actionGateTools.push(body.state?.tool); jev.order.push(`ACTION_GATE:${body.state?.tool}`); }
        if (id === 'verification') choice = 'PASS';
        if (id === 'failureType') choice = 'NONE';
        if (id === 'evidence') choice = 'SUFFICIENT';
        if (id === 'test') choice = 'NONE';
        if (id === 'stop') choice = 'STOP_SUCCESS';
        if (id === 'escalation') choice = 'LOCAL_CONTINUE';
        answers[id] = { choice, confidence: 0.99 };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ answers }));
      return;
    }
    const system = JSON.stringify(body.messages?.filter((message) => message.role === 'system') ?? []);
    if (/dda Planner role/u.test(system)) {
      model.planner += 1; model.order.push('planner'); jev.order.push('MODEL:planner');
      emitChat(response, textFrames(THREE_STEP_PLAN));
      return;
    }
    if (/Council member or Judge/u.test(system)) {
      model.council += 1; model.order.push('council');
      const judge = /Council Judge/u.test(JSON.stringify(body.messages));
      emitChat(response, textFrames(judge
        ? JSON.stringify({ decision: 'ACCEPT_PLAN', selectedProposalIds: [], rationale: 'ok', reasonCode: 'OK' })
        : JSON.stringify({ summary: 'plan ok', claim: 'plan ok', evidenceRefs: [], risks: [], nextActions: [], confidence: 0.9 })));
      return;
    }
    model.executor += 1;
    const toolMessages = (body.messages ?? []).filter((message) => message.role === 'tool');
    model.toolContents.push(...toolMessages.map((message) => String(message.content)));
    if (toolMessages.length === 0 && plannedCalls.length) {
      emitChat(response, toolCallFrames(plannedCalls.map(([name, args], index) => [`call_${model.executor}_${index}`, name, args])));
      return;
    }
    emitChat(response, textFrames(`The README marker is ${MARKER}.`));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await listenOnFetchablePort(server);
  const { port } = server.address();
  const keyName = `DDA_TEST_SPEED_${randomUUID().replaceAll('-', '')}`;
  const trajectory = join(workspace, 'trajectory.jsonl');
  const result = await run([
    'task', '--agent-mode', agentMode,
    '--provider', 'openai-chat', '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${port}/chat/completions`, '--api-key-env', keyName,
    '--execution-mode', 'READ_ONLY',
    '--prompt', prompt, '--workspace', workspace, '--trajectory-store', trajectory,
    '--evolution-store', join(workspace, 'evolution.json')
  ], {
    [keyName]: 'test-key', JEV_SPEED_KEY: 'jev-key',
    DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1', DDA_JEV_ENDPOINT: `http://127.0.0.1:${port}/jev`,
    DDA_JEV_API_KEY_ENV: 'JEV_SPEED_KEY', DDA_JEV_TIMEOUT_MS: '5000',
    DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', DDA_EXECUTION_MODE: 'READ_ONLY',
    ...(kernel ? { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' } : {}),
    ...env
  });
  const decisionTrace = await readFile(`${trajectory}.decision-trace.json`, 'utf8').then(JSON.parse).catch(() => undefined);
  return { result, jev, model, workspace, decisionTrace };
};

test('flags off: every read-only tool still asks the ACTION_GATE and metrics are reported', async (t) => {
  const { result, jev } = await scenario(t);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(jev.actionGateTools, ['workspace.read']);
  const metrics = payload.decisionLayer.metrics;
  assert.equal(metrics.jev.byKind.ACTION_GATE.requests, 1);
  assert.equal(metrics.jev.byKind.ACTION_GATE.shortCircuits, 0);
  assert.ok(metrics.jev.byKind.VERIFY_BEHAVIOR.requests >= 1);
  assert.ok(metrics.stages.execution.count >= 1);
  assert.ok(metrics.stages.verification.count >= 1);
  assert.equal(metrics.planTier, undefined);
  assert.doesNotMatch(result.stdout, /jev\.action_gate_skipped|plan\.tier_selected/u);
});

test('READONLY_FAST_PATH skips the gate for allowlisted in-workspace reads only', async (t) => {
  const { result, jev, decisionTrace } = await scenario(t, {
    env: { DDA_JEV_READONLY_FAST_PATH: '1' },
    kernel: true,
    toolCalls: (workspace) => [
      ['workspace.read', { path: 'README.md' }],
      ['workspace.list', { path: '' }],
      ['kernel.workspace_read', { path: 'README.md' }],
      ['kernel.session_list', {}],
      // Absolute (even in-workspace) paths are OUTSIDE_OR_OPAQUE: keep the gate.
      ['kernel.workspace_read', { path: join(workspace, 'README.md') }]
    ]
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(jev.actionGateTools.sort(), ['kernel.session_list', 'kernel.workspace_read'],
    'session tools and absolute paths keep the Jev ACTION_GATE');
  const gate = payload.decisionLayer.metrics.jev.byKind.ACTION_GATE;
  assert.equal(gate.requests, 2);
  assert.deepEqual(gate.shortCircuitReasons, { READONLY_FAST_PATH: 3 });
  const fastDecisions = decisionTrace.decisions.filter((decision) => decision.decisionType === 'SELECT_TOOL_ACTION'
    && decision.reasonCodes.includes('READONLY_FAST_PATH'));
  assert.equal(fastDecisions.length, 3);
});

test('READONLY_FAST_PATH never fast-paths kernel.host_request; READ_ONLY hard block stays first', async (t) => {
  const { result, jev, model } = await scenario(t, {
    env: { DDA_JEV_READONLY_FAST_PATH: '1' }, kernel: true,
    toolCalls: [['kernel.host_request', { kind: 'host.ping' }]]
  });
  assert.ok(model.toolContents.some((content) => /TOOL_NOT_ALLOWED_IN_MODE/u.test(content)), `${result.stderr}\n${model.toolContents.join('\n')}`);
  assert.doesNotMatch(result.stdout, /jev\.action_gate_skipped/u);
  assert.equal(jev.actionGateTools.includes('kernel.host_request'), false, 'hard block answers before Jev');
});

test('multi flags off: planner then council heuristic as today, no tier decision', async (t) => {
  const { result, jev, model } = await scenario(t, { agentMode: 'multi' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(model.planner, 1);
  assert.ok(model.council > 0, 'a three-step plan deliberates under the existing heuristic');
  assert.equal(jev.candidateKinds.includes('SELECT_PLAN_TIER'), false);
});

test('multi PLAN_TIER DIRECT: tier is chosen before the planner, planner still runs, council skipped', async (t) => {
  const { result, jev, model, decisionTrace } = await scenario(t, { agentMode: 'multi', env: { DDA_JEV_PLAN_TIER_ENABLED: '1' } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(jev.tierChoices, ['DIRECT', 'PLAN', 'PLAN_COUNCIL']);
  assert.ok(jev.order.indexOf('SELECT_PLAN_TIER') < jev.order.indexOf('MODEL:planner'), jev.order.join(','));
  assert.equal(model.planner, 1, 'DIRECT never skips the planner');
  assert.equal(model.council, 0);
  assert.equal(payload.council, undefined);
  assert.equal(payload.decisionLayer.metrics.planTier.tier, 'DIRECT');
  assert.ok(payload.decisionLayer.metrics.stages.planner.count === 1);
  assert.ok(decisionTrace.decisions.some((decision) => decision.decisionType === 'SELECT_PLAN_TIER' && decision.selectedOptionId === 'DIRECT'));
});

test('multi PLAN_TIER unknown Jev choice falls back to the existing heuristic', async (t) => {
  const { result, model, jev } = await scenario(t, { agentMode: 'multi', env: { DDA_JEV_PLAN_TIER_ENABLED: '1' }, tierChoice: 'SKIP_EVERYTHING' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.ok(jev.candidateKinds.includes('SELECT_PLAN_TIER'));
  assert.equal(model.planner, 1);
  assert.ok(model.council > 0, 'fallback keeps today\'s council heuristic');
  assert.equal(payload.decisionLayer.metrics.planTier.tier, undefined);
  assert.equal(payload.decisionLayer.metrics.planTier.source, 'rule');
});

test('multi PLAN_TIER is mutually exclusive with DDA_JEV_TOPOLOGY_ENABLED', async (t) => {
  const { result, jev, model } = await scenario(t, { agentMode: 'multi', env: { DDA_JEV_PLAN_TIER_ENABLED: '1', DDA_JEV_TOPOLOGY_ENABLED: '1' } });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(jev.candidateKinds.includes('SELECT_PLAN_TIER'), false);
  assert.ok(jev.candidateKinds.includes('SELECT_TOPOLOGY'));
  assert.ok(model.council > 0, 'topology DELIBERATE_THEN_EXECUTE still governs the council');
  assert.equal(payload.decisionLayer.metrics.planTier.reasonCode, 'PLAN_TIER_TOPOLOGY_EXCLUSIVE');
});
