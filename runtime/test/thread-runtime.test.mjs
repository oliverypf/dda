import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';
import { workspacePathKey } from '../src/platform/workspace-path.mjs';

// This suite exercises thread persistence, not semantic model quality.
const fixtureDecision = (request, response, body) => {
  if (request.url !== '/jev') return false;
  const answers = {};
  const defaults = { verification: 'PASS', failureType: 'NONE', evidence: 'SUFFICIENT',
    test: 'NONE', stop: 'STOP_SUCCESS', escalation: 'LOCAL_CONTINUE', actionGate: 'ALLOW' };
  for (const [id, question] of Object.entries(JSON.parse(body).questions)) {
    const choices = Object.keys(question.criteria ?? {});
    answers[id] = { choice: choices.includes(defaults[id]) ? defaults[id] : choices[0], confidence: 0.99 };
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ answers }));
  return true;
};

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    // These fixture runs must not inherit the installed desktop model routing.
    env: { ...process.env, LOCALAPPDATA: dirname(env.DDA_THREAD_STORE ?? env.DDA_HARNESS_EVENT_STORE),
      APPDATA: dirname(env.DDA_THREAD_STORE ?? env.DDA_HARNESS_EVENT_STORE), ...env },
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
      if (fixtureDecision(request, response, body)) return;
      requestBodies.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'thread turn complete' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    DDA_THREAD_STORE: threadStore,
    DDA_TRAJECTORY_STORE: trajectoryStore,
    DEEPSEEK_API_KEY: 'test-key',
    DDA_JEV_ENABLED: '1', DDA_JEV_API_KEY_ENV: 'DEEPSEEK_API_KEY',
    DDA_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/jev`,
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
  assert.equal(replayedPayload.events.find((event) => event.runId === firstPayload.runId
    && event.payload.persistedKind === 'TaskRunCompleted').payload.responseText, firstPayload.text);
  assert.equal(replayedPayload.events.find((event) => event.runId === secondPayload.runId
    && event.payload.persistedKind === 'TaskRunCompleted').payload.responseText, secondPayload.text);
  assert.equal(replayedPayload.events.some((event) => [
    'RecoveryStarted',
    'RecoveryCompleted',
    'ExecutionStateChanged',
    'DreamRunReconciled',
    'PluginStateChangeCommitted'
  ].includes(event.payload.persistedKind)), false);
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
test('rejects a thread from another workspace without mutating its binding or checkpoint', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-thread-workspace-binding-'));
  const otherWorkspace = await mkdtemp(join(tmpdir(), 'hmcodex-thread-other-workspace-'));
  const env = {
    DDA_THREAD_STORE: join(workspace, 'threads.json'),
    DDA_TRAJECTORY_STORE: join(workspace, 'trajectory.jsonl')
  };
  const created = await run(['thread', '--operation', 'create', '--workspace', workspace, '--title', 'Workspace A'], env);
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const original = JSON.parse(created.stdout.trim()).thread;
  const rejected = await run([
    'task', '--provider', 'deepseek', '--prompt', 'inspect workspace B',
    '--workspace', otherWorkspace, '--thread-id', original.id
  ], env);
  const result = JSON.parse(rejected.stdout.trim());
  assert.equal(result.ok, false);
  assert.match(result.error, /THREAD_WORKSPACE_MISMATCH/);
  const fetched = await run(['thread', '--operation', 'get', '--thread-id', original.id], env);
  assert.equal(fetched.code, 0, `${fetched.stderr}\n${fetched.stdout}`);
  assert.deepEqual(JSON.parse(fetched.stdout.trim()).thread, original);
});

test('resumes a thread in a linked task worktree and binds a new thread to the checkout', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-thread-worktree-runtime-'));
  const repoName = workspace.split(/[\\/]/u).at(-1);
  const worktree = join(dirname(workspace), `${repoName}.worktrees`, 'session-1');
  const git = (cwd, args) => execFileSync('git', ['-c', 'core.quotepath=false', '-C', cwd, ...args], {
    stdio: 'ignore', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['config', 'user.email', 'dda-test@example.com']);
  git(workspace, ['config', 'user.name', 'dda test']);
  await writeFile(join(workspace, 'readme.txt'), 'hello\n');
  git(workspace, ['add', 'readme.txt']);
  git(workspace, ['commit', '-m', 'init']);
  await mkdir(dirname(worktree), { recursive: true });
  git(workspace, ['worktree', 'add', '-b', 'dda/session-1', worktree, 'HEAD']);
  t.after(async () => {
    try { git(workspace, ['worktree', 'remove', '--force', worktree]); } catch { /* already gone */ }
    await rm(workspace, { recursive: true, force: true });
    await rm(dirname(worktree), { recursive: true, force: true });
  });

  const requestBodies = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      if (fixtureDecision(request, response, body)) return;
      requestBodies.push(body);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'thread turn complete' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  t.after(() => server.close());
  await listenOnFetchablePort(server);
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    DDA_THREAD_STORE: join(workspace, 'threads.json'),
    DDA_TRAJECTORY_STORE: join(workspace, 'trajectory.jsonl'),
    DEEPSEEK_API_KEY: 'test-key',
    DDA_JEV_ENABLED: '1', DDA_JEV_API_KEY_ENV: 'DEEPSEEK_API_KEY',
    DDA_JEV_ENDPOINT: `http://127.0.0.1:${address.port}/jev`,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`
  };

  const created = await run(['thread', '--operation', 'create', '--workspace', workspace, '--title', 'Checkout task'], env);
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const original = JSON.parse(created.stdout.trim()).thread;
  const resumed = await run([
    'task', '--provider', 'deepseek', '--prompt', '继续',
    '--workspace', worktree, '--thread-id', original.id
  ], env);
  const resumedPayload = JSON.parse(resumed.stdout.trim());
  assert.equal(resumedPayload.ok, true, `${resumed.stderr}\n${resumed.stdout}`);
  assert.equal(resumedPayload.threadId, original.id);
  assert.equal(workspacePathKey(resumedPayload.thread.cwd), workspacePathKey(workspace));
  assert.doesNotMatch(resumedPayload.error ?? '', /THREAD_WORKSPACE_MISMATCH/);

  const createdInWorktree = await run([
    'task', '--provider', 'deepseek', '--prompt', '新的并行任务', '--workspace', worktree
  ], env);
  const createdPayload = JSON.parse(createdInWorktree.stdout.trim());
  assert.equal(createdPayload.ok, true, `${createdInWorktree.stderr}\n${createdInWorktree.stdout}`);
  assert.notEqual(createdPayload.threadId, original.id);
  assert.equal(workspacePathKey(createdPayload.thread.cwd), workspacePathKey(workspace));
  assert.equal(requestBodies.length, 2);
});

