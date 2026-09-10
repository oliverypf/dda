import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskRunCoordinator } from '../src/task-run-coordinator.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const tempStore = async (name = 'hmcodex-run-') => join(await mkdtemp(join(tmpdir(), name)), 'run.json');

test('task run coordinator persists and restores state, events, and command receipts', async () => {
  const storagePath = await tempStore();
  const first = new TaskRunCoordinator({ storagePath, runId: 'run-persisted' });
  await first.load();
  const initial = first.transition('PLANNING', { expectedVersion: 0, commandId: 'plan-1', reason: 'start' });
  const replay = first.transition('PLANNING', { expectedVersion: 0, commandId: 'plan-1', reason: 'start' });
  assert.equal(initial.version, 1);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.event, initial.event);
  assert.throws(() => first.transition('PLANNING', { commandId: 'plan-1', reason: 'different' }), /IDEMPOTENCY_CONFLICT/);
  first.recordEvent('coordinator.checkpoint', { safe: true }, { commandId: 'event-1' });
  await first.flush();

  const restored = new TaskRunCoordinator({ storagePath, runId: 'run-persisted' });
  const snapshot = await restored.load();
  assert.equal(snapshot.state, 'PLANNING');
  assert.equal(snapshot.version, 1);
  assert.equal(restored.history.length, 1);
  assert.equal(restored.events.length, 2);
  assert.equal(restored.getReceipt('plan-1').version, 1);
  const continued = restored.transition('EXECUTING', { expectedVersion: 1 });
  assert.equal(continued.state, 'EXECUTING');
  await restored.flush();
  assert.match(await readFile(storagePath, 'utf8'), /"recordDigest":"sha256:/);
});

test('coordinator rejects mutations before loading a persisted store and detects stale versions', async () => {
  const storagePath = await tempStore();
  const coordinator = new TaskRunCoordinator({ storagePath, runId: 'run-load-first' });
  assert.throws(() => coordinator.transition('PLANNING'), /RUN_NOT_LOADED/);
  await coordinator.load();
  coordinator.transition('PLANNING');
  assert.throws(() => coordinator.transition('EXECUTING', { expectedVersion: 0 }), /RUN_STALE_VERSION/);
});

test('coordinator uses an optimistic persisted version to reject concurrent writers', async () => {
  const storagePath = await tempStore();
  const first = new TaskRunCoordinator({ storagePath, runId: 'run-conflict' });
  const second = new TaskRunCoordinator({ storagePath, runId: 'run-conflict' });
  await Promise.all([first.load(), second.load()]);
  first.transition('PLANNING');
  await first.flush();
  second.transition('PLANNING');
  await assert.rejects(() => second.flush(), /RUN_STORAGE_CONFLICT/);
  const recovered = await second.reload();
  assert.equal(recovered.state, 'PLANNING');
  assert.equal(recovered.version, 1);
});

test('event writes also participate in optimistic persistence even when run version is unchanged', async () => {
  const storagePath = await tempStore();
  const first = new TaskRunCoordinator({ storagePath, runId: 'run-event-conflict' });
  const second = new TaskRunCoordinator({ storagePath, runId: 'run-event-conflict' });
  await Promise.all([first.load(), second.load()]);
  first.recordEvent('checkpoint', { source: 'first' });
  await first.flush();
  second.recordEvent('checkpoint', { source: 'second' });
  await assert.rejects(() => second.flush(), /RUN_STORAGE_CONFLICT/);
});

test('transition and runtime events use one strictly increasing sequence', async () => {
  const coordinator = new TaskRunCoordinator();
  const first = coordinator.transition('PLANNING');
  const second = coordinator.recordEvent('checkpoint', { source: 'test' });
  const third = coordinator.transition('EXECUTING');
  assert.deepEqual(
    [first.event.sequence, second.event.sequence, third.event.sequence],
    [1, 2, 3]
  );
  assert.equal(coordinator.revision, 3);
});

test('flush waits for lifecycle event sink durability and reports sink failures', async () => {
  let committed = false;
  const coordinator = new TaskRunCoordinator({
    onTransition: async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      committed = true;
    }
  });
  coordinator.transition('PLANNING');
  assert.equal(committed, false);
  await coordinator.flush();
  assert.equal(committed, true);

  const failing = new TaskRunCoordinator({ onTransition: async () => { throw new Error('EVENT_SINK_FAILED'); } });
  failing.transition('PLANNING');
  await assert.rejects(failing.flush(), /EVENT_SINK_FAILED/);
});

test('approval pauses an executing run and denial fails it closed', async () => {
  const coordinator = new TaskRunCoordinator();
  coordinator.transition('PLANNING');
  coordinator.transition('EXECUTING');
  coordinator.transition('WAITING_APPROVAL', { reason: 'APPROVAL_REQUIRED' });
  const denied = coordinator.transition('FAILED', { reason: 'APPROVAL_DECLINED' });
  assert.equal(denied.state, 'FAILED');
  assert.equal(denied.event.from, 'WAITING_APPROVAL');
});

