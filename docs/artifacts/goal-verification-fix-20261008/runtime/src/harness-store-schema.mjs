import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const HARNESS_DATABASE_VERSION = 1;

// SQLITE_FULL/IOERR may already have rolled back the transaction. Cleanup must
// not replace the original failure with "no such savepoint".
const rollbackAfterFailure = (db, sql = 'ROLLBACK') => {
  try { db.exec(sql); } catch { /* caller still throws the original failure */ }
};

function validateSchemaConstraints(db) {
  const requiredKeys = {
    trajectory_events: [['event_id'], ['run_id', 'sequence'], ['aggregate_type', 'aggregate_id', 'aggregate_version']],
    command_dedup: [['command_id']],
    run_tombstones: [['run_id']],
    schema_metadata: [['key']]
  };
  for (const [table, keys] of Object.entries(requiredKeys)) {
    const metadata = db.prepare('SELECT strict FROM pragma_table_list WHERE schema=? AND name=?').get('main', table);
    if (metadata?.strict !== 1) throw new Error('HARNESS_DATABASE_SCHEMA_INVALID');
    const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(table);
    const uniqueKeys = indexes.map((index) => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name).map((column) => column.name));
    for (const key of keys) {
      if (!uniqueKeys.some((candidate) => JSON.stringify(candidate) === JSON.stringify(key))) {
        throw new Error('HARNESS_DATABASE_SCHEMA_INVALID');
      }
    }
    const columns = db.prepare('SELECT name, "notnull" AS required FROM pragma_table_info(?)').all(table);
    if (columns.some((column) => column.required !== 1)) throw new Error('HARNESS_DATABASE_SCHEMA_INVALID');
  }
}

