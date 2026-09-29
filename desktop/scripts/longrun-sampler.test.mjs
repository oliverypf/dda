import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleLongRun } from './longrun-sampler.mjs';
import { createHarnessEventStore } from '../../runtime/src/harness-event-store.mjs';

test('the sampler credits only the wall clock between real samples', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-longrun-sampler-'));
  const statePath = join(root, 'longrun.json');
  const base = 1_700_000_000_000;
  const first = await sampleLongRun({ statePath, nowMs: base });
  assert.equal(first.status, 'PENDING_OBSERVATION');
  assert.equal(first.samples, 1);
  const second = await sampleLongRun({ statePath, nowMs: base + 60_000 });
  assert.equal(second.observedMinutes, 1);
  assert.equal(second.sessions, 1);
  // A gap past the two-minute tolerance opens a new session instead of
  // crediting the machine's idle time.
  const third = await sampleLongRun({ statePath, nowMs: base + 60 * 60_000 });
  assert.equal(third.sessions, 2);
  assert.equal(third.observedMinutes, 1);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.artifact, 'WINDOWS_PHASE2_W10_LONGRUN_STATE');
  assert.equal(state.samples, 3);
  assert.equal(JSON.stringify(state).includes('NaN'), false);
});

test('the sampler records a real store count and fails closed without a state path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-longrun-store-'));
  const statePath = join(root, 'longrun.json');
  const storePath = join(root, 'store.db');
  await writeFile(storePath, '', 'utf8');
  const result = await sampleLongRun({ statePath, storePath, nowMs: 1_700_000_000_000 });
  assert.equal(result.samples, 1);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.lastSample.storePath, storePath);
  // A freshly created store is a real (empty) read, so the count is a number.
  assert.equal(typeof state.lastSample.eventCount, 'number');
  // A missing store must not block the observation, and the sample records no
  // count rather than a fabricated one.
  await sampleLongRun({ statePath, storePath: join(root, 'absent.db'), nowMs: 1_700_000_060_000 });
  const second = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(second.lastSample.storePath, join(root, 'absent.db'));
  assert.equal(second.lastSample.eventCount, undefined);
  await assert.rejects(() => sampleLongRun({ storePath }), /LONG_RUN_STATE_PATH_REQUIRED/u);
});

test('each sample names the physical store file it read', async () => {
  const localAppData = await mkdtemp(join(tmpdir(), 'hmcodex-longrun-physical-'));
  const profileRoot = join(localAppData, 'hmCodex');
  await mkdir(profileRoot, { recursive: true });
  const storePath = join(profileRoot, 'hmcodex.db');
  await createHarnessEventStore({ storagePath: storePath }).load();
  const twin = join(localAppData, 'Packages', 'Example.App_123', 'LocalCache', 'Local', 'hmCodex', 'hmcodex.db');
  await mkdir(join(twin, '..'), { recursive: true });
  await createHarnessEventStore({ storagePath: twin }).load();

  const statePath = join(localAppData, 'longrun.json');
  await sampleLongRun({ statePath, storePath, nowMs: 1_700_000_000_000, storeIdentityOptions: { localAppData, aliasRoot: null } });
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.lastSample.storePath, storePath);
  assert.equal(state.lastSample.eventCount, 0);
  assert.equal(state.lastSample.redirection, undefined);
  assert.equal(state.lastSample.additionalStores.length, 1);
  assert.equal(state.lastSample.additionalStores[0].role, 'PACKAGE_LOCAL_CACHE_COPY');
  assert.equal(state.lastSample.additionalStores[0].packageFamily, 'Example.App_123');
  assert.equal(state.lastSample.additionalStores[0].eventCount, 0);
});
