import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openHarnessDatabase, commitHarnessEvent } from '../src/harness-store-schema.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createTrajectoryStore } from '../src/trajectory-store.mjs';
import { rebuildReadModel } from '../src/read-model-rebuilder.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'hmcodex.db');
}
async function candidate() {
  const result = await createHarnessEventStore().append({ runId: 'r1', kind: 'TaskRunCreated', commandId: 'c1', payload: {} });
  const { event, receipt } = result;
  return { event, receipt };
}

test('SQLite commits events and receipts durably and retries idempotently', async (t) => {
  const path = await fixture(t);
  const { event, receipt } = await candidate();
  let db = openHarnessDatabase(path);
  try {
    assert.equal(commitHarnessEvent(db, event, receipt).idempotent, false);
  } finally { db.close(); }
  db = openHarnessDatabase(path);
  try {
    assert.equal(commitHarnessEvent(db, event, receipt).idempotent, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM command_dedup').get().n, 1);
    assert.throws(() => commitHarnessEvent(db, event, { ...receipt, requestDigest: 'changed' }), /IDEMPOTENCY_CONFLICT/);
  } finally { db.close(); }
});

test('receipt failure rolls back the event and leaves its sequence available', async (t) => {
  const db = openHarnessDatabase(await fixture(t));
  const { event, receipt } = await candidate();
  try {
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON command_dedup BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;");
    assert.throws(() => commitHarnessEvent(db, event, receipt), /injected receipt failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 0);
    db.exec('DROP TRIGGER reject_receipt');
    commitHarnessEvent(db, event, receipt);
    assert.throws(() => commitHarnessEvent(db, { ...event, eventId: 'other' }, { ...receipt, commandId: 'other' }), /CONCURRENT_CONFLICT/);
  } finally { db.close(); }
});

test('startup rejects corrupt files and unknown schema versions without migrating', async (t) => {
  const path = await fixture(t);
  let db = openHarnessDatabase(path);
  db.exec('PRAGMA user_version=99');
  db.close();
  assert.throws(() => openHarnessDatabase(path), /MIGRATION_REQUIRED/);
  db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99);
  db.close();
  const corruptPath = path + '.corrupt';
  await writeFile(corruptPath, 'not a SQLite database');
  assert.throws(() => openHarnessDatabase(corruptPath));
});

test('startup rejects a page-corrupted SQLite database instead of returning partial facts', async (t) => {
  const path = await fixture(t);
  const store = createHarnessEventStore({ storagePath: path });
  await store.load();
  for (let index = 0; index < 200; index += 1) {
    await store.append({ runId: 'run-page-corrupt', kind: 'Observed', payload: { index, text: 'x'.repeat(200) } });
  }
  const original = await readFile(path);
  const corrupted = Buffer.from(original);
  corrupted[4096] = corrupted[4096] ^ 0xff;
  await writeFile(path, corrupted);
  const reopened = createHarnessEventStore({ storagePath: path });
  await assert.rejects(reopened.load(), /HARNESS_STORE_(READ_FAILED|INVALID)/);
  assert.equal(reopened.summary().eventCount, 0);
});

test('SQL constraints reject duplicate aggregate positions across different runs', async (t) => {
  const db = openHarnessDatabase(await fixture(t));
  const { event, receipt } = await candidate();
  try {
    commitHarnessEvent(db, event, receipt);
    assert.throws(() => db.prepare('INSERT INTO trajectory_events SELECT ?, ?, sequence, aggregate_type, aggregate_id, aggregate_version, payload_digest, record_digest, envelope FROM trajectory_events').run('other', 'r2'), /UNIQUE constraint failed/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 1);
  } finally { db.close(); }
});

test('Harness facade persists to SQLite and purges receipts atomically', async (t) => {
  const storagePath = await fixture(t);
  const store = createHarnessEventStore({ storagePath });
  await store.append({ runId: 'r1', kind: 'TaskRunCreated', commandId: 'c1' });
  await store.append({ runId: 'r2', kind: 'TaskRunCreated', commandId: 'c2' });
  const restored = createHarnessEventStore({ storagePath });
  assert.equal((await restored.list()).length, 2);
  assert.equal((await restored.verify()).ok, true);
  assert.equal((await restored.purgeRun('r1')).purgedEventCount, 1);
  const after = createHarnessEventStore({ storagePath });
  assert.equal((await after.list()).length, 1);
  assert.equal(after.getReceipt('c1'), undefined);
  assert.equal(after.getReceipt('c2').status, 'COMMITTED');
  await assert.rejects(after.append({ runId: 'r1', kind: 'Late' }), /TOMBSTONED/);
});

test('Harness facade rejects tampered database envelopes', async (t) => {
  const storagePath = await fixture(t);
  await createHarnessEventStore({ storagePath }).append({ runId: 'r1', kind: 'First' });
  const db = openHarnessDatabase(storagePath);
  db.exec("UPDATE trajectory_events SET envelope=json_set(envelope, '$.payload.changed', 1)");
  db.close();
  await assert.rejects(createHarnessEventStore({ storagePath }).load(), /INVALID_EVENT/);
});

