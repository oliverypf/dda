import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

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

export const startUiModelFixture = async ({ delayMs = 25 } = {}) => {
  const server = createServer(async (request, response) => {
    try {
      const payload = await readJsonBody(request);
      const model = String(payload.model ?? '');
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const prompt = messages.map((message) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '')).join(' ');
      const hasToolResult = messages.some((message) => message?.role === 'tool');
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
      if (model === 'executor-fixture' && !hasToolResult && Array.isArray(payload.tools) && payload.tools.length > 0) {
        const readTool = findWireTool(payload, /workspace.*(list|read)|list|read/i) ?? (payload.tools[0]?.function ?? payload.tools[0]);
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
  const apiKeyEnv = 'HMCODEX_UI_MODEL_FIXTURE_KEY';
  const modelConfigPath = join(root, 'model-config.json');
  const dataRoot = join(root, 'data');
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
      { modelId: 'verifier-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'verifier-fixture', endpoint, apiKeyEnv, roles: ['semanticVerifier'] }
    ],
    roleBindings: { planner: 'planner-fixture', executor: 'executor-fixture', semanticVerifier: 'verifier-fixture' },
    decision: { enabled: false, enforce: false }
  };
  await writeFile(modelConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return {
    endpoint,
    modelConfigPath,
    dataRoot,
    workspaceRoot: root,
    env: { HMCODEX_MODEL_CONFIG: modelConfigPath, HMCODEX_DATA_DIR: dataRoot, HMCODEX_WORKSPACE_ROOT: root, [apiKeyEnv]: 'fixture-key', LOCALAPPDATA: join(root, 'local-app-data'), APPDATA: join(root, 'roaming-app-data') },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  };
};
