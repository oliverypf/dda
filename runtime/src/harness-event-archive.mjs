import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { HARNESS_STORE_SCHEMA_VERSION } from './harness-event-store.mjs';
import { openHarnessDatabase } from './harness-store-schema.mjs';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

// Archived sessions stay in the thread list metadata, but their task runs leave
// the live event database. History reads the archive; restore moves the same
// rows back. Runs move whole so sequence and aggregate versions stay intact.
const TERMINAL_RUN_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);
const BUSY_THREAD_STATES = new Set(['RUNNING', 'PAUSED']);
const ARCHIVE_REASON = 'THREAD_ARCHIVED';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const archiveReasonDigest = digest(ARCHIVE_REASON);

const sqlLiteral = (value) => `'${String(value).replaceAll('\\', '/').replaceAll("'", "''")}'`;

export function archiveDatabasePath(harnessPath) {
  if (typeof harnessPath !== 'string' || !/\.db$/iu.test(harnessPath)) throw new Error('HARNESS_ARCHIVE_PATH_INVALID');
  return harnessPath.replace(/\.db$/iu, '.archive.db');
}

export function archiveIndexPath(harnessPath) {
  return `${archiveDatabasePath(harnessPath)}.index.json`;
}

const normalizeThreadId = (threadId) => {
  if (typeof threadId !== 'string') throw new Error('THREAD_ID_REQUIRED');
  const id = threadId.trim();
  if (!id || id.length > 240 || /[\u0000-\u001f\u007f]/u.test(id)) throw new Error('THREAD_ID_INVALID');
  return id;
};

const addRunId = (runIds, value) => {
  if (typeof value !== 'string') return;
  const runId = value.trim();
  if (!runId || runId.startsWith('thread:') || runId.length > 240) return;
  runIds.add(runId);
};

function collectThreadRunIds(db, threadId, linkedRuns) {
  const runIds = new Set();
  const threadRun = `thread:${threadId}`;
  for (const row of db.prepare('SELECT envelope FROM trajectory_events WHERE run_id = ?').all(threadRun)) {
    const payload = JSON.parse(row.envelope).payload ?? {};
    addRunId(runIds, payload.runId);
    addRunId(runIds, payload.activeRunId);
    addRunId(runIds, payload.turn?.runId);
    addRunId(runIds, payload.checkpoint?.runId);
    if (Array.isArray(payload.turns)) {
      for (const turn of payload.turns) addRunId(runIds, turn?.runId);
    }
  }
  const linked = linkedRuns ?? new Map([[threadId, db.prepare(`SELECT DISTINCT run_id FROM trajectory_events
    WHERE json_extract(envelope, '$.payload.threadId') = ? AND run_id <> ?`).all(threadId, threadRun).map((row) => row.run_id)]]);
  for (const runId of linked.get(threadId) ?? []) addRunId(runIds, runId);
  return [...runIds];
}

// One pass for a batch. Repeating this per archived thread would reread the live database.
function linkedRunsByThread(db) {
  const linked = new Map();
  const rows = db.prepare(`SELECT run_id AS runId, json_extract(envelope, '$.payload.threadId') AS threadId
    FROM trajectory_events
    WHERE json_extract(envelope, '$.payload.threadId') IS NOT NULL
      AND run_id NOT LIKE 'thread:%'`).all();
  for (const row of rows) {
    if (typeof row.threadId !== 'string' || !row.threadId) continue;
    if (!linked.has(row.threadId)) linked.set(row.threadId, []);
    linked.get(row.threadId).push(row.runId);
  }
  return linked;
}

function threadIsBusy(db, threadId) {
  const row = db.prepare(`SELECT json_extract(envelope, '$.payload.state') AS state
    FROM trajectory_events
    WHERE json_extract(envelope, '$.payload.threadId') = ?
      AND json_extract(envelope, '$.kind') IN ('ThreadStateChanged', 'ThreadCheckpointCommitted', 'ThreadCheckpointCleared')
    ORDER BY json_extract(envelope, '$.emittedAtMs') DESC, run_id DESC, sequence DESC LIMIT 1`).get(threadId);
  return BUSY_THREAD_STATES.has(row?.state);
}

