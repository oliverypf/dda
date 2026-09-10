import test from 'node:test';
import assert from 'node:assert/strict';
import { RoleSessionManager } from '../src/role-session-manager.mjs';
import { RuleRouter } from '../src/rule-router.mjs';
import { TaskSafetyPrecheck } from '../src/task-safety-precheck.mjs';
import { ThreadStore } from '../src/thread-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('thread checkpoints commit a redacted recovery event to the Harness Store', async () => {
  const eventStore = createHarnessEventStore();
  const threads = new ThreadStore({ eventStore });
  const thread = await threads.create({ cwd: 'C:\workspace', title: 'private title' });
  const checkpoint = await threads.setCheckpoint(thread.id, { runId: 'run-thread', phase: 'PLANNING', state: 'RUNNING', planDigest: 'sha256:' + 'a'.repeat(64) });
  const events = await eventStore.list({ runId: 'run-thread' });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'ThreadCheckpointCommitted');
  assert.equal(events[0].payload.checkpointDigest, checkpoint.checkpointDigest);
  assert.doesNotMatch(JSON.stringify(events), /private title|workspace/);
});

test('durable role allocation and lifecycle commit Harness facts before cache updates', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const manager = new RoleSessionManager({ eventStore, idFactory: () => 'durable' });
  const context = await manager.allocateDurably({ runId: 'role-run', role: 'planner', model: 'fixture', adapterIdentity: { provider: 'fixture', protocol: 'test', model: 'fixture' } });
  assert.equal((await eventStore.list({ runId: 'role-run' })).length, 1);
  await manager.transitionDurably(context.contextId, 'BUSY');
  await manager.transitionDurably(context.contextId, 'CLOSED');
  assert.deepEqual((await eventStore.list({ runId: 'role-run' })).map((event) => event.kind), ['RoleContextAllocated', 'RoleContextStateChanged', 'RoleContextStateChanged']);
  assert.equal(manager.get(context.contextId).state, 'CLOSED');
});

test('role contexts are isolated and recoverable', () => {
  const manager = new RoleSessionManager({ idFactory: () => 'fixed' });
  const planner = manager.allocate({ runId: 'run-1', role: 'planner' });
  const fork = manager.fork(planner);
  assert.notEqual(planner.contextId, fork.contextId);
  manager.setBusy(planner.contextId);
  manager.interrupt(planner.contextId, 'cancel');
  assert.equal(manager.recover(planner.contextId).state, 'READY');
  manager.close(planner.contextId);
  assert.equal(manager.recover(planner.contextId).state, 'CLOSED');
});

test('role context lifecycle rejects invalid public transitions', () => {
  const manager = new RoleSessionManager({ idFactory: () => 'invalid-transition' });
  const context = manager.allocate({ runId: 'run-invalid-transition', role: 'executor' });
  assert.throws(() => manager.interrupt(context.contextId, 'not busy'), /ROLE_CONTEXT_INVALID_TRANSITION:READY->INTERRUPTING/);
  manager.close(context.contextId);
  assert.throws(() => manager.setBusy(context.contextId), /ROLE_CONTEXT_CLOSED/);
});

