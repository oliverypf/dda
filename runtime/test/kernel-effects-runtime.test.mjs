import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';

// End-to-end Prime Phase-2a: a scripted model drives kernel.host_request in a
// CONTROLLED run with no live approver (host-policy AUTO subset only).

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

const scenario = async (t, { call, env = {} }) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-kernel-effects-e2e-'));
  const stores = await mkdtemp(join(tmpdir(), 'dda-kernel-effects-stores-'));
  await writeFile(join(workspace, 'README.md'), '# effects\n', 'utf8');
  const advertised = [];
  const toolResults = [];
  let executorTurns = 0;
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    const toolMessages = (payload.messages ?? []).filter((message) => message.role === 'tool');
    if (toolMessages.length === 0 && executorTurns === 0) {
      executorTurns += 1;
      advertised.push(...(payload.tools ?? []).map((tool) => tool.function?.name));
      emitChat(response, toolCallFrames('call_effect', call.name, call.args));
      return;
    }
    toolResults.push(...toolMessages.map((message) => String(message.content)));
    emitChat(response, textFrames('done'));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await listenOnFetchablePort(server);
  const { port } = server.address();
  const keyName = `DDA_TEST_KERNEL_EFFECTS_${randomUUID().replaceAll('-', '')}`;
  const auditPath = join(stores, 'audit.jsonl');
  const result = await run([
    'task', '--provider', 'openai-chat', '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${port}/chat/completions`, '--api-key-env', keyName,
    '--execution-mode', 'CONTROLLED',
    '--lease-capabilities', 'file.write',
    '--prompt', 'Create notes.txt through the kernel.',
    '--workspace', workspace,
    '--trajectory-store', join(workspace, 'trajectory.jsonl'),
    '--evolution-store', join(workspace, 'evolution.json'),
    '--max-recovery-attempts', '1'
  ], {
    [keyName]: 'test-key',
    DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL',
    DDA_EXECUTION_MODE: 'CONTROLLED',
    DDA_RESIDENT_KERNEL: '1',
    DDA_PLATFORM: 'linux-cli',
    DDA_KERNEL_EFFECTS: 'fs.write',
    DDA_KERNEL_EFFECT_AUDIT: auditPath,
    DDA_KERNEL_EFFECT_DENYLIST: join(stores, 'denylist.json'),
    DDA_KERNEL_SESSION_STORE: join(stores, 'session.json'),
    ...env
  });
  return { result, advertised, toolResults, workspace, auditPath };
};

const exists = (path) => access(path).then(() => true, () => false);

test('effects on: discrete side-effect tools are hidden and fs.write runs via kernel.host_request (AUTO host policy, audited)', async (t) => {
  const { result, advertised, toolResults, workspace, auditPath } = await scenario(t, {
    call: { name: 'kernel.host_request', args: { kind: 'fs.write', payload: { path: 'notes.txt', content: 'from kernel\n', expectedBaseDigest: null } } }
  });
  const payload = lastJsonLine(result.stdout);
  const names = advertised.join(',');
  assert.match(names, /kernel_x2e_host_request/, names);
  for (const hidden of ['file_x2e_write', 'file_x2e_patch', 'shell_x2e_execute', 'test_x2e_execute', 'network_x2e_request']) {
    assert.doesNotMatch(names, new RegExp(hidden), `${hidden} must be hidden: ${names}`);
  }
  assert.ok(!payload.tools.some((tool) => ['file.write', 'file.patch', 'test.execute', 'shell.execute'].includes(tool.name)));
  assert.equal(payload.tools.find((tool) => tool.name === 'kernel.host_request').readOnly, false);
  assert.equal(await readFile(join(workspace, 'notes.txt'), 'utf8'), 'from kernel\n', `${result.stderr}\n${toolResults.join('\n')}`);
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(audit.map((record) => record.phase), ['REQUESTED', 'COMPLETED']);
  assert.equal(audit[1].approvalPath, 'AUTO_HOST_POLICY');
  assert.equal(audit[1].key, 'CONTROLLED|fs.write|workspace_write');
});

test('effects on: a hidden discrete file.write call is refused and writes nothing', async (t) => {
  const { toolResults, workspace } = await scenario(t, {
    call: { name: 'file.write', args: { path: 'notes.txt', content: 'discrete\n' } }
  });
  assert.equal(await exists(join(workspace, 'notes.txt')), false);
  assert.ok(toolResults.some((content) => /TOOL_NOT_FOUND|TOOL_ACTION_BLOCKED|not available|unknown/iu.test(content)), toolResults.join('\n'));
});

test('effects on: shell.exec is refused in Phase-2a', async (t) => {
  const { toolResults, workspace } = await scenario(t, {
    call: { name: 'kernel.host_request', args: { kind: 'shell.exec', payload: { command: 'touch', args: ['x'] } } }
  });
  assert.ok(toolResults.some((content) => /KERNEL_SIDE_EFFECT_REFUSED/u.test(content)), toolResults.join('\n'));
  assert.equal(await exists(join(workspace, 'x')), false);
});

