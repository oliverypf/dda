import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createThreadStore } from '../src/thread-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

test('thread history reads the scoped SQLite database without truncating at 512 events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-thread-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const events = createHarnessEventStore({ storagePath: `${trajectory}.db` });
  await events.importLegacyEvents(Array.from({ length: 513 }, (_, i) => ({ eventId: `source-${i}`, runId: 'r1', kind: 'Observed', payload: { ordinal: i } })));
  const threads = createThreadStore({ storagePath: `${trajectory}.threads.json`, eventStore: events });
  const thread = await threads.create({ cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'r1', summary: 'fixture' });
  const env = { ...process.env, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', HMCODEX_TRAJECTORY_STORE: trajectory, HMCODEX_DATA_DIR: directory };
  delete env.HMCODEX_HARNESS_EVENT_STORE;
  delete env.HMCODEX_THREAD_STORE;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'thread-events', '--thread-id', thread.id], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.events.length, 513);
  assert.equal(payload.events[0].payload.ordinal, 0);
  assert.equal(payload.events.at(-1).payload.ordinal, 512);
  assert.ok(payload.events.every((event) => event.eventId));
  const dashboard = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'dashboard'], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const model = JSON.parse(dashboard.stdout);
  assert.equal(model.projectionError, undefined);
  assert.equal(model.projection.runCount, 1);
  assert.equal(model.projection.timeline.length, 200);
  assert.ok(model.projection.timelinePage.total >= 513);
  assert.equal(model.projection.timelinePage.hasMore, true);
  assert.equal(model.threads[0].id, thread.id);
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const invoke = async (command) => JSON.parse((await promisify(execFile)(process.execPath, [cli, command], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
  const rebuilt = await invoke('rebuild-read-model');
  assert.equal(rebuilt.projection.projectionChecksum, model.projection.projectionChecksum);
  assert.ok(rebuilt.projection.timeline.length >= 513);
  const secondPage = JSON.parse((await promisify(execFile)(
    process.execPath,
    [cli, 'rebuild-read-model', '--timeline-cursor', '200', '--timeline-limit', '500'],
    { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  )).stdout);
  assert.equal(secondPage.timelinePage.items.length, secondPage.timelinePage.total - 200);
  assert.equal(secondPage.timelinePage.hasMore, false);
  const checked = await invoke('projection-check');
  assert.equal(checked.verification.ok, true);
  await events.append({ runId: 'r2', kind: 'TaskRunCreated' });
  await invoke('rebuild-read-model');
  const globalProjectionPath = `${trajectory}.db.read-model.json`;
  const beforeReplay = await readFile(globalProjectionPath, 'utf8');
  const replay = await promisify(execFile)(process.execPath, [cli, 'replay-run', '--run-id', 'r1'], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(JSON.parse(replay.stdout).projection.runCount, 1);
  assert.equal(await readFile(globalProjectionPath, 'utf8'), beforeReplay);
  assert.equal((await invoke('projection-check')).verification.ok, true);
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'replay-run', '--run-id', 'r1', '--output', globalProjectionPath], { env, windowsHide: true }), (error) => {
    assert.match(error.stdout, /READ_MODEL_REPLAY_OUTPUT_CONFLICT/);
    return true;
  });
  await assert.rejects(readFile(trajectory), { code: 'ENOENT' });
});