test('role context recovery preserves and validates adapter, thread and binding identity', () => {
  const manager = new RoleSessionManager({ idFactory: () => 'fixed' });
  const adapterIdentity = { adapterId: 'openai-responses', version: '1.0', wireSchemaHash: 'sha256:adapter' };
  const bindingSnapshot = { planner: { modelId: 'openai/gpt-test', provider: 'openai', protocol: 'responses' } };
  const context = manager.allocate({
    runId: 'run-identity',
    role: 'planner',
    model: 'gpt-test',
    adapterIdentity,
    threadId: 'thread-external-1',
    bindingSnapshot
  });
  assert.deepEqual(context.adapterIdentity, adapterIdentity);
  assert.equal(context.threadId, 'thread-external-1');
  assert.match(context.adapterIdentityDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(context.bindingSnapshotDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(manager.validateResume(context.contextId, {
    adapterId: adapterIdentity,
    externalThreadId: 'thread-external-1',
    bindingSnapshot
  }), { contextId: context.contextId, valid: true, mismatches: [] });

  // Expected values are compared by immutable digest, so object key order is
  // irrelevant and changing any identity dimension forces a replacement.
  const recovered = manager.recover(context.contextId, {
    adapterIdentity: { wireSchemaHash: 'sha256:adapter', version: '1.0', adapterId: 'openai-responses' },
    threadId: 'thread-external-1',
    bindingSnapshot: { planner: { protocol: 'responses', provider: 'openai', modelId: 'openai/gpt-test' } }
  });
  assert.equal(recovered.contextId, context.contextId);

  const replaced = manager.recover(context.contextId, {
    adapterId: { adapterId: 'openai-responses', version: '2.0', wireSchemaHash: 'sha256:adapter' },
    threadId: 'thread-external-1',
    bindingSnapshot
  });
  assert.notEqual(replaced.contextId, context.contextId);
  assert.equal(replaced.state, 'READY');
  assert.equal(replaced.metadata.replacementReason, 'RESUME_IDENTITY_MISMATCH');
  assert.deepEqual(replaced.metadata.replacementFields, ['adapterIdentity']);
  assert.equal(manager.get(context.contextId).state, 'CLOSED');
  assert.equal(manager.get(context.contextId).reason, 'RESUME_IDENTITY_MISMATCH');

  const threadChanged = manager.recover(replaced.contextId, { threadId: 'thread-external-2' });
  assert.notEqual(threadChanged.contextId, replaced.contextId);
  assert.equal(threadChanged.threadId, 'thread-external-2');
  assert.deepEqual(threadChanged.metadata.replacementFields, ['threadId']);
});

test('role context persistence rejects tampered identity and binding snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-role-identity-'));
  const storagePath = join(directory, 'roles.json');
  const manager = new RoleSessionManager({ storagePath });
  const context = manager.allocate({
    runId: 'run-identity',
    role: 'executor',
    adapterIdentity: { adapterId: 'windows-executor', version: '1' },
    threadId: 'thread-1',
    bindingSnapshot: { executor: { modelId: 'rule' } }
  });
  await manager.flush();
  const { readFile, writeFile } = await import('node:fs/promises');
  const disk = JSON.parse(await readFile(storagePath, 'utf8'));
  disk.contexts[0].bindingSnapshot.executor.modelId = 'different';
  await writeFile(storagePath, JSON.stringify(disk));
  await assert.rejects(() => new RoleSessionManager({ storagePath }).load(), /ROLE_CONTEXT_STORE_INVALID/);
  assert.equal(context.threadId, 'thread-1');
});

test('rule router blocks modify tasks in read-only mode', () => {
  const router = new RuleRouter();
  assert.equal(router.resolve({ prompt: '请修改文件', mode: 'READ_ONLY' }).status, 'BLOCKED');
  assert.equal(router.resolve({ prompt: '检查项目结构', mode: 'READ_ONLY' }).taskClass, 'inspect');
});

test('rule router fails closed for invalid mode or role filters', () => {
  const router = new RuleRouter();
  assert.deepEqual(router.resolve({ prompt: 'inspect', mode: 'UNSAFE' }), {
    taskClass: 'inspect', status: 'BLOCKED', reason: 'INVALID_EXECUTION_MODE', roles: {}
  });
  assert.equal(router.resolve({ prompt: 'inspect', allowedRoles: ['planner', 42] }).reason, 'INVALID_ALLOWED_ROLES');
});

test('task safety precheck requires a bounded prompt and workspace-scoped controlled execution', () => {
  const precheck = new TaskSafetyPrecheck();
  assert.equal(precheck.evaluate({ prompt: '', taskClass: 'unknown' }).status, 'BLOCKED');
  assert.equal(precheck.evaluate({ prompt: '修改文件', taskClass: 'modify', mode: 'CONTROLLED' }).reason, 'CONTROLLED_WORKSPACE_REQUIRED');
  const allowed = precheck.evaluate({ prompt: '修改文件', taskClass: 'modify', mode: 'CONTROLLED', workspaceRoot: 'C:\\project' });
  assert.equal(allowed.status, 'ALLOWED');
  assert.equal(allowed.constraints.sideEffectsRequireApproval, true);
  assert.equal(allowed.constraints.networkAllowed, false);
});

test('thread store supports list, append and fork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-thread-'));
  const store = new ThreadStore({ storagePath: join(directory, 'threads.json') });
  const thread = await store.create({ title: 'main' });
  await store.appendTurn(thread.id, { summary: 'done' });
  const fork = await store.fork(thread.id);
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.get(fork.id)).turns.length, 1);
});

