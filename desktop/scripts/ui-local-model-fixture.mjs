import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createHarnessEventStore } from '../../runtime/src/harness-event-store.mjs';
import { createThreadStore } from '../../runtime/src/thread-store.mjs';

const readJsonBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
};

const sse = async (response, events, { delayMs = 20 } = {}) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const event of events) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
    if (delayMs > 0) await delay(delayMs);
  }
  response.end('data: [DONE]\n\n');
};

const textEvents = (content) => [
  { choices: [{ delta: { content: String(content).slice(0, Math.ceil(String(content).length / 2)) }, finish_reason: null }] },
  { choices: [{ delta: { content: String(content).slice(Math.ceil(String(content).length / 2)) }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
];

const scoreEvents = (content) => [
  { choices: [{ delta: { content: `${content}<score>A</score>` }, logprobs: { content: [{ token: '<score>' }, { token: 'A', top_logprobs: [{ token: 'A', logprob: Math.log(0.97) }, { token: 'T', logprob: Math.log(0.03) }] }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
];

const findWireTool = (payload, pattern) => (Array.isArray(payload.tools) ? payload.tools : [])
  .map((tool) => tool?.function ?? tool)
  .find((tool) => pattern.test(String(tool?.name ?? '')));

export const startUiModelFixture = async ({ delayMs = 25, seedResumeThread = false, retryUpgrade = false, seedThreadCount = 0 } = {}) => {
  if (!Number.isInteger(seedThreadCount) || seedThreadCount < 0 || seedThreadCount > 200) throw Error('UI_SEED_THREAD_COUNT_INVALID');
  const stats = { totalCalls: 0, plannerCalls: 0, executorCalls: 0, verifierCalls: 0,
    definiteFailureCalls: 0, strongCalls: 0, strongEvidenceResults: 0 };
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/stats') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
        response.end(JSON.stringify(stats));
        return;
      }
      const payload = await readJsonBody(request);
      const model = String(payload.model ?? '');
      stats.totalCalls += 1;
      if (model === 'planner-fixture') stats.plannerCalls += 1;
      if (model === 'executor-fixture') stats.executorCalls += 1;
      if (model === 'verifier-fixture') stats.verifierCalls += 1;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const prompt = messages.map((message) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')).join(' ');
      const hasToolResult = messages.some((message) => message?.role === 'tool');
      if (retryUpgrade && model === 'executor-fixture' && prompt.includes('UI_RETRY_UPGRADE_PROBE')) {
        stats.definiteFailureCalls += 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'UI_DEFINITE_MODEL_FAILURE: upgrade required' } }));
        return;
      }
      if (model === 'strong-executor-fixture') {
        stats.strongCalls += 1;
        if (messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('UI_RETRY_UPGRADE_EVIDENCE'))) {
          stats.strongEvidenceResults += 1;
        }
      }
      if (model === 'verifier-fixture') {
        await sse(response, scoreEvents('Evidence-backed local UI fixture. '), { delayMs });
        return;
      }
      if (model === 'planner-fixture') {
        await sse(response, textEvents(JSON.stringify({
          planId: 'ui-local-fixture-plan',
          steps: [{ stepId: 'inspect', summary: 'Inspect the authorized workspace using a read-only tool.', actionKind: 'WORKSPACE_READ', dependencies: [] }],
          assumptions: ['The fixture workspace is available.'],
          acceptanceCriteria: ['The task records bounded workspace evidence.']
        })), { delayMs });
        return;
      }
      if (['executor-fixture', 'strong-executor-fixture'].includes(model) && !hasToolResult && Array.isArray(payload.tools) && payload.tools.length > 0) {
        const readTool = findWireTool(payload, model === 'strong-executor-fixture' ? /read/i : /workspace.*(list|read)|list|read/i) ?? (payload.tools[0]?.function ?? payload.tools[0]);
        const wireName = String(readTool?.name ?? 'workspace.list');
        const decodedRead = /read/i.test(wireName) && !/list/i.test(wireName);
        const call = {
          id: `call-ui-fixture-${randomUUID()}`,
          type: 'function',
          function: { name: wireName, arguments: JSON.stringify(decodedRead ? { path: 'README.md', maxChars: 2000 } : { path: '' }) }
        };
        await sse(response, [
          { choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ], { delayMs });
        return;
      }
      await sse(response, textEvents(`Local fixture completed the bounded read-only inspection. ${prompt.slice(0, 80)}`), { delayMs });
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/completions`;
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-ui-model-fixture-'));
  // Keep Chromium's locked profile files outside the authorized workspace.
  const webViewRoot = await mkdtemp(join(tmpdir(), 'hmcodex-ui-webview-'));
  const apiKeyEnv = 'HMCODEX_UI_MODEL_FIXTURE_KEY';
  const dataRoot = await mkdtemp(join(tmpdir(), 'hmcodex-ui-runtime-data-'));
  const modelConfigPath = join(dataRoot, 'model-config.json');
  const storeRoot = join(dataRoot, 'hmCodex');
  const trajectoryPath = join(storeRoot, 'trajectory.jsonl');
  const threadPath = join(storeRoot, 'threads.json');
  await writeFile(join(root, 'README.md'), 'UI_RETRY_UPGRADE_EVIDENCE: bounded successful workspace read.\n', 'utf8');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'example.mjs'), 'export const value = 1;\n', 'utf8');
  const config = {
    schemaVersion: '1.0',
    provider: 'compatible',
    protocol: 'chat-completions',
    model: 'planner-fixture',
    endpoint,
    apiKeyEnv,
    models: [
      { modelId: 'planner-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'planner-fixture', endpoint, apiKeyEnv, roles: ['planner'] },
      { modelId: 'executor-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'executor-fixture', endpoint, apiKeyEnv, roles: ['executor'] },
      { modelId: 'strong-executor-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'strong-executor-fixture', endpoint, apiKeyEnv, roles: ['executor'] },
      { modelId: 'verifier-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'verifier-fixture', endpoint, apiKeyEnv, roles: ['semanticVerifier'] }
    ],
    roleBindings: { planner: 'planner-fixture', executor: 'executor-fixture', semanticVerifier: 'verifier-fixture' },
    decision: { enabled: false, enforce: false }
  };
  await writeFile(modelConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  if (seedResumeThread) {
    await mkdir(storeRoot, { recursive: true });
    const harnessEventStore = createHarnessEventStore({ storagePath: `${trajectoryPath}.db` });
    await harnessEventStore.load();
    const threads = createThreadStore({ storagePath: threadPath, eventStore: harnessEventStore });
    const thread = await threads.create({ cwd: root, title: 'Checkpoint continue fixture' });
    const sourceRunId = `seed-interrupted-${randomUUID()}`;
    await threads.appendTurn(thread.id, {
      id: `turn-${sourceRunId}`,
      runId: sourceRunId,
      summary: 'state=FAILED | checkpoint fixture | step inspect interrupted',
      state: 'FAILED'
    });
    await threads.setCheckpoint(thread.id, {
      runId: sourceRunId,
      phase: 'EXECUTING',
      state: 'PAUSED',
      plan: {
        planId: 'seed-interrupted-plan',
        steps: [{
          stepId: 'inspect',
          summary: 'Inspect the authorized fixture workspace using a read-only tool.',
          actionKind: 'WORKSPACE_READ',
          dependencies: [],
          status: 'SUCCEEDED',
          attempt: 1,
          outputDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        }, {
          stepId: 'summarize',
          summary: 'Summarize the bounded workspace evidence.',
          actionKind: 'WORKSPACE_READ',
          dependencies: ['inspect'],
          status: 'PENDING'
        }],
        assumptions: ['The fixture workspace is available.'],
        acceptanceCriteria: ['The resumed task records bounded workspace evidence.']
      },
      pendingActions: ['reconcile interrupted plan step before any replay']
    });
  }
  if (seedThreadCount) {
    await mkdir(storeRoot, { recursive: true });
    const eventStore = createHarnessEventStore({ storagePath: `${trajectoryPath}.db` });
    await eventStore.load();
    const threads = createThreadStore({ storagePath: threadPath, eventStore });
    await threads.load();
    for (let index = 0; index < seedThreadCount; index++) {
      const thread = await threads.create({ cwd: root, title: `Sidebar scroll fixture ${String(index + 1).padStart(3, '0')}` });
      await threads.appendTurn(thread.id, { id: `scroll-turn-${index}`, runId: `scroll-run-${index}`,
        state: 'SUCCEEDED', summary: 'state=SUCCEEDED | completed sidebar scroll fixture' });
    }
  }
  return {
    endpoint,
    modelConfigPath,
    dataRoot,
    workspaceRoot: root,
    statsUrl: `${endpoint.replace(/\/chat\/completions$/u, '')}/stats`,
    env: {
      HMCODEX_MODEL_CONFIG: modelConfigPath,
      HMCODEX_DATA_DIR: dataRoot,
      HMCODEX_WORKSPACE_ROOT: root,
      HMCODEX_TRAJECTORY_STORE: trajectoryPath,
      HMCODEX_THREAD_STORE: threadPath,
      WEBVIEW2_USER_DATA_FOLDER: webViewRoot,
      [apiKeyEnv]: 'fixture-key',
      LOCALAPPDATA: join(dataRoot, 'local-app-data'),
      APPDATA: join(dataRoot, 'roaming-app-data')
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      await rm(webViewRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  };
};
