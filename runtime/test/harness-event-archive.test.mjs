import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { readThreadHistory } from '../src/thread-history-reader.mjs';
import { archiveThreadEvents, restoreThreadEvents, archiveDatabasePath, archiveIndexPath } from '../src/harness-event-archive.mjs';
import { openHarnessDatabase } from '../src/harness-store-schema.mjs';

const countRun = (dbPath, runId) => {
  const db = openHarnessDatabase(dbPath, { readOnly: true, verifyIntegrity: false });
  try {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM trajectory_events WHERE run_id = ?').get(runId).count);
  } finally { db.close(); }
};

test('archiving a finished thread moves its run events and history still reads them', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-event-archive-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath, now: () => 5_000 });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '已完成的任务', cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'run-done', summary: 'done', state: 'SUCCEEDED' });
  await threads.setState(thread.id, 'COMPLETED');
  await events.append({ runId: 'run-done', kind: 'TaskRunCreated', payload: { threadId: thread.id } });
  await events.append({ runId: 'run-done', kind: 'ToolCallRequested', payload: { id: 'call-1', name: 'workspace.list' } });
  await events.append({ runId: 'run-done', kind: 'TaskRunCompleted', payload: { outputDigest: 'sha256:' + 'ab'.repeat(32) } });
  await events.append({ runId: 'run-other', kind: 'TaskRunCreated', payload: {} });

  const moved = await archiveThreadEvents({ harnessPath, threadId: thread.id, now: 6_000 });
  assert.equal(moved.movedRunCount, 1);
  assert.equal(moved.movedEventCount, 3);
  assert.equal(countRun(harnessPath, 'run-done'), 0);
  assert.equal(countRun(harnessPath, 'run-other'), 1);
  assert.equal(countRun(archiveDatabasePath(harnessPath), 'run-done'), 3);
  const listed = await readThreadHistory({ harnessPath, listOnly: true });
  assert.equal(listed.threads.some((item) => item.id === thread.id), true);
  const history = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 10 });
  assert.equal(history.events.some((event) => event.payload.persistedKind === 'ToolCallRequested'), true);
  const reopened = createHarnessEventStore({ storagePath: harnessPath });
  await assert.rejects(reopened.append({ runId: 'run-done', kind: 'TaskRunCreated', payload: {} }), /HARNESS_RUN_TOMBSTONED/);

  const again = await archiveThreadEvents({ harnessPath, threadId: thread.id, now: 7_000 });
  assert.equal(again.movedEventCount, 0);
  const otherThread = await threads.create({ title: '未归档的任务', cwd: directory });
  await threads.appendTurn(otherThread.id, { runId: 'run-other', summary: 'keep live', state: 'SUCCEEDED' });
  const noRestore = await restoreThreadEvents({ harnessPath, threadId: otherThread.id, onlyIfArchived: true });
  assert.equal(noRestore.restoredRunCount, 0);
  assert.equal(countRun(archiveDatabasePath(harnessPath), 'run-done'), 3);

  await rm(archiveIndexPath(harnessPath));
  const restored = await restoreThreadEvents({ harnessPath, threadId: thread.id, onlyIfArchived: true });
  assert.equal(restored.restoredEventCount, 3);
  assert.equal(countRun(harnessPath, 'run-done'), 3);
  assert.equal(countRun(archiveDatabasePath(harnessPath), 'run-done'), 0);
  const after = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 10 });
  assert.equal(after.events.filter((event) => event.runId === 'run-done').length, 3);
  assert.equal((await restoreThreadEvents({ harnessPath, threadId: thread.id, onlyIfArchived: true })).restoredRunCount, 0);
  const resumed = createHarnessEventStore({ storagePath: harnessPath });
  await resumed.append({ runId: 'run-done', kind: 'TaskRunCompleted', payload: { note: 'after-restore' } });
});

test('a running thread stays in the live event database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-event-archive-busy-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '进行中', cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'run-live', summary: 'live' });
  await threads.setState(thread.id, 'RUNNING', { runId: 'run-live' });
  await events.append({ runId: 'run-live', kind: 'RunStateChanged', payload: { to: 'EXECUTING' } });
  await events.append({ runId: 'run-live', kind: 'ToolCallRequested', payload: { id: 'call-2', name: 'shell.execute' } });
  await assert.rejects(archiveThreadEvents({ harnessPath, threadId: thread.id }), /THREAD_ARCHIVE_BUSY/);
  assert.equal(countRun(harnessPath, 'run-live'), 2);
  await threads.setState(thread.id, 'IDLE');
  await assert.rejects(archiveThreadEvents({ harnessPath, threadId: thread.id }), /THREAD_ARCHIVE_BUSY/);
  await assert.rejects(archiveThreadEvents({ harnessPath, threadId: thread.id, allowUnsettled: true }), /THREAD_ARCHIVE_BUSY/);
  assert.equal(countRun(harnessPath, 'run-live'), 2);
  await threads.setState(thread.id, 'COMPLETED');
  await events.append({ runId: 'run-live', kind: 'RunStateChanged', payload: { to: 'SUCCEEDED' } });
  const moved = await archiveThreadEvents({ harnessPath, threadId: thread.id });
  assert.equal(moved.movedEventCount, 3);
  assert.equal(countRun(harnessPath, 'run-live'), 0);
  const tombstoneDb = openHarnessDatabase(harnessPath, { readOnly: true, verifyIntegrity: false });
  try {
    const tombstone = JSON.parse(tombstoneDb.prepare('SELECT envelope FROM run_tombstones').get().envelope);
    assert.equal(Number.isInteger(tombstone.purgedAtMs), true);
    assert.equal(tombstone.purgedAtMs >= 0, true);
  } finally { tombstoneDb.close(); }
  assert.equal((await createHarnessEventStore({ storagePath: harnessPath }).verify()).ok, true);
});

