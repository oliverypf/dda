import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createMemoryJournal } from '../src/memory-journal.mjs';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const run = (args, env) => new Promise((resolve, reject) => {
  const trajectoryStore = join(tmpdir(), `hmcodex-test-trajectory-${randomUUID()}.jsonl`);
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HMCODEX_CONTEXT_PROVIDER: 'journal', HMCODEX_TRAJECTORY_STORE: trajectoryStore, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr, trajectoryStore }));
});

test('Phase 1 runs a read-only task through the Cordis DeepSeek adapter', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-'));
  await writeFile(join(workspace, 'README.md'), '# Test workspace\n');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Cordis task complete.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查 README', '--workspace', workspace,
    '--evolution-store', join(workspace, 'evolution.json')
  ], {
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.executionMode, 'READ_ONLY');
  assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# Test workspace\n');
  assert.equal(payload.text, 'Cordis task complete.');
  assert.equal(payload.workspace.granted, true);
  assert.equal(payload.workspace.entryCount, 1);
  assert.equal(payload.evolution.store, 'PERSISTED');
  assert.equal(payload.evolution.proposalCount, 0);
  assert.equal(payload.trajectory.store, 'PERSISTED');
  assert.ok(payload.trajectory.eventCount >= 6);
  const database = await readFile(`${result.trajectoryStore}.db`);
  assert.equal(database.subarray(0, 16).toString(), 'SQLite format 3\0');
  await assert.rejects(readFile(result.trajectoryStore), { code: 'ENOENT' });
  assert.deepEqual(payload.tools.map((tool) => tool.name), ['workspace.list', 'workspace.read']);
  assert.ok(payload.plugins.some((plugin) => plugin.id === 'model-deepseek'));
  const scopedThreads = JSON.parse(await readFile(`${result.trajectoryStore}.threads.json`, 'utf8'));
  assert.ok(scopedThreads.threads.some((thread) => thread.title === '检查 README'));
  const evaluated = await run(['evaluate', '--run-id', payload.runId], {
    HMCODEX_TRAJECTORY_STORE: result.trajectoryStore,
    HMCODEX_HARNESS_EVENT_STORE: `${result.trajectoryStore}.db`
  });
  assert.equal(evaluated.code, 0, `${evaluated.stderr}\n${evaluated.stdout}`);
  const evaluation = JSON.parse(evaluated.stdout.trim()).evaluation;
  assert.equal(evaluation.decisionCoverage.percent, 100);
  assert.equal(evaluation.optionCoverage.percent, 100);
  assert.equal(evaluation.evidenceLinkRate.percent, 100);
  assert.equal(evaluation.decisionOutcomeLinkRate.percent, 100);
  assert.equal(evaluation.eligibleForLearning, true);
  const learning = await run(['export-learning', '--run-id', payload.runId], {
    HMCODEX_TRAJECTORY_STORE: result.trajectoryStore,
    HMCODEX_HARNESS_EVENT_STORE: `${result.trajectoryStore}.db`
  });
  assert.equal(learning.code, 0, `${learning.stderr}\n${learning.stdout}`);
  const sample = JSON.parse(learning.stdout.trim()).sample;
  assert.equal(sample.decisions.length, sample.outcomes.length);
  assert.equal(sample.metrics.decisionCoverage, 100);
  assert.equal(sample.metrics.decisionOutcomeLinkRate, 100);
  assert.ok(sample.decisions.every((decision) =>
    /^snapshot-[0-9a-f]{64}$/u.test(decision.featureSnapshotId)
    && /^snapshot-[0-9a-f]{64}$/u.test(decision.constraintSnapshotId)
    && /^snapshot-[0-9a-f]{64}$/u.test(decision.bindingSnapshotId)));
  assert.ok(new Set(sample.decisions.map((decision) => decision.bindingSnapshotId)).size > 1);
  const classifyDecision = sample.decisions.find((decision) => decision.decisionType === 'CLASSIFY_TASK');
  const classifyOutcome = sample.outcomes.find((outcome) => outcome.decisionId === classifyDecision.decisionId);
  const durableEvents = await createHarnessEventStore({ storagePath: `${result.trajectoryStore}.db` }).list();
  const taskClassifiedEventIds = durableEvents.filter((event) => event.kind === 'TaskClassified').map((event) => event.eventId);
  assert.ok(taskClassifiedEventIds.length > 0);
  assert.ok(classifyOutcome.executionEventIds.some((eventId) => taskClassifiedEventIds.includes(eventId)));
});

