import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

test('runs a bounded OpenAI tool round through CONTROLLED executor approval', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-controlled-task-'));
  await writeFile(join(workspace, 'script.js'), 'process.stdout.write("ok")', 'utf8');
  const trajectory = join(workspace, 'trajectory.jsonl');
  const evolution = join(workspace, 'evolution.json');
  await writeFile(join(workspace, 'README.md'), '# fixture\n', 'utf8');
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    requestCount += 1;
    assert.ok(Array.isArray(payload.tools));
    if (requestCount === 1) {
      // OpenAI-compatible gateways only accept ASCII tool names.  The runtime
      // keeps the provider-neutral id internally and encodes it on the wire.
      assert.ok(payload.tools.some((tool) => tool.function?.name === 'hmc_shell_x2e_execute'));
      const argumentsText = JSON.stringify({ command: process.execPath, args: ['script.js'] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell.execute', arguments: argumentsText } }] }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
        'data: [DONE]'
      ].join('\n\n') + '\n\n');
      return;
    }
    assert.equal(payload.messages.at(-2).role, 'assistant');
    assert.equal(payload.messages.at(-2).tool_calls[0].id, 'call_shell');
    assert.equal(payload.messages.at(-1).role, 'tool');
    assert.match(payload.messages.at(-1).content, /"stdout":"ok"/);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end([
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '任务完成' }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      'data: [DONE]'
    ].join('\n\n') + '\n\n');
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  const keyName = `DDA_TEST_CONTROLLED_KEY_${randomUUID().replaceAll('-', '')}`;
  const result = await run([
    'task',
    '--provider', 'openai-chat',
    '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${address.port}/chat/completions`,
    '--api-key-env', keyName,
    '--execution-mode', 'CONTROLLED',
    '--lease-capabilities', 'shell.execute',
    '--lease-commands', 'node',
    '--prompt', 'run shell',
    '--workspace', workspace,
    '--trajectory-store', trajectory,
    '--evolution-store', evolution
  ], { [keyName]: 'test-key' });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.executionMode, 'CONTROLLED');
  assert.equal(payload.toolRounds, 1);
  assert.equal(payload.toolCallCount, 1);
  assert.equal(payload.text, '任务完成');
  // Controlled channels persist authoritative events in the scoped SQLite
  // store derived from --trajectory-store; dump them through the event-list
  // command instead of reading a JSONL file that no longer exists.
  const listed = await run(['harness-events', 'list', '--trajectory-store', trajectory], {});
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  assert.doesNotMatch(listed.stdout, /process\.stdout\.write|"args"/);
});
