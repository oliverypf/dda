import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTrajectoryStore } from '../src/trajectory-store.mjs';
const execFileAsync = promisify(execFile);

import {
  createHarnessEventStore,
  harnessDigest,
  stableHarnessStringify
} from '../src/harness-event-store.mjs';

test('assigns per-run sequence and per-aggregate version with durable receipts', async () => {
  const store = createHarnessEventStore({ now: () => 1000, idFactory: (() => { let n = 0; return () => `fixed-${++n}`; })() });
  const first = await store.append({ runId: 'run-a', kind: 'TaskRunCreated', payload: { b: 2, a: 1 }, commandId: 'cmd-1' });
  const second = await store.append({ runId: 'run-b', kind: 'TaskRunCreated', payload: {}, commandId: 'cmd-2' });
  const third = await store.append({ runId: 'run-a', kind: 'TaskRunCompleted', payload: {}, commandId: 'cmd-3' });
  assert.equal(first.event.sequence, 1);
  assert.equal(first.event.aggregateVersion, 1);
  assert.equal(second.event.sequence, 1);
  assert.equal(third.event.sequence, 2);
  assert.equal(third.event.aggregateVersion, 2);
  assert.equal((await store.verify()).ok, true);
  assert.equal(store.getReceipt('cmd-1').status, 'COMMITTED');
  assert.equal(stableHarnessStringify({ a: 1, b: 2 }), stableHarnessStringify({ b: 2, a: 1 }));
  assert.match(harnessDigest({ ok: true }), /^sha256:[0-9a-f]{64}$/);
});

test('is idempotent for the same command and rejects a changed retry', async () => {
  const store = createHarnessEventStore();
  const first = await store.append({ runId: 'run-a', kind: 'ActionRequested', payload: { capability: 'file.write' }, commandId: 'cmd-1' });
  const retry = await store.append({ runId: 'run-a', kind: 'ActionRequested', payload: { capability: 'file.write' }, commandId: 'cmd-1' });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.events[0].eventId, first.event.eventId);
  assert.equal((await store.list({ runId: 'run-a' })).length, 1);
  await assert.rejects(
    store.append({ runId: 'run-a', kind: 'ActionRequested', payload: { capability: 'shell.execute' }, commandId: 'cmd-1' }),
    /HARNESS_COMMAND_IDEMPOTENCY_CONFLICT/
  );
});

test('fails closed on concurrent same-run sequence conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-concurrent-'));
  const storagePath = join(directory, 'harness-events.json');
  const left = createHarnessEventStore({ storagePath });
  const right = createHarnessEventStore({ storagePath });
  await Promise.all([left.load(), right.load()]);
  const results = await Promise.allSettled([
    left.append({ runId: 'run-concurrent', kind: 'First', payload: { side: 'left' } }),
    right.append({ runId: 'run-concurrent', kind: 'First', payload: { side: 'right' } })
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /HARNESS_STORE_CONCURRENT_CONFLICT/);
  const restored = createHarnessEventStore({ storagePath });
  assert.equal((await restored.list({ runId: 'run-concurrent' })).length, 1);
});

test('JSON appendBatch merges independent facades without dropping events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-batch-'));
  const storagePath = join(directory, 'events.json');
  const first = createHarnessEventStore({ storagePath, idFactory: (() => { let n = 0; return () => 'first-' + (++n); })() });
  const second = createHarnessEventStore({ storagePath, idFactory: (() => { let n = 0; return () => 'second-' + (++n); })() });
  await Promise.all([
    first.appendBatch([{ runId: 'batch-a', kind: 'A1', payload: {} }, { runId: 'batch-a', kind: 'A2', payload: {} }]),
    second.appendBatch([{ runId: 'batch-b', kind: 'B1', payload: {} }, { runId: 'batch-b', kind: 'B2', payload: {} }])
  ]);
  const reopened = createHarnessEventStore({ storagePath });
  const events = await reopened.list();
  assert.deepEqual(events.map((event) => event.kind).sort(), ['A1', 'A2', 'B1', 'B2']);
  assert.equal((await reopened.verify()).ok, true);
});

