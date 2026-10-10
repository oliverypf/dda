import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRuntimeEnv } from '../../runtime/src/platform/environment-policy.mjs';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { approvalResponse } from '../src/approval.mjs';
import { main, providerKeyNames } from '../src/main.mjs';
import { migrateDataDirectory } from '../src/migrate.mjs';
import { isBlockedWorkspacePath, resolveWorkspace } from '../src/workspace.mjs';

const capture = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });

const run = async (args, env, extra = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env, isTTY: false, disableSignals: true, ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

const isolatedEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-cli-'));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache')
  };
  await mkdir(env.HOME, { recursive: true });
  return { root, env };
};

test('usage and version stay on the contract exit codes', async () => {
  const { env } = await isolatedEnv();
  const unknown = await run(['nope', '--format', 'jsonl'], env);
  assert.equal(unknown.code, 2);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'UNKNOWN_COMMAND');
  assert.equal(unknown.stdout.trim().split('\n').length, 1);

  const version = await run(['--version', '--format', 'jsonl'], env);
  assert.equal(version.code, 0);
  const payload = JSON.parse(version.stdout);
  assert.equal(payload.platform, 'linux-cli');
  assert.equal(payload.protocol, '1.0');
});

test('the same entry selects Windows and HarmonyOS hosts', async () => {
  const { env } = await isolatedEnv();
  const windows = await run(['--version', '--format', 'jsonl'], env, { platform: 'win32', release: '10.0.22631' });
  assert.equal(JSON.parse(windows.stdout).platform, 'windows-cli');

  const harmony = await run(['--version', '--format', 'jsonl'], env, { platform: 'linux', release: '5.10.97-ohos' });
  assert.equal(JSON.parse(harmony.stdout).platform, 'harmonyos-cli');

  const explicit = await run(['--version', '--format', 'jsonl'], { ...env, HMCODEX_PLATFORM: 'linux-cli' }, {
    platform: 'win32',
    release: 'OpenHarmony 5.0'
  });
  assert.equal(JSON.parse(explicit.stdout).platform, 'linux-cli');

  assert.equal(isBlockedWorkspacePath('C:\\Windows\\System32', 'windows-cli'), true);
  assert.throws(() => resolveWorkspace('C:\\Windows', 'windows-cli'), /WORKSPACE_PATH_FORBIDDEN/);
  assert.equal(isBlockedWorkspacePath('/system/bin', 'harmonyos-cli'), true);
  assert.equal(isBlockedWorkspacePath('/proc/self', 'linux-cli'), true);
});

test('support-info follows the detected Windows and HarmonyOS profiles', async () => {
  const { env, root } = await isolatedEnv();
  const windows = await run(['support-info', '--format', 'jsonl', '--data-dir', join(root, 'win-data')], {
    ...env,
    LOCALAPPDATA: join(root, 'Local')
  }, { platform: 'win32', release: '10.0.22631' });
  assert.equal(windows.code, 0, windows.stderr + windows.stdout);
  const windowsPayload = JSON.parse(windows.stdout);
  assert.equal(windowsPayload.platform, 'windows-cli');
  assert.equal(windowsPayload.executor, 'restricted-windows');
  assert.equal(windowsPayload.dataRoot, join(root, 'win-data', 'hmCodex'));

  const harmony = await run(['support-info', '--format', 'jsonl', '--data-dir', join(root, 'ohos-data')], env, {
    platform: 'linux',
    release: 'OpenHarmony-5.0.0'
  });
  assert.equal(harmony.code, 0, harmony.stderr + harmony.stdout);
  const harmonyPayload = JSON.parse(harmony.stdout);
  assert.equal(harmonyPayload.platform, 'harmonyos-cli');
  assert.equal(harmonyPayload.executor, 'harmonyos-posix');
  assert.equal(harmonyPayload.dataRoot, join(root, 'ohos-data'));
});

test('health runs without a display and prints one JSON object', async () => {
  const { env } = await isolatedEnv();
  const result = await run(['health', '--format', 'jsonl'], env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.runtime.platform, 'linux');
  assert.equal(payload.model.provider.length > 0, true);
  assert.doesNotMatch(result.stdout, /secret|Bearer /u);
});

