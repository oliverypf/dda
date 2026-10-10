import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseLegacyTrajectoryEvents } from './trajectory-store.mjs';
import { validateHarnessStore } from './harness-event-store.mjs';
import { openHarnessDatabase, readHarnessDatabase } from './harness-store-schema.mjs';

const optionalRead = async (path) => readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});

// This check never creates the destination. A renamed empty database is not
// evidence that legacy history has been migrated.
export async function assertLegacyHarnessMigrated(databasePath) {
  if (!databasePath) return;
  const directory = dirname(databasePath);
  const trajectory = await optionalRead(join(directory, 'trajectory.jsonl'));
  const harness = await optionalRead(join(directory, 'harness-events.json'));
  const sources = [];
  if (trajectory !== undefined) sources.push(...parseLegacyTrajectoryEvents(trajectory).map((event) => ({ event, store: 'trajectory-jsonl' })));
  let oldTombstones = [];
  if (harness !== undefined) {
    const snapshot = JSON.parse(harness);
    validateHarnessStore(snapshot);
    sources.push(...snapshot.events.map((event) => ({ event, store: 'harness-json' })));
    oldTombstones = snapshot.tombstones ?? [];
  }
  if (!sources.length && !oldTombstones.length) return;
  let db;
  try { db = openHarnessDatabase(databasePath, { readOnly: true }); }
  catch { throw new Error('HARNESS_LEGACY_MIGRATION_REQUIRED'); }
  try {
    const snapshot = readHarnessDatabase(db);
    validateHarnessStore(snapshot);
    const deletedRuns = new Set(snapshot.tombstones.map((item) => item.runId));
    // Imported envelopes have new IDs, sequences and timestamps. Compare the
    // preserved fact fields, not the newly generated envelope digest.
    const sourceKey = (store, eventId, recordDigest, event) => JSON.stringify([
      store, eventId, recordDigest, event.runId, event.kind,
      event.aggregateType ?? 'TaskRun', event.aggregateId ?? event.runId, event.payloadDigest
    ]);
    const importedSources = new Set(snapshot.events.filter((event) => event.sourceRef).map((event) =>
      sourceKey(event.sourceRef.store, event.sourceRef.eventId, event.sourceRef.recordDigest, event)));
    for (const { event, store } of sources) {
      const imported = importedSources.has(sourceKey(store, event.eventId, event.recordDigest, event));
      if (!imported && !deletedRuns.has(event.runId)) throw new Error('HARNESS_LEGACY_MIGRATION_REQUIRED');
    }
    if (oldTombstones.some((item) => !deletedRuns.has(item.runId))) throw new Error('HARNESS_LEGACY_MIGRATION_REQUIRED');
  } finally { db.close(); }
}