test('JSON appendBatch rejects competing sequence positions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-batch-conflict-'));
  const storagePath = join(directory, 'events.json');
  const first = createHarnessEventStore({ storagePath });
  const second = createHarnessEventStore({ storagePath });
  await second.load();
  await first.appendBatch([{ runId: 'batch-conflict', kind: 'FIRST', payload: {} }]);
  await assert.rejects(
    second.appendBatch([{ runId: 'batch-conflict', kind: 'SECOND', payload: {} }]),
    /HARNESS_STORE_CONCURRENT_CONFLICT/
  );
});

test('SQLite appendBatch commits all events and receipts atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-sqlite-batch-'));
  const storagePath = join(directory, 'events.db');
  const store = createHarnessEventStore({ storagePath });
  const results = await store.appendBatch([
    { runId: 'sqlite-batch', kind: 'BatchStarted', payload: {}, commandId: 'batch-start' },
    { runId: 'sqlite-batch', kind: 'BatchFinished', payload: {}, commandId: 'batch-finish' }
  ]);
  assert.equal(results.length, 2);
  const reopened = createHarnessEventStore({ storagePath });
  assert.deepEqual((await reopened.list({ runId: 'sqlite-batch' })).map((event) => event.kind), ['BatchStarted', 'BatchFinished']);
  assert.equal((await reopened.verify()).ok, true);
  assert.equal(reopened.getReceipt('batch-start').status, 'COMMITTED');
  assert.equal(reopened.getReceipt('batch-finish').status, 'COMMITTED');
});

test('appendBatch rejects empty, oversized, and malformed batches', async () => {
  const store = createHarnessEventStore();
  await assert.rejects(() => store.appendBatch([]), /HARNESS_EVENT_BATCH_INVALID/);
  await assert.rejects(() => store.appendBatch([null]), /HARNESS_EVENT_BATCH_INVALID/);
  await assert.rejects(() => store.appendBatch(Array.from({ length: 129 }, () => ({ runId: 'too-many', kind: 'Event', payload: {} }))), /HARNESS_EVENT_BATCH_INVALID/);
});

test('appendBatch preserves idempotency for repeated commands', async () => {
  const store = createHarnessEventStore();
  const first = await store.appendBatch([{ runId: 'batch-idempotent', kind: 'OnlyOnce', payload: { value: 1 }, commandId: 'batch-once' }]);
  const second = await store.appendBatch([{ runId: 'batch-idempotent', kind: 'OnlyOnce', payload: { value: 1 }, commandId: 'batch-once' }]);
  assert.equal(first[0].receipt.status, 'COMMITTED');
  assert.equal(second[0].idempotent, true);
  assert.equal((await store.list({ runId: 'batch-idempotent' })).length, 1);
});

test('persists, reloads and verifies a self-checking event log', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-store-'));
  const storagePath = join(directory, 'harness-events.json');
  const first = createHarnessEventStore({ storagePath, now: () => 2000 });
  await first.append({ runId: 'run-a', kind: 'WorkspaceSnapshotCreated', payload: { entryCount: 3 } });
  const restored = createHarnessEventStore({ storagePath });
  await restored.load();
  assert.equal((await restored.list({ runId: 'run-a' }))[0].payload.entryCount, 3);
  assert.deepEqual(await restored.verify(), { ok: true, eventCount: 1, receiptCount: 1, tombstoneCount: 0 });
  await restored.append({ runId: 'run-a', kind: 'TaskRunCompleted', payload: {} });
  assert.equal(JSON.parse(await readFile(storagePath + '.backup', 'utf8')).events.length, 1);

  const parsed = JSON.parse(await readFile(storagePath, 'utf8'));
  parsed.events[0].payload.entryCount = 4;
  await writeFile(storagePath, JSON.stringify(parsed), 'utf8');
  const tampered = createHarnessEventStore({ storagePath });
  await assert.rejects(tampered.load(), /HARNESS_STORE_INVALID_EVENT/);
});

