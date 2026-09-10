import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrajectoryStore, sha256Digest, parseLegacyTrajectoryEvents } from '../src/trajectory-store.mjs';

test('legacy parsing rejects missing, repeated and out-of-order facts with valid individual digests', async () => {
  const store = createTrajectoryStore();
  const first = await store.append({ runId: 'one', kind: 'First' });
  const second = await store.append({ runId: 'one', kind: 'Second' });
  const other = await store.append({ runId: 'two', kind: 'First' });
  const encode = (events) => events.map((event) => JSON.stringify(event)).join('\n');
  for (const events of [[second], [first, first], [second, first], [first, second, second]]) {
    assert.throws(() => parseLegacyTrajectoryEvents(encode(events)), /TRAJECTORY_INVALID_EVENT/);
  }
  assert.equal(parseLegacyTrajectoryEvents(encode([first, other, second])).length, 3);
});

test('failed legacy initialization remains fail-closed on repeated append', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-trajectory-retry-'));
  const path = join(directory, 'trajectory.jsonl');
  await writeFile(path, 'corrupted history\n');
  const store = createTrajectoryStore(path);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(store.append({ runId: 'one', kind: 'First' }), /TRAJECTORY_INVALID_EVENT/);
  }
  assert.equal(await readFile(path, 'utf8'), 'corrupted history\n');
});

test('Harness trajectory adapter requires a matching commit receipt', async () => {
  for (const result of [undefined, { event: { eventId: 'one' } }, {
    receipt: { status: 'COMMITTED', eventIds: ['one'] },
    event: { eventId: 'one', runId: 'other', kind: 'First' }
  }]) {
    const store = createTrajectoryStore(undefined, { harnessEventStore: { append: async () => result } });
    await assert.rejects(store.append({ runId: 'run', kind: 'First' }), /DURABLE_COMMIT_REQUIRED/);
  }
});

test('appends redacted events with per-run sequences and resumes after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-trajectory-'));
  const path = join(directory, 'trajectory.jsonl');
  const store = createTrajectoryStore(path);
  await store.append({
    runId: 'run-one',
    kind: 'TaskRunCreated',
    payload: { promptDigest: sha256Digest('private prompt'), requestedMode: 'READ_ONLY' },
    sensitivity: 'SENSITIVE'
  });
  await Promise.all([
    store.append({ runId: 'run-one', kind: 'ModelRouteResolved', payload: { model: 'fixture' } }),
    store.append({ runId: 'run-one', kind: 'WorkspaceSnapshotCreated', payload: { entryCount: 2 } }),
    store.append({ runId: 'run-two', kind: 'TaskRunCreated', payload: { requestedMode: 'READ_ONLY' } })
  ]);

  const events = await store.list();
  assert.equal(events.length, 4);
  assert.deepEqual(events.filter((event) => event.runId === 'run-one').map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events.find((event) => event.runId === 'run-one')?.redactionState, 'REDACTED');
  assert.equal(events.some((event) => JSON.stringify(event).includes('private prompt')), false);
  assert.match(events[0].payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(events[0].recordDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(events[0].protocolVersion, '1.0');
  assert.equal(events[0].storageSchemaVersion, 1);
  assert.equal(events[0].appVersion, '0.1.0');
  assert.equal(events[0].policyVersion, 'runtime-safety-1');
  assert.equal(events[0].producerVersion, 'hmcodex-runtime@0.1.0');
  assert.deepEqual(store.summary(), { store: 'PERSISTED', eventCount: 4 });

  const reopened = createTrajectoryStore(path);
  await reopened.append({ runId: 'run-one', kind: 'TaskRunCompleted', payload: { outputDigest: sha256Digest('result') } });
  assert.equal((await reopened.list('run-one')).at(-1)?.sequence, 4);
  assert.equal((await readFile(path, 'utf8')).trim().split(/\r?\n/).length, 5);
});

test('can switch the trajectory facade to the durable Harness Event Store backend', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-trajectory-harness-'));
  const store = createTrajectoryStore(undefined, { harnessStoragePath: join(directory, 'harness-events.json') });
  const first = await store.append({ runId: 'run-harness', kind: 'TaskRunCreated', payload: { mode: 'READ_ONLY' } });
  const second = await store.append({ runId: 'run-harness', kind: 'TaskRunCompleted', payload: {} });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.deepEqual(store.summary(), { store: 'PERSISTED', eventCount: 2 });
  const reopened = createTrajectoryStore(undefined, { harnessStoragePath: join(directory, 'harness-events.json') });
  assert.equal((await reopened.list('run-harness')).length, 2);
  assert.equal((await reopened.harnessEventStore.verify()).ok, true);
});

