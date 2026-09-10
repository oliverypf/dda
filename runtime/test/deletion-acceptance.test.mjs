import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createReadModelRebuilder } from '../src/read-model-rebuilder.mjs';

const invoke = (args, env) => promisify(execFile)(process.execPath, [
  fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
  ...args
], { env, windowsHide: true });

test('purged run leaves only a tombstone and cannot be resurrected by caches or exports', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-deletion-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const readModelPath = `${harness}.read-model.json`;
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-a', kind: 'TaskRunCreated', commandId: 'a-created', payload: { title: 'A' } });
  await eventStore.append({ runId: 'run-a', kind: 'TaskRunCompleted', commandId: 'a-completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  await eventStore.append({ runId: 'run-b', kind: 'TaskRunCreated', commandId: 'b-created', payload: { title: 'B' } });
  await eventStore.append({ runId: 'run-b', kind: 'TaskRunCompleted', commandId: 'b-completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  const rebuilder = createReadModelRebuilder({ eventStore });
  const before = await rebuilder.rebuild({ storagePath: readModelPath });
  assert.equal(before.runCount, 2);

  const purged = await eventStore.purgeRun('run-a', { reason: 'USER_REQUESTED' });
  assert.equal(purged.status, 'COMMITTED');
  assert.deepEqual(await eventStore.list({ runId: 'run-a' }), []);
  assert.equal(eventStore.getReceipt('a-created'), undefined);
  assert.ok((await eventStore.listDeletedRunIds()).includes('run-a'));
  let tombstoneError;
  try {
    await eventStore.append({ runId: 'run-a', kind: 'Observed' });
  } catch (error) {
    tombstoneError = error;
  }
  assert.match(tombstoneError?.message ?? '', /HARNESS_RUN_TOMBSTONED/);

  const after = await rebuilder.rebuild({ storagePath: readModelPath });
  assert.equal(after.runCount, 1);
  assert.deepEqual(after.runs.map((run) => run.runId), ['run-b']);
  assert.equal(after.timeline.some((item) => item.runId === 'run-a'), false);

  const env = {
    ...process.env,
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness
  };
  const exportPath = join(directory, 'export-run-a.json');
  const exported = JSON.parse((await invoke(['export-data', '--run-id', 'run-a', '--output', exportPath], env)).stdout);
  assert.equal(exported.eventCount, 0);
  const metrics = JSON.parse((await invoke(['metrics'], env)).stdout);
  assert.equal(metrics.metrics.runCount, 1);
  assert.equal(metrics.metrics.nonTerminalRuns, 0);

  await writeFile(readModelPath, JSON.stringify({
    ...after,
    runCount: 2,
    runs: [...after.runs, { runId: 'run-a', title: 'A', state: 'SUCCEEDED', startedAtMs: 1, lastEventSequence: 2, terminal: true }]
  }), 'utf8');
  const staleCheck = JSON.parse((await invoke(['projection-check'], env)).stdout);
  assert.equal(staleCheck.verification.ok, false);
  const rebuilt = JSON.parse((await invoke(['rebuild-read-model'], env)).stdout);
  assert.equal(rebuilt.projection.runCount, 1);
  assert.equal(rebuilt.projection.runs.some((run) => run.runId === 'run-a'), false);
  const cleanCheck = JSON.parse((await invoke(['projection-check'], env)).stdout);
  assert.equal(cleanCheck.verification.ok, true);
});
