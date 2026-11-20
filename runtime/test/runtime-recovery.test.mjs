import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { reconcileInterruptedThreads } from '../src/thread-reconciliation.mjs';
import { dreamDigest } from '../src/dream-scheduler.mjs';

const isolatedAppData = await mkdtemp(join(tmpdir(), 'dda-recovery-app-data-'));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^DDA_.*(?:STORE|DATA_DIR)$/iu.test(key)));
const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...baseEnv, LOCALAPPDATA: isolatedAppData, APPDATA: isolatedAppData, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

test('recovery records a Git observer checkpoint in the Harness Store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-recovery-git-'));
  const harnessPath = join(directory, 'harness-events.db');
  const auditPath = join(directory, 'git-audit.json');
  const result = await run(['recovery', '--workspace', directory, '--harness-event-store', harnessPath, '--audit-store', auditPath, '--run-id', 'recovery-git'], {});
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.workspace.available, false);
  assert.equal(payload.workspace.status, 'NOT_A_REPOSITORY');
  assert.equal(typeof payload.workspace.observationDigest, 'string');
  assert.equal(typeof payload.workspace.changedFiles, 'number');
  const events = await createHarnessEventStore({ storagePath: harnessPath }).list();
  assert.deepEqual(events.map((event) => event.kind), ['RecoveryStarted', 'GitStateObserved', 'RecoveryCompleted']);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  assert.equal(audit.checkpoints.length, 1);
  assert.equal(audit.checkpoints[0].checkpointKind, 'RECOVERY');
});

test('thread recovery keeps live owners and checkpoints, and closes a lost owner once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-thread-reconcile-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  const threadPath = join(directory, 'threads.json');
  const threads = createThreadStore({ storagePath: threadPath, eventStore });
  const seed = async (runId, ownerPid) => {
    const thread = await threads.create({ cwd: directory, title: runId });
    await threads.setCheckpoint(thread.id, { runId, ownerPid, state: 'RUNNING', phase: 'EXECUTING' });
    return thread.id;
  };
  const live = await seed('live-run', 100);
  const lost = await seed('lost-run', 200);
  const options = { threadPath, eventStore, roleSessions: { list: () => [] }, ownerAlive: pid => pid === 100 };
  assert.equal(await reconcileInterruptedThreads(options), 1);
  assert.equal(await reconcileInterruptedThreads(options), 0);
  const result = createThreadStore({ storagePath: threadPath, eventStore });
  assert.equal((await result.get(live)).state, 'RUNNING');
  assert.equal((await result.get(lost)).state, 'FAILED');
  assert.equal((await result.get(lost)).checkpoint.runId, 'lost-run');
  const foreignStore = createHarnessEventStore({ storagePath: join(directory, 'other.db') });
  assert.equal(await reconcileInterruptedThreads({ ...options, eventStore: foreignStore, ownerAlive: () => false }), 0);
  assert.equal(JSON.parse(await readFile(threadPath, 'utf8')).threads.find(thread => thread.id === live).state, 'RUNNING');
});

