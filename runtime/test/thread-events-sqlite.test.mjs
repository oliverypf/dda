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

test('thread history pages the scoped SQLite database without losing events after 512', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-thread-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const events = createHarnessEventStore({ storagePath: `${trajectory}.db` });
  await events.importLegacyEvents(Array.from({ length: 513 }, (_, i) => ({
    eventId: `source-${i}`,
    runId: 'r1',
    kind: 'ToolInvocationCompleted',
    payload: { ordinal: i, toolName: 'fixture.read', status: 'SUCCEEDED' }
  })));
  const threads = createThreadStore({ storagePath: `${trajectory}.threads.json`, eventStore: events });
  const thread = await threads.create({ cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'r1', summary: 'fixture' });
  const env = { ...process.env, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', HMCODEX_TRAJECTORY_STORE: trajectory, HMCODEX_DATA_DIR: directory };
  delete env.HMCODEX_HARNESS_EVENT_STORE;
  delete env.HMCODEX_THREAD_STORE;
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'thread-events', '--thread-id', thread.id], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.events.length, 100);
  assert.equal(payload.events[0].payload.ordinal, 413);
  assert.equal(payload.events.at(-1).payload.ordinal, 512);
  assert.ok(payload.events.every((event) => event.eventId));
  assert.equal(payload.thread.turnCount, 1);
  assert.equal(payload.thread.turns, undefined);
  let page = payload;
  let all = page.events;
  while (page.hasMore) {
    page = JSON.parse((await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'thread-events', '--thread-id', thread.id,
        '--before', page.nextCursor], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
    assert.ok(page.events.length <= 100);
    all = [...page.events, ...all];
  }
  assert.equal(new Set(all.map((event) => event.eventId)).size, 513);
  assert.deepEqual(all.map((event) => event.payload.ordinal), Array.from({ length: 513 }, (_, i) => i));
  const summary = JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'dashboard', '--summary', 'true'],
    { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(summary.summaryOnly, true);
  assert.equal(summary.projection, undefined);
  assert.equal(summary.threads[0].turns, undefined);
  assert.equal(summary.threads[0].id, thread.id);
  const dashboard = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'dashboard'], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const model = JSON.parse(dashboard.stdout);
  assert.equal(model.projectionError, undefined);
  assert.equal(model.projection.runCount, 1);
  assert.equal(model.projection.timeline.length, 200);
  assert.ok(model.projection.timelinePage.total >= 513);
  assert.equal(model.projection.timelinePage.hasMore, true);
  assert.equal(model.threads[0].id, thread.id);
  const summaryDashboard = JSON.parse((await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'dashboard', '--timeline-limit', '0'
  ], { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(summaryDashboard.projection.timeline.length, 0);
  assert.equal(summaryDashboard.projection.timelinePage.items.length, 0);
  assert.equal(summaryDashboard.projection.timelinePage.total, model.projection.timelinePage.total);
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