test('purges a run, persists a minimal tombstone, and rejects late events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-purge-'));
  const storagePath = join(directory, 'harness-events.json');
  const store = createHarnessEventStore({ storagePath });
  await store.append({ runId: 'run-delete', kind: 'TaskRunCreated', payload: { titleDigest: harnessDigest('title') }, commandId: 'delete-1' });
  await store.append({ runId: 'run-delete', kind: 'TaskRunCompleted', payload: {}, commandId: 'delete-2' });
  await store.append({ runId: 'run-keep', kind: 'TaskRunCreated', payload: {}, commandId: 'keep-1' });
  const purged = await store.purgeRun('run-delete', { reason: 'USER_DELETE' });
  assert.equal(purged.status, 'COMMITTED');
  assert.equal(purged.purgedEventCount, 2);
  assert.equal((await store.list({ runId: 'run-delete' })).length, 0);
  assert.equal((await store.list({ runId: 'run-keep' })).length, 1);
  await assert.rejects(() => store.append({ runId: 'run-delete', kind: 'LateEvent', payload: {} }), /HARNESS_RUN_TOMBSTONED/);
  const repeated = await store.purgeRun('run-delete', { reason: 'different reason' });
  assert.equal(repeated.idempotent, true);
  const reopened = createHarnessEventStore({ storagePath });
  await reopened.load();
  assert.deepEqual(await reopened.verify(), { ok: true, eventCount: 1, receiptCount: 1, tombstoneCount: 1 });
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(persisted.tombstones.length, 1);
  assert.equal(Object.hasOwn(persisted.tombstones[0], 'reason'), false);
  assert.equal(JSON.stringify(persisted).includes('USER_DELETE'), false);
});

test('imports legacy events with an explicit source reference', async () => {
  const store = createHarnessEventStore();
  const imported = await store.importLegacyEvents([{
    eventId: 'legacy-event-1',
    recordDigest: harnessDigest({ legacy: true }),
    runId: 'run-legacy',
    kind: 'TaskRunCreated',
    payload: { source: 'redacted' }
  }]);
  assert.equal(imported[0].event.sourceRef.store, 'trajectory-jsonl');
  assert.equal(imported[0].event.sourceRef.eventId, 'legacy-event-1');
  assert.equal((await store.verify()).ok, true);
  await assert.rejects(store.importLegacyEvents([{ runId: 'run-legacy', kind: 'Bad', payload: {} }]), /HARNESS_IMPORT_SOURCE_ID_REQUIRED/);
});

test('rejects malformed stores, invalid input and oversized events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-invalid-'));
  const storagePath = join(directory, 'harness-events.json');
  await writeFile(storagePath, '{not-json', 'utf8');
  await assert.rejects(createHarnessEventStore({ storagePath }).load(), /HARNESS_STORE_READ_FAILED/);
  const store = createHarnessEventStore();
  await assert.rejects(store.append({ runId: 'run-a' }), /HARNESS_EVENT_INPUT_INVALID/);
  await assert.rejects(store.append({ runId: 'run-a', kind: 'Large', payload: { text: 'x'.repeat(200_000) } }), /HARNESS_EVENT_TOO_LARGE/);
});


test('retention purge rejects invalid batch limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-retention-limit-'));
  const harnessPath = join(directory, 'events.json');
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const invoke = (args) => execFileAsync(process.execPath, [entry, 'harness-events', ...args], { windowsHide: true });
  const invalidLimit = (error) => error?.stderr?.includes('RETENTION_PURGE_LIMIT_INVALID') || error?.stdout?.includes('RETENTION_PURGE_LIMIT_INVALID');
  await assert.rejects(invoke(['retention', '--purge-expired', '--purge-limit', '0', '--harness-event-store', harnessPath]), invalidLimit);
  await assert.rejects(invoke(['retention', '--purge-expired', '--purge-limit', '1.5', '--harness-event-store', harnessPath]), invalidLimit);
});

