import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { checkpointHarnessDatabase, restoreHarnessDatabase } from '../src/harness-store-checkpoint.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('deleted run IDs refresh across SQLite instances without exposing tombstone metadata', async (t) => {
  const directory = await fixture(t);
  const storagePath = join(directory, 'hmcodex.db');
  const reader = createHarnessEventStore({ storagePath });
  const writer = createHarnessEventStore({ storagePath });
  assert.deepEqual(await reader.listDeletedRunIds(), []);
  await writer.append({ runId: 'removed', kind: 'First', payload: {} });
  await writer.purgeRun('removed');
  assert.deepEqual(await reader.listDeletedRunIds(), ['removed']);
  const ids = await reader.listDeletedRunIds();
  ids.push('local-only');
  assert.deepEqual(await reader.listDeletedRunIds(), ['removed']);
});

test('checkpoint restores verified events, receipts and deletion tombstones', async (t) => {
  const directory = await fixture(t);
  const source = join(directory, 'hmcodex.db');
  const checkpoint = join(directory, 'checkpoint.db');
  const recovered = join(directory, 'recovered.db');
  const store = createHarnessEventStore({ storagePath: source });
  await store.append({ runId: 'keep', kind: 'First', commandId: 'keep-command' });
  await store.append({ runId: 'remove', kind: 'First' });
  await store.purgeRun('remove');
  const report = await checkpointHarnessDatabase(source, checkpoint);
  await store.append({ runId: 'keep', kind: 'Later' });
  const recovery = await restoreHarnessDatabase(checkpoint, recovered);
  assert.deepEqual(recovery, report);
  const restored = createHarnessEventStore({ storagePath: recovered });
  assert.equal((await restored.list()).length, 1);
  assert.equal(restored.getReceipt('keep-command').status, 'COMMITTED');
  await assert.rejects(restored.append({ runId: 'remove', kind: 'Late' }), /TOMBSTONED/);
});

test('recovery never overwrites a destination or creates a missing source', async (t) => {
  const directory = await fixture(t);
  const source = join(directory, 'hmcodex.db');
  const output = join(directory, 'existing.db');
  await createHarnessEventStore({ storagePath: source }).append({ runId: 'r1', kind: 'First' });
  await writeFile(output, 'preserve me');
  await assert.rejects(restoreHarnessDatabase(source, output), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'preserve me');
  await assert.rejects(restoreHarnessDatabase(source, source), /SAME_PATH/);
  const missing = join(directory, 'missing.db');
  await assert.rejects(restoreHarnessDatabase(missing, join(directory, 'new.db')));
  await assert.rejects(stat(missing), { code: 'ENOENT' });
});