test('recovery command closes records owned by a lost runtime process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-recovery-'));
  const executionPath = join(directory, 'execution.json');
  const rolePath = join(directory, 'roles.json');
  const dreamPath = join(directory, 'dream.json');
  const store = createExecutionStateStore({ storagePath: executionPath, ownerPid: 0 });
  await store.load();
  const intent = await store.createIntent({
    runId: 'run-lost-owner',
    capability: 'shell.execute',
    request: { command: 'node -v' },
    snapshotDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    operationId: 'operation-lost-owner'
  });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: 'run-lost-owner',
    intentId: intent.recordId,
    capability: 'shell.execute',
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    snapshotDigest: intent.snapshotDigest,
    expiresAt: Date.now() + 120000,
    operationId: intent.operationId
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(intent.recordId, 'WAITING_APPROVAL');
  const interruptedDream = {
    runId: 'dream-lost-owner',
    projectId: 'project-recovery',
    state: 'RUNNING',
    phase: 'GATHER',
    startedAtMs: 1,
    ownerPid: 424242,
    runtimeInstanceId: 'runtime-lost-owner'
  };
  await writeFile(dreamPath, `${JSON.stringify({
    schemaVersion: '1.0',
    runs: [{ ...interruptedDream, recordDigest: dreamDigest(interruptedDream) }]
  })}\n`, 'utf8');

  const result = await run(['recovery'], {
    DDA_EXECUTION_STATE_STORE: executionPath,
    DDA_ROLE_CONTEXT_STORE: rolePath,
    DDA_DREAM_STORE: dreamPath
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.reconciled, 3);
  assert.equal(payload.execution.records.length, 2);
  assert.deepEqual(payload.execution.records.map((record) => record.state).sort(), ['CANCELLED', 'REJECTED']);
  assert.equal(payload.dream.reconciled, 1);
  assert.equal(payload.dream.runs[0].errorCode, 'DREAM_OWNER_PROCESS_LOST');
  assert.equal(payload.pendingApprovals, 0);
  assert.equal(payload.revokedLeases, 0);

  const persisted = JSON.parse(await readFile(executionPath, 'utf8'));
  assert.deepEqual(persisted.records.map((record) => record.state).sort(), ['CANCELLED', 'REJECTED']);
  const persistedDream = JSON.parse(await readFile(dreamPath, 'utf8'));
  assert.equal(persistedDream.runs[0].state, 'FAILED');
});


test('execution-state CLI exposes digest-checked recovery actions for orphan records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-recovery-actions-'));
  const executionPath = join(directory, 'execution.json');
  const store = createExecutionStateStore({ storagePath: executionPath, ownerPid: 0 });
  const intent = await store.createIntent({ runId: 'run-recovery-actions', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    operationId: intent.operationId
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(intent.recordId, 'WAITING_APPROVAL');
  const pending = store.get(approval.recordId);
  const cancelledResult = await run(['execution-state', '--operation', 'cancel-approval', '--record-id', approval.recordId, '--expected-digest', pending.recordDigest], { DDA_EXECUTION_STATE_STORE: executionPath });
  assert.equal(cancelledResult.code, 0, cancelledResult.stderr);
  assert.equal(JSON.parse(cancelledResult.stdout.trim()).record.state, 'CANCELLED');

  await store.reload();
  const secondIntent = await store.createIntent({ runId: 'run-recovery-actions-lease', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(secondIntent.recordId, 'SAFETY_EVALUATING');
  const secondApproval = await store.createApproval({
    runId: secondIntent.runId,
    intentId: secondIntent.recordId,
    capability: secondIntent.capability,
    requestDigest: secondIntent.requestDigest,
    displayedDigest: secondIntent.requestDigest,
    operationId: secondIntent.operationId
  });
  await store.transition(secondApproval.recordId, 'PRESENTED');
  await store.transition(secondApproval.recordId, 'APPROVED');
  await store.transition(secondIntent.recordId, 'APPROVED');
  await store.transition(secondIntent.recordId, 'EXECUTING');
  const lease = await store.createLease({
    runId: secondIntent.runId,
    intentId: secondIntent.recordId,
    approvalId: secondApproval.recordId,
    capability: secondIntent.capability,
    requestDigest: secondIntent.requestDigest,
    operationId: secondIntent.operationId,
    expiresAt: Date.now() + 30_000
  });
  await store.transition(lease.recordId, 'ACTIVE');
  const activeLease = store.get(lease.recordId);
  const revokedResult = await run(['execution-state', '--operation', 'revoke-lease', '--record-id', lease.recordId, '--expected-digest', activeLease.recordDigest], { DDA_EXECUTION_STATE_STORE: executionPath });
  assert.equal(revokedResult.code, 0, revokedResult.stderr);
  assert.equal(JSON.parse(revokedResult.stdout.trim()).record.state, 'REVOKED');
});