test('retention purge limit leaves remaining expired runs for retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-retention-batch-'));
  const harnessPath = join(directory, 'events.json');
  const store = createHarnessEventStore({ storagePath: harnessPath, now: () => 100 });
  await store.load();
  await store.append({ runId: 'expired-a', kind: 'TaskRunCreated', payload: {}, commandId: 'retention-a' });
  await store.append({ runId: 'expired-b', kind: 'TaskRunCreated', payload: {}, commandId: 'retention-b' });
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const invoke = async (...args) => JSON.parse((await execFileAsync(process.execPath, [entry, 'harness-events', ...args], { windowsHide: true })).stdout);
  const first = await invoke('retention', '--retention-ms', '0', '--purge-expired', '--purge-limit', '1', '--now-ms', '100', '--harness-event-store', harnessPath);
  assert.equal(first.expiredCount, 2);
  assert.equal(first.purgedCount, 1);
  assert.equal(first.remainingExpiredCount, 1);
  const second = await invoke('retention', '--retention-ms', '0', '--purge-expired', '--purge-limit', '1', '--now-ms', '100', '--harness-event-store', harnessPath);
  assert.equal(second.purgedCount, 1);
  assert.equal(second.remainingExpiredCount, 0);
});

test('CLI imports, verifies and lists legacy events through the Harness store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-harness-cli-'));
  const sourcePath = join(directory, 'trajectory.jsonl');
  const harnessPath = join(directory, 'harness-events.json');
  const legacy = await createTrajectoryStore(sourcePath).append({
    runId: 'run-cli',
    kind: 'TaskRunCreated',
    payload: { status: 'redacted' }
  });
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const invoke = async (...args) => JSON.parse((await execFileAsync(process.execPath, [entry, 'harness-events', ...args], { cwd: process.cwd() })).stdout);
  const imported = await invoke('import', '--source', sourcePath, '--harness-event-store', harnessPath);
  assert.equal(imported.ok, true);
  assert.equal(imported.importedCount, 1);
  const verified = await invoke('verify', '--harness-event-store', harnessPath);
  assert.deepEqual(verified.verification, { ok: true, eventCount: 1, receiptCount: 1, tombstoneCount: 0 });
  const listed = await invoke('list', '--run-id', 'run-cli', '--harness-event-store', harnessPath);
  assert.equal(listed.events.length, 1);
  assert.deepEqual(listed.events[0].sourceRef, {
    store: 'trajectory-jsonl',
    eventId: legacy.eventId,
    recordDigest: legacy.recordDigest
  });
  const retention = await invoke('retention', '--harness-event-store', harnessPath);
  assert.equal(retention.runs[0].retentionUntilMs > retention.runs[0].lastEventAtMs, true);
  const beforeDelete = await invoke('verify', '--harness-event-store', harnessPath);
  assert.deepEqual(beforeDelete.verification, { ok: true, eventCount: 1, receiptCount: 1, tombstoneCount: 0 });
  const readModelPath = join(directory, 'read-model.json');
  const purged = await invoke('retention', '--retention-ms', '0', '--purge-expired', '--now-ms', String(Date.now()), '--read-model', readModelPath, '--harness-event-store', harnessPath);
  assert.equal(purged.ok, true);
  assert.match(purged.projectionChecksum, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(purged.expiredCount, 1);
  assert.equal(purged.purgedCount, 1);
  assert.equal(purged.remainingExpiredCount, 0);
  assert.equal(purged.purged.length, 1);
  const afterPurge = await invoke('verify', '--harness-event-store', harnessPath);
  assert.deepEqual(afterPurge.verification, { ok: true, eventCount: 0, receiptCount: 0, tombstoneCount: 1 });
});

test('a failed append does not poison subsequent reads', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-read', kind: 'Observed', commandId: 'cmd-read' });
  await store.purgeRun('run-read');
  await assert.rejects(store.append({ runId: 'run-read', kind: 'Observed' }), /HARNESS_RUN_TOMBSTONED/);
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await store.listDeletedRunIds(), ['run-read']);
  assert.equal((await store.verify()).ok, true);
});
