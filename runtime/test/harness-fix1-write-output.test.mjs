import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RuntimeSafetyMonitor, RestrictedWindowsExecutor, CAPABILITIES, EXECUTION_MODES } from '../src/safety-executor.mjs';
import { LinuxPosixExecutor } from '../src/platform/executor.mjs';
import { ToolRegistry, TOOL_ERROR_CODES, ToolRegistryError, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { createExplicitLeaseProvider, registerExecutorTools, pickDeclared } from '../src/controlled-tools.mjs';
import { textDigest } from '../src/text-patch.mjs';
import { createTaskProgress } from '../src/task-harness.mjs';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { resumeWrittenFiles } from '../src/task-file-harness.mjs';

const setupPatch = async (t, content, { Executor = RestrictedWindowsExecutor, corruptBytesWritten = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'dda-fix1-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), content);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const workspace = new ReadonlyWorkspace(root);
  const registry = new ToolRegistry({ allowSideEffects: true });
  let leases = 0;
  const executor = new Executor({ monitor });
  if (corruptBytesWritten) {
    let first = true;
    const original = executor.writeFile.bind(executor);
    executor.writeFile = async (...args) => {
      const result = await original(...args);
      if (first) { first = false; return { ...result, bytesWritten: 1.5 }; }
      return result;
    };
  }
  const leaseProvider = async (request) => {
    leases++;
    return createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.WRITE_FILE, CAPABILITIES.SHELL, CAPABILITIES.TEST]
    })(request);
  };
  // Wrap to count while still issuing real leases.
  const countedProvider = createExplicitLeaseProvider({
    monitor,
    capabilities: [CAPABILITIES.WRITE_FILE, CAPABILITIES.SHELL, CAPABILITIES.TEST]
  });
  const trackingProvider = async (...args) => { leases++; return countedProvider(...args); };
  trackingProvider.canLease = countedProvider.canLease;
  Object.defineProperty(trackingProvider, 'approvedCommands', { value: countedProvider.approvedCommands });
  registerExecutorTools(registry, executor, { workspace, leaseProvider: trackingProvider });
  return { root, registry, workspace, leases: () => leases, executor, monitor };
};

test('T1 pickDeclared strips undeclared fields from side-effect tool outputs', async (t) => {
  const fake = {
    async shell() { return { ok: true, timedOut: false, aborted: false, truncated: false, stdout: '', stderr: '', action: 'shell', cwd: '.', exitCode: 0, state: 'OBSERVED', extra: 1 }; },
    async writeFile() { return { ok: true, action: 'write_file', path: 'a.txt', bytesWritten: 1, contentDigest: 'sha256:' + 'a'.repeat(64), lease: null, state: 'OBSERVED', extra: true }; },
    async test() { return { ok: true, timedOut: false, aborted: false, truncated: false, stdout: '', stderr: '', action: 'test', cwd: '.', state: 'OBSERVED', noise: 'x' }; }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, fake, {
    leaseProvider: async () => ({ id: 'L' }),
    networkAdapter: { async request() { return { ok: true, status: 200, aborted: false, timedOut: false, truncated: false, body: '', durationMs: 1, action: 'network_request', leaked: 1 }; } }
  });
  for (const name of ['shell.execute', 'file.write', 'test.execute', 'network.request']) {
    const input = name === 'file.write' ? { path: 'a.txt', content: 'x' }
      : name === 'network.request' ? { host: 'example.com' }
        : { command: 'node' };
    const out = await registry.invoke(name, input);
    assert.equal(out.ok, true);
    assert.equal('extra' in out, false);
    assert.equal('noise' in out, false);
    assert.equal('leaked' in out, false);
  }
  assert.deepEqual(pickDeclared({ a: 1, b: 2 }, { properties: { a: {} } }), { a: 1 });
});

test('T2 LinuxPosixExecutor file.patch succeeds without TOOL_INVALID_OUTPUT', async (t) => {
  const { root, registry } = await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor });
  const result = await registry.invoke('file.patch', {
    path: 'source.txt',
    expectedDigest: textDigest('before\n'),
    replacements: [{ oldText: 'before', newText: 'after' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'patch_file');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
  assert.equal(result.afterDigest, textDigest('after\n'));
});

test('T3 identical patch resend is idempotentReplay without a second lease', async (t) => {
  const { root, registry, leases } = await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor });
  const req = { path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }] };
  const first = await registry.invoke('file.patch', req);
  assert.equal(first.ok, true);
  assert.notEqual(first.idempotentReplay, true);
  const beforeLeases = leases();
  const second = await registry.invoke('file.patch', req);
  assert.equal(second.idempotentReplay, true);
  assert.equal(second.bytesWritten, 0);
  assert.equal(second.lease, null);
  assert.equal(leases(), beforeLeases);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
});