test('default Harness thread commands read the same durable authority as the dashboard', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-thread-authority-runtime-'));
  const harnessStore = join(workspace, 'events.db');
  const env = {
    DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL',
    DDA_HARNESS_EVENT_STORE: harnessStore,
    DDA_DATA_DIR: workspace
  };

  const created = await run([
    'thread', '--operation', 'create', '--workspace', workspace, '--title', 'authority thread'
  ], env);
  assert.equal(created.code, 0, `${created.stderr}\n${created.stdout}`);
  const createdPayload = JSON.parse(created.stdout.trim());
  const threadId = createdPayload.thread.id;

  const listed = await run(['thread', '--operation', 'list'], env);
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  const listedPayload = JSON.parse(listed.stdout.trim());
  assert.equal(listedPayload.threads.find((thread) => thread.id === threadId)?.title, 'authority thread');

  const fetched = await run(['thread', '--operation', 'get', '--thread-id', threadId], env);
  assert.equal(fetched.code, 0, `${fetched.stderr}\n${fetched.stdout}`);
  const fetchedPayload = JSON.parse(fetched.stdout.trim());
  assert.equal(fetchedPayload.thread.id, threadId);
  assert.equal(fetchedPayload.thread.title, 'authority thread');
  assert.equal(JSON.stringify(fetchedPayload.thread).includes('authority thread'), true);
});
