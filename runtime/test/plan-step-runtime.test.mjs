import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

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

test('executes a multi-step planner DAG one step at a time and persists step checkpoints', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-plan-runtime-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const instructions = String(body.instructions ?? '');
    let text;
    if (/Planner role/iu.test(instructions)) {
      text = JSON.stringify({
        planId: 'integration-plan',
        steps: [
          { stepId: 'first', summary: 'collect first evidence', actionKind: 'READ' },
          { stepId: 'second', summary: 'summarize first evidence', actionKind: 'REPORT', dependencies: ['first'] }
        ],
        assumptions: ['README evidence is available'],
        acceptanceCriteria: ['both steps produce evidence'],
        selectedPlanId: 'integration-plan',
        candidatePlans: [
          {
            planId: 'integration-plan',
            steps: [
              { stepId: 'first', summary: 'collect first evidence', actionKind: 'READ' },
              { stepId: 'second', summary: 'summarize first evidence', actionKind: 'REPORT', dependencies: ['first'] }
            ],
            assumptions: ['README evidence is available'],
            acceptanceCriteria: ['both steps produce evidence']
          },
          {
            planId: 'alternative-plan',
            steps: [
              { stepId: 'single', summary: 'summarize directly', actionKind: 'REPORT' }
            ]
          }
        ]
      });
    } else if (/Semantic Verifier role/iu.test(instructions)) {
      text = JSON.stringify({ status: 'PASS', summary: 'step evidence is sufficient', progress: 1 });
    } else {
      text = `executor-step-${requests.filter((item) => !/Planner role|Semantic Verifier role/iu.test(String(item.instructions ?? ''))).length}`;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--agent-mode', 'multi', '--provider', 'openai', '--model', 'plan-integration-model',
    '--endpoint', `http://127.0.0.1:${address.port}/responses`, '--api-key-env', 'HMCODEX_PLAN_TEST_KEY',
    '--prompt', '执行多步骤检查', '--workspace', workspace, '--trajectory-store', trajectory
  ], { HMCODEX_PLAN_TEST_KEY: 'plan-test-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.plan.steps.map((step) => step.status), ['SUCCEEDED', 'SUCCEEDED']);
  assert.match(payload.text, /executor-step-1[\s\S]*executor-step-2/u);
  assert.equal(requests.filter((item) => /Planner role/iu.test(String(item.instructions ?? ''))).length, 1);
  assert.equal(requests.filter((item) => /Semantic Verifier role/iu.test(String(item.instructions ?? ''))).length, 2);
  assert.equal(requests.filter((item) => !/Planner role|Semantic Verifier role/iu.test(String(item.instructions ?? ''))).length, 2);
  const events = (await readFile(trajectory, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const stepEvents = events.filter((event) => event.kind === 'PlanStepStateChanged');
  assert.ok(stepEvents.some((event) => event.payload.steps.some((step) => step.stepId === 'first' && step.status === 'SUCCEEDED')));
  assert.ok(stepEvents.some((event) => event.payload.steps.some((step) => step.stepId === 'second' && step.status === 'SUCCEEDED')));
  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const plannerDecision = decisionTrace.decisions.find((decision) => decision.decisionType === 'CREATE_PLAN');
  assert.deepEqual(plannerDecision.assumptions.map((item) => item.statement), [
    'README evidence is available',
    'both steps produce evidence'
  ]);
  assert.deepEqual(plannerDecision.assumptions.map((item) => item.testable), [false, true]);
  assert.ok(plannerDecision.uncertaintyCodes.includes('PLAN_ASSUMPTIONS_UNVERIFIED'));
  assert.ok(plannerDecision.uncertaintyCodes.includes('PLAN_EVIDENCE_REQUIRED'));
  assert.equal(plannerDecision.selectedOptionId, 'plan-integration-plan');
  assert.deepEqual(
    plannerDecision.options.map((option) => option.optionId).sort(),
    ['plan-alternative-plan', 'plan-integration-plan']
  );
  const alternativePlanOption = plannerDecision.options.find((option) => option.optionId === 'plan-alternative-plan');
  assert.ok(alternativePlanOption.rejectionReasonCodes.includes('NOT_SELECTED_BY_PLANNER'));
  assert.ok(alternativePlanOption.rejectionReasonCodes.includes('RANK_2'));
});

test('multi-agent runtime reviews a complex plan through isolated Council turns', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-council-runtime-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const requests = [];
  const inputTextOf = (body) => [
    JSON.stringify(body.input ?? []),
    ...(Array.isArray(body.input) ? body.input.flatMap((item) => Array.isArray(item?.content) ? item.content.map((block) => block?.text ?? '') : []) : [])
  ].join('\n');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const instructions = String(body.instructions ?? '');
    const inputText = inputTextOf(body);
    let text;
    if (/Planner role/iu.test(instructions)) {
      text = JSON.stringify({ steps: [
        { stepId: 'one', summary: 'collect evidence', actionKind: 'READ' },
        { stepId: 'two', summary: 'run checks', actionKind: 'TEST', dependencies: ['one'] },
        { stepId: 'three', summary: 'summarize results', actionKind: 'REPORT', dependencies: ['two'] }
      ] });
    } else if (/Council Judge/iu.test(inputText)) {
      text = JSON.stringify({
        decision: 'ACCEPT_PLAN',
        selectedProposalIds: ['proposal-plan-reviewer'],
        rationale: 'selected the bounded plan'
      });
    } else if (/Council member/iu.test(inputText)) {
      text = JSON.stringify({ summary: 'plan is bounded', claim: 'plan is bounded', evidenceRefs: ['plan'], confidence: 0.8 });
    } else if (/Semantic Verifier role/iu.test(instructions)) {
      text = JSON.stringify({ status: 'PASS', summary: 'evidence is sufficient', progress: 1 });
    } else {
      text = 'bounded executor result';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const configPath = join(workspace, 'council-models.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai',
    protocol: 'responses',
    model: 'council-integration-model',
    endpoint: `http://127.0.0.1:${address.port}/responses`,
    apiKeyEnv: 'HMCODEX_COUNCIL_KEY',
    models: [
      {
        id: 'openai/council-executor',
        provider: 'openai',
        protocol: 'responses',
        model: 'council-executor-model',
        endpoint: `http://127.0.0.1:${address.port}/responses`,
        apiKeyEnv: 'HMCODEX_COUNCIL_KEY'
      },
      {
        id: 'openai/council-verifier',
        provider: 'openai',
        protocol: 'responses',
        model: 'council-verifier-model',
        endpoint: `http://127.0.0.1:${address.port}/responses`,
        apiKeyEnv: 'HMCODEX_COUNCIL_KEY'
      }
    ],
    roleBindings: { semanticVerifier: { selector: 'PINNED', modelId: 'openai/council-verifier' } }
  }));
  const result = await run([
    'task', '--agent-mode', 'multi', '--config', configPath,
    '--prompt', '构建并测试三步检查', '--workspace', workspace,
    '--trajectory-store', trajectory
  ], { HMCODEX_COUNCIL_KEY: 'council-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.council.decision, 'ACCEPT_PLAN');
  assert.equal(payload.council.proposalCount, 2);
  assert.equal(requests.filter((item) => /Council member/iu.test(inputTextOf(item))).length, 2);
  assert.equal(requests.filter((item) => /Council Judge/iu.test(inputTextOf(item))).length, 1);
  const evaluated = await run(['evaluate', '--run-id', payload.runId], {
    HMCODEX_TRAJECTORY_STORE: trajectory
  });
  assert.equal(evaluated.code, 0, `${evaluated.stderr}\n${evaluated.stdout}`);
  const evaluation = JSON.parse(evaluated.stdout.trim()).evaluation;
  assert.equal(evaluation.decisionCoverage.percent, 100);
  assert.equal(evaluation.optionCoverage.percent, 100);
  assert.equal(evaluation.evidenceLinkRate.percent, 100);
  assert.equal(evaluation.decisionOutcomeLinkRate.percent, 100);
  assert.ok(evaluation.decisionTypes.includes('REVIEW_PLAN'));
  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const councilDecision = decisionTrace.decisions.find((decision) => decision.decisionType === 'REVIEW_PLAN');
  assert.ok(councilDecision.outputRefs.some((ref) => ref.startsWith('council-ranking-')));
  assert.ok(councilDecision.assumptions.some((item) =>
    item.statement === 'selected the bounded plan' && item.source === 'MODEL_INFERENCE'));
  const selectedCouncilOption = councilDecision.options.find((option) => option.optionId === councilDecision.selectedOptionId);
  assert.equal(selectedCouncilOption.expectedQuality, 0.8);
  assert.ok(councilDecision.options.some((option) => option.rejectionReasonCodes.includes('RANK_2')));
});

test('resumes a failed thread from its checkpoint without rerunning completed steps', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-plan-resume-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const threadStore = join(workspace, 'threads.json');
  const requests = [];
  let semanticCalls = 0;
  const inputTextOf = (body) => [
    JSON.stringify(body.input ?? []),
    ...(Array.isArray(body.input) ? body.input.flatMap((item) => Array.isArray(item?.content) ? item.content.map((block) => block?.text ?? '') : []) : [])
  ].join('\n');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const instructions = String(body.instructions ?? '');
    const inputText = inputTextOf(body);
    let text;
    if (/Planner role/iu.test(instructions)) {
      text = JSON.stringify({
        steps: [
          { stepId: 'completed', summary: 'complete this first', actionKind: 'READ' },
          { stepId: 'resume', summary: 'resume this step', actionKind: 'REPORT', dependencies: ['completed'] }
        ]
      });
    } else if (/Semantic Verifier role/iu.test(instructions)) {
      semanticCalls += 1;
      if (semanticCalls === 2 || semanticCalls === 3) {
        text = JSON.stringify({ status: 'UNCERTAIN', summary: 'evidence is insufficient', progress: 0, failureCodes: ['FIRST_ATTEMPT_UNCERTAIN'] });
      } else {
        text = JSON.stringify({ status: 'PASS', summary: 'resumed evidence is sufficient', progress: 1 });
      }
    } else {
      text = 'executor evidence';
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const common = [
    'task', '--agent-mode', 'multi', '--provider', 'openai', '--model', 'resume-model',
    '--endpoint', `http://127.0.0.1:${address.port}/responses`, '--api-key-env', 'HMCODEX_RESUME_KEY',
    '--workspace', workspace, '--trajectory-store', trajectory, '--thread-store', threadStore,
    '--max-recovery-attempts', '2'
  ];
  const first = await run([...common, '--prompt', 'initial attempt'], { HMCODEX_RESUME_KEY: 'resume-key' });
  assert.equal(first.code, 1, `${first.stderr}\n${first.stdout}`);
  const persisted = JSON.parse(await readFile(threadStore, 'utf8'));
  const thread = persisted.threads[0];
  assert.ok(thread?.checkpoint?.plan);
  assert.equal(thread.checkpoint.plan.steps.find((step) => step.stepId === 'completed').status, 'SUCCEEDED');
  assert.equal(thread.checkpoint.plan.steps.find((step) => step.stepId === 'resume').status, 'FAILED');
  const evaluated = await run(['evaluate', '--run-id', thread.checkpoint.runId], {
    HMCODEX_TRAJECTORY_STORE: trajectory
  });
  assert.equal(evaluated.code, 0, `${evaluated.stderr}\n${evaluated.stdout}`);
  const evaluation = JSON.parse(evaluated.stdout.trim()).evaluation;
  assert.equal(evaluation.decisionCoverage.percent, 100);
  assert.equal(evaluation.optionCoverage.percent, 100);
  assert.equal(evaluation.evidenceLinkRate.percent, 100);
  assert.equal(evaluation.decisionOutcomeLinkRate.percent, 100);
  assert.ok(evaluation.decisionTypes.includes('DIAGNOSE_VERIFICATION'));
  assert.ok(evaluation.decisionTypes.includes('RECOVER_TASK'));
  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const uncertainVerification = decisionTrace.decisions.find((decision) =>
    decision.decisionType === 'VERIFY_TASK_RESULT' && decision.selectedOptionId === 'verdict-UNCERTAIN');
  assert.ok(uncertainVerification.uncertaintyCodes.includes('VERIFIER_EVIDENCE_INSUFFICIENT'));
  const beforeResumeRequests = requests.length;
  const second = await run([...common, '--resume', '--thread-id', thread.id, '--prompt', 'resume attempt'], { HMCODEX_RESUME_KEY: 'resume-key' });
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  const payload = JSON.parse(second.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.resumedFromRunId, thread.checkpoint.runId);
  assert.deepEqual(payload.plan.steps.map((step) => step.status), ['SUCCEEDED', 'SUCCEEDED']);
  const resumeRequests = requests.slice(beforeResumeRequests);
  assert.equal(resumeRequests.filter((item) => /Planner role/iu.test(String(item.instructions ?? ''))).length, 0);
  assert.equal(resumeRequests.filter((item) => inputTextOf(item).includes('Current validated plan step: completed')).length, 0);
  assert.equal(resumeRequests.filter((item) => inputTextOf(item).includes('Current validated plan step: resume')).length, 1);
});