test('support-info reports the linux platform and the selected data root', async () => {
  const { env, root } = await isolatedEnv();
  const dataDir = join(root, 'explicit-data');
  const result = await run(['support-info', '--format', 'jsonl', '--data-dir', dataDir], env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.platform, 'linux-cli');
  assert.equal(payload.policyChannel, 'READ_ONLY');
  assert.equal(payload.executor, 'linux-posix');
  assert.equal(payload.protocolVersion, '1.0');
  assert.equal(payload.dataRoot, dataDir);
  assert.equal(payload.runtime.ok, true);
});

test('read-only task arguments fail closed before a model call', async () => {
  const { env, root } = await isolatedEnv();
  const missingPrompt = await run(['task', '--workspace', root, '--format', 'jsonl'], env);
  assert.equal(missingPrompt.code, 2);
  const missingWorkspace = await run(['task', '--prompt', '看看', '--workspace', join(root, 'missing'), '--format', 'jsonl'], env);
  assert.equal(missingWorkspace.code, 4);
  assert.equal(JSON.parse(missingWorkspace.stdout).error.code, 'WORKSPACE_NOT_FOUND');
  const forbidden = await run(['task', '--prompt', '看看', '--workspace', '/proc', '--format', 'jsonl'], env);
  assert.equal(forbidden.code, 4);
  const controlled = await run(['task', '--prompt', '跑一下', '--workspace', root, '--execution-mode', 'CONTROLLED', '--format', 'jsonl'], env);
  assert.equal(controlled.code, 5);
  assert.equal(JSON.parse(controlled.stdout).error.code, 'APPROVAL_UNAVAILABLE');
});

test('thread list uses the Linux data root and returns an empty catalog', async () => {
  const { env, root } = await isolatedEnv();
  const dataDir = join(root, 'threads');
  const result = await run(['thread', 'list', '--format', 'jsonl', '--data-dir', dataDir], env);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.threads, []);
});

test('approval digest mismatch and a missing TTY cannot approve', () => {
  const request = { payload: { requestId: 'approval-1', requestDigest: 'sha256:' + 'a'.repeat(64) } };
  assert.equal(approvalResponse({ request, mode: 'prompt', tty: false, input: 'y' }).reason, 'APPROVAL_UNAVAILABLE');
  const mismatch = approvalResponse({
    request,
    mode: 'jsonl',
    input: JSON.stringify({ type: 'approval_response', requestId: 'approval-1', approved: true, displayedDigest: 'sha256:' + 'b'.repeat(64) })
  });
  assert.equal(mismatch.approved, false);
  assert.equal(mismatch.message.displayedDigest, request.payload.requestDigest);
  const granted = approvalResponse({
    request,
    mode: 'prompt',
    tty: true,
    input: 'y'
  });
  assert.equal(granted.approved, true);
  assert.equal(granted.message.approved, true);
});

test('migrate-data plans and copies into a fresh data directory', async () => {
  const { env, root } = await isolatedEnv();
  const source = join(root, 'old');
  const target = join(root, 'new');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'threads.json'), '{"threads":[]}\n');
  const planned = await run(['migrate-data', '--from', source, '--data-dir', target, '--format', 'jsonl'], env);
  assert.equal(planned.code, 0, planned.stderr + planned.stdout);
  const plannedPayload = JSON.parse(planned.stdout);
  assert.equal(plannedPayload.status, 'PLANNED');
  assert.equal(plannedPayload.filesCopied, 0);
  const applied = await run(['migrate-data', '--from', source, '--data-dir', target, '--apply', '--format', 'jsonl'], env);
  assert.equal(applied.code, 0, applied.stderr + applied.stdout);
  const appliedPayload = JSON.parse(applied.stdout);
  assert.equal(appliedPayload.status, 'COMPLETED');
  assert.equal(appliedPayload.digestVerified, true);
  assert.equal(appliedPayload.filesCopied, 1);
  assert.equal(await readFile(join(target, 'threads.json'), 'utf8'), '{"threads":[]}\n');
});

test('migration stops when the target already has data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-migrate-'));
  const source = join(root, 'old');
  const target = join(root, 'new');
  await mkdir(source, { recursive: true });
  await mkdir(target, { recursive: true });
  await writeFile(join(source, 'threads.json'), '{"threads":[]}\n');
  await writeFile(join(target, 'memory.json'), '{}\n');
  const stopped = await migrateDataDirectory({ sourceRoot: source, targetRoot: target, apply: true });
  assert.equal(stopped.status, 'STOPPED');
  assert.equal(stopped.filesCopied, 0);
  const emptyTarget = join(root, 'empty');
  const completed = await migrateDataDirectory({ sourceRoot: source, targetRoot: emptyTarget, apply: true });
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.digestVerified, true);
  assert.equal(completed.filesCopied, 1);
});

