import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { persistJsonFile } from '../src/persistent-json-store.mjs';

const directoryFor = (prefix) => mkdtemp(join(tmpdir(), prefix));

test('reclaims an abandoned lock and replaces the JSON snapshot', async () => {
  const directory = await directoryFor('hmcodex-persistence-lock-');
  const storagePath = join(directory, 'state.json');
  const lockPath = `${storagePath}.lock`;
  await writeFile(lockPath, '{"token":"abandoned","pid":1}\n', 'utf8');
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await persistJsonFile(storagePath, { schemaVersion: 'test', value: 1 }, { staleLockMs: 100, lockTimeoutMs: 2_000 });
  assert.deepEqual(JSON.parse(await readFile(storagePath, 'utf8')), { schemaVersion: 'test', value: 1 });
  await assert.rejects(() => readFile(lockPath), { code: 'ENOENT' });
});

test('backs off and reports a live lock instead of overwriting it', async () => {
  const directory = await directoryFor('hmcodex-persistence-timeout-');
  const storagePath = join(directory, 'state.json');
  const lockPath = `${storagePath}.lock`;
  await writeFile(lockPath, '{"token":"live","pid":1}\n', 'utf8');
  await assert.rejects(
    () => persistJsonFile(storagePath, { schemaVersion: 'test' }, { lockTimeoutMs: 40, staleLockMs: 60_000, retryDelayMs: 2, maxRetryDelayMs: 4 }),
    (error) => error?.code === 'PERSISTENCE_LOCK_TIMEOUT'
  );
});

test('serializes independent Node processes without EPERM or corrupt JSON', async () => {
  const directory = await directoryFor('hmcodex-persistence-concurrent-');
  const storagePath = join(directory, 'state.json');
  const helperUrl = pathToFileURL(fileURLToPath(new URL('../src/persistent-json-store.mjs', import.meta.url))).href;
  const childCode = `
    import { mergeRecordsById, persistJsonFile } from ${JSON.stringify(helperUrl)};
    const file = process.argv[1];
    const worker = process.argv[2];
    for (let iteration = 0; iteration < 12; iteration += 1) {
      await persistJsonFile(file, { schemaVersion: 'test', records: [{ id: worker, worker, iteration, updatedAtMs: Date.now() }] }, {
        lockTimeoutMs: 15_000,
        merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'records' })
      });
    }
  `;
  const runWorker = (worker) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, storagePath, String(worker)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`worker ${worker} exited ${code}: ${stderr}`)));
  });

  await Promise.all(Array.from({ length: 6 }, (_, worker) => runWorker(worker)));
  const final = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(final.schemaVersion, 'test');
  assert.equal(final.records.length, 6);
  assert.deepEqual(new Set(final.records.map((record) => record.worker)), new Set(['0', '1', '2', '3', '4', '5']));
});