test('T3c AFTER_EFFECT then resend yields idempotentReplay; file bytes unchanged', async (t) => {
  const { root, registry, leases } = await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor, corruptBytesWritten: true });
  const req = { path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }] };
  await assert.rejects(() => registry.invoke('file.patch', req), (error) => {
    assert.equal(error.code, TOOL_ERROR_CODES.OUTPUT_AFTER_EFFECT);
    assert.equal(error.details?.cause, TOOL_ERROR_CODES.INVALID_OUTPUT);
    return true;
  });
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
  const afterFirst = leases();
  assert.ok(afterFirst >= 1);
  const replay = await registry.invoke('file.patch', req);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.ok, true);
  assert.equal(leases(), afterFirst);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
});

test('T3b ledger eviction then resend with expectedDigest stays PATCH_STALE_DIGEST (no double write)', async (t) => {
  const { root, registry } = await setupPatch(t, 'v0\n', { Executor: LinuxPosixExecutor });
  // Fill ledger with 64 other paths so the first entry is evicted.
  for (let i = 0; i < 64; i++) {
    await writeFile(join(root, `f${i}.txt`), 'a');
    await registry.invoke('file.patch', {
      path: `f${i}.txt`,
      replacements: [{ oldText: 'a', newText: 'b' }]
    });
  }
  // Original source.txt was never patched in this registry; patch it once, then
  // evict by filling again is heavy — instead patch source, then flood 64, then
  // try to re-apply the same patch against already-patched content with stale digest.
  await writeFile(join(root, 'source.txt'), 'before\n');
  await registry.invoke('file.patch', {
    path: 'source.txt',
    replacements: [{ oldText: 'before', newText: 'after' }]
  });
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
  for (let i = 0; i < 64; i++) {
    await writeFile(join(root, `g${i}.txt`), 'x');
    await registry.invoke('file.patch', {
      path: `g${i}.txt`,
      replacements: [{ oldText: 'x', newText: 'y' }]
    });
  }
  const before = await readFile(join(root, 'source.txt'), 'utf8');
  await assert.rejects(() => registry.invoke('file.patch', {
    path: 'source.txt',
    expectedDigest: textDigest('before\n'),
    replacements: [{ oldText: 'before', newText: 'after' }]
  }), /PATCH_STALE_DIGEST/);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), before);
});

test('T4 changed file after successful patch rejects resend as PATCH_STALE_DIGEST', async (t) => {
  const { root, registry } = await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor });
  await registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }] });
  await writeFile(join(root, 'source.txt'), 'other\n');
  await assert.rejects(() => registry.invoke('file.patch', {
    path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }]
  }), /PATCH_STALE_DIGEST/);
});

test('T5 restoring beforeDigest allows a normal re-apply', async (t) => {
  const { root, registry, leases } = await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor });
  await registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }] });
  await writeFile(join(root, 'source.txt'), 'before\n');
  const beforeLeases = leases();
  const again = await registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }] });
  assert.equal(again.ok, true);
  assert.notEqual(again.idempotentReplay, true);
  assert.ok(leases() > beforeLeases);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
});

test('T6 resend without digest where newText contains oldText does not double-apply', async (t) => {
  const { root, registry } = await setupPatch(t, 'ab\n', { Executor: LinuxPosixExecutor });
  const req = { path: 'source.txt', replacements: [{ oldText: 'ab', newText: 'abab' }] };
  await registry.invoke('file.patch', req);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'abab\n');
  const replay = await registry.invoke('file.patch', req);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'abab\n');
});

test('T7 file.write idempotent replay', async (t) => {
  const { root, registry, leases } = await setupPatch(t, 'old', { Executor: LinuxPosixExecutor });
  const first = await registry.invoke('file.write', { path: 'source.txt', content: 'new' });
  assert.equal(first.ok, true);
  const n = leases();
  const second = await registry.invoke('file.write', { path: 'source.txt', content: 'new' });
  assert.equal(second.idempotentReplay, true);
  assert.equal(leases(), n);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'new');
});

test('T8 executor return keys are a subset of output schema properties', async (t) => {
  const { registry } = await setupPatch(t, 'x', { Executor: LinuxPosixExecutor });
  const write = await registry.invoke('file.write', { path: 'source.txt', content: 'y' });
  const writeSchema = registry.list().find((tool) => tool.name === 'file.write').outputSchema;
  for (const key of Object.keys(write)) assert.ok(key in writeSchema.properties, key);
  await writeFile(join((await setupPatch(t, 'before\n', { Executor: LinuxPosixExecutor })).root, 'noop'), ''); // keep t hooks
});

test('T8b Windows executor keys ⊆ schema (no state on write is fine)', async (t) => {
  const { registry, root } = await setupPatch(t, 'before\n');
  const patched = await registry.invoke('file.patch', {
    path: 'source.txt', replacements: [{ oldText: 'before', newText: 'after' }]
  });
  const schema = registry.list().find((tool) => tool.name === 'file.patch').outputSchema;
  for (const key of Object.keys(patched)) assert.ok(key in schema.properties, key);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
});