function unsettledRuns(db) {
  return db.prepare(`SELECT e.run_id AS runId, json_extract(e.envelope, '$.payload.to') AS state
    FROM trajectory_events e
    JOIN move_runs r ON r.run_id = e.run_id
    JOIN (
      SELECT t.run_id, MAX(t.sequence) AS sequence
      FROM trajectory_events t
      JOIN move_runs mr ON mr.run_id = t.run_id
      WHERE json_extract(t.envelope, '$.kind') = 'RunStateChanged'
      GROUP BY t.run_id
    ) latest ON latest.run_id = e.run_id AND latest.sequence = e.sequence`).all()
    .filter((row) => !TERMINAL_RUN_STATES.has(row.state))
    .map((row) => row.runId);
}

const archiveTimestamp = (now) => {
  // Callers inject a clock (`now = Date.now`), not a timestamp. A function
  // value canonicalizes as null and JSON.stringify then drops the field, so
  // the stored digest never matches a later read.
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isInteger(value) || value < 0) throw new Error('HARNESS_ARCHIVE_TIME_INVALID');
  return value;
};

const tombstoneFor = (runId, now) => {
  const unsigned = {
    schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
    tombstoneId: `tombstone-${randomUUID()}`,
    runId,
    purgedAtMs: archiveTimestamp(now),
    reasonDigest: archiveReasonDigest
  };
  return { ...unsigned, recordDigest: digest(unsigned) };
};

function assertMovedRuns(db, schema) {
  const events = `${schema}.trajectory_events`;
  const receipts = `${schema}.command_dedup`;
  const tombstones = `${schema}.run_tombstones`;
  const gap = db.prepare(`SELECT run_id FROM ${events}
    WHERE run_id IN (SELECT run_id FROM move_runs)
    GROUP BY run_id HAVING MIN(sequence) <> 1 OR MAX(sequence) <> COUNT(*) LIMIT 1`).get();
  if (gap) throw new Error('HARNESS_ARCHIVE_SEQUENCE_INVALID');
  const orphan = db.prepare(`SELECT c.command_id FROM ${receipts} c, json_each(c.receipt, '$.eventIds') ids
    LEFT JOIN ${events} e ON e.event_id = ids.value
    WHERE e.event_id IS NULL LIMIT 1`).get();
  if (orphan) throw new Error('HARNESS_ARCHIVE_RECEIPT_ORPHAN');
  const conflict = db.prepare(`SELECT e.event_id FROM ${events} e
    JOIN ${tombstones} t ON t.run_id = e.run_id LIMIT 1`).get();
  if (conflict) throw new Error('HARNESS_ARCHIVE_TOMBSTONE_CONFLICT');
}

function rememberRuns(db, runIds) {
  db.exec('DROP TABLE IF EXISTS move_runs');
  db.exec('CREATE TEMP TABLE move_runs (run_id TEXT PRIMARY KEY)');
  const insert = db.prepare('INSERT INTO move_runs(run_id) VALUES (?)');
  for (const runId of runIds) insert.run(runId);
}

const fileBytes = (filePath) => existsSync(filePath) ? statSync(filePath).size : 0;

function vacuumDatabase(filePath) {
  const bytesBefore = fileBytes(filePath);
  if (!bytesBefore) return { bytesBefore: 0, bytesAfter: 0 };
  const db = openHarnessDatabase(filePath);
  try { db.exec('VACUUM'); }
  finally { db.close(); }
  return { bytesBefore, bytesAfter: fileBytes(filePath) };
}

async function writeArchiveIndex(harnessPath, threadId, runIds) {
  const filePath = archiveIndexPath(harnessPath);
  await persistJsonFile(filePath, { schemaVersion: '1.0', threads: { [threadId]: runIds } }, {
    merge: (existing, incoming) => {
      const threads = existing?.threads && typeof existing.threads === 'object' && !Array.isArray(existing.threads)
        ? { ...existing.threads }
        : {};
      const next = incoming?.threads?.[threadId];
      if (!Array.isArray(next) || next.length === 0) delete threads[threadId];
      else threads[threadId] = next;
      return { schemaVersion: '1.0', threads };
    }
  });
}

export async function readArchivedRunIds(harnessPath, threadId) {
  const filePath = archiveIndexPath(harnessPath);
  if (!existsSync(filePath)) return [];
  const parsed = await readPersistentJsonFile(filePath);
  const runs = parsed?.threads?.[threadId];
  if (!Array.isArray(runs)) return [];
  return runs.filter((runId) => typeof runId === 'string' && runId && !runId.startsWith('thread:') && runId.length <= 240);
}

const threadExists = (db, threadId) => Boolean(
  db.prepare('SELECT 1 FROM trajectory_events WHERE run_id = ? LIMIT 1').get(`thread:${threadId}`)
  || db.prepare(`SELECT 1 FROM trajectory_events WHERE json_extract(envelope, '$.payload.threadId') = ? LIMIT 1`).get(threadId)
);