test('Phase 1 records memory conflict and supersession suggestions from recalled memories', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-memory-conflict-'));
  await writeFile(join(workspace, 'README.md'), '# Memory fixture\n');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'memory conflict task complete' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const trajectory = join(workspace, 'trajectory.jsonl');
  const journal = createMemoryJournal({ storagePath: `${trajectory}.memory.json` });
  await journal.load();
  const proposed = journal.propose({
    runId: 'prior-run',
    statement: 'Verified task outcome: class=inspect; verifier=PASS; outputDigest=sha256:prior; README',
    sourceEventIds: ['prior-event'],
    scope: 'workspace',
    kind: 'TASK_OUTCOME',
    confidence: 0.9
  });
  journal.verify(proposed.memoryId, { accepted: true, reason: 'fixture' });
  journal.activate(proposed.memoryId);
  await journal.flush();

  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查 README', '--workspace', workspace
  ], {
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    HMCODEX_TRAJECTORY_STORE: trajectory,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const decisionTrace = JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8'));
  const consolidation = decisionTrace.decisions.find((decision) => decision.decisionType === 'CONSOLIDATE_MEMORY');
  assert.ok(consolidation.uncertaintyCodes.includes('MEMORY_POTENTIAL_CONFLICT'));
  assert.ok(consolidation.uncertaintyCodes.includes('MEMORY_SUPERSESSION_CANDIDATE'));
  assert.ok(consolidation.options.some((option) => option.optionId === 'memory-proposal-supersede'));
});

test('records a failed run when the model provider is unreachable', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-provider-down-'));
  await writeFile(join(workspace, 'README.md'), '# Provider down fixture\n');
  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', 'provider down prompt', '--workspace', workspace
  ], {
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1'
  });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.ok(payload.error);
  const durable = await createHarnessEventStore({ storagePath: `${result.trajectoryStore}.db` }).list();
  const failed = durable.find((event) => event.kind === 'TaskRunFailed');
  assert.ok(failed);
  assert.equal(JSON.stringify(durable).includes('provider down prompt'), false);
});

