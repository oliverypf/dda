import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertProjectionOutput } from '../src/projection-output-guard.mjs';

test('projection output rejects the source and hard-link aliases without changing files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-projection-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'hmcodex.db');
  const alias = join(directory, 'alias.json');
  await writeFile(source, 'preserved');
  await link(source, alias);
  await assert.rejects(assertProjectionOutput(source, [source]), /OUTPUT_CONFLICT/);
  await assert.rejects(assertProjectionOutput(alias, [source]), /OUTPUT_CONFLICT/);
  await assertProjectionOutput(join(directory, 'projection.json'), [source]);
  assert.equal(await readFile(source, 'utf8'), 'preserved');
});