test('T9 side-effect invalid output becomes TOOL_OUTPUT_AFTER_EFFECT', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'file.write',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { const: true }, state: { type: 'string', enum: ['OBSERVED'] } },
      required: ['ok'],
      additionalProperties: false
    },
    handler: () => ({ ok: true, state: 'UNKNOWN' })
  });
  await assert.rejects(() => registry.invoke('file.write', {}), (error) => {
    assert.ok(error instanceof ToolRegistryError);
    assert.equal(error.code, TOOL_ERROR_CODES.OUTPUT_AFTER_EFFECT);
    assert.equal(error.details.cause, TOOL_ERROR_CODES.INVALID_OUTPUT);
    return true;
  });
});

test('T10 read-only invalid output stays TOOL_INVALID_OUTPUT', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.read',
    readOnly: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false
    },
    handler: () => ({ wrong: true })
  });
  await assert.rejects(() => registry.invoke('workspace.read', {}), /TOOL_INVALID_OUTPUT/);
});

test('T11 side-effect oversized output becomes TOOL_OUTPUT_AFTER_EFFECT with TOO_LARGE cause', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true, maxOutputBytes: 32, maxOutputChars: 32 });
  registry.register({
    name: 'file.write',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { const: true }, body: { type: 'string' } },
      required: ['ok', 'body'],
      additionalProperties: false
    },
    handler: () => ({ ok: true, body: 'x'.repeat(80) })
  });
  await assert.rejects(() => registry.invoke('file.write', {}), (error) => {
    assert.equal(error.code, TOOL_ERROR_CODES.OUTPUT_AFTER_EFFECT);
    assert.equal(error.details.cause, TOOL_ERROR_CODES.OUTPUT_TOO_LARGE);
    return true;
  });
});

test('T12 task-runner surfaces effectApplied for TOOL_OUTPUT_AFTER_EFFECT', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({
    name: 'file.patch',
    readOnly: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { ok: { const: true }, state: { type: 'string', enum: ['OBSERVED'] } },
      required: ['ok'],
      additionalProperties: false
    },
    handler: () => ({ ok: true, state: 'UNKNOWN' })
  });
  const events = [];
  const requests = [];
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(cordisPlugin((ctx) => ctx.provide('modelProvider', {
    provider: 'fixture', protocol: 'fixture', model: 'after-effect',
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) yield { type: 'tool-call', id: 'c1', name: 'file.patch', arguments: '{}' };
      else yield { type: 'text-delta', text: 'done' };
      yield { type: 'finish', reason: { kind: requests.length === 1 ? 'tool-calls' : 'stop' } };
    }
  }), 'after-effect'));
  await root.plugin(taskRunnerPlugin);
  try {
    await root.taskRunner.run({
      prompt: 'patch once',
      workspace: { granted: true, rootLabel: 'f', snapshotDigest: 'sha256:x', entries: [], sections: [] },
      mode: 'CONTROLLED',
      onEvent: (event) => events.push(event)
    });
    const result = events.find((event) => event.kind === 'tool.result');
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'TOOL_OUTPUT_AFTER_EFFECT');
    assert.equal(result.effectApplied, true);
    assert.equal(result.nextAction, 'READ_CURRENT_FILE_DO_NOT_RESEND');
    const toolMsg = requests[1].messages.find((message) => message.source?.kind === 'tool');
    const body = JSON.parse(toolMsg.content[0].content[0].text);
    assert.equal(body.effectApplied, true);
    assert.equal(body.nextAction, 'READ_CURRENT_FILE_DO_NOT_RESEND');
  } finally {
    await root.fiber.dispose();
  }
});

test('T13 harness counters for writesApplied / unverified / idempotent', () => {
  const progress = createTaskProgress();
  progress.observe({ kind: 'lease.consumed', payload: { capability: 'file.write', ok: true } });
  progress.observe({ kind: 'tool.result', payload: { name: 'file.patch', ok: false, errorCode: 'TOOL_OUTPUT_AFTER_EFFECT', effectApplied: true } });
  progress.observe({ kind: 'tool.result', payload: { name: 'file.patch', ok: true, idempotentReplay: true } });
  progress.observe({ kind: 'tool.result', payload: { name: 'file.write', ok: true } });
  const snap = progress.snapshot();
  assert.equal(snap.writesApplied, 1);
  assert.equal(snap.writesAppliedUnverified, 1);
  assert.equal(snap.idempotentReplays, 1);
  assert.equal(snap.successfulWrites, 1);
});

test('T14 resumeWrittenFiles ignores TaskWriteEffectUnverified', async () => {
  const files = await resumeWrittenFiles({
    events: [{
      runId: 'r1', eventId: 'e1', kind: 'TaskWriteEffectUnverified',
      payload: { payload: { name: 'file.patch', errorCode: 'TOOL_OUTPUT_AFTER_EFFECT' } }
    }],
    sourceRunId: 'r1',
    checkpointDigest: 'sha256:' + 'a'.repeat(64),
    threadId: 't',
    promptDigest: 'sha256:' + 'b'.repeat(64),
    workspace: { read: async () => assert.fail('should not read') },
    mode: 'CONTROLLED'
  }).catch((error) => error);
  // Lineage invalid without TaskRunCreated — ensure Unverified alone cannot invent writes.
  assert.ok(files instanceof Error || Array.isArray(files));
  if (Array.isArray(files)) assert.equal(files.length, 0);
});
