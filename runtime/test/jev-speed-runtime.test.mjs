import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalMappedPath } from '../src/platform/workspace-path.mjs';
import { executorDescriptor } from '../src/platform/platform-identity.mjs';
import { createSafetyStateStore, transitionTighten } from '../src/safety-state.mjs';
import { readThreadHistory } from '../src/thread-history-reader.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

// End-to-end contract for the Jev speed MVP with a fixture Jev endpoint and a
// scripted chat-completions model. Every speed flag is default OFF.

const MARKER = 'JEV_SPEED_MARKER';
const residentKernelTestEnv = process.platform === 'linux'
  ? {}
  : { DDA_RESIDENT_KERNEL_SANDBOX: '1' };

const run = (args, env, onStdoutLine) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DDA_') && name !== 'JEV_API_KEY'));
  return runEvidenceProcess(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url), env: { ...base, ...env }, inheritEnv: false, onStdoutLine
  });
};

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
  answerText = `The README marker is ${MARKER}.`,
  buildTestChoice,
  executionProfileChoice,
  tierChoice = 'DIRECT',
  verificationChoice = 'PASS',
  actionGateChoice = 'ALLOW',
  actionGateReason = 'UNSPECIFIED',
  onStdoutLine,
  stopChoice,
  kernel = false,
  prompt = 'Read README.md and report its marker.',
  executionMode = 'CONTROLLED',
  leaseCapabilities = '',
  leaseCommands = '',
  maxRecoveryAttempts = 1,
  extraArgs = [],
  plan = THREE_STEP_PLAN
} = {}) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-jev-speed-'));
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-jev-speed-state-'));
  await writeFile(join(workspace, 'README.md'), `${MARKER}\n`, 'utf8');
  await writeFile(join(workspace, 'note.txt'), 'note\n', 'utf8');
  const jev = { actionGateTools: [], candidateKinds: [], tierChoices: undefined, verifications: [],
    verificationRequests: [], evidenceDecisionSteps: [], buildTestQuestions: [], order: [] };
  const model = { planner: 0, council: 0, executor: 0, order: [], toolContents: [], executorAttempts: [] };
  const plannedCalls = typeof toolCalls === 'function' ? await toolCalls(workspace) : toolCalls;
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
          else if (kind === 'SELECT_EXECUTION_PROFILE' && executionProfileChoice) choice = executionProfileChoice;
        }
        if (id === 'actionGate') {
          jev.actionGateTools.push(body.state?.tool);
          jev.order.push(`ACTION_GATE:${body.state?.tool}`);
          choice = typeof actionGateChoice === 'function' ? actionGateChoice(body.state, question) : actionGateChoice;
          if (choice === 'UNAVAILABLE') {
            response.writeHead(503).end();
            return;
          }
        }
        if (id === 'actionGateReason') choice = actionGateReason;
        if (id.startsWith('build-test-claim-')) {
          const context = question.instructions.context;
          jev.buildTestQuestions.push({ id, choices, ...context });
          if (buildTestChoice) choice = buildTestChoice(context, choices);
        }
        if (id === 'verification') {
          const attempt = Number(body.state?.action?.attempt) || (jev.verifications.length + 1);
          choice = typeof verificationChoice === 'function' ? verificationChoice(attempt, body.state) : verificationChoice;
          jev.verifications.push(choice);
          jev.verificationRequests.push({ stepId: body.state?.action?.stepId, choices, context: question.instructions.context });
          jev.order.push(`VERIFY:${choice}`);
        }
        if (id === 'failureType') choice = 'NONE';
        if (id === 'evidence') {
          jev.evidenceDecisionSteps.push(body.state?.action?.stepId);
          choice = 'SUFFICIENT';
        }
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
    emitChat(response, textFrames(answerText));
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
    ...extraArgs,
    ...(onStdoutLine ? ['--events', 'stdout'] : [])
  ];
  if (executionMode === 'CONTROLLED') {
    args.push('--lease-capabilities', leaseCapabilities || 'file.write',
      '--lease-commands', leaseCommands || 'node');
  }
  const result = await run(args, {
    LOCALAPPDATA: localAppData,
    [keyName]: 'test-key', JEV_SPEED_KEY: 'jev-key',
    DDA_JEV_ENABLED: '1', DDA_JEV_ENFORCE: '1', DDA_JEV_ENDPOINT: `http://127.0.0.1:${port}/jev`,
    DDA_JEV_API_KEY_ENV: 'JEV_SPEED_KEY', DDA_JEV_TIMEOUT_MS: '5000',
    DDA_RELEASE_CHANNEL: executionMode === 'CONTROLLED' ? 'WINDOWS_FULL_LOCAL' : 'WINDOWS_PHASE1_READ_ONLY',
    DDA_EXECUTION_MODE: executionMode,
    ...(kernel ? { DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli', ...residentKernelTestEnv } : {}),
    ...env
  }, onStdoutLine);
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

test('prerequisite workspace reads get a binary scope verdict before final task verification', async (t) => {
  const { result, jev } = await scenario(t, {
    agentMode: 'multi',
    answerText: [
      `The README marker is ${MARKER}.`,
      '按已记录的失败教训，`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle` 之前返回 `WORKSPACE_NOT_FOUND`。',
      '历史记录显示 `npm run build:exe` 与 `node scripts/build-full-local.mjs` 均以 `SAFETY_LEASE_REQUIRED` 失败。',
      '下一步：在 `desktop` 目录执行 `npm run build:windows:full-local`（建议超时 1200000 ms）。'
    ].join('\n')
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(lastJsonLine(result.stdout).ok, true);
  assert.deepEqual(jev.buildTestQuestions, []);
  const scoped = jev.verificationRequests.filter(request => request.context.workspaceRead);
  assert.deepEqual(scoped.map(request => request.stepId), ['read-a', 'read-b']);
  for (const { stepId, choices, context: { workspaceRead } } of scoped) {
    assert.deepEqual(choices, ['PASS', 'FAIL']);
    assert.equal(workspaceRead.completedInvocations, 1);
    assert.equal(workspaceRead.inWorkspaceInvocations, 1);
    assert.equal(workspaceRead.readOnlyInvocations, 1);
    assert.equal(workspaceRead.recentResults[0].path, 'README.md');
    assert.match(workspaceRead.recentResults[0].outputDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(!jev.evidenceDecisionSteps.includes(stepId));
  }
  const final = jev.verificationRequests.find(request => request.stepId === 'report');
  assert.deepEqual(final?.choices, ['PASS', 'FAIL', 'UNCERTAIN']);
  assert.equal(final.context.workspaceRead, undefined);
  assert.ok(jev.evidenceDecisionSteps.includes('report'));
  assert.ok(jev.actionGateTools.includes('workspace.read'));
});

test('a read prerequisite can finish a clean retry after a blocked shell proposal and binary text refusal', async t => {
  let verdicts = 0;
  const { result, jev } = await scenario(t, {
    agentMode: 'multi', executionProfileChoice: 'full-executor',
    verificationChoice: () => ++verdicts === 1 ? 'UNCERTAIN' : 'PASS',
    toolCalls: async workspace => {
      await writeFile(join(workspace, 'attachment.bin'), Buffer.from([0, 1, 2, 3, 0, 0, 0, 0]));
      return [
        ['workspace.read', { path: 'README.md' }], ['shell.execute', { command: 'node', args: ['--version'] }],
        ['workspace.read', { path: 'attachment.bin' }]
      ];
    },
    recoveryToolCalls: [['workspace.read', { path: 'README.md' }]]
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true, JSON.stringify(payload.verification ?? payload.error));
  const [first, retry] = jev.verificationRequests.filter(request => request.stepId === 'read-a');
  assert.equal(first.context.workspaceRead, undefined);
  assert.deepEqual(retry.context.workspaceRead.priorLimits.map(item => item.errorCode),
    ['TOOL_OUTSIDE_EXECUTION_SCOPE', 'WORKSPACE_BINARY_FILE']);
  assert.equal(retry.context.workspaceRead.completedInvocations, 1);
  assert.match(payload.text, /后续计划步骤仍需独立验证/u);
  assert.equal(jev.verificationRequests.at(-1).stepId, 'report');
});

test('reporting a successful viewer installation without an installer receipt cannot complete the task', async (t) => {
  const { result } = await scenario(t, {
    prompt: '这台机子上需要安装查看pptx的软件，安装一个',
    toolCalls: [], answerText: '已安装 PPTX 查看器。', verificationChoice: 'PASS'
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.harness.verification.status, 'UNCERTAIN');
  assert.equal(payload.harness.verification.nextAction, 'REVIEW_INSTALLATION');
});

test('conditional unchanged-source step submits cited snapshot text to verification without a write', async t => {
  let cited;
  const { result } = await scenario(t, {
    agentMode: 'multi', executionProfileChoice: 'full-executor',
    prompt: 'Update note.txt if it disagrees with README.md.',
    plan: JSON.stringify({ planId: 'compare-plan', steps: [{ stepId: 'compare',
      summary: 'Compare note.txt and README.md, only patch when needed.', actionKind: 'EXECUTE' }],
      assumptions: [], acceptanceCriteria: ['Compare the two sources'] }),
    toolCalls: async workspace => {
      await writeFile(join(workspace, 'note.txt'), MARKER + '\n');
      return [['workspace.read', { path: 'note.txt' }]];
    },
    answerText: 'The marker in `note.txt` matches the `README.md` snapshot. No patch was necessary.',
    verificationChoice: (_attempt, state) => {
      cited = state.evidence.filter(item => item.id.startsWith('cited-source-'));
      return cited.some(item => item.claim.includes('README.md') && item.claim.includes(MARKER))
        && cited.some(item => item.claim.includes('note.txt') && item.claim.includes(MARKER)) ? 'PASS' : 'FAIL';
    }
  });
  assert.equal(cited?.length, 2);
  assert.equal(lastJsonLine(result.stdout).ok, true);
});

test('a rejected workspace read scope stops the plan without reopening evidence review', async (t) => {
  const { result, jev } = await scenario(t, { agentMode: 'multi', verificationChoice: 'FAIL' });
  assert.equal(lastJsonLine(result.stdout).ok, false);
  assert.deepEqual(jev.verificationRequests.map(request => request.stepId), ['read-a']);
  assert.deepEqual(jev.verificationRequests[0].choices, ['PASS', 'FAIL']);
  assert.deepEqual(jev.evidenceDecisionSteps, []);
});

const buildTestFixtureAccess = async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-jev-build-test-'));
  await mkdir(join(localAppData, 'hmCodex'));
  await writeFile(join(localAppData, 'hmCodex', 'computer-access.json'), JSON.stringify({
    version: 1, scope: 'USER_FILESYSTEM', mode: 'FULL_ACCESS', updatedAtMs: Date.now()
  }));
  return { LOCALAPPDATA: localAppData };
};

test('a requested exe build can collect prerequisite evidence and execute its build step', async (t) => {
  const target = 'desktop/src-tauri/target';
  const { result, jev, model } = await scenario(t, {
    env: await buildTestFixtureAccess(),
    agentMode: 'multi',
    prompt: '编译exe',
    executionProfileChoice: 'workspace-readonly',
    leaseCapabilities: 'shell.execute',
    actionGateChoice: ({ tool }) => tool === 'workspace.list' ? 'REQUEST_EVIDENCE' : 'ALLOW',
    actionGateReason: 'PRIOR_OBSERVATION_MISSING',
    answerText: '当前步骤已完成。',
    plan: JSON.stringify({
      planId: 'desktop-build-plan',
      steps: [
        { stepId: 'inspect', summary: 'Inspect the build output directory', actionKind: 'READ' },
        { stepId: 'build', summary: 'Run the build and produce output.exe', actionKind: 'EXECUTE', dependencies: ['inspect'] }
      ],
      assumptions: [], acceptanceCriteria: ['Produce output.exe']
    }),
    toolCalls: async workspace => {
      await mkdir(join(workspace, target), { recursive: true });
      await writeFile(join(workspace, target, 'placeholder.txt'), 'fixture');
      await writeFile(join(workspace, 'build.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('output.exe', 'fixture'); console.log('artifact=output.exe');");
      return [
        ['workspace.list', { path: target }],
        ['workspace.list', { path: '..' }],
        ['shell.execute', { command: 'node', args: ['build.mjs'] }]
      ];
    },
    recoveryToolCalls: [['shell.execute', { command: 'node', args: ['build.mjs'] }]]
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true, JSON.stringify({ error: payload.error, verification: payload.verification, buildTest: payload.buildTest }));
  assert.ok(!jev.candidateKinds.includes('SELECT_EXECUTION_PROFILE'));
  assert.deepEqual(jev.actionGateTools.filter(tool => tool !== 'user.clarify'), ['workspace.list', 'shell.execute']);
  assert.equal(jev.verificationRequests.find(request => request.stepId === 'inspect')?.context.workspaceRead.completedInvocations, 1);
  assert.ok(model.toolContents.some(content => content.includes(`${target}/placeholder.txt`)));
  assert.ok(model.toolContents.some(content => content.includes('TOOL_ACTION_REQUIRES_EVIDENCE')));
  assert.ok(model.toolContents.some(content => content.includes('TOOL_OUTSIDE_EXECUTION_SCOPE')));
  assert.equal(payload.buildTest.items.find(item => item.id === 'build-artifact-origin')?.status, 'VERIFIED');
});

test('编译exe replaces an inspection-only plan and continues past an existing exe', async (t) => {
  const { result, jev } = await scenario(t, {
    env: await buildTestFixtureAccess(), agentMode: 'multi', prompt: '编译exe',
    leaseCapabilities: 'shell.execute',
    plan: JSON.stringify({ steps: [{ stepId: 'locate-existing-exe', summary: 'Check existing output.exe', actionKind: 'READ' }] }),
    answerText: '已经找到 output.exe。',
    toolCalls: async workspace => {
      await writeFile(join(workspace, 'output.exe'), 'old');
      await writeFile(join(workspace, 'build.mjs'), [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "if (readFileSync('output.exe', 'utf8') !== 'old') process.exit(1);",
        "writeFileSync('output.exe', 'rebuilt'); console.log('artifact=output.exe');"
      ].join('\n'));
      return [];
    },
    // The first model answer arrives with no tool calls; the host asks again.
    recoveryToolCalls: [['shell.execute', { command: 'node', args: ['build.mjs'] }]]
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true, JSON.stringify(payload.verification));
  assert.deepEqual(jev.actionGateTools.filter(tool => tool === 'shell.execute'), ['shell.execute']);
  const [command, , artifact] = payload.buildTest.items;
  assert.equal(command.results[0].exitCode, 0);
  assert.equal(artifact.results[0].sizeBytes, 7);
});

test('the declared executable build runs once through the process gate with an existing artifact', async (t) => {
  const { result, jev } = await scenario(t, {
    env: await buildTestFixtureAccess(), agentMode: 'multi', prompt: '编译exe',
    leaseCapabilities: 'shell.execute', leaseCommands: 'npm', answerText: '构建完成，运行了 300 个测试。',
    plan: JSON.stringify({ steps: [{ stepId: 'inspect-old', summary: 'Check output.exe', actionKind: 'READ' }] }),
    toolCalls: async workspace => {
      await writeFile(join(workspace, 'package.json'), JSON.stringify({
        scripts: { 'build:exe': 'node build.mjs' }, dda: { executableBuildScript: 'build:exe' }
      }));
      await writeFile(join(workspace, 'output.exe'), 'old');
      await writeFile(join(workspace, 'build.mjs'), [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "if (readFileSync('output.exe', 'utf8') !== 'old') process.exit(1);",
        "writeFileSync('output.exe', 'rebuilt'); console.log('artifact=output.exe');"
      ].join('\n'));
      return [];
    }
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true, JSON.stringify({ error: payload.error, verification: payload.verification }));
  assert.match(payload.text, /退出码：0/u);
  assert.doesNotMatch(payload.text, /300 个测试/u);
  const proof = jev.verificationRequests.find(request => request.stepId === 'build-executable').context.executableBuild;
  assert.equal(proof.exitCode, 0);
  assert.equal(proof.artifacts[0].path, 'output.exe');
  assert.deepEqual(jev.actionGateTools.filter(tool => tool === 'shell.execute'), ['shell.execute']);
  assert.deepEqual(payload.buildTest.items[0].results[0].args, ['run', 'build:exe']);
  assert.equal(payload.buildTest.items[0].results[0].exitCode, 0);
  assert.equal(payload.buildTest.items[2].results[0].sizeBytes, 7);
});

test('build and test conclusions cite actual invocation and current artifact records', async (t) => {
  const { result, jev } = await scenario(t, {
    env: await buildTestFixtureAccess(),
    prompt: 'Run the build and tests and report their results and the build artifact.',
    answerText: '构建成功。已生成 `output.exe`。全部 1 项测试通过。',
    leaseCapabilities: 'shell.execute,test.execute',
    toolCalls: async workspace => {
      await writeFile(join(workspace, 'build.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('output.exe', 'fixture'); console.log('artifact=output.exe');");
      await writeFile(join(workspace, 'unit.test.mjs'), "import test from 'node:test'; test('fixture', () => {});");
      return [
        ['shell.execute', { command: 'node', args: ['build.mjs'] }],
        ['test.execute', { command: 'node', args: ['--test', '--test-isolation=none', 'unit.test.mjs'] }]
      ];
    }
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(result.code, 0, `${result.stderr}\n${JSON.stringify({ error: payload.error, verification: payload.verification, errors: payload.harness?.errors })}`);
  assert.deepEqual(jev.buildTestQuestions.map(question => question.claimKind), ['BUILD', 'ARTIFACT', 'TEST_RESULT']);
  assert.deepEqual(jev.buildTestQuestions[0].evidence[0].args, ['build.mjs']);
  assert.equal(jev.buildTestQuestions[0].evidence[0].exitCode, 0);
  assert.equal(jev.buildTestQuestions[1].evidence[0].artifacts[0].path, 'output.exe');
  assert.equal(jev.buildTestQuestions[2].evidence[0].testCounts.pass, 1);
  const checks = payload.verification.checks.filter(check => check.id.includes('.build-test-claim-'));
  assert.equal(checks.length, 3);
  assert.ok(checks.every(check => check.status === 'PASS' && check.evidence[0].startsWith('build-test-process-')));
  assert.deepEqual(payload.buildTest.items.map(item => item.status), ['VERIFIED', 'VERIFIED', 'VERIFIED']);
  assert.match(payload.text, /运行时核验/u);
  assert.deepEqual(jev.actionGateTools.filter(tool => tool !== 'user.clarify'), ['shell.execute', 'test.execute']);
});

for (const matchingDigest of [true, false]) {
  test(`fixed build report handles paraphrased output and a ${matchingDigest ? 'verified' : 'mismatched'} reuse digest`, async (t) => {
    const { result, jev, model } = await scenario(t, {
      env: await buildTestFixtureAccess(),
      prompt: '编译 exe。',
      answerText: '现已编完。产物在 output.exe。',
      leaseCapabilities: 'shell.execute', maxRecoveryAttempts: 2,
      toolCalls: async workspace => {
        const path = join(workspace, 'output.exe');
        const content = 'existing fixture';
        await writeFile(path, content);
        await utimes(path, 1_600_000_000, 1_600_000_000);
        const sha256 = `sha256:${createHash('sha256').update(matchingDigest ? content : 'wrong').digest('hex')}`;
        const record = JSON.stringify({ version: 1, path: 'output.exe', sha256, disposition: 'REUSED' });
        await writeFile(join(workspace, 'build.mjs'), `console.log(${JSON.stringify(`DDA_BUILD_ARTIFACT ${record}`)});`);
        return [['shell.execute', { command: 'node', args: ['build.mjs'] }]];
      }
    });
    const payload = lastJsonLine(result.stdout);
    assert.equal(payload.ok, matchingDigest, JSON.stringify({ error: payload.error, verification: payload.verification, buildTest: payload.buildTest }));
    assert.deepEqual(jev.buildTestQuestions, []);
    assert.deepEqual(model.executorAttempts, [1]);
    const [build, tests, artifact] = payload.buildTest.items;
    assert.equal(build.results[0].execution, 'SUCCEEDED');
    assert.equal(build.status, 'VERIFIED');
    assert.equal(tests.status, 'NOT_REQUESTED');
    assert.equal(artifact.status, matchingDigest ? 'VERIFIED' : 'PENDING');
    if (matchingDigest) {
      assert.equal(artifact.results[0].disposition, 'REUSED');
      assert.match(payload.text, /本次复用/u);
    } else {
      assert.equal(payload.verification.status, 'UNCERTAIN');
      assert.deepEqual(payload.verification.failureCodes, ['BUILD_ARTIFACT_RECORD_MISSING']);
    }
  });
}

test('missing required build and test receipts are reported after step verification', async (t) => {
  const { result, jev, model } = await scenario(t, {
    prompt: 'Report the actual build and test results.',
    answerText: '构建成功。测试全部通过。',
    toolCalls: [], maxRecoveryAttempts: 2
  });
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.verification?.status, 'UNCERTAIN');
  assert.deepEqual(payload.verification?.failureCodes, ['BUILD_COMMAND_RECORD_MISSING', 'TEST_COMMAND_RECORD_MISSING']);
  assert.match(payload.verification.checks[1].message, /缺少本次测试命令记录/u);
  assert.deepEqual(jev.buildTestQuestions, []);
  assert.deepEqual(jev.verificationRequests.map(request => request.stepId), ['execute']);
  assert.deepEqual(model.executorAttempts, [1]);
});

test('Jev receives host scope for a scoped dependency omitted from the workspace snapshot', async (t) => {
  const path = 'desktop/node_modules/@tauri-apps/cli';
  const gateRequests = new Map();
  const { result, model } = await scenario(t, {
    prompt: 'List the installed Tauri CLI package directory to check that the dependency is present.',
    toolCalls: async (workspace) => {
      await mkdir(join(workspace, path), { recursive: true });
      await writeFile(join(workspace, path, 'package.json'), '{"name":"@tauri-apps/cli"}');
      return [['workspace.list', { path }], ['workspace.list', { path: '..' }]];
    },
    actionGateChoice: (state, question) => {
      const requestedPath = JSON.parse(state.action.summary).path;
      const checked = state.evidence.find(item => item.id === 'host-workspace-read-scope');
      const scope = checked && JSON.parse(checked.claim).hostWorkspaceReadScope;
      gateRequests.set(requestedPath, { scope, question });
      return scope === 'IN_WORKSPACE' ? 'ALLOW' : 'REQUEST_EVIDENCE';
    }
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(gateRequests.get(path)?.scope, 'IN_WORKSPACE');
  assert.match(gateRequests.get(path).question.criteria.REQUEST_EVIDENCE, /hostWorkspaceReadScope/u);
  assert.ok(['OUTSIDE_WORKSPACE', 'UNVERIFIED'].includes(gateRequests.get('..')?.scope));
  assert.ok(model.toolContents.some(content => content.includes(`${path}/package.json`)));
  assert.ok(model.toolContents.some(content => content.includes('TOOL_ACTION_REQUIRES_EVIDENCE')));
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

test('READONLY_FAST_PATH never fast-paths kernel.host_request; kernel effects stay disabled', async (t) => {
  const { result, jev, model } = await scenario(t, {
    env: { DDA_JEV_READONLY_FAST_PATH: '1' }, kernel: true,
    toolCalls: [['kernel.host_request', { kind: 'shell.exec', payload: { command: 'echo never' } }]]
  });
  assert.ok(model.toolContents.some((content) => /KERNEL_SIDE_EFFECT_REFUSED|KERNEL_EFFECTS_DISABLED|TOOL_ACTION_BLOCKED_BY_JEV/u.test(content)), `${result.stderr}\n${model.toolContents.join('\n')}`);
  assert.doesNotMatch(result.stdout, /jev\.action_gate_skipped/u);
  assert.equal(jev.actionGateTools.includes('kernel.host_request'), true,
    'no mode-level block exists; the Jev gate answers for host_request');
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

test('Windows git grep can proceed from a stored SANDBOX state in both safety gate modes', {
  skip: process.platform !== 'win32'
}, async (t) => {
  for (const spectrum of ['1', '0']) {
    await t.test(`spectrum=${spectrum}`, async (subtest) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'dda-action-sandbox-'));
      const statePath = join(stateDir, 'safety-state.json');
      const key = { entityId: executorDescriptor({}).id, capabilityId: 'shell.execute', taskClass: '*' };
      const stateStore = createSafetyStateStore({ storagePath: statePath });
      await stateStore.load();
      await transitionTighten({ stateStore, key, to: 'SANDBOX', reasonCode: 'TEST_SANDBOX_STATE' });

      let gitGateRequest;
      const { result, model, jev, decisionTrace } = await scenario(subtest, {
        // Isolate the safety state from independent capability and risk gates.
        env: {
          DDA_SAFETY_STATE_STORE: statePath,
          DDA_SAFETY_SPECTRUM: spectrum,
          DDA_CAPABILITY_PATH: '0',
          DDA_RISK_VECTOR: '0'
        },
        leaseCapabilities: 'shell.execute',
        leaseCommands: 'git',
        prompt: 'Run git grep in the workspace and report the matching README marker.',
        toolCalls: workspace => {
          execFileSync('git', ['init', '-q'], { cwd: workspace });
          execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'README.md'], { cwd: workspace });
          return [['shell.execute', { command: 'git', args: ['grep', '-in', '--heading', '-e', MARKER], cwd: '' }]];
        },
        actionGateChoice: (state, question) => {
          if (state.tool === 'shell.execute') gitGateRequest = { state, question };
          return 'ALLOW';
        }
      });

      assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
      assert.ok(jev.actionGateTools.includes('shell.execute'));
      const claim = id => JSON.parse(gitGateRequest.state.evidence.find(item => item.id === id).claim);
      assert.deepEqual(claim('host-command-inspection').hostCommandInspection, {
        operation: 'git grep', expectedEffect: 'READ_ONLY', cwdCheck: 'IN_WORKSPACE', explicitPathsChecked: 0
      });
      assert.equal(claim('host-proposed-tool-policy').hostToolPolicy.executionPolicy, 'HOST_ONE_SHOT_LEASE_REQUIRED');
      assert.match(gitGateRequest.question.instructions.question, /-e supplies a search pattern/u);
      const action = decisionTrace.decisions.find(item => item.decisionType === 'SELECT_TOOL_ACTION');
      assert.ok(action?.selectedOptionId?.endsWith('-selected'), JSON.stringify(action?.reasonCodes));
      assert.ok(model.toolContents.some(content => JSON.parse(content).stdout?.includes(MARKER)));
      const persisted = createSafetyStateStore({ storagePath: statePath });
      await persisted.load();
      assert.equal(persisted.getState(key).state, 'SANDBOX');
    });
  }
});

test('npm script and entry point reach the ACTION_GATE before the command executes', async (t) => {
  let reviewed = false;
  const localAppData = await mkdtemp(join(tmpdir(), 'dda-jev-npm-policy-'));
  await mkdir(join(localAppData, 'hmCodex'));
  await writeFile(join(localAppData, 'hmCodex', 'computer-access.json'), JSON.stringify({
    version: 1, scope: 'USER_FILESYSTEM', mode: 'FULL_ACCESS', updatedAtMs: Date.now()
  }));
  const { result, model, jev } = await scenario(t, {
    env: { LOCALAPPDATA: localAppData },
    leaseCapabilities: 'shell.execute',
    leaseCommands: 'npm',
    prompt: 'Run the workspace npm build script and report its marker.',
    toolCalls: async (workspace) => {
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'node build.mjs' } }));
      await writeFile(join(workspace, 'build.mjs'), 'console.log("BUILD_FIXTURE_EXECUTED");\n');
      return [['shell.execute', { command: 'npm', args: ['run', 'build'], cwd: '.' }]];
    },
    actionGateChoice: state => {
      const claims = state.evidence.filter(item => item.id.startsWith('host-workspace-context-'))
        .map(item => JSON.parse(item.claim));
      reviewed = claims.some(item => item.path === 'package.json' && item.outputData.text === 'build: node build.mjs')
        && claims.some(item => item.path === 'build.mjs' && item.outputData.text?.includes('BUILD_FIXTURE_EXECUTED'));
      return reviewed ? 'ALLOW' : 'REQUEST_EVIDENCE';
    }
  });
  assert.equal(reviewed, true, JSON.stringify({ gate: jev.actionGateTools, tools: model.toolContents, error: result.stderr.slice(-900) }));
  assert.ok(model.toolContents.some(content => JSON.parse(content).stdout?.includes('BUILD_FIXTURE_EXECUTED')),
    JSON.stringify(model.toolContents));
});

test('only a reviewed clarification interrupts a running task', async (t) => {
  for (const [decision, goal, question] of [
    ['BLOCK', '编译exe', '这条运行没有具体任务描述，请说明你希望我做什么？'],
    ['ALLOW', 'Compile the exe for the target architecture I specify.', 'Should the executable target x64 or ARM64?'],
    ['UNAVAILABLE', '编译exe', '请再说明这条任务的目标。']
  ]) {
    await t.test(decision, async (t) => {
      let reviewed = false;
      const questionsShown = [];
      const { model } = await scenario(t, {
        prompt: goal,
        toolCalls: [
          [['user.clarify', { question }]],
          [['workspace.read', { path: 'README.md' }]]
        ],
        actionGateChoice: state => {
          if (state.tool !== 'user.clarify') return 'ALLOW';
          reviewed = state.tool === 'user.clarify' && state.goal === goal && state.action.summary === question;
          return reviewed ? decision : 'BLOCK';
        },
        onStdoutLine: (line, child) => {
          const event = JSON.parse(line);
          if (event.kind !== 'clarification.requested') return;
          questionsShown.push(event.payload.question);
          child.stdin.write(JSON.stringify({
            type: 'clarification_response', requestId: event.payload.requestId, answer: 'x64'
          }) + '\n');
        }
      });
      assert.equal(reviewed, true);
      assert.deepEqual(questionsShown, decision === 'ALLOW' ? [question] : []);
      const result = model.toolContents.map(content => JSON.parse(content));
      assert.ok(result.some(item => item.content?.includes(MARKER)), JSON.stringify(result));
      if (decision === 'ALLOW') assert.ok(result.some(item => item.answer === 'x64'));
      else assert.ok(result.some(item => item.errorCode ===
        (decision === 'UNAVAILABLE' ? 'CLARIFICATION_REVIEW_UNAVAILABLE' : 'CLARIFICATION_NOT_NEEDED')));
    });
  }
});

test('tool deferrals retain their reason in live output and historical evidence', async (t) => {
  const live = [];
  const { result, trajectory, model } = await scenario(t, {
    toolCalls: [
      [['workspace.read', { path: 'deferred.txt' }]],
      [['workspace.read', { path: 'rejected.txt' }]],
      [['workspace.read', { path: 'README.md' }]]
    ],
    actionGateChoice: state => state.action.summary.includes('deferred.txt') ? 'REQUEST_EVIDENCE'
      : state.action.summary.includes('rejected.txt') ? 'BLOCK' : 'ALLOW',
    // This reason fits the deferral but contradicts the BLOCK decision.
    actionGateReason: 'PRIOR_OBSERVATION_MISSING',
    onStdoutLine: line => {
      const event = JSON.parse(line);
      if (event.kind === 'tool.result' && event.payload.ok === false) live.push(event.payload);
    }
  });
  const modelResults = model.toolContents.map(x => JSON.parse(x));
  assert.ok(modelResults.some(x => x.gateReason === 'PRIOR_OBSERVATION_MISSING'));
  assert.ok(modelResults.some(x => x.content?.includes(MARKER)));
  assert.equal(live.length, 2);
  assert.match(live[0].message, /未执行。缺少前置步骤/u);
  assert.match(live[1].message, /没有返回具体原因/u);
  const { threadId } = lastJsonLine(result.stdout);
  const history = await readThreadHistory({ harnessPath: `${trajectory}.db`, threadId });
  const deferred = history.events.filter(event => event.payload.persistedKind === 'ToolActionNotExecuted');
  assert.deepEqual(deferred.map(({ payload }) => [payload.path, payload.invocationAttempted, payload.gateDecision, payload.gateReason, payload.nextAction]), [
    ['deferred.txt', false, 'REQUEST_EVIDENCE', 'PRIOR_OBSERVATION_MISSING', 'COLLECT_EVIDENCE'],
    ['rejected.txt', false, 'BLOCK', undefined, 'STOP_OR_PATCH']
  ]);
  assert.equal(history.events.some(event => event.payload.persistedKind === 'ToolInvocationCompleted'
    && ['deferred.txt', 'rejected.txt'].includes(event.payload.path)), false);
});

test('Jev controls a workspace write under FULL_ACCESS even with a stale workspace lock', async (t) => {
  for (const choice of ['ALLOW', 'BLOCK', 'REQUIRE_APPROVAL', 'UNAVAILABLE']) {
    await t.test(choice, async (t) => {
      const localAppData = await mkdtemp(join(tmpdir(), 'dda-jev-workspace-policy-'));
      const policyDirectory = join(localAppData, 'hmCodex');
      const legacyLocks = join(localAppData, 'hmcodex-workspace-leases');
      await mkdir(policyDirectory);
      await mkdir(legacyLocks);
      await writeFile(join(policyDirectory, 'computer-access.json'), JSON.stringify({
        version: 1, scope: 'USER_FILESYSTEM', mode: 'FULL_ACCESS', updatedAtMs: Date.now()
      }));
      const { jev, model, workspace } = await scenario(t, {
        actionGateChoice: choice,
        env: { LOCALAPPDATA: localAppData, TMPDIR: localAppData, TEMP: localAppData, TMP: localAppData },
        prompt: 'Write hello to note.txt in this workspace.',
        toolCalls: async (workspace) => {
          const canonical = canonicalMappedPath(workspace).replace(/[\\/]+/g, '\\');
          const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          const fingerprint = createHash('sha256').update(key).digest('hex');
          await writeFile(join(legacyLocks, `workspace-${fingerprint}.lock`), JSON.stringify({
            leaseId: 'old-runtime-lease', expiresAt: Date.now() + 10 * 60_000
          }));
          return [['file.write', { path: 'note.txt', content: 'hello\n' }]];
        }
      });
      assert.ok(jev.actionGateTools.includes('file.write'));
      assert.equal(await readFile(join(workspace, 'note.txt'), 'utf8'), choice === 'ALLOW' ? 'hello\n' : 'note\n');
      if (choice === 'BLOCK') {
        assert.ok(model.toolContents.some((content) => content.includes('TOOL_ACTION_BLOCKED_BY_JEV')));
      } else if (choice !== 'ALLOW') {
        assert.ok(model.toolContents.some((content) => content.includes('SAFETY_LEASE_REQUIRED')),
          JSON.stringify(model.toolContents));
      }
    });
  }
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