test('thread store readers wait for an in-flight cross-process replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-thread-reader-'));
  const storagePath = join(directory, 'threads.json');
  const markerPath = join(directory, 'writer-in-lock');
  const writerModule = pathToFileURL(fileURLToPath(new URL('../src/persistent-json-store.mjs', import.meta.url))).href;
  const writerCode = `
    import { writeFile } from 'node:fs/promises';
    import { persistJsonFile } from ${JSON.stringify(writerModule)};
    const [file, marker] = process.argv.slice(1);
    await persistJsonFile(file, {
      schemaVersion: '1.0',
      threads: [{ id: 'thread-after-replacement', title: 'after', turns: [], state: 'IDLE', createdAtMs: 2, updatedAtMs: 2 }]
    }, {
      merge: async (_existing, incoming) => {
        await writeFile(marker, 'locked', 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 300));
        return incoming;
      }
    });
  `;

  // Seed a complete snapshot so a racy reader can be distinguished from the
  // replacement that is intentionally held under the persistence lock.
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify({
    schemaVersion: '1.0',
    threads: [{ id: 'thread-before-replacement', title: 'before', turns: [], state: 'IDLE', createdAtMs: 1, updatedAtMs: 1 }]
  }), 'utf8'));
  const writer = spawn(process.execPath, ['--input-type=module', '-e', writerCode, storagePath, markerPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  writer.stderr.on('data', (chunk) => { stderr += chunk; });
  const writerExit = new Promise((resolve, reject) => {
    writer.once('error', reject);
    writer.once('close', (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(markerPath);
      break;
    } catch {
      if (attempt === 99) throw new Error('writer did not acquire persistence lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const reader = new ThreadStore({ storagePath });
  await reader.load();
  await writerExit;
  assert.ok(await reader.get('thread-after-replacement'));
  assert.equal(await reader.get('thread-before-replacement'), undefined);
});

test('persists role contexts and restores their lifecycle state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-role-context-'));
  const storagePath = join(directory, 'roles.json');
  const manager = new RoleSessionManager({ storagePath, idFactory: () => 'fixed' });
  const context = manager.allocate({ runId: 'run-1', role: 'planner', model: 'gpt-test' });
  manager.setBusy(context.contextId);
  await manager.flush();

  const restored = new RoleSessionManager({ storagePath });
  await restored.load();
  assert.equal(restored.get(context.contextId).state, 'BUSY');
  assert.equal(restored.get(context.contextId).model, 'gpt-test');
});

test('reconciles persisted busy contexts only after their owner is lost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-role-reconcile-'));
  const storagePath = join(directory, 'roles.json');
  const manager = new RoleSessionManager({ storagePath, ownerPid: 424244, runtimeInstanceId: 'runtime-owner' });
  const context = manager.allocate({ runId: 'run-owner', role: 'executor' });
  manager.setBusy(context.contextId);
  await manager.flush();

  const restored = new RoleSessionManager({ storagePath, ownerPid: 424245, runtimeInstanceId: 'runtime-restarted' });
  await restored.load();
  const live = await restored.reconcile({ isOwnerAlive: () => true });
  assert.equal(live.reconciled, 0);
  assert.equal(restored.get(context.contextId).state, 'BUSY');

  const lost = await restored.reconcile({ isOwnerAlive: () => false });
  assert.equal(lost.reconciled, 1);
  assert.equal(restored.get(context.contextId).state, 'FAILED');
  assert.equal(restored.get(context.contextId).reason, 'OWNER_PROCESS_LOST');
});

test('persists a redacted task checkpoint and rejects tampering or forbidden fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-thread-checkpoint-'));
  const storagePath = join(directory, 'threads.json');
  const store = new ThreadStore({ storagePath });
  const thread = await store.create({ title: 'checkpoint' });
  const checkpoint = await store.setCheckpoint(thread.id, {
    runId: 'run-1',
    phase: 'RECOVERING',
    plan: [{ id: 'probe', status: 'PENDING', actionDigest: 'sha256:abc' }],
    assumptions: ['workspace is canonical'],
    blockers: ['TESTS_FAILED'],
    pendingActions: ['run bounded probe'],
    roleContexts: [{ role: 'executor', modelId: 'openai/gpt-test' }]
  });
  assert.match(checkpoint.checkpointDigest, /^sha256:/);
  const restored = new ThreadStore({ storagePath });
  await restored.load();
  assert.equal((await restored.get(thread.id)).checkpoint.phase, 'RECOVERING');
  await assert.rejects(() => store.setCheckpoint(thread.id, { runId: 'run-2', phase: 'EXECUTING', prompt: 'secret' }), /THREAD_CHECKPOINT_FORBIDDEN_FIELD/);
  const disk = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(storagePath, 'utf8')));
  disk.threads[0].checkpoint.phase = 'EXECUTING';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(storagePath, JSON.stringify(disk)));
  await assert.rejects(() => new ThreadStore({ storagePath }).load(), /THREAD_STORE_INVALID/);
});
