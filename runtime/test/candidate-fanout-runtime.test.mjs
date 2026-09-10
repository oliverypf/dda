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

const sse = (response, text) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
};

for (const scenario of ['success', 'drafts-failed', 'judge-failed']) {
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
    if (scenario === 'drafts-failed' && /\/candidate-[ab]$/u.test(request.url) && /isolated hmCodex role/iu.test(system)) {
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
    if (/Independently verify/iu.test(system)) {
      if (scenario === 'judge-failed') {
        sse(response, 'no probability evidence');
        return;
      }
      const input = JSON.parse(body.input[0].content[0].text);
      const positions = ['A', 'B'].flatMap((slot) => {
        const probability = input[`trajectory${slot}`].modelId === 'model-b' ? 0.9 : 0.2;
        return [{ token: `<score_${slot}>` }, { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(probability) }, { token: 'T', logprob: Math.log(1 - probability) }] }, { token: `</score_${slot}>` }];
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '<score_A>A</score_A><score_B>A</score_B>', logprobs: positions })}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
      return;
    }
    if (/Semantic Verifier role/iu.test(system)) {
      sse(response, JSON.stringify({ status: 'PASS', summary: 'evidence is sufficient', progress: 1 }));
      return;
    }
    sse(response, 'executor completed the reported step');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
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
      semanticVerifier: { selector: 'PINNED', modelId: 'openai/default-model' }
    }
  }), 'utf8');

  const result = await run([
    'task', '--agent-mode', 'multi', '--config', configPath,
    '--prompt', '请帮我处理一下这件事', '--workspace', workspace,
    '--trajectory-store', trajectory, '--harness-event-store', harnessStore
  ], { [keyName]: 'candidate-test-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  if (scenario !== 'success') {
    const store = createHarnessEventStore({ storagePath: harnessStore });
    await store.load();
    const records = (await store.list({ aggregateType: 'ModelEgress' })).flatMap((event) => event.payload?.records ?? []);
    const drafts = records.filter((record) => record.phase === 'CANDIDATE_DRAFT');
    assert.equal(drafts.length, 2);
    assert.ok(drafts.every((record) => record.status === (scenario === 'drafts-failed' ? 'FAILED' : 'SUCCEEDED')));
    const judges = records.filter((record) => record.phase === 'CANDIDATE_JUDGE');
    assert.equal(judges.length, scenario === 'judge-failed' ? 1 : 0);
    if (judges.length) assert.equal(judges[0].status, 'FAILED');
    assert.equal(JSON.stringify(records).includes('no probability evidence'), false);
    return;
  }
  // The judge runs in its own dedicated role context, bound to an independent
  // model identity rather than to any candidate binding.
  const judgeRole = payload.roles.find((role) => role.role === 'candidate-judge');
  assert.ok(judgeRole, 'a dedicated candidate-judge role context must be allocated');
  assert.equal(judgeRole.isolation, 'DEDICATED');
  assert.equal(judgeRole.model, 'default-model');
  assert.equal(payload.roles.some((role) => role.role === 'executor' && role.model === 'candidate-a'), true);

  // Both candidate bindings were really invoked, one physical draft call each,
  // each on its own provider.
  const roleTurn = (item) => /isolated hmCodex role/iu.test(String(item.body.instructions ?? ''));
  const candidateCalls = requests.filter((item) => roleTurn(item) && (item.url === '/candidate-a' || item.url === '/candidate-b'));
  assert.deepEqual(candidateCalls.map((item) => item.url).sort(), ['/candidate-a', '/candidate-b']);
  // Candidate drafts are isolated no-tool turns.
  for (const call of candidateCalls) {
    assert.match(String(call.body.instructions ?? ''), /isolated hmCodex role/iu);
    assert.deepEqual(call.body.tools, []);
  }

  const egressStore = createHarnessEventStore({ storagePath: harnessStore });
  const judgeCalls = requests.filter((item) => /Independently verify/iu.test(String(item.body.instructions ?? '')));
  assert.equal(judgeCalls.length, 18);
  assert.ok(judgeCalls.every((item) => item.body.top_logprobs === 20));
  assert.deepEqual(judgeCalls[0].body.tools, []);
  assert.match(JSON.stringify(judgeCalls[0].body), /draft from candidate-a/u);
  assert.match(JSON.stringify(judgeCalls[0].body), /draft from candidate-b/u);
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
  assert.equal(egressRecords.filter((record) => record.phase === 'CANDIDATE_JUDGE').length, 18);
  const verificationSamples = events.filter((event) => event.kind === 'CandidateVerificationSample');
  assert.equal(verificationSamples.length, 18);
  assert.equal(JSON.stringify(egressRecords).includes('draft from candidate'), false);
  assert.deepEqual(selection.options.map((option) => option.optionId).sort(), ['model-a', 'model-b']);
  assert.equal(selection.selectedOptionId, 'model-b');
  assert.ok(Math.abs(selection.options.find((option) => option.optionId === 'model-a').expectedQuality - 1 / (1 + Math.exp(0.7))) < 1e-10);
  assert.ok(Math.abs(selection.options.find((option) => option.optionId === 'model-b').expectedQuality - 1 / (1 + Math.exp(-0.7))) < 1e-10);
  assert.ok(selection.reasonCodes.includes('CANDIDATE_SELECTION_JUDGE_RANKED'));
  assert.equal(selection.evidenceRefs.length, 20);
  const sampleEventIds = new Set(verificationSamples.map((event) => event.eventId));
  assert.equal(selection.evidenceRefs.filter((ref) => sampleEventIds.has(ref.eventId)).length, 18);
  for (const option of selection.options) assert.equal(option.evidenceRefs.length, 19);
  const committed = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  assert.equal(JSON.stringify(committed).includes('draft from candidate-a'), false);

  // The single tool-executing turn received the selected draft and never saw
  // the losing candidate's draft.
  const executorCalls = requests.filter((item) => !/isolated hmCodex role|Planner role|Council member or Judge|Independently verify|Semantic Verifier role/iu.test(String(item.body.instructions ?? '')));
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
