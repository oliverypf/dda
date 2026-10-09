import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { readThreadHistory, parseHistoryOptions } from '../src/thread-history-reader.mjs';
import { openHarnessDatabase } from '../src/harness-store-schema.mjs';
import { saveRunResponse, readRunResponse } from '../src/run-response-store.mjs';
import { sha256Digest } from '../src/trajectory-store.mjs';

test('history uses a stable cursor across runs, equal timestamps, new writes, and excluded maintenance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-page-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath, now: () => 2000 });
  const threads = createThreadStore({ eventStore: events });
  const a = await threads.create({ title: 'private-title', cwd: directory });
  const b = await threads.create({ cwd: directory });
  await threads.appendTurn(a.id, { runId: 'a', summary: 'private-turn' });
  await threads.appendTurn(a.id, { runId: 'z', summary: 'private-turn' });
  await threads.appendTurn(b.id, { runId: 'unrelated' });
  for (const runId of ['a', 'z', 'unrelated']) {
    await events.appendBatch(Array.from({ length: 80 }, (_, i) => ({ runId,
      kind: i % 2 ? 'TaskRunCompleted' : 'MemoryStateChanged', payload: { ordinal: i } })));
  }
  const options = { harnessPath, threadId: a.id, limit: 50 };
  const latest = await readThreadHistory(options);
  assert.equal(latest.events.length, 50);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.thread.turnCount, 2);
  assert.equal(latest.thread.turns, undefined);
  await events.append({ runId: 'z', kind: 'TaskRunCompleted' });
  const older = await readThreadHistory({ ...options, before: latest.nextCursor });
  assert.equal(older.events.length, 30);
  assert.equal(older.hasMore, false);
  const all = [...older.events, ...latest.events];
  assert.equal(new Set(all.map((e) => e.eventId)).size, 80);
  assert.ok(all.every((e) => e.runId !== 'unrelated' && e.payload.persistedKind === 'TaskRunCompleted'));
  await assert.rejects(readThreadHistory({ ...options, threadId: b.id, before: latest.nextCursor }), /CURSOR_INVALID/);
  await events.purgeRun('a');
  const afterPurge = await readThreadHistory(options);
  assert.ok(afterPurge.events.every((e) => e.runId === 'z'));
  const fork = await threads.fork(a.id);
  assert.equal((await readThreadHistory({ ...options, threadId: fork.id })).events.length, 41);
  await threads.setCheckpoint(b.id, { runId: 'unfinished', phase: 'PLANNING', plan: { steps: [] } });
  await events.append({ runId: 'unfinished', kind: 'TaskRunCreated' });
  const unfinished = await readThreadHistory({ ...options, threadId: b.id });
  assert.equal(unfinished.thread.resumable, false);
  assert.equal(unfinished.thread.resumeMode, 'INVALID');
  assert.ok(unfinished.events.some((event) => event.runId === 'unfinished'));
  const summaries = await readThreadHistory({ harnessPath, listOnly: true });
  const projected = await createThreadStore({ eventStore: createHarnessEventStore({ storagePath: harnessPath }) }).list();
  assert.deepEqual(summaries.threads, projected.map(({ turns, checkpoint, ...thread }) => ({ ...thread,
    turnCount: turns.length, resumable: false, resumeMode: thread.id === b.id ? 'INVALID' : 'NONE' })));
  assert.ok(!JSON.stringify(summaries).includes('private-turn'));
  await threads.clearCheckpoint(b.id, { state: 'PAUSED' });
  assert.equal((await readThreadHistory({ harnessPath, threadId: b.id, summariesOnly: true })).thread.resumable, false);
  assert.equal((await readThreadHistory({ harnessPath, threadId: b.id, summariesOnly: true })).thread.resumeMode, 'NONE');
  const db = openHarnessDatabase(harnessPath);
  db.prepare("UPDATE trajectory_events SET envelope=json_set(envelope, '$.payload.ordinal', 999) WHERE event_id=?")
    .run(afterPurge.events[0].eventId);
  db.close();
  await assert.rejects(readThreadHistory(options), /DIGEST_INVALID/);
});

test('history distinguishes a real plan, preparation, invalid progress and absent checkpoints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'history-resume-modes-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const threads = createThreadStore({ eventStore: createHarnessEventStore({ storagePath: harnessPath }) });
  for (const [resumeMode, plan, phase] of [
    ['PLAN', { steps: [{ stepId: 'inspect', actionKind: 'READ', dependencies: [] }] }, 'EXECUTING'],
    ['PREPARATION', [{ id: 'classify', status: 'RUNNING', actionDigest: `sha256:${'a'.repeat(64)}` }], 'PLANNING'],
    ['INVALID', { steps: [] }, 'PLANNING'],
    ['NONE', undefined, undefined]
  ]) {
    const thread = await threads.create({ cwd: directory });
    if (plan) await threads.setCheckpoint(thread.id, { runId: `mode-${resumeMode}`, phase, plan });
    const expected = ['PLAN', 'PREPARATION'].includes(resumeMode);
    for (const summariesOnly of [false, true]) {
      const result = await readThreadHistory({ harnessPath, threadId: thread.id, summariesOnly });
      assert.equal(result.thread.resumeMode, resumeMode);
      assert.equal(result.thread.resumable, expected);
    }
    const list = await readThreadHistory({ harnessPath, listOnly: true });
    assert.equal(list.threads.find(item => item.id === thread.id).resumeMode, resumeMode);
    assert.equal(list.threads.find(item => item.id === thread.id).resumable, expected);
  }
});

