import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
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

const sse = (response, text, logprobs) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const data = { type: 'response.output_text.delta', delta: text, ...(logprobs ? { logprobs } : {}) };
  response.end(`event: response.output_text.delta\ndata: ${JSON.stringify(data)}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
};

for (const scenario of ['success', 'drafts-failed', 'judge-failed', 'configured']) {
test(`multi-agent candidate runtime audits ${scenario}`, async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-candidate-runtime-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const harnessStore = join(workspace, 'events.db');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ url: request.url, body });
    const system = String(body.instructions ?? '');
    if (request.url === '/jev') {
      const answers = {};
      for (const [id, question] of Object.entries(body.questions ?? {})) {
        const choice = id === 'candidate' ? 'model-b'
          : id === 'actionGate' ? 'ALLOW'
            : id === 'verification' ? 'PASS'
              : question.choices?.[0];
        if (choice) answers[id] = { choice, confidence: 0.9 };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ answers }));
      return;
    }
    if (scenario === 'drafts-failed' && /\/candidate-[ab]$/u.test(request.url) && /isolated dda role/iu.test(system)) {
      sse(response, '');
      return;
    }
    if (request.url === '/candidate-a') {
      sse(response, 'draft from candidate-a');
      return;
    }
    if (request.url === '/candidate-b') {
      sse(response, 'draft from candidate-b');
      return;
    }
    if (/Planner role/iu.test(system)) {
      sse(response, JSON.stringify({
        planId: 'candidate-plan',
        steps: [{ stepId: 'only', summary: 'report the current state', actionKind: 'REPORT' }],
        assumptions: [],
        acceptanceCriteria: ['a bounded report is produced']
      }));
      return;
    }
    if (/Semantic Verifier role/iu.test(system)) {
      sse(response, JSON.stringify({ summary: 'evidence is sufficient' }) + '<score>A</score>', [
        { token: '<score>' },
        { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(0.97) }, { token: 'T', logprob: Math.log(0.03) }] }
      ]);
      return;
    }
    sse(response, 'executor completed the reported step');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const keyName = `HMCODEX_TEST_CANDIDATE_KEY_${randomUUID().replaceAll('-', '')}`;
  const configPath = join(workspace, 'model-config.json');
  await writeFile(configPath, JSON.stringify({
    schemaVersion: '1.0',
    provider: 'openai',
    protocol: 'responses',
    model: 'default-model',
    endpoint: `${base}/responses`,
    apiKeyEnv: keyName,
    models: [
      { id: 'model-a', provider: 'openai', protocol: 'responses', model: 'candidate-a', endpoint: `${base}/candidate-a`, apiKeyEnv: keyName },
      { id: 'model-b', provider: 'openai', protocol: 'responses', model: 'candidate-b', endpoint: `${base}/candidate-b`, apiKeyEnv: keyName }
    ],
    roleBindings: {
      executor: {
        selector: 'CANDIDATE_SET',
        candidateBindings: [{ modelId: 'model-a' }, { modelId: 'model-b' }],
        fanout: 2,
        fanoutBudget: { maxCandidates: 2, maxConcurrency: 2 }
      },
    },
    decision: {
      enabled: true,
      enforce: true,
      endpoint: `${base}/jev`,
      apiKeyEnv: keyName,
      model: 'jev-latest'
    },
    // Operator configuration, not a constant: "configured" proves the file
    // value really reaches the verifier instead of the built-in defaults.
    ...(scenario === 'configured' ? {
      verifier: {
        criteria: ['Specification: satisfies the task requirements', 'Output: proposed output matches the requested result'],
        repetitions: 1,
        pivots: 2,
        maxComparisons: 8,
        seed: 'configured-seed'
      }
    } : {})
  }), 'utf8');

  const result = await run([
    'task', '--agent-mode', 'multi', '--config', configPath,
    '--prompt', '请帮我处理一下这件事', '--workspace', workspace,
    '--trajectory-store', trajectory, '--harness-event-store', harnessStore
  ], { [keyName]: 'candidate-test-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  const expectsSuccess = scenario === 'success' || scenario === 'configured';
  if (!expectsSuccess) {
    const store = createHarnessEventStore({ storagePath: harnessStore });
    await store.load();
    const records = (await store.list({ aggregateType: 'ModelEgress' })).flatMap((event) => event.payload?.records ?? []);
    const drafts = records.filter((record) => record.phase === 'CANDIDATE_DRAFT');
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((record) => record.status === (scenario === 'drafts-failed' ? 'FAILED' : 'SUCCEEDED')));
    const judges = records.filter((record) => record.phase === 'CANDIDATE_JUDGE');
    assert.equal(judges.length, 0);
    assert.equal(JSON.stringify(records).includes('no probability evidence'), false);
    return;
  }
  // Candidate selection is owned by Jev, so no candidate-judge model context
  // is allocated.
  const judgeRole = payload.roles.find((role) => role.role === 'candidate-judge');
  assert.equal(judgeRole, undefined);
  assert.equal(payload.roles.some((role) => role.role === 'executor' && role.model === 'candidate-a'), true);

  // Both candidate bindings were really invoked, one physical draft call each,
  // each on its own provider.
  const roleTurn = (item) => /isolated dda role/iu.test(String(item.body.instructions ?? ''));
  const candidateCalls = requests.filter((item) => roleTurn(item) && (item.url === '/candidate-a' || item.url === '/candidate-b'));
  assert.deepEqual(candidateCalls.map((item) => item.url).sort(), ['/candidate-a', '/candidate-b']);
  // Candidate drafts are isolated no-tool turns.
  for (const call of candidateCalls) {
    assert.match(String(call.body.instructions ?? ''), /isolated dda role/iu);
    assert.deepEqual(call.body.tools, []);
  }

  const egressStore = createHarnessEventStore({ storagePath: harnessStore });
  const jevCalls = requests.filter((item) => item.url === '/jev');
  assert.ok(jevCalls.length >= 1);
  assert.ok(jevCalls.every((item) => !Object.hasOwn(item.body, 'tools')));
  await egressStore.load();
  const events = await egressStore.list({ runId: payload.runId });
  const candidateEvents = events.filter((event) => event.kind === 'CandidateTurnCompleted');
  assert.equal(candidateEvents.length, 2);
  assert.deepEqual(
    candidateEvents.map((event) => event.payload?.payload?.candidateId ?? event.payload?.candidateId).sort(),
    ['model-a', 'model-b']
  );

  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const selection = decisionTrace.decisions.find((decision) => decision.decisionType === 'SELECT_CANDIDATE');
  assert.ok(selection, 'a SELECT_CANDIDATE decision must be committed');
  // Egress and cost are recorded per candidate, not once per run.
  const egressRecords = (await egressStore.list({ aggregateType: 'ModelEgress' }))
    .filter((event) => event.kind === 'ModelEgressRecorded')
    .flatMap((event) => event.payload?.records ?? []);
  const draftEgress = egressRecords.filter((record) => record.phase === 'CANDIDATE_DRAFT');
  assert.deepEqual(draftEgress.map((record) => record.candidateId).sort(), ['model-a', 'model-b']);
  assert.deepEqual(draftEgress.map((record) => record.modelId).sort(), ['model-a', 'model-b']);
  for (const record of draftEgress) {
    assert.match(record.promptDigest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(record.redaction.promptIncluded, false);
    assert.equal(record.egress.host, '127.0.0.1');
    assert.match(record.egress.targetDigest, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.equal(egressRecords.filter((record) => record.phase === 'CANDIDATE_JUDGE').length, 0);
  const verificationSamples = events.filter((event) => event.kind === 'CandidateVerificationSample');
  assert.equal(verificationSamples.length, 0);
  const verificationCompleted = events.filter((event) => event.kind === 'CandidateVerificationCompleted');
  assert.equal(verificationCompleted.length, 0);
  assert.equal(JSON.stringify(egressRecords).includes('draft from candidate'), false);
  assert.deepEqual(selection.options.map((option) => option.optionId).sort(), ['model-a', 'model-b']);
  assert.equal(selection.selectedOptionId, 'model-b');
  assert.equal(selection.options.find((option) => option.optionId === 'model-b').expectedQuality, 0.9);
  assert.ok(selection.reasonCodes.includes('CANDIDATE_SELECTION_JUDGE_RANKED'));
  const committed = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  assert.equal(JSON.stringify(committed).includes('draft from candidate-a'), false);

  // The single tool-executing turn received the selected draft and never saw
  // the losing candidate's draft.
  const executorCalls = requests.filter((item) => !/isolated dda role|Planner role|Council member or Judge|Independently verify|Semantic Verifier role/iu.test(String(item.body.instructions ?? '')));
  assert.ok(executorCalls.length >= 1);
  const executorText = JSON.stringify(executorCalls.map((item) => item.body));
  assert.ok(executorText.includes('draft from candidate-b'));
  assert.equal(executorText.includes('draft from candidate-a'), false);
  // Only the selected draft reached the tool-executing turn.
  for (const call of candidateCalls) {
    assert.deepEqual(call.body.tools, []);
  }
});
}
