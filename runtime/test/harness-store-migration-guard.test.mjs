import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTrajectoryStore } from '../src/trajectory-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { assertLegacyHarnessMigrated } from '../src/harness-store-migration-guard.mjs';

test('default database migration gate requires source-linked history, not just an existing file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-migration-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'hmcodex.db');
  await assertLegacyHarnessMigrated(databasePath);
  const legacy = await createTrajectoryStore(join(directory, 'trajectory.jsonl')).append({ runId: 'old', kind: 'First' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await assert.rejects(stat(databasePath), { code: 'ENOENT' });
  const store = createHarnessEventStore({ storagePath: databasePath });
  await store.load();
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.importLegacyEvents([legacy]);
  await assertLegacyHarnessMigrated(databasePath);
  await store.purgeRun('old');
  await assertLegacyHarnessMigrated(databasePath);
});

test('migration provenance cannot substitute a different run or event kind', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-migration-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'hmcodex.db');
  const legacy = await createTrajectoryStore(join(directory, 'trajectory.jsonl')).append({ runId: 'old', kind: 'First' });
  const store = createHarnessEventStore({ storagePath: databasePath });
  const sourceRef = { store: 'trajectory-jsonl', eventId: legacy.eventId, recordDigest: legacy.recordDigest };
  await store.append({ runId: 'unrelated', kind: legacy.kind, sourceRef, commandId: 'wrong-run' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.append({ runId: legacy.runId, kind: 'Different', sourceRef, commandId: 'wrong-kind' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.append({ runId: legacy.runId, kind: legacy.kind, payload: { changed: true }, sourceRef, commandId: 'wrong-payload' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.append({ runId: legacy.runId, kind: legacy.kind, aggregateType: 'Memory', sourceRef, commandId: 'wrong-aggregate-type' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.append({ runId: legacy.runId, kind: legacy.kind, aggregateId: 'another', sourceRef, commandId: 'wrong-aggregate-id' });
  await assert.rejects(assertLegacyHarnessMigrated(databasePath), /MIGRATION_REQUIRED/);
  await store.importLegacyEvents([legacy]);
  await assertLegacyHarnessMigrated(databasePath);
});