test('task timeout aborts the model request and records a failed run', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-timeout-'));
  await writeFile(join(workspace, 'README.md'), '# Timeout fixture\n');
  const server = createServer((_request, _response) => {
    // Keep the connection open so only the task timeout can finish the run.
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', 'timeout prompt', '--workspace', workspace, '--task-timeout-ms', '500'
  ], {
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.match(payload.error, /TASK_TIMEOUT/);
  const durable = await createHarnessEventStore({ storagePath: `${result.trajectoryStore}.db` }).list();
  const failed = durable.find((event) => event.kind === 'TaskRunFailed');
  assert.ok(failed);
  assert.equal(failed.payload.code, 'TASK_TIMEOUT');
  assert.equal(JSON.stringify(durable).includes('timeout prompt'), false);
});

test('task cancel request aborts a running task and records a cancelled run', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-cancel-'));
  await writeFile(join(workspace, 'README.md'), '# Cancel fixture\n');
  const server = createServer((_request, _response) => {
    // Keep the connection open so only an external cancel can finish the run.
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const trajectoryStore = join(tmpdir(), `hmcodex-test-trajectory-${randomUUID()}.jsonl`);
  const child = spawn(process.execPath, [
    'src/index.mjs', 'task', '--provider', 'deepseek', '--prompt', 'cancel prompt',
    '--workspace', workspace, '--events', 'stdout', '--cancel-poll-ms', '100'
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      HMCODEX_CONTEXT_PROVIDER: 'journal',
      HMCODEX_TRAJECTORY_STORE: trajectoryStore,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_EXECUTION_MODE: 'READ_ONLY',
      DEEPSEEK_API_KEY: 'test-key',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let runId;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (runId) return;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        if (typeof frame.runId === 'string' && frame.runId) { runId = frame.runId; return; }
      } catch {
        // The current chunk may end in a partial JSONL frame.
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const deadline = Date.now() + 15_000;
  while (!runId && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(runId, `task did not emit a run frame\n${stderr}\n${stdout}`);
  const cancellation = await run(['cancel', '--run-id', runId], { HMCODEX_TRAJECTORY_STORE: trajectoryStore });
  assert.equal(cancellation.code, 0, `${cancellation.stderr}\n${cancellation.stdout}`);
  const cancellationPayload = JSON.parse(cancellation.stdout.trim());
  assert.equal(cancellationPayload.ok, true);
  assert.equal(cancellationPayload.runId, runId);
  assert.equal(cancellationPayload.status, 'CANCEL_REQUESTED');
  const exitCode = await closed;
  assert.equal(exitCode, 1, `${stderr}\n${stdout}`);
  const finalPayload = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(finalPayload.ok, false);
  assert.equal(finalPayload.runId, runId);
  assert.match(finalPayload.error, /TASK_CANCELLED/);
  const durable = await createHarnessEventStore({ storagePath: `${trajectoryStore}.db` }).list();
  const cancelled = durable.find((event) => event.kind === 'TaskRunFailed');
  assert.ok(cancelled);
  assert.equal(cancelled.payload.code, 'TASK_CANCELLED');
  assert.equal(cancelled.payload.outcomeStatus, 'CANCELLED');
  assert.equal(JSON.stringify(durable).includes('cancel prompt'), false);
});

test('storage hard limit blocks a new run while recovery and export remain available', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-capacity-'));
  await writeFile(join(workspace, 'README.md'), '# Capacity fixture\n');
  const trajectoryStore = join(tmpdir(), `hmcodex-test-trajectory-${randomUUID()}.jsonl`);
  await writeFile(trajectoryStore, 'x'.repeat(4096));
  const env = {
    HMCODEX_TRAJECTORY_STORE: trajectoryStore,
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:1'
  };
  const blocked = await run([
    'task', '--provider', 'deepseek', '--prompt', 'capacity prompt',
    '--workspace', workspace, '--storage-max-bytes', '1024'
  ], env);
  assert.equal(blocked.code, 1, `${blocked.stderr}\n${blocked.stdout}`);
  const blockedPayload = JSON.parse(blocked.stdout.trim());
  assert.match(blockedPayload.error, /STORAGE_CAPACITY_HARD_LIMIT/);
  await assert.rejects(readFile(`${trajectoryStore}.db`), { code: 'ENOENT' });
  const capacity = await run(['capacity', '--storage-max-bytes', '1024'], env);
  assert.equal(capacity.code, 0, `${capacity.stderr}\n${capacity.stdout}`);
  assert.equal(JSON.parse(capacity.stdout.trim()).assessment.level, 'HARD_LIMIT');
  const recovery = await run(['recovery', '--storage-max-bytes', '1024'], env);
  assert.equal(recovery.code, 0, `${recovery.stderr}\n${recovery.stdout}`);
  assert.equal(JSON.parse(recovery.stdout.trim()).ok, true);
  const exported = await run(['export-data', '--scope', 'all', '--output', join(workspace, 'export.json')], env);
  assert.equal(exported.code, 0, `${exported.stderr}\n${exported.stdout}`);
  assert.equal(JSON.parse(exported.stdout.trim()).ok, true);
});

test('emits monotonic runtime heartbeats while a streamed model request is pending', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-heartbeat-'));
  await writeFile(join(workspace, 'README.md'), '# Heartbeat fixture\n');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'heartbeat complete' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    }, 850);
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查心跳', '--workspace', workspace,
    '--events', 'stdout', '--heartbeat-interval-ms', '250'
  ], {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const frames = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const events = frames.filter((frame) => frame.type === 'runtime_event');
  const heartbeats = events.filter((event) => event.kind === 'runtime.heartbeat');
  assert.ok(heartbeats.length >= 2, `expected multiple heartbeats, received ${heartbeats.length}`);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  assert.ok(heartbeats.every((event) => typeof event.payload.state === 'string'));
  assert.ok(heartbeats.every((event) => Number.isFinite(event.payload.uptimeMs) && event.payload.uptimeMs >= 0));
  const payload = frames.at(-1);
  assert.equal(payload.ok, true);
  assert.equal(payload.text, 'heartbeat complete');
});

test('runs a verified task through the local Memory Journal context port', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-openviking-'));
  await writeFile(join(workspace, 'README.md'), '# OpenViking fixture\n');
  let modelRequestBody = '';
  const modelServer = createServer((request, response) => {
    request.on('data', (chunk) => { modelRequestBody += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OpenViking task complete.' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  t.after(() => modelServer.close());
  await listenOnFetchablePort(modelServer);
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === 'object');

  const contextRequests = [];
  const contextServer = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const parsedBody = body ? JSON.parse(body) : undefined;
      contextRequests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        actorPeer: request.headers['x-openviking-actor-peer'],
        body: parsedBody
      });
      const send = (result) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', result }));
      };
      if (request.url === '/api/v1/sessions') return send({ session_id: parsedBody.session_id });
      if (request.url === '/api/v1/search/search') return send({
        entries: [{
          uri: 'viking://user/test/memories/entities/hmcodex.md',
          category: 'entities',
          score: 0.88,
          detail: 'abstract',
          text: 'Use the recalled OpenViking project context.'
        }],
        rendered: '<memory>Use the recalled OpenViking project context.</memory>',
        stats: { used_tokens: 18 }
      });
      if (request.url?.endsWith('/used')) return send({ contexts_used: 1, skills_used: 0 });
      if (request.url?.endsWith('/messages/batch')) return send({ added: 1 });
      if (request.url?.endsWith('/commit')) return send({ status: 'accepted', task_id: 'extract-1' });
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'error', error: { code: 'NOT_FOUND' } }));
    });
  });
  t.after(() => contextServer.close());
  await listenOnFetchablePort(contextServer);
  const contextAddress = contextServer.address();
  assert.ok(contextAddress && typeof contextAddress === 'object');

  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查 OpenViking 上下文', '--workspace', workspace
  ], {
    DEEPSEEK_API_KEY: 'model-test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelAddress.port}`,
    HMCODEX_CONTEXT_PROVIDER: 'openviking',
    HMCODEX_OPENVIKING_URL: `http://127.0.0.1:${contextAddress.port}`,
    HMCODEX_OPENVIKING_API_KEY_ENV: 'OPENVIKING_TEST_KEY',
    OPENVIKING_TEST_KEY: 'context-test-key'
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.context.provider, 'memory-journal');
  assert.equal(payload.context.status, 'COMMITTED');
  assert.equal(payload.context.recalledCount, 0);
  assert.equal(payload.context.usedCount, 0);
  assert.equal(payload.context.recordedCount, 1);
  assert.equal(payload.context.committedCount, 1);
  assert.doesNotMatch(modelRequestBody, /Use the recalled OpenViking project context\./u);
  assert.equal(contextRequests.length, 0);
});