test('a stale facade cannot return an old receipt after another facade purges the run', async (t) => {
  const storagePath = await fixture(t);
  const left = createHarnessEventStore({ storagePath });
  const input = { runId: 'r1', kind: 'First', commandId: 'c1' };
  await left.append(input);
  await createHarnessEventStore({ storagePath }).purgeRun('r1');
  await assert.rejects(left.append(input), /TOMBSTONED/);
});

test('SQLite legacy import rolls back the entire batch on a mid-batch storage failure', async (t) => {
  const storagePath = await fixture(t);
  const db = openHarnessDatabase(storagePath);
  db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON trajectory_events WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'injected import failure'); END;");
  db.close();
  const events = [1, 2].map((n) => ({ eventId: `old-${n}`, runId: 'r1', kind: 'Imported', payload: { n } }));
  const store = createHarnessEventStore({ storagePath });
  await assert.rejects(store.importLegacyEvents(events), /injected import failure/);
  const check = openHarnessDatabase(storagePath);
  assert.equal(check.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM command_dedup').get().n, 0);
  check.exec('DROP TRIGGER reject_second');
  check.close();
  await store.importLegacyEvents(events);
  const retry = await store.importLegacyEvents(events);
  assert.ok(retry.every((result) => result.idempotent));
  assert.equal((await store.list()).length, 2);
  assert.equal((await store.list())[0].sourceRef.eventId, 'old-1');
});

test('CLI imports JSONL into SQLite without modifying the source file', async (t) => {
  const storagePath = await fixture(t);
  const source = storagePath + '.source.jsonl';
  await createTrajectoryStore(source).append({ runId: 'r1', kind: 'TaskRunCreated', payload: {} });
  const original = await readFile(source, 'utf8');
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const args = [cli, 'harness-events', '--operation', 'import', '--source', source, '--harness-event-store', storagePath];
  const result = await promisify(execFile)(process.execPath, args, { windowsHide: true });
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(await readFile(source, 'utf8'), original);
  assert.equal((await createHarnessEventStore({ storagePath }).list()).length, 1);
  const corrupted = JSON.parse(original);
  corrupted.payload = { tampered: true };
  await writeFile(source, JSON.stringify(corrupted) + '\n');
  await assert.rejects(promisify(execFile)(process.execPath, args, { windowsHide: true }), (error) => {
    assert.match(error.stdout, /TRAJECTORY_INVALID_EVENT/);
    return true;
  });
  assert.equal((await createHarnessEventStore({ storagePath }).list()).length, 1);
});

test('Harness JSON migration atomically preserves tombstones and source references', async (t) => {
  const storagePath = await fixture(t);
  const legacyPath = storagePath + '.legacy.json';
  const legacy = createHarnessEventStore({ storagePath: legacyPath });
  await legacy.append({ runId: 'keep', kind: 'First' });
  await legacy.append({ runId: 'deleted', kind: 'First' });
  await legacy.purgeRun('deleted');
  const raw = await readFile(legacyPath, 'utf8');
  const snapshot = JSON.parse(raw);
  const db = openHarnessDatabase(storagePath);
  db.exec("CREATE TRIGGER reject_tombstone BEFORE INSERT ON run_tombstones BEGIN SELECT RAISE(ABORT,'injected tombstone failure'); END;");
  db.close();
  const target = createHarnessEventStore({ storagePath });
  await assert.rejects(target.importLegacySnapshot(snapshot), /injected tombstone failure/);
  const check = openHarnessDatabase(storagePath);
  assert.equal(check.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 0);
  assert.equal(check.prepare('SELECT count(*) AS n FROM command_dedup').get().n, 0);
  check.exec('DROP TRIGGER reject_tombstone');
  check.close();
  await target.importLegacySnapshot(snapshot);
  await target.importLegacySnapshot(snapshot);
  assert.equal((await target.list()).length, 1);
  assert.equal((await target.list())[0].sourceRef.store, 'harness-json');
  await assert.rejects(target.append({ runId: 'deleted', kind: 'Late' }), /TOMBSTONED/);
  assert.equal(await readFile(legacyPath, 'utf8'), raw);
});

test('legacy command identities distinguish sources and reject changed provenance', async (t) => {
  const target = createHarnessEventStore({ storagePath: await fixture(t) });
  const event = { eventId: 'same-id', runId: 'r1', kind: 'First' };
  await target.importLegacyEvents([event], { sourceStore: 'source-a' });
  await target.importLegacyEvents([event], { sourceStore: 'source-b' });
  assert.equal((await target.list()).length, 2);
  await assert.rejects(target.importLegacyEvents([{ ...event, recordDigest: 'sha256:' + 'a'.repeat(64) }], { sourceStore: 'source-a' }), /IDEMPOTENCY_CONFLICT/);
});

