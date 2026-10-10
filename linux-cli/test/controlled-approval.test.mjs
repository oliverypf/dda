import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { main } from '../src/main.mjs';

// End-to-end CONTROLLED approval through the real dda entry: a fake
// OpenAI-compatible model asks for one shell.execute call, the runtime raises
// approval.requested, and the CLI answers through deny / jsonl / prompt.

const BIN = fileURLToPath(new URL('../bin/dda.mjs', import.meta.url));
const SHELL_ARGS = ['-e', 'process.stdout.write("approved-run")'];

const sse = (chunks) => [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n') + '\n\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-controlled-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(payload);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests.length === 1) {
      const args = JSON.stringify({ command: process.execPath, args: SHELL_ARGS });
      response.end(sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_shell', type: 'function', function: { name: 'shell.execute', arguments: args } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ]));
      return;
    }
    response.end(sse([
      { choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listenOnFetchablePort(server);
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    DDA_TEST_MODEL_KEY: 'controlled-fixture-key',
    HMCODEX_MODEL_API_KEY_ENV: 'DDA_TEST_MODEL_KEY',
    HMCODEX_MODEL_ENDPOINT: `http://127.0.0.1:${port}/chat/completions`,
    HMCODEX_JEV_ENABLED: '0',
    HMCODEX_LEASE_CAPABILITIES: 'shell.execute',
    HMCODEX_LEASE_COMMANDS: 'node'
  };
  await mkdir(env.HOME, { recursive: true });
  const args = (mode) => [
    'task', '--workspace', workspace, '--prompt', 'run the shell check', '--format', 'jsonl',
    '--execution-mode', 'CONTROLLED', '--approval-mode', mode, '--data-dir', join(root, 'dda-data'), '--timeout-ms', '60000'
  ];
  // Whether the approved command actually ran is visible in the tool result the
  // runtime sends back to the model on the second request.
  const shellRan = () => requests.slice(1).some((payload) => (payload.messages ?? [])
    .some((message) => message.role === 'tool' && /"stdout":"approved-run"/u.test(String(message.content))));
  return { root, workspace, env, args, requests, shellRan };
}

const events = (text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const kinds = (text, kind) => events(text).filter((event) => event.kind === kind);

// A stdout sink that answers each approval.requested through a callback.
function answeringStdout(onRequest) {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
      for (const line of String(chunk).split('\n')) {
        if (!line.includes('"approval.requested"')) continue;
        onRequest(JSON.parse(line));
      }
      return true;
    }
  };
}

const runMain = async (argv, env, extra = {}) => {
  const stdout = extra.stdout ?? { text: '', write(chunk) { this.text += chunk; return true; } };
  const stderr = { text: '', write(chunk) { this.text += chunk; return true; } };
  const code = await main(argv, { stdout, stderr, env, isTTY: false, disableSignals: true, ...extra, stdout });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

test('CONTROLLED --approval-mode deny declines and the command never runs', async (t) => {
  const f = await fixture(t);
  const result = await runMain(f.args('deny'), f.env);
  assert.equal(kinds(result.stdout, 'approval.requested').length, 1, result.stdout);
  assert.equal(kinds(result.stdout, 'approval.resolved')[0].payload.state, 'DECLINED');
  assert.equal(f.shellRan(), false);
  assert.equal(result.code, 5, result.stdout);
  assert.equal(result.stdout.includes('controlled-fixture-key'), false);
});

test('CONTROLLED --approval-mode jsonl approves with the displayed digest', async (t) => {
  const f = await fixture(t);
  const input = new PassThrough();
  const stdout = answeringStdout((event) => {
    input.write(`${JSON.stringify({ type: 'approval_response', requestId: event.payload.requestId, approved: true, displayedDigest: event.payload.requestDigest })}\n`);
  });
  const result = await runMain(f.args('jsonl'), f.env, { stdout, approvalInput: input });
  input.end();
  assert.equal(kinds(result.stdout, 'approval.resolved')[0]?.payload.state, 'APPROVED', result.stdout);
  assert.equal(f.shellRan(), true);
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('CONTROLLED --approval-mode jsonl turns a digest mismatch into a denial', async (t) => {
  const f = await fixture(t);
  const input = new PassThrough();
  const stdout = answeringStdout((event) => {
    input.write(`${JSON.stringify({ type: 'approval_response', requestId: event.payload.requestId, approved: true, displayedDigest: `sha256:${'0'.repeat(64)}` })}\n`);
  });
  const started = Date.now();
  const result = await runMain(f.args('jsonl'), f.env, { stdout, approvalInput: input });
  input.end();
  assert.equal(kinds(result.stdout, 'approval.resolved')[0]?.payload.state, 'DECLINED', result.stdout);
  assert.equal(f.shellRan(), false);
  assert.equal(result.code, 5);
  // The denial is immediate; it does not wait for the approval to expire.
  assert.ok(Date.now() - started < 30000);
});

test('CONTROLLED --approval-mode jsonl denies when stdin ends without an answer', async (t) => {
  const f = await fixture(t);
  const input = new PassThrough();
  input.end();
  const result = await runMain(f.args('jsonl'), f.env, { approvalInput: input });
  assert.equal(kinds(result.stdout, 'approval.resolved')[0]?.payload.state, 'DECLINED', result.stdout);
  assert.equal(f.shellRan(), false);
  assert.equal(result.code, 5);
});

test('CONTROLLED prompt mode asks the terminal and honours y and n', async (t) => {
  const f = await fixture(t);
  const asked = [];
  const approved = await runMain(f.args('prompt'), f.env, {
    isTTY: true,
    approvalTTY: true,
    readApprovalLine: async (event) => { asked.push(event.payload.requestId); return 'y'; }
  });
  assert.equal(asked.length, 1);
  assert.equal(f.shellRan(), true);
  assert.equal(approved.code, 0, approved.stdout + approved.stderr);
  assert.match(approved.stderr, /需要审批/u);

  const g = await fixture(t);
  const declined = await runMain(g.args('prompt'), g.env, {
    isTTY: true,
    approvalTTY: true,
    readApprovalLine: async () => 'n'
  });
  assert.equal(g.shellRan(), false);
  assert.equal(declined.code, 5);
});

test('prompt approval needs a terminal on stdin and a reader', async (t) => {
  const f = await fixture(t);
  const pipedStdin = await runMain(f.args('prompt'), f.env, { isTTY: true, approvalTTY: false, readApprovalLine: async () => 'y' });
  assert.equal(pipedStdin.code, 5);
  assert.equal(JSON.parse(pipedStdin.stdout).error.code, 'APPROVAL_UNAVAILABLE');
  const noReader = await runMain(f.args('prompt'), f.env, { isTTY: true, approvalTTY: true });
  assert.equal(noReader.code, 5);
  const noInput = await runMain(f.args('jsonl'), f.env, {});
  assert.equal(noInput.code, 5);
  assert.equal(JSON.parse(noInput.stdout).error.code, 'APPROVAL_UNAVAILABLE');
  assert.equal(f.requests.length, 0);
});

test('bin/dda.mjs wires stdin into jsonl approval', async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [BIN, ...f.args('jsonl')], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.includes('"approval.requested"')) continue;
      const event = JSON.parse(line);
      child.stdin.write(`${JSON.stringify({ type: 'approval_response', requestId: event.payload.requestId, approved: true, displayedDigest: event.payload.requestDigest })}\n`);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(kinds(stdout, 'approval.resolved')[0]?.payload.state, 'APPROVED', stdout + stderr);
  assert.equal(f.shellRan(), true);
  assert.equal(code, 0, stdout + stderr);
});

test('the stdio prompt reader answers in order and treats EOF as no', async () => {
  const { createStdioApprovalIO } = await import('../src/terminal-approval.mjs');
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const io = createStdioApprovalIO({ stdin, stderr });
  const first = io.readApprovalLine({});
  const second = io.readApprovalLine({});
  stdin.write('y\n');
  assert.equal(await first, 'y');
  stdin.end();
  assert.equal(await second, 'n');
  assert.equal(await io.readApprovalLine({}), 'n');
  io.close();
});