function rejectIfBusy(db, id) {
  if (threadIsBusy(db, id) || unsettledRuns(db).length) throw new Error('THREAD_ARCHIVE_BUSY');
}

function archiveOne(db, harnessPath, id, now, linkedRuns) {
  let attached = false;
  let movedEventCount = 0;
  let movedRunCount = 0;
  const runIds = [];
  try {
    if (!threadExists(db, id)) return { threadId: id, movedRunCount: 0, movedEventCount: 0, missing: true, runIds };
    if (threadIsBusy(db, id)) throw new Error('THREAD_ARCHIVE_BUSY');
    runIds.push(...collectThreadRunIds(db, id, linkedRuns));
    rememberRuns(db, runIds);
    if (unsettledRuns(db).length) throw new Error('THREAD_ARCHIVE_BUSY');
    db.prepare(`DELETE FROM move_runs WHERE run_id NOT IN (SELECT DISTINCT run_id FROM trajectory_events)`).run();
    const liveRunCount = Number(db.prepare('SELECT COUNT(*) AS count FROM move_runs').get().count);
    if (liveRunCount > 0) {
      const archivePath = archiveDatabasePath(harnessPath);
      if (!existsSync(archivePath)) openHarnessDatabase(archivePath).close();
      db.exec(`ATTACH DATABASE ${sqlLiteral(archivePath)} AS archive`);
      attached = true;
      db.exec('BEGIN IMMEDIATE');
      try {
        rejectIfBusy(db, id);
        const split = db.prepare(`SELECT other.run_id AS runId
          FROM main.trajectory_events moved
          JOIN move_runs r ON r.run_id = moved.run_id
          JOIN main.trajectory_events other
            ON other.aggregate_type = moved.aggregate_type
           AND other.aggregate_id = moved.aggregate_id
           AND other.run_id <> moved.run_id
          LEFT JOIN move_runs included ON included.run_id = other.run_id
          WHERE included.run_id IS NULL
          LIMIT 1`).get();
        if (split) throw new Error('HARNESS_ARCHIVE_AGGREGATE_SPLIT');
        db.prepare(`INSERT OR IGNORE INTO archive.trajectory_events
          SELECT e.* FROM main.trajectory_events e JOIN move_runs r ON r.run_id = e.run_id`).run();
        db.prepare(`INSERT OR IGNORE INTO archive.command_dedup
          SELECT c.* FROM main.command_dedup c
          WHERE EXISTS (
            SELECT 1 FROM json_each(c.receipt, '$.eventIds') ids
            JOIN main.trajectory_events e ON e.event_id = ids.value
            JOIN move_runs r ON r.run_id = e.run_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM json_each(c.receipt, '$.eventIds') ids
            LEFT JOIN main.trajectory_events e ON e.event_id = ids.value
            LEFT JOIN move_runs r ON r.run_id = e.run_id
            WHERE e.event_id IS NULL OR r.run_id IS NULL
          )`).run();
        db.prepare(`DELETE FROM main.command_dedup WHERE command_id IN (
          SELECT c.command_id FROM archive.command_dedup c
          WHERE EXISTS (
            SELECT 1 FROM json_each(c.receipt, '$.eventIds') ids
            JOIN archive.trajectory_events e ON e.event_id = ids.value
            JOIN move_runs r ON r.run_id = e.run_id
          )
        )`).run();
        const deleted = db.prepare('DELETE FROM main.trajectory_events WHERE run_id IN (SELECT run_id FROM move_runs)').run();
        movedEventCount = Number(deleted.changes);
        const insertTombstone = db.prepare('INSERT OR IGNORE INTO main.run_tombstones(run_id, envelope) VALUES (?, ?)');
        for (const row of db.prepare('SELECT run_id FROM move_runs').all()) {
          insertTombstone.run(row.run_id, JSON.stringify(tombstoneFor(row.run_id, now)));
        }
        movedRunCount = liveRunCount;
        assertMovedRuns(db, 'main');
        assertMovedRuns(db, 'archive');
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* keep the original failure */ }
        throw error;
      }
    }
    return { threadId: id, movedRunCount, movedEventCount, runIds };
  } finally {
    if (attached) {
      try { db.exec('DETACH archive'); } catch { /* the next thread re-attaches */ }
    }
  }
}

