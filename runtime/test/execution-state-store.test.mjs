import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

test('persists intent approval and one-shot lease lifecycle summaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-execution-state-'));
  const storagePath = join(directory, 'execution.json');
  const store = createExecutionStateStore({ storagePath });
  const intent = await store.createIntent({ runId: 'run-1', capability: 'shell.execute', request: { command: 'node', args: ['-e', 'ok'], cwd: '.' }, snapshotDigest: 'sha256:test' });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({ runId: 'run-1', intentId: intent.recordId, capability: 'shell.execute', requestDigest: intent.requestDigest, displayedDigest: intent.requestDigest });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(intent.recordId, 'WAITING_APPROVAL');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');
  const lease = await store.createLease({ runId: 'run-1', intentId: intent.recordId, approvalId: approval.recordId, capability: 'shell.execute', commands: ['node'], expiresAt: Date.now() + 1000 });
  await store.transition(lease.recordId, 'ACTIVE');
  await store.transition(lease.recordId, 'CONSUMING');
  await store.transition(lease.recordId, 'CONSUMED');
  await store.transition(intent.recordId, 'EXECUTING');
  await store.transition(intent.recordId, 'COMPLETED');
  const reopened = createExecutionStateStore({ storagePath });
  await reopened.load();
  assert.equal(reopened.get(intent.recordId).state, 'COMPLETED');
  assert.equal(reopened.get(approval.recordId).state, 'APPROVED');
  assert.equal(reopened.get(lease.recordId).state, 'CONSUMED');
  const persisted = await readFile(storagePath, 'utf8');
  assert.doesNotMatch(persisted, /"-e"|"ok"/);
});

