import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessStorageCapacity, assertStorageCapacityForRun } from '../src/storage-capacity.mjs';

test('reports bounded storage levels without exposing paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-capacity-'));
  const file = join(directory, 'store.json');
  await writeFile(file, '1234567890');
  const assessment = await assessStorageCapacity({ paths: [file, file], maxBytes: 20, warningRatio: 0.5, criticalRatio: 0.75, hardRatio: 0.95 });
  assert.equal(assessment.totalBytes, 10);
  assert.equal(assessment.level, 'WARNING');
  assert.equal(assessment.fileCount, 1);
  assert.equal('path' in assessment.entries[0], false);
});

test('blocks only new runs at the hard capacity threshold', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-capacity-hard-'));
  const file = join(directory, 'store.json');
  await writeFile(file, '12345678901234567890');
  await assert.rejects(() => assertStorageCapacityForRun({ paths: [file], maxBytes: 20 }), /STORAGE_CAPACITY_HARD_LIMIT/);
  const warning = await assertStorageCapacityForRun({ paths: [file], maxBytes: 100 });
  assert.equal(warning.level, 'OK');
});

test('SQLite capacity includes journal sidecars without double counting explicit entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-capacity-sqlite-'));
  const file = join(directory, 'hmcodex.db');
  await writeFile(file, 'x'.repeat(60));
  await writeFile(`${file}-wal`, 'x'.repeat(40));
  const assessment = await assessStorageCapacity({ paths: [file, `${file}-wal`], maxBytes: 100 });
  assert.equal(assessment.totalBytes, 100);
  assert.equal(assessment.fileCount, 2);
  assert.equal(assessment.level, 'HARD_LIMIT');
  await assert.rejects(assertStorageCapacityForRun({ paths: [file], maxBytes: 100 }), /HARD_LIMIT/);
});

test('rejects invalid threshold ordering and capacity limits', async () => {
  await assert.rejects(() => assessStorageCapacity({ maxBytes: 0 }), /STORAGE_CAPACITY_LIMIT_INVALID/);
  await assert.rejects(() => assessStorageCapacity({ warningRatio: 0.9, criticalRatio: 0.8 }), /STORAGE_CAPACITY_THRESHOLDS_INVALID/);
});

test('maps the 70/85/95 thresholds to warning, critical, and hard limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-capacity-thresholds-'));
  const file = join(directory, 'store.json');
  const assess = async (bytes) => {
    await writeFile(file, 'x'.repeat(bytes));
    return assessStorageCapacity({ paths: [file], maxBytes: 1000 });
  };
  assert.equal((await assess(699)).level, 'OK');
  assert.equal((await assess(700)).level, 'WARNING');
  assert.equal((await assess(849)).level, 'WARNING');
  assert.equal((await assess(850)).level, 'CRITICAL');
  assert.equal((await assess(949)).level, 'CRITICAL');
  assert.equal((await assess(950)).level, 'HARD_LIMIT');
  assert.equal((await assess(1000)).level, 'HARD_LIMIT');
  await writeFile(file, 'x'.repeat(850));
  const critical = await assertStorageCapacityForRun({ paths: [file], maxBytes: 1000 });
  assert.equal(critical.level, 'CRITICAL');
  await writeFile(file, 'x'.repeat(950));
  await assert.rejects(() => assertStorageCapacityForRun({ paths: [file], maxBytes: 1000 }), /STORAGE_CAPACITY_HARD_LIMIT/);
});