const finishArchive = async (harnessPath, result, vacuum) => {
  if (result.runIds.length) await writeArchiveIndex(harnessPath, result.threadId, result.runIds);
  let vacuumReport;
  if (vacuum && result.movedEventCount > 0) {
    try { vacuumReport = vacuumDatabase(harnessPath); }
    catch (error) { vacuumReport = { vacuumError: error instanceof Error ? error.message : String(error) }; }
  }
  return {
    threadId: result.threadId,
    movedRunCount: result.movedRunCount,
    movedEventCount: result.movedEventCount,
    ...(result.missing ? { missing: true } : {}),
    ...(result.busy ? { busy: true } : {}),
    ...(result.split ? { split: true } : {}),
    ...(vacuumReport ?? {})
  };
};

export async function archiveThreadEvents({ harnessPath, threadId, now = Date.now, vacuum = false } = {}) {
  const id = normalizeThreadId(threadId);
  if (typeof harnessPath !== 'string' || !harnessPath.endsWith('.db')) throw new Error('HARNESS_ARCHIVE_SQLITE_REQUIRED');
  const db = openHarnessDatabase(harnessPath);
  let result;
  try { result = archiveOne(db, harnessPath, id, now); }
  finally { db.close(); }
  return finishArchive(harnessPath, result, vacuum);
}

export async function archiveThreadEventsBatch({ harnessPath, threadIds, now = Date.now, vacuum = false } = {}) {
  if (!Array.isArray(threadIds) || threadIds.length > 500) throw new Error('THREAD_ID_INVALID');
  if (typeof harnessPath !== 'string' || !harnessPath.endsWith('.db')) throw new Error('HARNESS_ARCHIVE_SQLITE_REQUIRED');
  const ids = threadIds.map((threadId) => normalizeThreadId(threadId));
  const db = openHarnessDatabase(harnessPath);
  const results = [];
  try {
    const linkedRuns = linkedRunsByThread(db);
    for (const id of ids) {
      try { results.push(archiveOne(db, harnessPath, id, now, linkedRuns)); }
      catch (error) {
        const message = error?.message ?? '';
        // One session's shared profile stream or leftover run must not put the
        // others back, and must not abort the rest of the batch.
        if (message !== 'THREAD_ARCHIVE_BUSY' && message !== 'HARNESS_ARCHIVE_AGGREGATE_SPLIT') throw error;
        results.push({
          threadId: id, movedRunCount: 0, movedEventCount: 0, runIds: [],
          ...(message === 'THREAD_ARCHIVE_BUSY' ? { busy: true } : { split: true })
        });
      }
    }
  } finally { db.close(); }
  const published = [];
  for (const result of results) published.push(await finishArchive(harnessPath, result, false));
  const movedEventCount = published.reduce((sum, result) => sum + (result.movedEventCount ?? 0), 0);
  let vacuumReport;
  if (vacuum && movedEventCount > 0) {
    try { vacuumReport = vacuumDatabase(harnessPath); }
    catch (error) { vacuumReport = { vacuumError: error instanceof Error ? error.message : String(error) }; }
  }
  return { movedEventCount, threads: published, ...(vacuumReport ?? {}) };
}