test('archived history pages stay in order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-event-archive-page-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath, now: () => 9_000 });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '分页', cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'run-page', summary: 'page', state: 'SUCCEEDED' });
  await threads.setState(thread.id, 'COMPLETED');
  for (let index = 0; index < 3; index += 1) {
    await events.append({ runId: 'run-page', kind: 'TaskRunCompleted', payload: { ordinal: index } });
  }
  await archiveThreadEvents({ harnessPath, threadId: thread.id });
  const latest = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 2 });
  assert.equal(latest.events.length, 2);
  assert.equal(latest.hasMore, true);
  assert.deepEqual(latest.events.map((event) => event.payload.ordinal), [1, 2]);
  const older = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 2, before: latest.nextCursor });
  assert.equal(older.events.length, 1);
  assert.equal(older.hasMore, false);
  assert.equal(older.events[0].payload.ordinal, 0);
});

test('task entry restores only the selected legacy archive before model startup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-event-archive-launch-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const archivePath = archiveDatabasePath(harnessPath);
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ cwd: directory });
  const otherThread = await threads.create({ cwd: directory });
  for (const [entry, runId] of [[thread, 'run-legacy'], [otherThread, 'run-unrelated']]) {
    await threads.appendTurn(entry.id, { runId, summary: 'done', state: 'SUCCEEDED' });
    await threads.setState(entry.id, 'COMPLETED');
    await events.append({ runId, kind: 'TaskRunCreated', payload: { threadId: entry.id } });
    await archiveThreadEvents({ harnessPath, threadId: entry.id });
  }
  const entrypoint = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [entrypoint, 'task',
    '--thread-id', thread.id, '--prompt', '继续任务', '--workspace', directory,
    '--config', join(directory, 'missing-model-config.json')
  ], { env: {
    ...process.env,
    DDA_DATA_DIR: directory,
    DDA_HARNESS_EVENT_STORE: harnessPath,
    DDA_TRAJECTORY_STORE: join(directory, 'trajectory.jsonl'),
    DDA_THREAD_STORE: join(directory, 'threads.json'),
    DDA_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL'
  } }), (error) => {
    assert.match(JSON.parse(error.stdout.trim()).error, /^MODEL_CONFIG_NOT_FOUND:/u);
    return true;
  });
  assert.equal(countRun(harnessPath, 'run-legacy'), 1);
  assert.equal(countRun(archivePath, 'run-legacy'), 0);
  assert.equal(countRun(harnessPath, 'run-unrelated'), 0);
  assert.equal(countRun(archivePath, 'run-unrelated'), 1);
});

test('a legacy restore conflict leaves the archived copy intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-event-archive-conflict-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'run-archived', summary: 'done', state: 'SUCCEEDED' });
  const shared = { kind: 'TaskRunCreated', aggregateType: 'TaskRun', aggregateId: 'shared-aggregate' };
  await events.append({ ...shared, runId: 'run-archived', payload: { threadId: thread.id } });
  await archiveThreadEvents({ harnessPath, threadId: thread.id });
  await events.append({ ...shared, runId: 'run-live' });

  await assert.rejects(restoreThreadEvents({ harnessPath, threadId: thread.id, onlyIfArchived: true }), /HARNESS_ARCHIVE_RESTORE_CONFLICT/u);
  assert.equal(countRun(harnessPath, 'run-live'), 1);
  assert.equal(countRun(harnessPath, 'run-archived'), 0);
  assert.equal(countRun(archiveDatabasePath(harnessPath), 'run-archived'), 1);
});

test('public archive commands preserve a live writer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-live-archive-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: db });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ cwd: directory });
  const runId = 'live-writer';
  await threads.setState(thread.id, 'RUNNING', { runId });
  await events.append({ runId, kind: 'TaskRunCreated', payload: { threadId: thread.id } });
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const run = (args) => promisify(execFile)(process.execPath, [cli, 'harness-events', ...args,
    '--harness-event-store', db], { env: { ...process.env, DDA_DATA_DIR: directory } });
  await assert.rejects(run(['archive-thread', '--thread-id', thread.id]),
    error => JSON.parse(error.stdout).error === 'THREAD_ARCHIVE_BUSY');
  const { stdout } = await run(['archive-threads', '--thread-ids', JSON.stringify([thread.id])]);
  assert.equal(JSON.parse(stdout).threads[0].busy, true);
  await events.append({ runId, kind: 'TaskRunCompleted', payload: {} });
  assert.equal(countRun(db, runId), 2);
});
