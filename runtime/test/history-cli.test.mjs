import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';

test('lightweight history CLI matches the main entry point and stays read-only', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const harnessPath = join(directory, 'history.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'run', summary: 'private-summary'.repeat(100) });
  for (let offset = 0; offset < 230; offset += 128) {
    await events.appendBatch(Array.from({ length: Math.min(128, 230 - offset) }, (_, n) => ({
      runId: 'run', kind: 'TaskRunCompleted', payload: { n: offset + n }
    })));
  }
  const env = { ...process.env, HMCODEX_DATA_DIR: directory, HMCODEX_HARNESS_EVENT_STORE: harnessPath,
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY' };
  delete env.HMCODEX_BAKED_RELEASE_CHANNEL;
  delete env.HMCODEX_THREAD_STORE;
  delete env.HMCODEX_TRAJECTORY_STORE;
  const call = async (entry, args) => {
    const start = performance.now();
    const { stdout } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL(`../src/${entry}.mjs`, import.meta.url)), ...args], { env, windowsHide: true });
    return { data: JSON.parse(stdout.trim().split('\n').at(-1)), ms: performance.now() - start };
  };
  const before = await stat(harnessPath);
  const args = ['thread-events', '--thread-id', thread.id];
  const main = await call('index', args);
  const lean = await call('history-cli', args);
  assert.deepEqual(lean.data, main.data);
  assert.equal(lean.data.events.length, 100);
  assert.equal(lean.data.thread.turns, undefined);
  const previous = await call('history-cli', [...args, '--limit', '50', '--before', lean.data.nextCursor]);
  assert.equal(previous.data.events.length, 50);
  assert.ok(previous.data.events.at(-1).sequence < lean.data.events[0].sequence);
  for (const args of [ ['dashboard', '--summary', 'true'], ['thread', '--operation', 'list', '--summary', 'true'],
    ['thread', '--operation', 'get', '--thread-id', thread.id, '--summary', 'true'] ]) {
    assert.deepEqual((await call('history-cli', args)).data, (await call('index', args)).data);
  }
  const after = await stat(harnessPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  for (const args of [['dashboard'], ['recovery'], ['thread', '--operation', 'fork', '--summary', 'true']]) {
    await assert.rejects(call('history-cli', args), (error) => /HISTORY_READ_COMMAND_REQUIRED/.test(error.stdout));
  }
  t.diagnostic(JSON.stringify({ mainColdMs: Math.round(main.ms), historyColdMs: Math.round(lean.ms), events: lean.data.events.length }));
});
