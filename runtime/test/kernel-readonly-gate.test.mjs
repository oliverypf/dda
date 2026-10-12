import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

const KERNEL_ENV = {
  DDA_RESIDENT_KERNEL: '1',
  DDA_PLATFORM: 'linux-cli',
  ...(process.platform === 'linux' ? {} : { DDA_RESIDENT_KERNEL_SANDBOX: '1' }),
  DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
  DDA_EXECUTION_MODE: 'READ_ONLY'
};

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...KERNEL_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
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

const toolCallFrames = (id, name, args) => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}`,
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

const scriptedTask = async (t, { onRequest, prompt }) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-kernel-readonly-'));
  await writeFile(join(workspace, 'README.md'), '# kernel readonly gate\n', 'utf8');
  const trajectory = join(workspace, 'trajectory.jsonl');
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    requests.push(payload);
    onRequest({ request, response, payload, requests, workspace });
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  const keyName = `DDA_TEST_KERNEL_GATE_${randomUUID().replaceAll('-', '')}`;
  const result = await run([
    'task',
    '--provider', 'openai-chat',
    '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${address.port}/chat/completions`,
    '--api-key-env', keyName,
    '--execution-mode', 'READ_ONLY',
    '--prompt', prompt,
    '--workspace', workspace,
    '--trajectory-store', trajectory,
    '--evolution-store', join(workspace, 'evolution.json')
  ], { [keyName]: 'test-key' });
  return { result, requests, workspace, trajectory };
};

test('READ_ONLY kernel.workspace_list completes when the resident kernel is on', async (t) => {
  const { result, requests, workspace } = await scriptedTask(t, {
    prompt: 'List the authorized workspace through the resident kernel.',
    onRequest({ response, payload, requests: seen, workspace: root }) {
      if (seen.length === 1) {
        assert.ok(payload.tools.some((tool) => tool.function?.name === 'hmc_kernel_x2e_workspace_list'),
          `advertised tools: ${JSON.stringify(payload.tools.map((tool) => tool.function?.name))}`);
        emitChat(response, toolCallFrames('call_kernel_list', 'kernel.workspace_list', { path: root }));
        return;
      }
      const tool = payload.messages.find((message) => message.role === 'tool');
      assert.ok(tool, 'expected a kernel.workspace_list tool result');
      assert.doesNotMatch(String(tool.content), /TOOL_NOT_ALLOWED_IN_MODE|TOOL_ACTION_BLOCKED_BY_JEV/);
      assert.match(String(tool.content), /README\.md/);
      emitChat(response, textFrames('kernel list complete'));
    }
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = lastJsonLine(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.executionMode, 'READ_ONLY');
  assert.equal(payload.text, 'kernel list complete');
  assert.ok(payload.tools.some((tool) => tool.name === 'kernel.workspace_list'));
  assert.ok(payload.tools.some((tool) => tool.name === 'kernel.session_list'));
  assert.equal(payload.toolCallCount, 1);
  assert.equal(requests.length, 2);
  assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# kernel readonly gate\n');
});

test('READ_ONLY still blocks kernel.host_request when the resident kernel is on', async (t) => {
  let blockedResult;
  const { result, requests } = await scriptedTask(t, {
    prompt: 'Probe the host bridge through the resident kernel.',
    onRequest({ response, payload, requests: seen }) {
      if (seen.length === 1) {
        emitChat(response, toolCallFrames('call_host', 'kernel.host_request', { kind: 'host.ping' }));
        return;
      }
      const tool = payload.messages.find((message) => message.role === 'tool');
      assert.ok(tool, 'expected a blocked kernel.host_request result');
      blockedResult = String(tool.content);
      assert.match(blockedResult, /TOOL_ACTION_BLOCKED_BY_JEV|TOOL_NOT_ALLOWED_IN_MODE/);
      assert.doesNotMatch(blockedResult, /KERNEL_SIDE_EFFECT_REFUSED|"pong"|host\.ping/);
      emitChat(response, textFrames('host request blocked'));
    }
  });
  const payload = lastJsonLine(result.stdout);
  assert.ok(blockedResult, `${result.stderr}\n${result.stdout}`);
  assert.match(blockedResult, /TOOL_ACTION_BLOCKED_BY_JEV|TOOL_NOT_ALLOWED_IN_MODE/);
  const harnessErrors = payload.harness?.errors ?? payload.error ?? '';
  assert.match(JSON.stringify(harnessErrors), /TOOL_ACTION_BLOCKED_BY_JEV|TOOL_NOT_ALLOWED_IN_MODE/);
  assert.equal(requests.length, 2);
});