test('commits execution state changes into the Harness Event Store without raw request content', async () => {
  const eventStore = createHarnessEventStore();
  const store = createExecutionStateStore({ eventStore });
  const intent = await store.createIntent({ runId: 'run-harness-state', capability: 'shell.execute', request: { command: 'node', args: ['-e', 'secret'] } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const events = await eventStore.list({ runId: 'run-harness-state' });
  assert.deepEqual(events.map((event) => event.kind), ['ExecutionStateChanged', 'ExecutionStateChanged']);
  assert.equal(events[0].payload.state, 'PROPOSED');
  assert.equal(events[1].payload.state, 'SAFETY_EVALUATING');
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test('rejects a non-committed execution receipt before exposing an intent', async () => {
  const store = createExecutionStateStore({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(
    store.createIntent({ runId: 'run-uncommitted', capability: 'shell.execute', request: { command: 'node' } }),
    /DURABLE_COMMIT_REQUIRED/
  );
  assert.equal(store.list('intent').length, 0);
});

test('rejects illegal lifecycle transitions', async () => {
  const store = createExecutionStateStore();
  const intent = await store.createIntent({ runId: 'run-2', capability: 'file.write', request: { path: 'result.txt', content: 'secret' } });
  await assert.rejects(() => store.transition(intent.recordId, 'COMPLETED'), /EXECUTION_STATE_INVALID_TRANSITION/);
});

test('reconciles only records whose owner process is no longer alive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-execution-reconcile-'));
  const storagePath = join(directory, 'execution.json');
  const ownerPid = 424242;
  const store = createExecutionStateStore({ storagePath, ownerPid, runtimeInstanceId: 'runtime-crashed' });
  const intent = await store.createIntent({
    runId: 'run-crashed',
    capability: 'shell.execute',
    request: { command: 'node', args: ['--version'] },
    scope: { workspace: 'fixture' },
    bindingSnapshot: { executor: 'windows-restricted' },
    executorIdentity: 'windows-restricted'
  });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: 'run-crashed', intentId: intent.recordId, capability: 'shell.execute',
    requestDigest: intent.requestDigest, displayedDigest: intent.requestDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(intent.recordId, 'WAITING_APPROVAL');

  const liveResult = await store.reconcile({ isOwnerAlive: () => true });
  assert.equal(liveResult.reconciled, 0);
  assert.equal(store.get(intent.recordId).state, 'WAITING_APPROVAL');

  const crashedResult = await store.reconcile({ isOwnerAlive: () => false });
  assert.equal(crashedResult.reconciled, 2);
  assert.equal(store.get(intent.recordId).state, 'REJECTED');
  assert.equal(store.get(approval.recordId).state, 'CANCELLED');
  assert.equal(intent.operationId.startsWith('operation-'), true);
  assert.match(intent.scopeDigest, /^sha256:/);
  assert.match(intent.bindingSnapshotDigest, /^sha256:/);
  assert.equal(intent.executorIdentity, 'windows-restricted');
});

test('claims a persisted lease exactly once and reconciles uncertain execution', async () => {
  const store = createExecutionStateStore({ ownerPid: 424243, runtimeInstanceId: 'runtime-crashed' });
  const intent = await store.createIntent({ runId: 'run-lease', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: 'run-lease', intentId: intent.recordId, capability: 'shell.execute',
    requestDigest: intent.requestDigest, displayedDigest: intent.requestDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'EXECUTING');
  const lease = await store.createLease({
    runId: 'run-lease', intentId: intent.recordId, approvalId: approval.recordId,
    capability: 'shell.execute', requestDigest: intent.requestDigest, expiresAt: Date.now() + 30_000
  });
  await store.transition(lease.recordId, 'ACTIVE');
  await store.claimLease(lease.recordId, { requestDigest: intent.requestDigest, operationId: intent.operationId });
  await assert.rejects(() => store.claimLease(lease.recordId), /EXECUTION_LEASE_NOT_ACTIVE:CONSUMING/);
  const result = await store.reconcile({ isOwnerAlive: () => false });
  assert.equal(result.records.some((record) => record.recordId === lease.recordId && record.state === 'REVOKED'), true);
  assert.equal(store.get(intent.recordId).state, 'FAILED');
});

test('rejects a stale cross-process record mutation with an optimistic digest check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-execution-conflict-'));
  const storagePath = join(directory, 'execution.json');
  const first = createExecutionStateStore({ storagePath, runtimeInstanceId: 'runtime-first' });
  const intent = await first.createIntent({ runId: 'run-conflict', capability: 'shell.execute', request: { command: 'node' } });

  const second = createExecutionStateStore({ storagePath, runtimeInstanceId: 'runtime-second' });
  await second.load();
  await first.transition(intent.recordId, 'SAFETY_EVALUATING');

  await assert.rejects(
    () => second.transition(intent.recordId, 'SAFETY_EVALUATING'),
    /EXECUTION_STATE_CONFLICT/
  );
  assert.equal(second.get(intent.recordId).state, 'PROPOSED');
  await second.reload();
  assert.equal(second.get(intent.recordId).state, 'SAFETY_EVALUATING');
});

test('rejects a persisted approval whose intent reference is missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-execution-reference-'));
  const storagePath = join(directory, 'execution.json');
  const store = createExecutionStateStore({ storagePath });
  const intent = await store.createIntent({ runId: 'run-reference', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  await store.createApproval({
    runId: 'run-reference',
    intentId: intent.recordId,
    capability: 'shell.execute',
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest
  });
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  persisted.records = persisted.records.filter((record) => record.recordId !== intent.recordId);
  await writeFile(storagePath, `${JSON.stringify(persisted)}\n`, 'utf8');

  const reopened = createExecutionStateStore({ storagePath });
  await assert.rejects(() => reopened.load(), /EXECUTION_STATE_INVALID_REFERENCE/);
});

