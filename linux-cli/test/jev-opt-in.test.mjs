import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { isDecisionPlaneConfigured } from '../../runtime/src/model-config.mjs';
import { main } from '../src/main.mjs';

// Jev is an explicit per-deployment opt-in: a `decision` block in the model
// config or any HMCODEX_JEV_* variable. A bare key does not turn it on.

test('decision plane configuration rule', () => {
  assert.equal(isDecisionPlaneConfigured({ fileConfig: {}, env: {} }), false);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: {}, env: { JEV_API_KEY: 'k' } }), false);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: {}, env: { HMCODEX_JEV_ENABLED: ' ' } }), false);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: { decision: {} }, env: {} }), true);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: { decision: [] }, env: {} }), false);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: {}, env: { HMCODEX_JEV_ENABLED: '1' } }), true);
  assert.equal(isDecisionPlaneConfigured({ fileConfig: {}, env: { HMCODEX_JEV_ENDPOINT: 'https://openrouter.ai/api/v1/systemone' } }), true);
});

const sse = (chunks) => [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), 'data: [DONE]'].join('\n\n') + '\n\n';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-jev-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), '# fixture\n');
  const model = createServer(async (request, response) => {
    for await (const _ of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse([
      { choices: [{ index: 0, delta: { content: 'README.md is the only file.' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ]));
  });
  const jevRequests = [];
  const jev = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    jevRequests.push({ authorization: request.headers.authorization, body });
    // Answer every finite question with its first criterion.
    const answers = Object.fromEntries(Object.entries(body.questions ?? {}).map(([name, question]) => {
      const first = Object.keys(question?.criteria ?? {})[0];
      return [name, first === undefined ? null : { choice: first }];
    }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answers }));
  });
  t.after(() => Promise.all([model, jev].map((server) => new Promise((resolve) => server.close(resolve)))));
  const modelPort = await listenOnFetchablePort(model);
  const jevPort = await listenOnFetchablePort(jev);
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
    DDA_TEST_MODEL_KEY: 'model-fixture-key',
    HMCODEX_MODEL_API_KEY_ENV: 'DDA_TEST_MODEL_KEY',
    HMCODEX_MODEL_ENDPOINT: `http://127.0.0.1:${modelPort}/chat/completions`
  };
  await mkdir(env.HOME, { recursive: true });
  const jevEndpoint = `http://127.0.0.1:${jevPort}/v1/systemone`;
  const run = async (extraEnv) => {
    const stdout = { text: '', write(chunk) { this.text += chunk; return true; } };
    const stderr = { text: '', write(chunk) { this.text += chunk; return true; } };
    const code = await main([
      'task', '--workspace', workspace, '--prompt', 'list the files', '--format', 'jsonl',
      '--data-dir', join(root, `data-${Math.random().toString(16).slice(2)}`)
    ], { stdout, stderr, env: { ...env, ...extraEnv }, isTTY: false, disableSignals: true });
    const objects = stdout.text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const result = objects.find((item) => item.type !== 'runtime_event');
    return { code, stdout: stdout.text, stderr: stderr.text, result };
  };
  return { run, jevRequests, jevEndpoint };
}

test('a bare JEV_API_KEY does not enable Jev', async (t) => {
  const f = await fixture(t);
  const outcome = await f.run({ JEV_API_KEY: 'bare-jev-key' });
  assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
  assert.equal(outcome.result?.decisionLayer?.enabled, false, outcome.stdout);
  assert.equal(outcome.result?.decisionLayer?.configured, false);
  assert.equal(outcome.stdout.includes('bare-jev-key'), false);
});

test('HMCODEX_JEV_* deployment variables opt in and reach the configured System One host', async (t) => {
  const f = await fixture(t);
  const outcome = await f.run({
    HMCODEX_JEV_ENDPOINT: f.jevEndpoint,
    HMCODEX_JEV_API_KEY_ENV: 'DDA_TEST_JEV_KEY',
    DDA_TEST_JEV_KEY: 'jev-fixture-key',
    // The default key must never follow an overridden endpoint.
    JEV_API_KEY: 'default-jev-key'
  });
  assert.equal(outcome.result?.decisionLayer?.enabled, true, outcome.stdout + outcome.stderr);
  assert.ok(f.jevRequests.length >= 1, outcome.stdout);
  assert.ok(f.jevRequests.every((request) => request.authorization === 'Bearer jev-fixture-key'));
  assert.equal(JSON.stringify(f.jevRequests).includes('default-jev-key'), false);
  const output = outcome.stdout + outcome.stderr;
  assert.equal(output.includes('jev-fixture-key'), false);
  assert.equal(output.includes('default-jev-key'), false);
});

test('HMCODEX_JEV_ENABLED=0 keeps a configured deployment off', async (t) => {
  const f = await fixture(t);
  const outcome = await f.run({
    HMCODEX_JEV_ENABLED: '0',
    HMCODEX_JEV_ENDPOINT: f.jevEndpoint,
    HMCODEX_JEV_API_KEY_ENV: 'DDA_TEST_JEV_KEY',
    DDA_TEST_JEV_KEY: 'jev-fixture-key'
  });
  assert.equal(outcome.code, 0, outcome.stdout + outcome.stderr);
  assert.equal(outcome.result?.decisionLayer?.enabled, false);
  assert.equal(f.jevRequests.length, 0);
});

test('a decision block in the model config opts in', async (t) => {
  const f = await fixture(t);
  const configDir = await mkdtemp(join(tmpdir(), 'dda-jev-config-'));
  const configPath = join(configDir, 'model-config.json');
  await writeFile(configPath, JSON.stringify({
    decision: { endpoint: f.jevEndpoint, apiKeyEnv: 'DDA_TEST_JEV_KEY', model: 'jev-latest' }
  }));
  const outcome = await f.run({ HMCODEX_MODEL_CONFIG: configPath, DDA_TEST_JEV_KEY: 'jev-fixture-key' });
  assert.equal(outcome.result?.decisionLayer?.enabled, true, outcome.stdout + outcome.stderr);
  assert.ok(f.jevRequests.length >= 1);
});
