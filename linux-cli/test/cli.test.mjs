import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalResponse } from '../src/approval.mjs';
import { main } from '../src/main.mjs';
import { migrateDataDirectory } from '../src/migrate.mjs';

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
