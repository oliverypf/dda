import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { dreamDigest } from '../src/dream-scheduler.mjs';

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

test('recovery records a Git observer checkpoint in the Harness Store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-runtime-recovery-git-'));
  const harnessPath = join(directory, 'harness-events.json');
  const auditPath = join(directory, 'git-audit.json');
  const result = await run(['recovery', '--workspace', directory, '--harness-event-store', harnessPath, '--audit-store', auditPath, '--run-id', 'recovery-git'], {});
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  const events = JSON.parse(await readFile(harnessPath, 'utf8')).events;
  assert.deepEqual(events.map((event) => event.kind), ['RecoveryStarted', 'GitStateObserved', 'RecoveryCompleted']);
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  assert.equal(audit.checkpoints.length, 1);
  assert.equal(audit.checkpoints[0].checkpointKind, 'RECOVERY');
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
    HMCODEX_EXECUTION_STATE_STORE: executionPath,
    HMCODEX_ROLE_CONTEXT_STORE: rolePath,
    HMCODEX_DREAM_STORE: dreamPath
  });
  assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.reconciled, 3);
  assert.equal(payload.execution.records.length, 2);
  assert.deepEqual(payload.execution.records.map((record) => record.state).sort(), ['CANCELLED', 'REJECTED']);
  assert.equal(payload.dream.reconciled, 1);
  assert.equal(payload.dream.runs[0].errorCode, 'DREAM_OWNER_PROCESS_LOST');

  const persisted = JSON.parse(await readFile(executionPath, 'utf8'));
  assert.deepEqual(persisted.records.map((record) => record.state).sort(), ['CANCELLED', 'REJECTED']);
  const persistedDream = JSON.parse(await readFile(dreamPath, 'utf8'));
  assert.equal(persistedDream.runs[0].state, 'FAILED');
});