test('keeps the local context path independent of an unavailable external server', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-openviking-degraded-'));
  await writeFile(join(workspace, 'README.md'), '# Unavailable context fixture\n');
  const modelServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Task survives context outage.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => modelServer.close());
  await listenOnFetchablePort(modelServer);
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress === 'object');
  const contextServer = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'error', error: { code: 'UNAVAILABLE', message: 'secret internal detail' } }));
  });
  t.after(() => contextServer.close());
  await listenOnFetchablePort(contextServer);
  const contextAddress = contextServer.address();
  assert.ok(contextAddress && typeof contextAddress === 'object');

  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '继续执行', '--workspace', workspace
  ], {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelAddress.port}`,
    HMCODEX_CONTEXT_PROVIDER: 'openviking',
    HMCODEX_OPENVIKING_URL: `http://127.0.0.1:${contextAddress.port}`
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.context.provider, 'memory-journal');
  assert.equal(payload.context.status, 'COMMITTED');
  assert.equal(payload.context.recalledCount, 0);
  assert.doesNotMatch(JSON.stringify(payload.context), /secret internal detail/u);
});

test('auto-derives a PROPOSED evolution candidate from a verified task outcome', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-auto-evolution-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const evolution = join(workspace, 'evolution.json');
  const evaluation = join(workspace, 'evaluations.json');
  await writeFile(join(workspace, 'README.md'), '# Auto evolution fixture\n');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'verified result' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查 README', '--workspace', workspace,
    '--auto-evolution-proposal', '--trajectory-store', trajectory,
    '--evolution-store', evolution, '--evaluation-store', evaluation
  ], {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.ok(payload.evolution.proposal, JSON.stringify(payload));
  assert.equal(payload.evolution.proposal.status, 'PROPOSED');
  assert.equal(payload.evolution.proposal.candidateType, 'OUTCOME_DERIVED');
  assert.equal(payload.evolution.proposal.sourceOutcomeIds.length, 1);
  const proposals = JSON.parse(await readFile(evolution, 'utf8'));
  assert.equal(proposals.proposals.length, 1);
  assert.equal(proposals.proposals[0].status, 'PROPOSED');
  assert.doesNotMatch(JSON.stringify(proposals), /prompt|reasoning|credential|api[_-]?key/i);
  const evaluations = JSON.parse(await readFile(evaluation, 'utf8'));
  assert.equal(evaluations.outcomes.length, 1);
  assert.equal(evaluations.outcomes[0].verified, true);
  assert.doesNotMatch(JSON.stringify(evaluations), /prompt|reasoning|credential|api[_-]?key/i);
});