test('SQLite trajectory retries return the original committed event without adding facts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-trajectory-receipt-'));
  const harnessStoragePath = join(directory, 'hmcodex.db');
  const input = { runId: 'retry', kind: 'First', commandId: 'repeat-command', payload: { status: 'READY' } };
  const store = createTrajectoryStore(undefined, { harnessStoragePath });
  const first = await store.append(input);
  const reopened = createTrajectoryStore(undefined, { harnessStoragePath });
  assert.deepEqual(await reopened.append(input), first);
  assert.equal((await reopened.list('retry')).length, 1);
  const mismatched = createTrajectoryStore(undefined, { harnessEventStore: { append: async () => ({
    event: { ...first, payload: { status: 'DIFFERENT' } },
    receipt: { status: 'COMMITTED', commandId: input.commandId, eventIds: [first.eventId] }
  }) } });
  await assert.rejects(mismatched.append(input), /DURABLE_COMMIT_REQUIRED/);
});

test('preserves bounded operation and causation metadata in trajectory events', async () => {
  const store = createTrajectoryStore(undefined);
  const event = await store.append({
    runId: 'run-metadata',
    kind: 'ApprovalResolved',
    operationId: 'operation-1',
    correlationId: 'correlation-1',
    causationId: 'event-parent',
    protocolVersion: '1.1',
    storageSchemaVersion: 2,
    appVersion: '0.2.0',
    policyVersion: 'runtime-safety-2',
    producerVersion: 'provider-adapter@2.0.0',
    payload: { state: 'APPROVED' }
  });
  assert.deepEqual({
    operationId: event.operationId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    protocolVersion: event.protocolVersion,
    storageSchemaVersion: event.storageSchemaVersion,
    appVersion: event.appVersion,
    policyVersion: event.policyVersion,
    producerVersion: event.producerVersion
  }, {
    operationId: 'operation-1',
    correlationId: 'correlation-1',
    causationId: 'event-parent',
    protocolVersion: '1.1',
    storageSchemaVersion: 2,
    appVersion: '0.2.0',
    policyVersion: 'runtime-safety-2',
    producerVersion: 'provider-adapter@2.0.0'
  });
});

test('adapts a persisted trajectory record to the canonical harness envelope', async () => {
  const store = createTrajectoryStore(undefined);
  const record = await store.append({
    runId: 'run-adapter',
    kind: 'ApprovalResolved',
    actorType: 'runtime',
    actorId: 'runtime-test',
    correlationId: 'operation-correlation',
    payload: { state: 'APPROVED' }
  });
  const event = store.toHarnessEvent(record);
  assert.deepEqual({
    eventId: event.eventId,
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
    aggregateVersion: event.aggregateVersion,
    correlationId: event.correlationId,
    actorType: event.actorType,
    actorId: event.actorId,
    protocolVersion: event.protocolVersion,
    storageSchemaVersion: event.storageSchemaVersion,
    policyVersion: event.policyVersion,
    producerVersion: event.producerVersion
  }, {
    eventId: record.eventId,
    schemaVersion: '1.0',
    runId: 'run-adapter',
    aggregateType: 'TaskRun',
    aggregateId: 'run-adapter',
    sequence: 1,
    aggregateVersion: 1,
    correlationId: 'operation-correlation',
    actorType: 'SYSTEM',
    actorId: 'runtime-test',
    protocolVersion: '1.0',
    storageSchemaVersion: 1,
    policyVersion: 'runtime-safety-1',
    producerVersion: 'hmcodex-runtime@0.1.0'
  });
  assert.match(event.payloadDigest, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => store.toHarnessEvent({ ...record, payloadDigest: 'invalid' }), /HARNESS_EVENT_PAYLOAD_DIGEST_INVALID/);
});

test('rejects a tampered persisted event digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-trajectory-tampered-'));
  const path = join(directory, 'trajectory.jsonl');
  const store = createTrajectoryStore(path);
  await store.append({ runId: 'run-one', kind: 'TaskRunCreated', payload: { requestedMode: 'READ_ONLY' } });
  const raw = await readFile(path, 'utf8');
  const event = JSON.parse(raw);
  event.payload.requestedMode = 'CONTROLLED_WRITE';
  const { recordDigest: _recordDigest, ...unsigned } = event;
  event.recordDigest = sha256Digest(JSON.stringify(unsigned));
  await writeFile(path, `${JSON.stringify(event)}\n`);
  await assert.rejects(createTrajectoryStore(path).append({
    runId: 'run-one', kind: 'TaskRunCompleted', payload: {}
  }), /TRAJECTORY/);
});

test('supports an in-memory store when no data directory is available', async () => {
  const store = createTrajectoryStore(undefined);
  await store.append({ runId: 'run-memory', kind: 'TaskRunCreated', payload: {} });
  assert.deepEqual(store.summary(), { store: 'MEMORY_ONLY', eventCount: 1 });
  assert.equal((await store.list('run-memory')).length, 1);
});
