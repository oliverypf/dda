import { mkdtemp, readFile } from 'node:fs/promises';
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

test('creates, resumes and forks a persisted thread while restoring bounded context', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-thread-runtime-workspace-'));
  const threadStore = join(workspace, 'threads.json');
  const trajectoryStore = join(workspace, 'trajectory.jsonl');
  const requestBodies = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requestBodies.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'thread turn complete' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  t.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    HMCODEX_THREAD_STORE: threadStore,
    HMCODEX_TRAJECTORY_STORE: trajectoryStore,
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  };

  const first = await run([
    'task', '--provider', 'deepseek', '--prompt', '检查第一次任务', '--workspace', workspace
  ], env);
  assert.equal(first.code, 0, `${first.stderr}\n${first.stdout}`);
  const firstPayload = JSON.parse(first.stdout.trim());
  assert.equal(firstPayload.ok, true);
  assert.equal(firstPayload.thread.turnCount, 1);
  assert.equal(firstPayload.threadId, firstPayload.thread.id);

  const second = await run([
    'task', '--provider', 'deepseek', '--prompt', '继续同一个任务', '--workspace', workspace,
    '--thread-id', firstPayload.threadId
  ], env);
  assert.equal(second.code, 0, `${second.stderr}\n${second.stdout}`);
  const secondPayload = JSON.parse(second.stdout.trim());
  assert.equal(secondPayload.threadId, firstPayload.threadId);
  assert.equal(secondPayload.thread.turnCount, 2);
  assert.equal(requestBodies.length, 2);
  assert.match(requestBodies[1], /Prior thread turn summaries/);

  const listed = await run(['thread', '--operation', 'list'], env);
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  const listedPayload = JSON.parse(listed.stdout.trim());
  assert.equal(listedPayload.threads.length, 1);
  assert.equal(listedPayload.threads[0].turns.length, 2);

  const replayed = await run(['thread-events', '--thread-id', firstPayload.threadId], env);
  assert.equal(replayed.code, 0, `${replayed.stderr}\n${replayed.stdout}`);
  const replayedPayload = JSON.parse(replayed.stdout.trim());
  assert.equal(replayedPayload.ok, true);
  assert.equal(replayedPayload.threadId, firstPayload.threadId);
  assert.ok(replayedPayload.events.length > 0);
  assert.equal(replayedPayload.events.every((event) => event.runId), true);
  assert.equal(replayedPayload.events.every((event) => event.type === 'runtime_event'), true);
  assert.equal(replayedPayload.events.some((event) => event.payload.persistedKind === 'TaskRunCreated'), true);
  assert.equal(replayedPayload.events.some((event) => event.payload.persistedKind === 'TaskRunCompleted'), true);
  assert.equal(replayedPayload.events.some((event) => JSON.stringify(event).includes('检查第一次任务')), false);

  const forked = await run([
    'thread', '--operation', 'fork', '--thread-id', firstPayload.threadId, '--title', '分支任务'
  ], env);
  assert.equal(forked.code, 0, `${forked.stderr}\n${forked.stdout}`);
  const forkedPayload = JSON.parse(forked.stdout.trim());
  assert.notEqual(forkedPayload.thread.id, firstPayload.threadId);
  assert.equal(forkedPayload.thread.turns.length, 2);
  const persisted = JSON.parse(await readFile(threadStore, 'utf8'));
  assert.equal(persisted.threads.length, 2);
});
