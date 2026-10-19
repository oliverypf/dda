import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';

// T24 / T26 (freeze r5 NITs): assert real process exitCode from bin/dda.mjs,
// and that runtime/src/index.mjs emitEvent whitelist fields reach CLI jsonl.

const BIN = fileURLToPath(new URL('../bin/dda.mjs', import.meta.url));
const INDEX_MJS = fileURLToPath(new URL('../../runtime/src/index.mjs', import.meta.url));

const sse = (chunks) => [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n') + '\n\n';

const parseLines = (text) => text.trim().split('\n').filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return { raw: line }; }
});

async function spawnDda(t, { handler, env: extraEnv = {}, args = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dda-fix2-nit-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  const server = createServer(handler);
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
    DDA_TEST_MODEL_KEY: 'fix2-nit-key',
    DDA_MODEL_API_KEY_ENV: 'DDA_TEST_MODEL_KEY',
    DDA_MODEL_ENDPOINT: `http://127.0.0.1:${port}/chat/completions`,
    DDA_JEV_ENABLED: '0',
    DDA_MODEL_STREAM_RETRY_DELAY_MS: '0',
    ...extraEnv
  };
  await mkdir(env.HOME, { recursive: true });
  const child = spawn(process.execPath, [
    BIN, 'task', '--workspace', workspace, '--prompt', 'say hi', '--format', 'jsonl',
    '--execution-mode', 'READ_ONLY', '--data-dir', join(root, 'dda-data'), '--timeout-ms', '45000',
    ...args
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { exitCode, stdout, stderr, lines: parseLines(stdout), final: parseLines(stdout).at(-1) };
}

test('T24 process exitCode MODEL_TRANSPORT→1 and harness.recovery.failureClass', async (t) => {
  const { exitCode, final, stderr } = await spawnDda(t, {
    handler: (_req, res) => { res.writeHead(502); res.end('{}'); }
  });
  assert.equal(exitCode, 1, stderr);
  assert.equal(final?.ok, false);
  assert.equal(final?.error?.code, 'MODEL_TRANSPORT');
  assert.equal(final?.harness?.recovery?.failureClass, 'MODEL_TRANSPORT');
});

test('T24 process exitCode MODEL_PROVIDER_REJECTED:401→3', async (t) => {
  const { exitCode, final, stderr } = await spawnDda(t, {
    handler: (_req, res) => { res.writeHead(401); res.end('{}'); }
  });
  assert.equal(exitCode, 3, stderr);
  assert.equal(final?.error?.code, 'MODEL_PROVIDER_REJECTED:401');
});

test('T24 process exitCode MODEL_REQUEST_REJECTED:400→1', async (t) => {
  const { exitCode, final, stderr } = await spawnDda(t, {
    handler: (_req, res) => { res.writeHead(400); res.end('{}'); }
  });
  assert.equal(exitCode, 1, stderr);
  assert.equal(final?.error?.code, 'MODEL_REQUEST_REJECTED:400');
});

test('T24 process exitCode MODEL_RETRY_CONFIG_INVALID→3', async (t) => {
  const { exitCode, final, stderr } = await spawnDda(t, {
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]));
    },
    env: { DDA_MODEL_STREAM_RETRIES: '99' }
  });
  assert.equal(exitCode, 3, stderr);
  assert.equal(final?.error?.code, 'MODEL_RETRY_CONFIG_INVALID');
});

// Also covers T24e (fake-server SSE mid-stream interrupt -> round retry -> success).
test('T26/T24e index.mjs whitelist forwards discardedTextChars after SSE interrupt', async (t) => {
  let attempts = 0;
  const partial = 'PARTIAL_SHOULD_DISCARD';
  const { exitCode, lines, stderr } = await spawnDda(t, {
    handler: (req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`);
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse([
        { choices: [{ index: 0, delta: { content: 'final ok' }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
      ]));
    },
    env: { DDA_MODEL_STREAM_RETRIES: '2', DDA_MODEL_STREAM_RETRY_DELAY_MS: '0' }
  });
  assert.equal(exitCode, 0, stderr);
  const retry = lines.find((event) => event.type === 'runtime_event' && event.kind === 'model.stream_retry');
  assert.ok(retry, 'expected model.stream_retry runtime_event through index.mjs whitelist');
  assert.equal(retry.payload.discardedTextChars, partial.length);
  assert.equal(typeof retry.payload.streamAttempt, 'number');
  assert.equal(typeof retry.payload.requestsRemaining, 'number');
});

test('T26 index.mjs emitEvent whitelist source includes effectApplied/idempotentReplay/discardedTextChars', async () => {
  const source = await readFile(INDEX_MJS, 'utf8');
  // Anchor on the stream_retry discardedTextChars forward (freeze §2.3), not an
  // earlier emitEvent(event.kind) helper such as role-turn projection.
  const anchor = "discardedTextChars: event.discardedTextChars";
  const at = source.indexOf(anchor);
  assert.ok(at > 0, 'discardedTextChars whitelist forward missing from index.mjs');
  const window = source.slice(Math.max(0, at - 1200), at + 400);
  assert.match(window, /effectApplied:\s*true/);
  assert.match(window, /idempotentReplay:\s*true/);
  assert.match(window, /discardedTextChars:\s*event\.discardedTextChars/);
  assert.match(window, /event\.kind === 'model\.stream_retry'/);
});
