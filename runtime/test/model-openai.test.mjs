import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createModelPlugins } from '../src/plugins/model-deepseek.mjs';

const run = (args, env) => new Promise((resolve, reject) => {
  const trajectoryStore = join(tmpdir(), `hmcodex-test-trajectory-${randomUUID()}.jsonl`);
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HMCODEX_TRAJECTORY_STORE: trajectoryStore, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const workspaceFixture = async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-openai-'));
  await writeFile(join(workspace, 'README.md'), '# OpenAI fixture\n');
  return workspace;
};

test('uses OpenCode Go Chat Completions as the default provider instead of DeepSeek', async () => {
  const root = new Context();
  for (const plugin of createModelPlugins({ model: 'default-model' })) await root.plugin(plugin);
  assert.equal(root.modelProvider.provider, 'openai-chat');
  assert.equal(root.modelProvider.protocol, 'chat-completions');
  assert.equal(root.modelProvider.model, 'default-model');
  await root.fiber.dispose();
});

test('sends configured extra headers and a generated OpenCode Go session header', async (t) => {
  const workspace = await workspaceFixture();
  let seen;
  const server = createServer(async (request, response) => {
    seen = {
      url: request.url,
      session: request.headers['x-opencode-session'],
      tenant: request.headers['x-tenant'],
      authorization: request.headers.authorization
    };
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const configPath = join(workspace, 'headers-config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai-chat',
    protocol: 'chat-completions',
    model: 'mimo-v2.5-pro',
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    apiKeyEnv: 'TEST_HEADER_KEY',
    headers: { 'x-tenant': 'tenant-a' },
    sessionHeader: 'x-opencode-session'
  }));
  const result = await run([
    'task', '--config', configPath, '--prompt', 'header check', '--workspace', workspace
  ], { TEST_HEADER_KEY: 'header-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(seen.url, '/chat/completions');
  assert.equal(seen.tenant, 'tenant-a');
  assert.equal(seen.authorization, 'Bearer header-key');
  assert.match(seen.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
});

test('calls an OpenAI Responses endpoint and normalizes output_text deltas', async (t) => {
  const workspace = await workspaceFixture();
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/responses');
    assert.equal(request.headers.authorization, 'Bearer responses-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'responses-model');
    assert.equal(body.stream, true);
    assert.equal(body.instructions.includes('READ_ONLY'), true);
    assert.equal(body.input[0].content[0].type, 'input_text');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Responses "}\r\n\r\n');
    response.write('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"complete."}\r\n\r\n');
    response.write('event: response.completed\r\ndata: {"type":"response.completed"}\r\n\r\n');
    response.end();
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'openai', '--model', 'responses-model',
    '--endpoint', `http://127.0.0.1:${address.port}/responses`,
    '--api-key-env', 'TEST_OPENAI_RESPONSES_KEY', '--prompt', '检查 Responses', '--workspace', workspace
  ], { TEST_OPENAI_RESPONSES_KEY: 'responses-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.text, 'Responses complete.');
  assert.deepEqual(payload.model, { provider: 'openai', protocol: 'responses', model: 'responses-model' });
});

test('calls an OpenAI-compatible Chat Completions endpoint', async (t) => {
  const workspace = await workspaceFixture();
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer chat-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'chat-model');
    assert.equal(body.messages[0].role, 'system');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Chat ' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'complete.' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await run([
    'task', '--provider', 'openai-chat', '--model', 'chat-model',
    '--endpoint', `http://127.0.0.1:${address.port}/chat/completions`,
    '--api-key-env', 'TEST_OPENAI_CHAT_KEY', '--prompt', '检查 Chat', '--workspace', workspace
  ], { TEST_OPENAI_CHAT_KEY: 'chat-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.text, 'Chat complete.');
  assert.deepEqual(payload.model, { provider: 'openai-chat', protocol: 'chat-completions', model: 'chat-model' });
});

test('loads the OpenAI Responses route from a JSON config file', async (t) => {
  const workspace = await workspaceFixture();
  const configPath = join(workspace, 'model-config.json');
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/configured-responses');
    assert.equal(request.headers.authorization, 'Bearer config-key');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'configured-model');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Configured."}\n\n');
    response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai',
    protocol: 'responses',
    model: 'configured-model',
    endpoint: `http://127.0.0.1:${address.port}/configured-responses`,
    apiKeyEnv: 'TEST_CONFIG_KEY'
  }));
  const result = await run([
    'task', '--config', configPath, '--prompt', '使用文件配置', '--workspace', workspace
  ], {
    TEST_CONFIG_KEY: 'config-key',
    HMCODEX_MODEL: 'environment-model',
    HMCODEX_MODEL_PROVIDER: 'compatible'
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.text, 'Configured.');
  assert.deepEqual(payload.model, { provider: 'openai', protocol: 'responses', model: 'configured-model' });
  assert.equal(payload.trajectory.store, 'PERSISTED');
  assert.ok(payload.trajectory.eventCount >= 6);
});

test('restores a bounded prior-run context on the next task', async (t) => {
  const workspace = await workspaceFixture();
  const trajectoryPath = join(workspace, 'trajectory.jsonl');
  const requestBodies = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"run-${requestBodies.length}"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n`);
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const commonArgs = [
    'task', '--provider', 'openai', '--model', 'continuation-model',
    '--endpoint', `http://127.0.0.1:${address.port}/responses`,
    '--api-key-env', 'TEST_CONTINUATION_KEY', '--workspace', workspace,
    '--trajectory-store', trajectoryPath
  ];
  const first = await run([...commonArgs, '--prompt', '第一轮任务'], { TEST_CONTINUATION_KEY: 'continuation-key' });
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  const second = await run([...commonArgs, '--prompt', '第二轮任务'], { TEST_CONTINUATION_KEY: 'continuation-key' });
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  assert.equal(requestBodies.length, 2);
  const secondInput = requestBodies[1].input[0].content[0].text;
  assert.match(secondInput, /Previous hmCodex run summaries/);
  assert.match(secondInput, /state=SUCCEEDED/);
  assert.equal(secondInput.includes('第一轮任务'), false);
  const secondTrajectory = JSON.parse(second.stdout.trim()).trajectory;
  assert.equal(secondTrajectory.store, 'PERSISTED');
  assert.ok(secondTrajectory.eventCount >= 12);
});

test('records a redacted failure event when model credentials are missing', async () => {
  const workspace = await workspaceFixture();
  const trajectoryPath = join(workspace, 'failure-trajectory.jsonl');
  const result = await run([
    'task', '--provider', 'openai', '--model', 'missing-key-model',
    '--endpoint', 'http://127.0.0.1:1/responses', '--api-key-env', 'HMCODEX_TEST_KEY_UNSET',
    '--prompt', 'failure prompt must not be stored', '--workspace', workspace,
    '--trajectory-store', trajectoryPath
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /MISSING_CREDENTIAL:HMCODEX_TEST_KEY_UNSET/);
  const events = (await readFile(trajectoryPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const failedEvent = events.find((event) => event.kind === 'TaskRunFailed');
  assert.ok(failedEvent);
  assert.equal(JSON.parse(result.stdout.trim()).runId, failedEvent.runId);
  assert.equal(failedEvent.payload.code, 'MISSING_CREDENTIAL');
  assert.equal(events.some((event) => JSON.stringify(event).includes('failure prompt must not be stored')), false);
});