test('binds approvals and leases to the persisted channel and capability snapshot', async () => {
  const store = createExecutionStateStore();
  const capabilitySnapshot = { releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED', capabilities: ['shell.execute'], commands: ['node'] };
  const intent = await store.createIntent({
    runId: 'run-channel',
    capability: 'shell.execute',
    request: { command: 'node' },
    capabilitySnapshot,
    releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED'
  });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');

  await assert.rejects(() => store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    capabilitySnapshot,
    releaseChannel: 'WINDOWS_PHASE1_READ_ONLY'
  }), /EXECUTION_RELEASE_CHANNEL_MISMATCH/);

  const approval = await store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    capabilitySnapshot,
    releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED'
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');

  await assert.rejects(() => store.createLease({
    runId: intent.runId,
    intentId: intent.recordId,
    approvalId: approval.recordId,
    capability: intent.capability,
    capabilitySnapshot,
    releaseChannel: 'WINDOWS_FULL_LOCAL',
    expiresAt: Date.now() + 10_000
  }), /EXECUTION_RELEASE_CHANNEL_MISMATCH/);

  const lease = await store.createLease({
    runId: intent.runId,
    intentId: intent.recordId,
    approvalId: approval.recordId,
    capability: intent.capability,
    commands: ['node'],
    expiresAt: Date.now() + 10_000
  });
  assert.equal(lease.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.equal(lease.capabilitySnapshotDigest, intent.capabilitySnapshotDigest);
  assert.equal(approval.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
});

test('rejects unbound approval and lease requests before exposing them in memory', async () => {
  const store = createExecutionStateStore();
  const intent = await store.createIntent({
    runId: 'run-binding',
    capability: 'shell.execute',
    request: { command: 'node' },
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    operationId: 'operation-binding'
  });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');

  await assert.rejects(() => store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: 'sha256:forged'
  }), /EXECUTION_DISPLAY_DIGEST_MISMATCH/);
  assert.equal(store.list('approval').length, 0);

  const approval = await store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    snapshotDigest: intent.snapshotDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');

  await assert.rejects(() => store.createLease({
    runId: intent.runId,
    intentId: intent.recordId,
    approvalId: approval.recordId,
    capability: intent.capability,
    commands: [42],
    expiresAt: Date.now() + 10_000
  }), /EXECUTION_LEASE_COMMANDS_INVALID/);
  assert.equal(store.list('lease').length, 0);

  await store.transition(intent.recordId, 'EXECUTING');
  const lease = await store.createLease({
    runId: intent.runId,
    intentId: intent.recordId,
    approvalId: approval.recordId,
    capability: intent.capability,
    expiresAt: Date.now() + 10_000
  });
  assert.equal(lease.state, 'PROPOSED');
});

async function createApprovalLeaseFlow({ store, runId, capability = 'shell.execute', commands } = {}) {
  const intent = await store.createIntent({ runId, capability, request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId, intentId: intent.recordId, capability,
    requestDigest: intent.requestDigest, displayedDigest: intent.requestDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'EXECUTING');
  const leaseOptions = {
    runId, intentId: intent.recordId, approvalId: approval.recordId,
    capability, requestDigest: intent.requestDigest, expiresAt: Date.now() + 30_000
  };
  if (commands) leaseOptions.commands = commands;
  const lease = await store.createLease(leaseOptions);
  await store.transition(lease.recordId, 'ACTIVE');
  return { intent, approval, lease };
}

test('transitions an expired lease to EXPIRED and rejects all subsequent claims', async () => {
  const store = createExecutionStateStore();
  const intent = await store.createIntent({ runId: 'run-expiry-fault', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: intent.runId, intentId: intent.recordId, capability: intent.capability,
    requestDigest: intent.requestDigest, displayedDigest: intent.requestDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(approval.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'APPROVED');
  await store.transition(intent.recordId, 'EXECUTING');
  const lease = await store.createLease({
    runId: intent.runId, intentId: intent.recordId, approvalId: approval.recordId,
    capability: intent.capability, requestDigest: intent.requestDigest, expiresAt: Date.now() + 50
  });
  await store.transition(lease.recordId, 'ACTIVE');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    () => store.claimLease(lease.recordId),
    /EXECUTION_LEASE_EXPIRED/
  );
  assert.equal(store.get(lease.recordId).state, 'EXPIRED');
});

test('rejects a claim on a revoked lease and expireLeases does not reactivate it', async () => {
  const store = createExecutionStateStore();
  const { lease } = await createApprovalLeaseFlow({ store, runId: 'run-revoke-fault' });
  await store.revokeLease(lease.recordId, 'POLICY_TIGHTENED');
  assert.equal(store.get(lease.recordId).state, 'REVOKED');
  await assert.rejects(
    () => store.claimLease(lease.recordId),
    /EXECUTION_LEASE_NOT_ACTIVE:REVOKED/
  );
  const expiredBatch = await store.expireLeases(Date.now() + 60_000);
  assert.equal(expiredBatch.some((record) => record.recordId === lease.recordId), false);
  assert.equal(store.get(lease.recordId).state, 'REVOKED');
});

test('rejects a stale claim after a lease has been consumed by the original executor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-execution-double-spend-'));
  const storagePath = join(directory, 'execution.json');
  const first = createExecutionStateStore({ storagePath, runtimeInstanceId: 'runtime-a' });
  const { intent, lease } = await createApprovalLeaseFlow({ store: first, runId: 'run-double-spend' });
  await first.claimLease(lease.recordId, { requestDigest: intent.requestDigest, operationId: intent.operationId });
  await first.completeLease(lease.recordId, { ok: true });
  assert.equal(first.get(lease.recordId).state, 'CONSUMED');

  const second = createExecutionStateStore({ storagePath, runtimeInstanceId: 'runtime-b' });
  await second.load();
  await assert.rejects(
    () => second.claimLease(lease.recordId),
    /EXECUTION_LEASE_NOT_ACTIVE:CONSUMED/
  );
  assert.equal(second.get(lease.recordId).state, 'CONSUMED');
});