test('aggregates dashboard state from the same scoped stores as a task run', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-dashboard-workspace-'));
  const trajectory = join(workspace, 'trajectory.jsonl');
  const env = {
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_THREAD_STORE: `${trajectory}.threads.json`,
    HMCODEX_MEMORY_STORE: `${trajectory}.memory.json`,
    HMCODEX_DREAM_STORE: `${trajectory}.dream.json`,
    HMCODEX_PLUGIN_GOVERNANCE_STORE: `${trajectory}.plugins.json`,
    HMCODEX_EVOLUTION_STORE: `${trajectory}.evolution.json`,
    HMCODEX_EVALUATION_STORE: `${trajectory}.evaluation.json`
  };
  const created = await run(['thread', 'create', '--workspace', workspace, '--title', '聚合状态'], env);
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const dashboard = await run(['dashboard'], env);
  assert.equal(dashboard.code, 0, `${dashboard.stderr}\n${dashboard.stdout}`);
  const payload = JSON.parse(dashboard.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.threads.length, 1);
  assert.equal(payload.threads[0].title, '聚合状态');
  assert.deepEqual(payload.execution, { ok: true, records: [] });
  assert.deepEqual(payload.memories, []);
  assert.deepEqual(payload.dreams, []);
  assert.deepEqual(payload.plugins, []);
  assert.deepEqual(payload.evolution, {
    proposals: [],
    reports: [],
    control: { enabled: true, changedAtMs: 0 }
  });
});


