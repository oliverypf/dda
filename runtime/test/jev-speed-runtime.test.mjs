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
 * toolCalls: list of [name, args] the executor proposes in its first turn
 *   (or a function(workspace) => list). For recovery attempts, recoveryToolCalls
 *   (or a function) supplies the second-attempt tool list.
 * tierChoice: answer for SELECT_PLAN_TIER (string or a function of choices).
 * verificationChoice: string or function(attempt) => PASS|FAIL|UNCERTAIN.
 */
const scenario = async (t, {
  env = {}, agentMode = 'single',
  toolCalls = [['workspace.read', { path: 'README.md' }]],
  recoveryToolCalls,
  tierChoice = 'DIRECT',
  verificationChoice = 'PASS',
  stopChoice,
  kernel = false,
  prompt = 'Read README.md and report its marker.',
  executionMode = 'READ_ONLY',
  leaseCapabilities = '',
  leaseCommands = '',
  maxRecoveryAttempts = 1,
  extraArgs = [],
  plan = THREE_STEP_PLAN
} = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-jev-speed-'));
  await writeFile(join(workspace, 'README.md'), `${MARKER}\n`, 'utf8');
  await writeFile(join(workspace, 'note.txt'), 'note\n', 'utf8');
  const jev = { actionGateTools: [], candidateKinds: [], tierChoices: undefined, verifications: [], order: [] };
  const model = { planner: 0, council: 0, executor: 0, order: [], toolContents: [], executorAttempts: [] };
  const plannedCalls = typeof toolCalls === 'function' ? toolCalls(workspace) : toolCalls;
  const recoveryCalls = typeof recoveryToolCalls === 'function' ? recoveryToolCalls(workspace)
    : (recoveryToolCalls ?? plannedCalls);
  let executeAttempt = 0;
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
            // Keep unknown choices as-is so the engine can fall back to the heuristic.
            choice = typeof tierChoice === 'function' ? tierChoice(choices) : tierChoice;
          } else if (kind === 'SELECT_TOPOLOGY') choice = 'DELIBERATE_THEN_EXECUTE';
        }
        if (id === 'actionGate') {
          choice = 'ALLOW';
          jev.actionGateTools.push(body.state?.tool);
          jev.order.push(`ACTION_GATE:${body.state?.tool}`);
        }
        if (id === 'verification') {
          const attempt = Number(body.state?.action?.attempt) || (jev.verifications.length + 1);
          choice = typeof verificationChoice === 'function' ? verificationChoice(attempt) : verificationChoice;
          jev.verifications.push(choice);
          jev.order.push(`VERIFY:${choice}`);
        }
        if (id === 'failureType') choice = 'NONE';
        if (id === 'evidence') choice = 'SUFFICIENT';
        if (id === 'test') choice = 'NONE';
        if (id === 'stop') {
          // STOP_SUCCESS + non-PASS verification is enforced into FAIL and aborts
          // recovery. Prefer NEED_MORE_EVIDENCE whenever the caller wants a
          // recoverable non-PASS (or overrides stopChoice).
          const latestVerify = jev.verifications.at(-1);
          const resolved = typeof stopChoice === 'function'
            ? stopChoice({ verification: latestVerify, attempt: jev.verifications.length })
            : stopChoice;
          choice = resolved ?? (latestVerify && latestVerify !== 'PASS' ? 'NEED_MORE_EVIDENCE' : 'STOP_SUCCESS');
        }
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
      emitChat(response, textFrames(plan));
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
    // A fresh executor turn with no tool results yet is a new execute attempt
    // (attempt 1, or recovery attempt 2+ after diagnosis). toolCalls may be a
    // flat list (one round) or an array of rounds for multi-turn scripting.
    if (toolMessages.length === 0) {
      executeAttempt += 1;
      model.executorAttempts.push(executeAttempt);
    }
    const activeCalls = executeAttempt <= 1 ? plannedCalls : recoveryCalls;
    const rounds = Array.isArray(activeCalls?.[0]) && Array.isArray(activeCalls[0][0])
      ? activeCalls
      : (activeCalls?.length ? [activeCalls] : []);
    // toolMessages.length counts completed rounds; propose the next round.
    const nextRound = rounds[toolMessages.length];
    if (nextRound?.length) {
      emitChat(response, toolCallFrames(nextRound.map(([name, args], index) => [`call_${model.executor}_${index}`, name, args])));
      return;
    }
    emitChat(response, textFrames(`The README marker is ${MARKER}.`));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await listenOnFetchablePort(server);
  const { port } = server.address();
  const keyName = `DDA_TEST_SPEED_${randomUUID().replaceAll('-', '')}`;
  const trajectory = join(workspace, 'trajectory.jsonl');
  const args = [
    'task', '--agent-mode', agentMode,
    '--provider', 'openai-chat', '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${port}/chat/completions`, '--api-key-env', keyName,
    '--execution-mode', executionMode,
    '--prompt', prompt, '--workspace', workspace, '--trajectory-store', trajectory,
    '--evolution-store', join(workspace, 'evolution.json'),
    '--max-recovery-attempts', String(maxRecoveryAttempts),
    ...extraArgs
  ];
  if (executionMode === 'CONTROLLED') {
    args.push('--lease-capabilities', leaseCapabilities || 'file.write',
      '--lease-commands', leaseCommands || 'node');
  }
  const result = await run(args, {
    [keyName]: 'test-key', JEV_SPEED_KEY: 'jev-key',
    DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1', DDA_JEV_ENDPOINT: `http://127.0.0.1:${port}/jev`,
    DDA_JEV_API_KEY_ENV: 'JEV_SPEED_KEY', DDA_JEV_TIMEOUT_MS: '5000',
    DDA_RELEASE_CHANNEL: executionMode === 'CONTROLLED' ? 'WINDOWS_FULL_LOCAL' : 'WINDOWS_PHASE1_READ_ONLY',
    DDA_EXECUTION_MODE: executionMode,
    ...(kernel ? { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli' } : {}),
    ...env
  });
  const decisionTrace = await readFile(`${trajectory}.decision-trace.json`, 'utf8').then(JSON.parse).catch(() => undefined);
  return { result, jev, model, workspace, decisionTrace, trajectory };
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

test('multi PLAN_TIER PLAN: planner runs, council skipped (same effect as DIRECT today)', async (t) => {
  const { result, jev, model, decisionTrace } = await scenario(t, {
    agentMode: 'multi', env: { DDA_JEV_PLAN_TIER_ENABLED: '1' }, tierChoice: 'PLAN'
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(jev.tierChoices, ['DIRECT', 'PLAN', 'PLAN_COUNCIL']);
  assert.ok(jev.order.indexOf('SELECT_PLAN_TIER') < jev.order.indexOf('MODEL:planner'), jev.order.join(','));
  assert.equal(model.planner, 1, 'PLAN never skips the planner');
  assert.equal(model.council, 0, 'PLAN skips the council');
  assert.equal(payload.council, undefined);
  assert.equal(payload.decisionLayer.metrics.planTier.tier, 'PLAN');
  assert.ok(decisionTrace.decisions.some((decision) => decision.decisionType === 'SELECT_PLAN_TIER'
    && decision.selectedOptionId === 'PLAN'));
});

test('CONTROLLED modify host filter offers only PLAN_COUNCIL (never DIRECT or PLAN)', async (t) => {
  const { result, jev, model } = await scenario(t, {
    agentMode: 'multi',
    executionMode: 'CONTROLLED',
    leaseCapabilities: 'file.write',
    env: { DDA_JEV_PLAN_TIER_ENABLED: '1' },
    // Prefer PLAN/DIRECT if somehow offered — the host filter must not allow them.
    tierChoice: (choices) => (choices.includes('PLAN') ? 'PLAN' : (choices.includes('DIRECT') ? 'DIRECT' : choices[0])),
    prompt: 'Please modify note.txt to say hello and report what you wrote.',
    toolCalls: [['file.write', { path: 'note.txt', content: 'hello\n' }]],
    // Single WRITE step: modify taskClass still forces council under PLAN_COUNCIL.
    plan: JSON.stringify({
      planId: 'controlled-modify-plan',
      steps: [
        { stepId: 'write', summary: 'write note.txt', actionKind: 'WRITE' }
      ],
      assumptions: [], acceptanceCriteria: ['note.txt says hello']
    })
  });
  assert.deepEqual(jev.tierChoices, ['PLAN_COUNCIL'],
    `CONTROLLED+modify must not offer DIRECT or PLAN; got ${JSON.stringify(jev.tierChoices)}\n${result.stderr}\n${result.stdout}`);
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.decisionLayer.metrics.planTier.tier, 'PLAN_COUNCIL');
  assert.equal(model.planner, 1);
  assert.ok(model.council > 0, 'forced PLAN_COUNCIL keeps the council for modify');
});

test('CONTROLLED side effect still hits ACTION_GATE when READONLY_FAST_PATH is on', async (t) => {
  const { result, jev } = await scenario(t, {
    executionMode: 'CONTROLLED',
    leaseCapabilities: 'file.write',
    env: { DDA_JEV_READONLY_FAST_PATH: '1' },
    prompt: 'Please modify note.txt to say hello after reading README.md.',
    toolCalls: [
      ['workspace.read', { path: 'README.md' }],
      ['file.write', { path: 'note.txt', content: 'hello\n' }]
    ]
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(jev.actionGateTools.includes('workspace.read'), false,
    'in-workspace read is fast-pathed');
  assert.ok(jev.actionGateTools.includes('file.write'),
    'side-effect write must still consult ACTION_GATE');
  const gate = payload.decisionLayer.metrics.jev.byKind.ACTION_GATE;
  assert.ok(gate.shortCircuitReasons?.READONLY_FAST_PATH >= 1);
  assert.ok(gate.requests >= 1, 'at least the write still requests Jev');
});

for (const verdict of ['UNCERTAIN', 'STALLED']) {
  test(`#16 ${verdict} still arms reapproval with both speed flags on`, async (t) => {
    const { result, jev, model } = await scenario(t, {
      executionMode: 'CONTROLLED',
      leaseCapabilities: 'file.write',
      maxRecoveryAttempts: 2,
      env: {
        DDA_JEV_READONLY_FAST_PATH: '1',
        DDA_JEV_PLAN_TIER_ENABLED: '1'
      },
      // single agent: plan tier stays inert, but both flags are on as required.
      agentMode: 'single',
      prompt: 'Please modify note.txt to say hello.',
      toolCalls: verdict === 'STALLED'
        // Cross-round identical reads (same round would be TOOL_DUPLICATE_REQUEST)
        // make the rule verifier STALLED; then a write leaves a side effect.
        ? [
          [['workspace.read', { path: 'README.md' }]],
          [['workspace.read', { path: 'README.md' }]],
          [['file.write', { path: 'note.txt', content: 'hello\n' }]]
        ]
        : [['file.write', { path: 'note.txt', content: 'hello\n' }]],
      recoveryToolCalls: [['file.write', { path: 'other.txt', content: 'hello again\n' }]],
      // UNCERTAIN: Jev downgrades a rule PASS. STALLED: keep Jev at PASS so the
      // rule STALLED status is preserved. stopChoice forces recovery instead of
      // STOP_SUCCESS→FAIL enforcement.
      verificationChoice: (attempt) => (verdict === 'UNCERTAIN' && attempt === 1 ? 'UNCERTAIN' : 'PASS'),
      stopChoice: ({ verification, attempt }) => (
        attempt === 1 || verification !== 'PASS' ? 'NEED_MORE_EVIDENCE' : 'STOP_SUCCESS'
      )
    });
    assert.ok(model.executorAttempts.includes(1), `${result.stderr}\n${result.stdout}`);
    assert.ok(model.executorAttempts.includes(2),
      `recovery must re-execute after ${verdict}: attempts=${model.executorAttempts} verifications=${jev.verifications}\n${result.stderr}\n${result.stdout}`);
    // First-attempt write still consulted ACTION_GATE (fast path does not cover writes).
    assert.ok(jev.actionGateTools.includes('file.write'), jev.actionGateTools.join(','));
    // Second-attempt write is refused: no live approver + reapproval armed.
    assert.ok(model.toolContents.some((content) => /SAFETY_LEASE_REQUIRED|APPROVAL_REQUIRED_NO_LIVE_APPROVER|NO_LIVE_APPROVER/u.test(content)),
      `expected reapproval refusal after ${verdict}:\n${model.toolContents.join('\n')}\n${result.stderr}`);
    if (verdict === 'UNCERTAIN') {
      assert.ok(jev.verifications.includes('UNCERTAIN'), jev.verifications.join(','));
    }
  });
}