test('rejects a claim with mismatched request digest or operation identity', async () => {
  const store = createExecutionStateStore();
  const { intent, lease } = await createApprovalLeaseFlow({ store, runId: 'run-identity-fault' });
  await assert.rejects(
    () => store.claimLease(lease.recordId, { requestDigest: `sha256:${'b'.repeat(64)}` }),
    /EXECUTION_LEASE_DIGEST_MISMATCH/
  );
  await assert.rejects(
    () => store.claimLease(lease.recordId, { operationId: 'operation-forged' }),
    /EXECUTION_LEASE_OPERATION_MISMATCH/
  );
  assert.equal(store.get(lease.recordId).state, 'ACTIVE');
});


test('cancels only orphaned pending approvals with an expected record digest', async () => {
  const store = createExecutionStateStore({ ownerPid: 424242 });
  const intent = await store.createIntent({ runId: 'run-recovery-approval', capability: 'shell.execute', request: { command: 'node' } });
  await store.transition(intent.recordId, 'SAFETY_EVALUATING');
  const approval = await store.createApproval({
    runId: intent.runId,
    intentId: intent.recordId,
    capability: intent.capability,
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest
  });
  await store.transition(approval.recordId, 'PRESENTED');
  await store.transition(intent.recordId, 'WAITING_APPROVAL');
  const pending = store.get(approval.recordId);
  await assert.rejects(
    () => store.cancelOrphanedApproval(approval.recordId, { expectedDigest: 'sha256:' + '0'.repeat(64), isOwnerAlive: () => false }),
    /EXECUTION_STATE_CONFLICT/
  );
  await assert.rejects(
    () => store.cancelOrphanedApproval(approval.recordId, { expectedDigest: pending.recordDigest, isOwnerAlive: () => true }),
    /EXECUTION_APPROVAL_OWNER_ALIVE/
  );
  const cancelled = await store.cancelOrphanedApproval(approval.recordId, { expectedDigest: pending.recordDigest, reason: 'USER_RECOVERY_CANCELLED', isOwnerAlive: () => false });
  assert.equal(cancelled.state, 'CANCELLED');
  assert.equal(store.get(approval.recordId).state, 'CANCELLED');
});

test('revokes a lease only when the recovery action still targets the observed record', async () => {
  const store = createExecutionStateStore();
  const { lease } = await createApprovalLeaseFlow({ store, runId: 'run-recovery-lease' });
  const observed = store.get(lease.recordId);
  await assert.rejects(
    () => store.revokeLeaseWithDigest(lease.recordId, { expectedDigest: 'sha256:' + 'f'.repeat(64) }),
    /EXECUTION_STATE_CONFLICT/
  );
  const revoked = await store.revokeLeaseWithDigest(lease.recordId, { expectedDigest: observed.recordDigest, reason: 'USER_RECOVERY_REVOKED' });
  assert.equal(revoked.state, 'REVOKED');
  assert.equal(store.get(lease.recordId).transition.metadata.reason, 'USER_RECOVERY_REVOKED');
});