for (const extension of ['json', 'db']) {
test(`uses the Harness Event Store as the task event backend (${extension})`, async (t) => {
  const channel = extension === 'db' ? 'WINDOWS_PHASE1_READ_ONLY' : 'WINDOWS_MVP_PRE_PHASE1';
  const invoke = (args, env) => run(args, { ...env, HMCODEX_RELEASE_CHANNEL: channel });
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-harness-'));
  await writeFile(join(workspace, 'README.md'), '# Harness fixture\n');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'harness task complete' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const trajectory = join(workspace, 'trajectory.jsonl');
  const harness = join(workspace, `harness-events.${extension}`);
  const result = await invoke(['task', '--provider', 'deepseek', '--prompt', '检查 Harness', '--workspace', workspace], {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port,
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  });
  assert.equal(result.code, 0, result.stderr + '\n' + result.stdout);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.trajectory.store, 'PERSISTED');
  assert.ok(payload.trajectory.eventCount >= 6);
  assert.match(payload.feedback.recordId, /^feedback-/u);
  const feedbackStore = JSON.parse(await readFile(trajectory + '.feedback.json', 'utf8'));
  assert.equal(feedbackStore.events.length, 1);
  assert.equal(feedbackStore.events[0].feedback.outcomeStatus, 'SUCCEEDED');
  assert.equal(feedbackStore.events[0].feedback.outcomeId, `task-outcome-${feedbackStore.events[0].feedback.runId}`);
  const traceStore = JSON.parse(await readFile(trajectory + '.decision-trace.json', 'utf8'));
  const canonicalOutcome = traceStore.outcomes.find((outcome) => outcome.outcomeId === feedbackStore.events[0].feedback.outcomeId);
  assert.ok(canonicalOutcome);
  assert.equal(payload.runId, canonicalOutcome.runId);
  assert.equal(traceStore.decisions.find((decision) => decision.decisionId === canonicalOutcome.decisionId)?.role, 'verifier');
  assert.equal(canonicalOutcome.verifierReportIds.length, 1);
  if (extension === 'db') assert.equal((await readFile(harness)).subarray(0, 16).toString(), 'SQLite format 3\0');
  const harnessStore = { events: await createHarnessEventStore({ storagePath: harness }).list() };
  assert.equal(harnessStore.events.find((event) => event.eventId === canonicalOutcome.verifierReportIds[0])?.kind, 'VerificationCompleted');
  const rebuilt = await invoke(['rebuild-read-model', '--trajectory-store', trajectory, '--read-model', join(workspace, 'read-model.json')], {
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  });
  assert.equal(rebuilt.code, 0, rebuilt.stderr + '\n' + rebuilt.stdout);
  const rebuiltProjection = JSON.parse(rebuilt.stdout.trim()).projection;
  assert.equal(rebuiltProjection.outcomes.length, 1);
  assert.equal(rebuiltProjection.outcomes[0].outcomeId, `task-outcome-${rebuiltProjection.outcomes[0].runId}`);
  assert.equal(rebuiltProjection.feedback.length, 1);
  assert.equal(rebuiltProjection.feedback[0].outcomeId, rebuiltProjection.outcomes[0].outcomeId);
  const verify = await invoke(['harness-events', 'verify', '--harness-event-store', harness], {
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  });
  assert.equal(verify.code, 0, verify.stderr + '\n' + verify.stdout);
  const verification = JSON.parse(verify.stdout.trim()).verification;
  assert.equal(verification.ok, true);
  assert.equal(verification.eventCount, payload.trajectory.eventCount);
  await writeFile(trajectory + '.decision-trace.json', '{not-json', 'utf8');
  const evaluated = await invoke(['evaluate', '--run-id', canonicalOutcome.runId,
    '--harness-event-store', harness, '--decision-trace-store', trajectory + '.decision-trace.json'], {
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  });
  assert.equal(evaluated.code, 0, evaluated.stderr + '\n' + evaluated.stdout);
  const evaluation = JSON.parse(evaluated.stdout.trim()).evaluation;
  assert.equal(evaluation.decisionCount, traceStore.decisions.length);
  await writeFile(trajectory + '.feedback.json', '{not-json', 'utf8');
  const dashboard = await invoke(['dashboard'], {
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  });
  assert.equal(dashboard.code, 0, dashboard.stderr + '\n' + dashboard.stdout);
  const dashboardPayload = JSON.parse(dashboard.stdout.trim());
  assert.equal(Array.isArray(dashboardPayload.feedback), true);
  assert.equal(dashboardPayload.feedback.length, 1);
  assert.equal(typeof dashboardPayload.feedback[0].runId, 'string');
  assert.equal(dashboardPayload.feedback[0].outcomeId, `task-outcome-${dashboardPayload.feedback[0].runId}`);
  assert.equal(Object.hasOwn(dashboardPayload.feedback[0], 'prompt'), false);
  assert.equal(Object.hasOwn(dashboardPayload.feedback[0], 'reasoning'), false);
  if (extension === 'db') {
    // Restore a valid stale cache: the deleted run must still stay deleted.
    await writeFile(trajectory + '.decision-trace.json', JSON.stringify(traceStore));
    const env = { HMCODEX_TRAJECTORY_STORE: trajectory, HMCODEX_HARNESS_EVENT_STORE: harness };
    const purged = await invoke(['harness-events', 'purge', '--run-id', canonicalOutcome.runId,
      '--harness-event-store', harness], env);
    assert.equal(purged.code, 0, purged.stderr + '\n' + purged.stdout);
    const after = await invoke(['evaluate', '--run-id', canonicalOutcome.runId,
      '--harness-event-store', harness, '--decision-trace-store', trajectory + '.decision-trace.json'], env);
    assert.equal(after.code, 0, after.stderr + '\n' + after.stdout);
    const afterEvaluation = JSON.parse(after.stdout.trim()).evaluation;
    assert.equal(afterEvaluation.decisionCount, 0);
    assert.equal(afterEvaluation.eligibleForLearning, false);
    const afterDashboard = await invoke(['dashboard'], env);
    assert.equal(afterDashboard.code, 0, afterDashboard.stderr + '\n' + afterDashboard.stdout);
    const deletedDashboard = JSON.parse(afterDashboard.stdout.trim());
    assert.ok(deletedDashboard.projection);
    assert.ok(deletedDashboard.deletedRunIds.includes(canonicalOutcome.runId));
    assert.deepEqual(deletedDashboard.projection.outcomes, []);
    assert.deepEqual(deletedDashboard.projection.feedback, []);
    assert.deepEqual(deletedDashboard.feedback, []);
  }
});
}