test('coordinator supports cancellation, unsupported pause, and quarantine as durable states', async () => {
  const storagePath = await tempStore();
  const coordinator = new TaskRunCoordinator({ storagePath, runId: 'run-safety-states' });
  await coordinator.load();
  coordinator.transition('PAUSED_UNSUPPORTED');
  coordinator.transition('RECOVERING');
  coordinator.transition('QUARANTINED', { reason: 'UNKNOWN_SECURITY_EVENT' });
  await coordinator.flush();

  const restored = new TaskRunCoordinator({ storagePath, runId: 'run-safety-states' });
  await restored.load();
  assert.equal(restored.state, 'QUARANTINED');
  assert.equal(restored.terminal, true);
  assert.throws(() => restored.transition('RECOVERING'), /RUN_INVALID_TRANSITION:QUARANTINED->RECOVERING/);

  const cancelling = new TaskRunCoordinator();
  cancelling.transition('CANCELLING');
  cancelling.transition('CANCELLED');
  assert.equal(cancelling.state, 'CANCELLED');
});

test('coordinator rejects a tampered persisted snapshot', async () => {
  const storagePath = await tempStore();
  await writeFile(storagePath, JSON.stringify({ schemaVersion: '1.0', state: 'CREATED', version: 0 }), 'utf8');
  const coordinator = new TaskRunCoordinator({ storagePath, runId: 'run-tampered' });
  await assert.rejects(() => coordinator.load(), /RUN_STORE_INVALID/);
});

test('explicit run id cannot attach to another persisted run', async () => {
  const storagePath = await tempStore();
  const owner = new TaskRunCoordinator({ storagePath, runId: 'run-owner' });
  await owner.load();
  owner.transition('PLANNING');
  await owner.flush();
  const other = new TaskRunCoordinator({ storagePath, runId: 'run-other' });
  await assert.rejects(() => other.load(), /RUN_STORE_RUN_ID_MISMATCH/);
});

test('coordinator commits run events to the harness event store with COMMITTED receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-coordinator-events-'));
  const storagePath = join(directory, 'run.json');
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const coordinator = new TaskRunCoordinator({ runId: 'run-event-store', storagePath, eventStore });
  assert.throws(() => coordinator.transition('PLANNING'), /RUN_NOT_LOADED/);
  await coordinator.load();

  const transitioned = await coordinator.transitionAndFlush('PLANNING', {
    commandId: 'cmd-transition',
    expectedVersion: 0,
    reason: 'start'
  });
  const recorded = await coordinator.recordEventAndFlush('TaskClassified', { category: 'read' }, { commandId: 'cmd-event' });

  assert.equal(transitioned.state, 'PLANNING');
  assert.equal(coordinator.getReceipt('cmd-transition').status, 'COMMITTED');
  assert.equal(coordinator.getReceipt('cmd-transition').eventId, transitioned.event.eventId);
  assert.equal(coordinator.getReceipt('cmd-event').status, 'COMMITTED');
  assert.equal(coordinator.getReceipt('cmd-event').eventId, recorded.event.eventId);

  const durable = await eventStore.list({ runId: 'run-event-store' });
  assert.deepEqual(durable.map((event) => event.kind), ['RunStateChanged', 'TaskClassified']);
  assert.equal(durable[0].payload.eventId, transitioned.event.eventId);
  assert.equal(durable[1].payload.eventId, recorded.event.eventId);
  assert.match(durable[0].payloadDigest, /^sha256:[0-9a-f]{64}$/u);
  await assert.rejects(() => readFile(storagePath, 'utf8'), /ENOENT/);
});

test('coordinator restores state, events, and receipts from the harness event store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-coordinator-restore-'));
  const eventStorePath = join(directory, 'events.db');
  const eventStore = createHarnessEventStore({ storagePath: eventStorePath });
  await eventStore.load();
  const coordinator = new TaskRunCoordinator({ runId: 'run-event-restore', eventStore });
  await coordinator.load();
  const first = await coordinator.transitionAndFlush('PLANNING', { commandId: 'cmd-transition', expectedVersion: 0 });
  await coordinator.recordEventAndFlush('TaskClassified', { category: 'read' }, { commandId: 'cmd-event' });

  const reopenedStore = createHarnessEventStore({ storagePath: eventStorePath });
  await reopenedStore.load();
  const restored = new TaskRunCoordinator({ runId: 'run-event-restore', eventStore: reopenedStore });
  const snapshot = await restored.load();
  assert.equal(snapshot.state, 'PLANNING');
  assert.equal(snapshot.version, 1);
  assert.equal(restored.revision, 2);
  assert.deepEqual(restored.events.map((event) => event.kind), ['RunStateChanged', 'TaskClassified']);
  assert.equal(restored.getReceipt('cmd-transition').status, 'COMMITTED');
  assert.equal(restored.getReceipt('cmd-event').status, 'COMMITTED');

  const replay = restored.transition('PLANNING', { commandId: 'cmd-transition', expectedVersion: 0 });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.event.eventId, first.event.eventId);
  await restored.flush();
  assert.equal((await reopenedStore.list({ runId: 'run-event-restore' })).length, 2);
});