test('SQLite full error rolls back without hiding the storage failure', async (t) => {
  const db = openHarnessDatabase(await fixture(t));
  try {
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    db.exec(`PRAGMA max_page_count=${pages}`);
    const result = await createHarnessEventStore().append({ runId: 'full-run', kind: 'Large', payload: { data: 'x'.repeat(32000) } });
    assert.throws(() => commitHarnessEvent(db, result.event, result.receipt), /database or disk is full/i);
    assert.equal(db.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM command_dedup').get().n, 0);
  } finally { db.close(); }
});

test('long-lived SQLite readers refresh committed events and verify current storage', async (t) => {
  const storagePath = await fixture(t);
  const reader = createHarnessEventStore({ storagePath });
  await reader.load();
  const writer = createHarnessEventStore({ storagePath });
  await writer.append({ runId: 'r1', kind: 'First' });
  assert.equal((await reader.list()).length, 1);
  await writer.purgeRun('r1');
  assert.equal((await reader.verify()).eventCount, 0);
  assert.equal((await reader.list()).length, 0);
  const db = openHarnessDatabase(storagePath);
  db.exec("UPDATE run_tombstones SET envelope=json_set(envelope,'$.reasonDigest','tampered')");
  db.close();
  await assert.rejects(reader.verify(), /TOMBSTONE/);
});

test('startup rejects a schema that retains columns but loses sequence uniqueness', async (t) => {
  const storagePath = await fixture(t);
  const db = openHarnessDatabase(storagePath);
  db.exec(`DROP TABLE trajectory_events;
    CREATE TABLE trajectory_events (
      event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, aggregate_version INTEGER NOT NULL,
      payload_digest TEXT NOT NULL, record_digest TEXT NOT NULL, envelope TEXT NOT NULL,
      UNIQUE(aggregate_type, aggregate_id, aggregate_version)
    ) STRICT;`);
  db.close();
  assert.throws(() => openHarnessDatabase(storagePath), /SCHEMA_INVALID/);
  assert.throws(() => openHarnessDatabase(storagePath, { readOnly: true }), /SCHEMA_INVALID/);
});

test('shared aggregate versions stay continuous across differently sorted run IDs', async (t) => {
  const storagePath = await fixture(t);
  const store = createHarnessEventStore({ storagePath });
  for (const runId of ['z-run', 'a-run', 'm-run']) {
    await store.append({ runId, aggregateType: 'SharedContext', aggregateId: 'shared', kind: 'ContextObserved' });
  }
  const reopened = createHarnessEventStore({ storagePath });
  const events = await reopened.list();
  assert.deepEqual(events.map((event) => event.aggregateVersion), [2, 3, 1]);
  assert.equal((await reopened.verify()).ok, true);
  const projection = await rebuildReadModel({ events });
  assert.equal(projection.runCount, 3);
  assert.equal((await rebuildReadModel({ events: [...events].reverse() })).projectionChecksum, projection.projectionChecksum);
});

test('purge rolls back before commit if it would leave shared aggregate version gaps', async (t) => {
  const storagePath = await fixture(t);
  const store = createHarnessEventStore({ storagePath });
  for (const runId of ['first-run', 'second-run']) {
    await store.append({ runId, aggregateType: 'Shared', aggregateId: 'shared', kind: 'Observed', commandId: runId });
  }
  await assert.rejects(store.purgeRun('first-run'), /AGGREGATE_VERSION_INVALID/);
  const reopened = createHarnessEventStore({ storagePath });
  assert.equal((await reopened.list()).length, 2);
  assert.equal((await reopened.verify()).tombstoneCount, 0);
  assert.ok(reopened.getReceipt('first-run'));
  assert.ok(reopened.getReceipt('second-run'));
});

test('append validates the resulting transaction before returning a durable receipt', async (t) => {
  const storagePath = await fixture(t);
  const db = openHarnessDatabase(storagePath);
  db.exec(`CREATE TRIGGER corrupt_insert AFTER INSERT ON trajectory_events BEGIN
    UPDATE trajectory_events SET envelope=json_set(envelope, '$.payload.changed', 1) WHERE event_id=NEW.event_id;
  END;`);
  db.close();
  const store = createHarnessEventStore({ storagePath });
  await assert.rejects(store.append({ runId: 'r1', kind: 'First', commandId: 'c1' }), /INVALID_EVENT/);
  const reopened = createHarnessEventStore({ storagePath });
  assert.equal((await reopened.list()).length, 0);
  assert.equal(reopened.getReceipt('c1'), undefined);
  const check = openHarnessDatabase(storagePath);
  check.exec('DROP TRIGGER corrupt_insert');
  check.close();
  await store.append({ runId: 'r1', kind: 'First', commandId: 'c1' });
  assert.equal((await store.list())[0].sequence, 1);
});