test('page parameters reject invalid limits and malformed cursors', () => {
  for (const limit of [0, -1, 1.5, 501, NaN, Infinity, 'abc']) {
    assert.throws(() => parseHistoryOptions({ limit }), /LIMIT_INVALID/);
  }
  for (const before of ['', 'abc', 'a'.repeat(2049)]) {
    assert.throws(() => parseHistoryOptions({ threadId: 'x', before }), /CURSOR_INVALID/);
  }
  assert.equal(parseHistoryOptions().limit, 100);
});

test('empty SQLite history does not create a database on a read', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-empty-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  assert.deepEqual(await readThreadHistory({ harnessPath: join(directory, 'missing.db'), listOnly: true }),
    { ok: true, threads: [] });
});


test('restores a local thread title only when it matches the durable title digest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-title-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const threadPath = join(directory, 'threads.json');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ storagePath: threadPath, eventStore: events });
  const created = await threads.create({ title: '持久任务标题', cwd: directory });

  const restored = await readThreadHistory({ harnessPath, threadPath, listOnly: true });
  assert.equal(restored.threads.find((thread) => thread.id === created.id)?.title, '持久任务标题');
  const durableEvents = await events.list({ runId: `thread:${created.id}` });
  assert.equal(JSON.stringify(durableEvents).includes('持久任务标题'), false);

  const local = JSON.parse(await readFile(threadPath, 'utf8'));
  local.threads.find((thread) => thread.id === created.id).title = '被篡改的标题';
  await writeFile(threadPath, JSON.stringify(local), 'utf8');
  const rejected = await readThreadHistory({ harnessPath, threadPath, listOnly: true });
  assert.equal(rejected.threads.find((thread) => thread.id === created.id)?.title,
    `Thread ${created.id.slice(-8)}`);
});

for (const extension of ['db', 'json']) {
  test(`history restores complete responses with pagination, forks and purge (${extension})`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'history-response-'));
    t.after(() => rm(directory, { force: true, recursive: true }));
    const harnessPath = join(directory, `events.${extension}`);
    const threadPath = join(directory, 'threads.json');
    const events = createHarnessEventStore({ storagePath: harnessPath });
    const threads = createThreadStore({ storagePath: threadPath, eventStore: events });
    const thread = await threads.create({ cwd: directory });
    const text = '# 模型回复\n\n' + '保留完整内容、换行和代码。'.repeat(500);
    const outputDigest = sha256Digest(text);
    await threads.appendTurn(thread.id, { runId: 'with-response' });
    await saveRunResponse(harnessPath, 'with-response', text);
    await events.append({ runId: 'with-response', kind: 'TaskRunCompleted', payload: { outputDigest } });
    await threads.appendTurn(thread.id, { runId: 'legacy' });
    await events.append({ runId: 'legacy', kind: 'TaskRunCompleted', payload: { outputDigest } });
    const options = { harnessPath, threadPath, threadId: thread.id, limit: 1 };
    const latest = await readThreadHistory(options);
    assert.equal(latest.events[0].payload.responseUnavailable, true);
    const older = await readThreadHistory({ ...options, before: latest.nextCursor });
    assert.equal(older.events[0].payload.responseText, text);
    assert.equal(older.hasMore, false);
    const fork = await threads.fork(thread.id);
    const forkHistory = await readThreadHistory({ ...options, threadId: fork.id, limit: 10 });
    assert.equal(forkHistory.events.find((e) => e.runId === 'with-response').payload.responseText, text);
    assert.equal(JSON.stringify(await events.list()).includes('保留完整内容'), false);
    assert.equal(JSON.stringify(await readThreadHistory({ harnessPath, threadPath, listOnly: true })).includes('保留完整内容'), false);
    await saveRunResponse(harnessPath, 'with-response', 'mismatched content');
    const damaged = await readThreadHistory({ ...options, before: latest.nextCursor });
    assert.equal(damaged.events[0].payload.responseText, undefined);
    assert.equal(damaged.events[0].payload.responseUnavailable, true);
    await saveRunResponse(harnessPath, 'with-response', text);
    await events.purgeRun('with-response');
    assert.equal(await readRunResponse(harnessPath, 'with-response', outputDigest), undefined);
    assert.equal((await readThreadHistory({ ...options, limit: 10 })).events.some((e) => e.runId === 'with-response'), false);
    await events.purgeRun('with-response');
  });
}