test('coordinator fails closed when the event store does not return a COMMITTED receipt', async () => {
  const eventStore = {
    async list() { return []; },
    async append(input) {
      return {
        event: {
          eventId: input.eventId,
          runId: input.runId,
          kind: input.kind,
          aggregateType: 'TaskRun',
          aggregateId: input.runId,
          payload: input.payload,
          payloadDigest: `sha256:${'0'.repeat(64)}`,
          recordDigest: `sha256:${'0'.repeat(64)}`
        },
        receipt: { status: 'PENDING', eventIds: [input.eventId], commandId: input.commandId }
      };
    }
  };
  const coordinator = new TaskRunCoordinator({ runId: 'run-pending', eventStore });
  await coordinator.load();
  coordinator.transition('PLANNING', { commandId: 'cmd-pending' });
  await assert.rejects(() => coordinator.flush(), /RUN_EVENT_COMMIT_UNVERIFIED/);
  assert.equal(coordinator.getReceipt('cmd-pending').status, 'ACCEPTED');
});

test('coordinator retries the same durable event id after a commit failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-coordinator-retry-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const append = eventStore.append.bind(eventStore);
  let failOnce = true;
  eventStore.append = async (input) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('HARNESS_STORE_LIMIT');
    }
    return append(input);
  };

  const coordinator = new TaskRunCoordinator({ runId: 'run-event-retry', eventStore });
  await coordinator.load();
  coordinator.transition('PLANNING', { commandId: 'cmd-transition' });
  const requestedEventId = coordinator.events[0].eventId;
  await assert.rejects(() => coordinator.flush(), /RUN_EVENT_COMMIT_FAILED:HARNESS_STORE_LIMIT/);

  await coordinator.recordEventAndFlush('RetryMarker', { ok: true }, { commandId: 'cmd-marker' });
  const durable = await eventStore.list({ runId: 'run-event-retry' });
  assert.deepEqual(durable.map((event) => event.kind), ['RunStateChanged', 'RetryMarker']);
  assert.equal(durable[0].eventId, requestedEventId);
  assert.equal(coordinator.getReceipt('cmd-transition').status, 'COMMITTED');
  assert.equal(coordinator.getReceipt('cmd-marker').status, 'COMMITTED');
});

test('coordinator reload discards optimistic state whose durable commit failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-coordinator-partial-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const append = eventStore.append.bind(eventStore);
  let attempts = 0;
  let failing = true;
  eventStore.append = async (input) => {
    attempts += 1;
    if (attempts >= 2 && failing) throw new Error('HARNESS_STORE_LIMIT');
    return append(input);
  };

  const coordinator = new TaskRunCoordinator({ runId: 'run-event-partial', eventStore });
  await coordinator.load();
  coordinator.transition('PLANNING', { commandId: 'cmd-transition' });
  coordinator.recordEvent('TaskClassified', { category: 'read' }, { commandId: 'cmd-event' });
  assert.equal(coordinator.events.length, 2);
  await assert.rejects(() => coordinator.flush(), /RUN_EVENT_COMMIT_FAILED:HARNESS_STORE_LIMIT/);
  assert.equal((await eventStore.list({ runId: 'run-event-partial' })).length, 1);

  failing = false;
  eventStore.append = append;
  const recovered = await coordinator.reload();
  assert.equal(recovered.state, 'PLANNING');
  assert.equal(recovered.version, 1);
  assert.equal(recovered.revision, 1);
  assert.deepEqual(recovered.events.map((event) => event.kind), ['RunStateChanged']);
  assert.equal(coordinator.getReceipt('cmd-transition').status, 'COMMITTED');
  assert.equal(coordinator.getReceipt('cmd-event'), undefined);

  await coordinator.recordEventAndFlush('TaskClassified', { category: 'read' }, { commandId: 'cmd-event' });
  assert.equal(coordinator.getReceipt('cmd-event').status, 'COMMITTED');
  assert.deepEqual(
    (await eventStore.list({ runId: 'run-event-partial' })).map((event) => event.kind),
    ['RunStateChanged', 'TaskClassified']
  );
});

test('coordinator notifies event sinks only after the durable commit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-coordinator-notify-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const append = eventStore.append.bind(eventStore);
  const order = [];
  eventStore.append = async (input) => {
    const result = await append(input);
    order.push(`committed:${input.kind}`);
    return result;
  };
  const coordinator = new TaskRunCoordinator({
    runId: 'run-event-notify',
    eventStore,
    onEvent: (event) => { order.push(`notified:${event.kind}`); }
  });
  await coordinator.load();
  await coordinator.transitionAndFlush('PLANNING');
  await coordinator.recordEventAndFlush('TaskClassified', { category: 'read' });
  assert.deepEqual(order, [
    'committed:RunStateChanged',
    'notified:RunStateChanged',
    'committed:TaskClassified',
    'notified:TaskClassified'
  ]);
});