test('the default OpenCode key is forwarded without a config and other secrets stay stripped', async () => {
  const { root } = await isolatedEnv();
  const missing = join(root, 'missing-model-config.json');
  const names = await providerKeyNames(missing);
  assert.ok(names.includes('OPENCODE_GO_API_KEY'));
  const child = buildRuntimeEnv({
    PATH: '/usr/bin',
    HOME: join(root, 'home'),
    OPENCODE_GO_API_KEY: 'go-key',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    STRAY_API_TOKEN: 'stray-token'
  }, { extraKeys: names });
  assert.equal(child.OPENCODE_GO_API_KEY, 'go-key');
  assert.equal(child.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(child.STRAY_API_TOKEN, undefined);
  assert.deepEqual(await providerKeyNames(undefined), ['OPENCODE_GO_API_KEY', 'JEV_API_KEY']);
  assert.ok(names.includes('JEV_API_KEY'));

  const configPath = join(root, 'model-config.json');
  await writeFile(configPath, JSON.stringify({
    provider: 'openai-chat',
    apiKeyEnv: 'CUSTOM_PROVIDER_KEY',
    decision: { apiKeyEnv: 'DECISION_KEY' },
    models: [{ apiKeyEnv: 'MODEL_KEY' }, { apiKeyEnv: 'not a key' }]
  }));
  const configured = await providerKeyNames(configPath);
  const configuredEnv = buildRuntimeEnv({
    OPENCODE_GO_API_KEY: 'go-key',
    CUSTOM_PROVIDER_KEY: 'custom',
    DECISION_KEY: 'decision',
    MODEL_KEY: 'model',
    AWS_SECRET_ACCESS_KEY: 'aws-secret'
  }, { extraKeys: configured });
  assert.equal(configuredEnv.OPENCODE_GO_API_KEY, 'go-key');
  assert.equal(configuredEnv.CUSTOM_PROVIDER_KEY, 'custom');
  assert.equal(configuredEnv.DECISION_KEY, 'decision');
  assert.equal(configuredEnv.MODEL_KEY, 'model');
  assert.equal(configuredEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(configured.includes('JEV_API_KEY'), false);

  const openRouterConfig = join(root, 'openrouter.json');
  await writeFile(openRouterConfig, JSON.stringify({
    decision: { endpoint: 'https://openrouter.ai/api/v1/systemone', model: 'jev-latest', apiKeyEnv: 'OPENROUTER_API_KEY' }
  }));
  const openRouterEnv = buildRuntimeEnv({
    OPENROUTER_API_KEY: 'router',
    JEV_API_KEY: 'jev'
  }, { extraKeys: await providerKeyNames(openRouterConfig) });
  assert.equal(openRouterEnv.OPENROUTER_API_KEY, 'router');
  assert.equal(openRouterEnv.JEV_API_KEY, undefined);

  const omitted = join(root, 'omitted.json');
  await writeFile(omitted, JSON.stringify({ provider: 'openai-chat', model: 'mimo-v2.5-pro' }));
  assert.ok((await providerKeyNames(omitted)).includes('OPENCODE_GO_API_KEY'));
  assert.ok((await providerKeyNames(omitted)).includes('JEV_API_KEY'));
});

test('task uses OPENCODE_GO_API_KEY from the environment when no model config exists', async (t) => {
  const { env, root } = await isolatedEnv();
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const secret = 'go-key-from-env';
  const stray = 'stray-secret-value';
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
      headers: request.headers
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listenOnFetchablePort(server);
  const result = await run([
    'task', '--workspace', workspace, '--prompt', 'reply with ok', '--format', 'jsonl', '--data-dir', join(root, 'task-data')
  ], {
    ...env,
    OPENCODE_GO_API_KEY: secret,
    AWS_SECRET_ACCESS_KEY: stray,
    STRAY_API_TOKEN: stray,
    HMCODEX_MODEL_ENDPOINT: `http://127.0.0.1:${port}/chat/completions`
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.code, 0, output);
  assert.doesNotMatch(output, /MISSING_CREDENTIAL:OPENCODE_GO_API_KEY/);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(stray), false);
  assert.ok(requests.length >= 1, output);
  assert.equal(requests[0].authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(requests).includes(stray), false);
});