// Opening an existing database must never silently migrate or repair it.
export function openHarnessDatabase(storagePath, { readOnly = false, verifyIntegrity = true } = {}) {
  if (typeof storagePath !== 'string' || !storagePath.trim()) throw new Error('HARNESS_DATABASE_PATH_REQUIRED');
  if (!readOnly && storagePath !== ':memory:') mkdirSync(dirname(storagePath), { recursive: true });
  const db = new DatabaseSync(storagePath, { readOnly });
  try {
    // secure_delete keeps purged prompt/source bytes out of freed pages; a
    // plain DELETE only unlinks rows and leaves the payload on disk.
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    // Interactive read-only projections validate returned envelopes. Audits and
    // every writable connection still run the complete integrity check.
    if (!readOnly || verifyIntegrity) {
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('HARNESS_DATABASE_CORRUPT');
    }
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version === 0) {
      if (readOnly) throw new Error('HARNESS_DATABASE_MIGRATION_REQUIRED');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      if (tables.length) throw new Error('HARNESS_DATABASE_MIGRATION_REQUIRED');
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        INSERT INTO schema_metadata VALUES ('storage_schema_version', '1');
        CREATE TABLE trajectory_events (
          event_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          aggregate_type TEXT NOT NULL,
          aggregate_id TEXT NOT NULL,
          aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
          payload_digest TEXT NOT NULL,
          record_digest TEXT NOT NULL,
          envelope TEXT NOT NULL CHECK(json_valid(envelope)),
          UNIQUE(run_id, sequence),
          UNIQUE(aggregate_type, aggregate_id, aggregate_version)
        ) STRICT;
        CREATE TABLE command_dedup (
          command_id TEXT PRIMARY KEY,
          request_digest TEXT NOT NULL,
          receipt TEXT NOT NULL CHECK(json_valid(receipt))
        ) STRICT;
        CREATE TABLE run_tombstones (
          run_id TEXT PRIMARY KEY,
          envelope TEXT NOT NULL CHECK(json_valid(envelope))
        ) STRICT;
        PRAGMA user_version=1;
        COMMIT;`);
    } else if (version !== HARNESS_DATABASE_VERSION) {
      throw new Error('HARNESS_DATABASE_MIGRATION_REQUIRED');
    }
    const metadata = db.prepare("SELECT value FROM schema_metadata WHERE key='storage_schema_version'").get();
    if (metadata?.value !== String(HARNESS_DATABASE_VERSION)) throw new Error('HARNESS_DATABASE_SCHEMA_INVALID');
    // Validate required columns even when tables are empty.
    db.prepare('SELECT event_id, run_id, sequence, aggregate_type, aggregate_id, aggregate_version, payload_digest, record_digest, envelope FROM trajectory_events LIMIT 0').all();
    db.prepare('SELECT command_id, request_digest, receipt FROM command_dedup LIMIT 0').all();
    db.prepare('SELECT run_id, envelope FROM run_tombstones LIMIT 0').all();
    validateSchemaConstraints(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// Receipt insertion and event insertion share the same durable transaction.
// Validation of domain envelopes belongs to the Harness Event Store facade.
export function commitHarnessEvent(db, event, receipt, validateSnapshot, { skipIdentityCheck = false } = {}) {
  db.exec('SAVEPOINT harness_append');
  try {
    const previous = db.prepare('SELECT request_digest, receipt FROM command_dedup WHERE command_id=?').get(receipt.commandId);
    if (previous) {
      if (previous.request_digest !== receipt.requestDigest) throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT');
      db.exec('RELEASE harness_append');
      return { ...JSON.parse(previous.receipt), idempotent: true };
    }
    if (db.prepare('SELECT 1 FROM run_tombstones WHERE run_id=?').get(event.runId)) throw new Error('HARNESS_RUN_TOMBSTONED');
    if (!skipIdentityCheck) {
      const run = db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM trajectory_events WHERE run_id=?').get(event.runId);
      const aggregate = db.prepare('SELECT COALESCE(MAX(aggregate_version),0) AS version FROM trajectory_events WHERE aggregate_type=? AND aggregate_id=?').get(event.aggregateType, event.aggregateId);
      if (event.sequence !== run.version + 1 || event.aggregateVersion !== aggregate.version + 1) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
    }
    try {
      db.prepare('INSERT INTO trajectory_events VALUES (?,?,?,?,?,?,?,?,?)').run(event.eventId, event.runId, event.sequence, event.aggregateType, event.aggregateId, event.aggregateVersion, event.payloadDigest, event.recordDigest, JSON.stringify(event));
    } catch (error) {
      if (/UNIQUE constraint failed/iu.test(error?.message ?? '')) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
      throw error;
    }
    db.prepare('INSERT INTO command_dedup VALUES (?,?,?)').run(receipt.commandId, receipt.requestDigest, JSON.stringify(receipt));
    if (validateSnapshot) validateSnapshot(readHarnessDatabase(db));
    db.exec('RELEASE harness_append');
    return { ...receipt, idempotent: false };
  } catch (error) {
    rollbackAfterFailure(db, 'ROLLBACK TO harness_append; RELEASE harness_append');
    throw error;
  }
}

export function commitHarnessBatch(db, entries, tombstones = [], validateSnapshot) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const receipts = entries.map(({ event, receipt }) => commitHarnessEvent(db, event, receipt));
    for (const tombstone of tombstones) purgeHarnessRun(db, tombstone);
    if (validateSnapshot) validateSnapshot(readHarnessDatabase(db));
    db.exec('COMMIT');
    return receipts;
  } catch (error) { rollbackAfterFailure(db); throw error; }
}

const parseEventRow = (row) => {
  const event = JSON.parse(row.envelope);
  if (event.eventId !== row.event_id || event.runId !== row.run_id || event.sequence !== row.sequence
    || event.aggregateType !== row.aggregate_type || event.aggregateId !== row.aggregate_id
    || event.aggregateVersion !== row.aggregate_version || event.payloadDigest !== row.payload_digest
    || event.recordDigest !== row.record_digest) throw new Error('HARNESS_DATABASE_ENVELOPE_MISMATCH');
  return event;
};

export function readHarnessDatabase(db) {
  db.exec('SAVEPOINT harness_read');
  try {
    const events = db.prepare('SELECT * FROM trajectory_events ORDER BY run_id, sequence').all().map(parseEventRow);
    const receipts = db.prepare('SELECT * FROM command_dedup').all().map((row) => {
      const receipt = JSON.parse(row.receipt);
      if (receipt.commandId !== row.command_id || receipt.requestDigest !== row.request_digest) throw new Error('HARNESS_DATABASE_RECEIPT_MISMATCH');
      return receipt;
    });
    const tombstones = db.prepare('SELECT * FROM run_tombstones').all().map((row) => {
      const tombstone = JSON.parse(row.envelope);
      if (tombstone.runId !== row.run_id) throw new Error('HARNESS_DATABASE_TOMBSTONE_MISMATCH');
      return tombstone;
    });
    db.exec('RELEASE harness_read');
    return { schemaVersion: '1.0', events, receipts, tombstones };
  } catch (error) { rollbackAfterFailure(db, 'ROLLBACK TO harness_read; RELEASE harness_read'); throw error; }
}

const eventFilter = ({ runId, aggregateType, aggregateId } = {}) => {
  const clauses = [];
  const params = [];
  if (typeof runId === 'string' && runId) { clauses.push('run_id=?'); params.push(runId); }
  if (typeof aggregateType === 'string' && aggregateType) { clauses.push('aggregate_type=?'); params.push(aggregateType); }
  if (typeof aggregateId === 'string' && aggregateId) { clauses.push('aggregate_id=?'); params.push(aggregateId); }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
};

export function countHarnessEvents(db, filters = {}) {
  const { where, params } = eventFilter(filters);
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM trajectory_events${where}`).get(...params).count);
}