test('effects on: a secret-path write is refused without a live approver', async (t) => {
  const { toolResults, workspace } = await scenario(t, {
    call: { name: 'kernel.host_request', args: { kind: 'fs.write', payload: { path: '.env', content: 'TOKEN=1\n', expectedBaseDigest: null } } }
  });
  assert.equal(await exists(join(workspace, '.env')), false);
  assert.ok(toolResults.some((content) => /SAFETY_LEASE_REQUIRED|TOOL_ACTION_BLOCKED/u.test(content)), toolResults.join('\n'));
});

test('kernel unavailable (non-Linux identity): read-only tools only, no discrete side effects come back', async (t) => {
  const { result, advertised, workspace } = await scenario(t, {
    env: { DDA_PLATFORM: '' },
    call: { name: 'file.write', args: { path: 'notes.txt', content: 'discrete\n' } }
  });
  const payload = lastJsonLine(result.stdout);
  const names = advertised.join(',');
  assert.ok(advertised.length > 0, result.stderr);
  // Only read-only inspection tools are advertised; no kernel bridge, no
  // discrete write/patch/test/shell/network.
  assert.ok(advertised.every((name) => /^hmc_(workspace_x2e_(list|read|focus)|file_x2e_diff)$/u.test(name)), names);
  assert.match(JSON.stringify(payload.harness?.errors ?? []), /TOOL_NOT_FOUND/);
  assert.equal(await exists(join(workspace, 'notes.txt')), false);
});

test('live jsonl approver: fs.write_batch shows one batch card and writes N files with N leases', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-kernel-batch-e2e-'));
  const stores = await mkdtemp(join(tmpdir(), 'dda-kernel-batch-stores-'));
  await writeFile(join(workspace, 'README.md'), '# batch\n', 'utf8');
  let executorTurns = 0;
  const toolResults = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const payload = JSON.parse(Buffer.concat(body).toString('utf8'));
    const toolMessages = (payload.messages ?? []).filter((message) => message.role === 'tool');
    if (toolMessages.length === 0 && executorTurns === 0) {
      executorTurns += 1;
      emitChat(response, toolCallFrames('call_batch', 'kernel.host_request', { kind: 'fs.write_batch', payload: { items: [
        { op: 'write', path: 'one.txt', content: '1\n', expectedBaseDigest: null },
        { op: 'write', path: 'two.txt', content: '2\n', expectedBaseDigest: null },
        { op: 'write', path: 'three.txt', content: '3\n', expectedBaseDigest: null }
      ] } }));
      return;
    }
    toolResults.push(...toolMessages.map((message) => String(message.content)));
    emitChat(response, textFrames('batch done'));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await listenOnFetchablePort(server);
  const { port } = server.address();
  const keyName = `DDA_TEST_KERNEL_BATCH_${randomUUID().replaceAll('-', '')}`;
  const child = spawn(process.execPath, [
    'src/index.mjs', 'task', '--provider', 'openai-chat', '--protocol', 'chat-completions',
    '--endpoint', `http://127.0.0.1:${port}/chat/completions`, '--api-key-env', keyName,
    '--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write',
    '--prompt', 'Write three files through one kernel batch.', '--workspace', workspace,
    '--trajectory-store', join(workspace, 'trajectory.jsonl'), '--evolution-store', join(workspace, 'evolution.json'),
    '--max-recovery-attempts', '1', '--events', 'stdout'
  ], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env, [keyName]: 'test-key',
      DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', DDA_EXECUTION_MODE: 'CONTROLLED',
      DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli',
      DDA_KERNEL_EFFECTS: 'fs.write', DDA_KERNEL_WRITE_BATCH: '1',
      DDA_KERNEL_EFFECT_AUDIT: join(stores, 'audit.jsonl'), DDA_KERNEL_EFFECT_DENYLIST: join(stores, 'denylist.json'),
      DDA_KERNEL_SESSION_STORE: join(stores, 'session.json')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const events = [];
  let stdout = '';
  let stderr = '';
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffered += chunk.toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      if (value.type !== 'runtime_event') continue;
      events.push(value);
      if (value.kind === 'approval.requested') {
        child.stdin.write(JSON.stringify({ type: 'approval_response', requestId: value.payload.requestId, approved: true, displayedDigest: value.payload.requestDigest }) + '\n');
      }
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`batch e2e timed out\n${stdout}\n${stderr}`)); }, 120_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  const requested = events.filter((event) => event.kind === 'approval.requested');
  assert.equal(requested.length, 1, `one batch card only\n${stderr}\n${toolResults.join('\n')}`);
  assert.equal(requested[0].payload.kernelBatch.items.length, 3);
  assert.equal(events.filter((event) => event.kind === 'lease.issued').length, 3, 'one lease per item');
  for (const [name, content] of [['one.txt', '1\n'], ['two.txt', '2\n'], ['three.txt', '3\n']]) {
    assert.equal(await readFile(join(workspace, name), 'utf8'), content);
  }
  assert.ok(events.some((event) => event.kind === 'kernel.batch_completed'));
  assert.equal(code, 0, `${stderr}\n${stdout.slice(-2000)}`);
});