export async function restoreThreadEvents({ harnessPath, threadId, vacuum = false, onlyIfArchived = false } = {}) {
  const id = normalizeThreadId(threadId);
  if (typeof harnessPath !== 'string' || !harnessPath.endsWith('.db')) throw new Error('HARNESS_ARCHIVE_SQLITE_REQUIRED');
  const archivePath = archiveDatabasePath(harnessPath);
  const emptyReport = { threadId: id, restoredRunCount: 0, restoredEventCount: 0 };
  if (onlyIfArchived && !existsSync(archivePath)) return emptyReport;
  const indexed = await readArchivedRunIds(harnessPath, id);
  const db = openHarnessDatabase(harnessPath, { verifyIntegrity: !onlyIfArchived });
  let attached = false;
  let restoredEventCount = 0;
  let restoredRunCount = 0;
  try {
    const runIds = new Set([...indexed, ...collectThreadRunIds(db, id, onlyIfArchived ? new Map() : undefined)]);
    if (existsSync(archivePath)) {
      const archiveDb = openHarnessDatabase(archivePath, { readOnly: true, verifyIntegrity: false });
      try {
        const linked = archiveDb.prepare(`SELECT DISTINCT run_id FROM trajectory_events
          WHERE json_extract(envelope, '$.payload.threadId') = ?`).all(id);
        for (const row of linked) addRunId(runIds, row.run_id);
        if (onlyIfArchived && !archiveDb.prepare(`SELECT 1 FROM trajectory_events
          WHERE run_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(JSON.stringify([...runIds]))) return emptyReport;
      } finally { archiveDb.close(); }
    }
    rememberRuns(db, [...runIds]);
    if (!existsSync(archivePath) || runIds.size === 0) {
      restoredRunCount = 0;
    } else {
      db.exec(`ATTACH DATABASE ${sqlLiteral(archivePath)} AS archive`);
      attached = true;
      db.prepare(`DELETE FROM move_runs WHERE run_id NOT IN (
        SELECT run_id FROM archive.trajectory_events
        UNION
        SELECT run_id FROM main.run_tombstones WHERE json_extract(envelope, '$.reasonDigest') = ?
      )`).run(archiveReasonDigest);
      db.prepare(`DELETE FROM move_runs WHERE run_id IN (
        SELECT run_id FROM main.run_tombstones
        WHERE json_extract(envelope, '$.reasonDigest') IS NOT NULL
          AND json_extract(envelope, '$.reasonDigest') <> ?
      )`).run(archiveReasonDigest);
      const restorable = Number(db.prepare('SELECT COUNT(*) AS count FROM move_runs').get().count);
      if (restorable > 0) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare(`INSERT OR IGNORE INTO main.trajectory_events
            SELECT e.* FROM archive.trajectory_events e JOIN move_runs r ON r.run_id = e.run_id`).run();
          db.prepare(`INSERT OR IGNORE INTO main.command_dedup
            SELECT c.* FROM archive.command_dedup c
            WHERE EXISTS (
              SELECT 1 FROM json_each(c.receipt, '$.eventIds') ids
              JOIN archive.trajectory_events e ON e.event_id = ids.value
              JOIN move_runs r ON r.run_id = e.run_id
            )`).run();
          const eventConflict = db.prepare(`SELECT archived.event_id
            FROM archive.trajectory_events archived
            JOIN move_runs r ON r.run_id = archived.run_id
            LEFT JOIN main.trajectory_events live ON live.event_id = archived.event_id
            WHERE live.event_id IS NULL OR live.envelope <> archived.envelope LIMIT 1`).get();
          const receiptConflict = db.prepare(`SELECT archived.command_id
            FROM archive.command_dedup archived
            JOIN json_each(archived.receipt, '$.eventIds') ids
            JOIN archive.trajectory_events e ON e.event_id = ids.value
            JOIN move_runs r ON r.run_id = e.run_id
            LEFT JOIN main.command_dedup live ON live.command_id = archived.command_id
            WHERE live.command_id IS NULL OR live.receipt <> archived.receipt
              OR live.request_digest <> archived.request_digest LIMIT 1`).get();
          if (eventConflict || receiptConflict) throw new Error('HARNESS_ARCHIVE_RESTORE_CONFLICT');
          db.prepare(`DELETE FROM main.run_tombstones
            WHERE run_id IN (SELECT run_id FROM move_runs)
              AND json_extract(envelope, '$.reasonDigest') = ?`).run(archiveReasonDigest);
          const deleted = db.prepare('DELETE FROM archive.trajectory_events WHERE run_id IN (SELECT run_id FROM move_runs)').run();
          restoredEventCount = Number(deleted.changes);
          db.prepare(`DELETE FROM archive.command_dedup WHERE command_id IN (
            SELECT c.command_id FROM main.command_dedup c
            WHERE EXISTS (
              SELECT 1 FROM json_each(c.receipt, '$.eventIds') ids
              JOIN main.trajectory_events e ON e.event_id = ids.value
              JOIN move_runs r ON r.run_id = e.run_id
            )
          )`).run();
          restoredRunCount = restorable;
          assertMovedRuns(db, 'main');
          assertMovedRuns(db, 'archive');
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* keep the original failure */ }
          throw error;
        }
      }
    }
  } finally {
    if (attached) {
      try { db.exec('DETACH archive'); } catch { /* the connection is closing anyway */ }
    }
    db.close();
  }
  await writeArchiveIndex(harnessPath, id, []);
  let vacuumReport;
  if (vacuum && restoredEventCount > 0) {
    try { vacuumReport = vacuumDatabase(archivePath); }
    catch (error) { vacuumReport = { vacuumError: error instanceof Error ? error.message : String(error) }; }
  }
  return { threadId: id, restoredRunCount, restoredEventCount, ...(vacuumReport ?? {}) };
}

export function vacuumHarnessDatabase(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath.endsWith('.db')) throw new Error('HARNESS_ARCHIVE_SQLITE_REQUIRED');
  return vacuumDatabase(storagePath);
}