// Keyset pagination keeps a single (run_id, sequence) cursor instead of an
// OFFSET scan, so pages remain stable and cheap after millions of rows.
export function readHarnessEventPage(db, { limit = 500, afterRunId, afterSequence, ...filters } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('HARNESS_DATABASE_PAGE_LIMIT_INVALID');
  const { where, params } = eventFilter(filters);
  const cursor = typeof afterRunId === 'string' && afterRunId
    ? {
        clause: `${where ? ' AND' : ' WHERE'} (run_id > ? OR (run_id = ? AND sequence > ?))`,
        params: [afterRunId, afterRunId, Number.isInteger(afterSequence) ? afterSequence : 0]
      }
    : { clause: '', params: [] };
  const rows = db.prepare(`SELECT * FROM trajectory_events${where}${cursor.clause} ORDER BY run_id, sequence LIMIT ?`)
    .all(...params, ...cursor.params, limit + 1);
  const hasMore = rows.length > limit;
  const events = (hasMore ? rows.slice(0, limit) : rows).map(parseEventRow);
  const last = events.at(-1);
  return {
    events,
    limit,
    hasMore,
    ...(hasMore && last ? { nextCursor: { afterRunId: last.runId, afterSequence: last.sequence } } : {})
  };
}

// Read the newest events for one run without scanning and materializing its full history.
export function readHarnessEventTail(db, { runIds = [], kinds = [], before, limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('THREAD_HISTORY_LIMIT_INVALID');
  if (!runIds.length) return { events: [], hasMore: false };
  const params = [JSON.stringify(runIds), JSON.stringify(kinds)];
  const cursor = before
    ? "AND (json_extract(envelope, '$.emittedAtMs'), run_id, sequence) < (?, ?, ?)"
    : '';
  if (before) params.push(before.emittedAtMs, before.runId, before.sequence);
  const rows = db.prepare(`SELECT * FROM trajectory_events
    WHERE run_id IN (SELECT value FROM json_each(?))
    AND json_extract(envelope, '$.kind') IN (SELECT value FROM json_each(?))
    ${cursor}
    ORDER BY json_extract(envelope, '$.emittedAtMs') DESC, run_id DESC, sequence DESC LIMIT ?`)
    .all(...params, limit + 1);
  return { events: rows.slice(0, limit).reverse().map(parseEventRow), hasMore: rows.length > limit };
}
export function readHarnessEventsByIds(db, eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM trajectory_events WHERE event_id IN (${placeholders}) ORDER BY run_id, sequence`)
    .all(...eventIds).map(parseEventRow);
}

export function readHarnessReceipt(db, commandId) {
  const row = db.prepare('SELECT * FROM command_dedup WHERE command_id=?').get(commandId);
  if (!row) return undefined;
  const receipt = JSON.parse(row.receipt);
  if (receipt.commandId !== row.command_id || receipt.requestDigest !== row.request_digest) {
    throw new Error('HARNESS_DATABASE_RECEIPT_MISMATCH');
  }
  return receipt;
}

export function readHarnessReceiptPage(db, { afterCommandId, limit = 1000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('HARNESS_DATABASE_PAGE_LIMIT_INVALID');
  const rows = afterCommandId
    ? db.prepare('SELECT * FROM command_dedup WHERE command_id > ? ORDER BY command_id LIMIT ?').all(afterCommandId, limit + 1)
    : db.prepare('SELECT * FROM command_dedup ORDER BY command_id LIMIT ?').all(limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const receipts = pageRows.map((row) => {
    const receipt = JSON.parse(row.receipt);
    if (receipt.commandId !== row.command_id || receipt.requestDigest !== row.request_digest) {
      throw new Error('HARNESS_DATABASE_RECEIPT_MISMATCH');
    }
    return receipt;
  });
  return {
    receipts,
    limit,
    hasMore,
    ...(hasMore ? { nextCursor: { afterCommandId: pageRows.at(-1).command_id } } : {})
  };
}

export function readHarnessTombstones(db) {
  return db.prepare('SELECT * FROM run_tombstones').all().map((row) => {
    const tombstone = JSON.parse(row.envelope);
    if (tombstone.runId !== row.run_id) throw new Error('HARNESS_DATABASE_TOMBSTONE_MISMATCH');
    return tombstone;
  });
}

export function nextHarnessIdentity(db, { runId, aggregateType, aggregateId }) {
  const run = db.prepare('SELECT COALESCE(MAX(sequence),0) AS version FROM trajectory_events WHERE run_id=?').get(runId);
  const aggregate = db.prepare('SELECT COALESCE(MAX(aggregate_version),0) AS version FROM trajectory_events WHERE aggregate_type=? AND aggregate_id=?')
    .get(aggregateType, aggregateId);
  return { sequence: Number(run.version) + 1, aggregateVersion: Number(aggregate.version) + 1 };
}

export function readHarnessSummary(db) {
  const lastSequenceByRun = Object.fromEntries(
    db.prepare('SELECT run_id, MAX(sequence) AS sequence FROM trajectory_events GROUP BY run_id').all()
      .map((row) => [row.run_id, Number(row.sequence)])
  );
  return {
    eventCount: Number(db.prepare('SELECT COUNT(*) AS count FROM trajectory_events').get().count),
    receiptCount: Number(db.prepare('SELECT COUNT(*) AS count FROM command_dedup').get().count),
    tombstoneCount: Number(db.prepare('SELECT COUNT(*) AS count FROM run_tombstones').get().count),
    lastSequenceByRun
  };
}

export function purgeHarnessRun(db, tombstone, validateDatabase) {
  db.exec('SAVEPOINT harness_purge');
  try {
    const prior = db.prepare('SELECT envelope FROM run_tombstones WHERE run_id=?').get(tombstone.runId);
    if (prior) {
      db.exec('RELEASE harness_purge');
      return { status: 'COMMITTED', tombstone: JSON.parse(prior.envelope), purgedEventCount: 0, idempotent: true };
    }
    db.prepare(`DELETE FROM command_dedup WHERE command_id IN (
      SELECT command_id FROM command_dedup, json_each(receipt, '$.eventIds') AS ids
      JOIN trajectory_events ON trajectory_events.event_id=ids.value WHERE trajectory_events.run_id=?
    )`).run(tombstone.runId);
    const result = db.prepare('DELETE FROM trajectory_events WHERE run_id=?').run(tombstone.runId);
    db.prepare('INSERT INTO run_tombstones VALUES (?,?)').run(tombstone.runId, JSON.stringify(tombstone));
    if (validateDatabase) validateDatabase(db);
    db.exec('RELEASE harness_purge');
    return { status: 'COMMITTED', tombstone, purgedEventCount: Number(result.changes), idempotent: false };
  } catch (error) { rollbackAfterFailure(db, 'ROLLBACK TO harness_purge; RELEASE harness_purge'); throw error; }
}
