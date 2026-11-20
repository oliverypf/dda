import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { readThreadHistory, parseHistoryOptions } from '../src/thread-history-reader.mjs';
import { openHarnessDatabase } from '../src/harness-store-schema.mjs';
import { saveRunImages, saveRunResponse, readRunResponse, saveRunThinking } from '../src/run-response-store.mjs';
import { sha256Digest } from '../src/trajectory-store.mjs';

test('history restores image attachments from the local run content store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-images-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '带图片的任务', cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'image-run', summary: '带图片', state: 'SUCCEEDED' });
  const input = [{ name: 'screen.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,QQ==' }];
  const refs = await saveRunImages(harnessPath, 'image-run', input);
  await events.append({ runId: 'image-run', kind: 'TaskRunCreated', payload: { imageRefs: refs } });
  const history = await readThreadHistory({ harnessPath, threadId: thread.id });
  const created = history.events.find((event) => event.payload.persistedKind === 'TaskRunCreated');
  assert.deepEqual(created?.payload.images, input);
});

test('history restores thinking content and durable tool requests after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-live-trace-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '可恢复轨迹', cwd: directory });
  await threads.appendTurn(thread.id, { runId: 'trace-run', summary: 'trace', state: 'SUCCEEDED' });
  const thinkingDigest = await saveRunThinking(harnessPath, 'trace-run', '先检查项目结构，再运行验证。');
  await events.append({ runId: 'trace-run', kind: 'TaskRunCreated', payload: {} });
  await events.append({ runId: 'trace-run', kind: 'ToolCallRequested', payload: {
    id: 'call-1', name: 'workspace.list', round: 1
  } });
  await events.append({ runId: 'trace-run', kind: 'ToolInvocationCompleted', payload: {
    id: 'call-1', name: 'workspace.list', ok: true, outputChars: 42
  } });
  await events.append({ runId: 'trace-run', kind: 'TaskRunCompleted', payload: {
    outputDigest: 'sha256:' + 'a'.repeat(64), reasoningDigest: thinkingDigest
  } });
  const history = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 20 });
  assert.ok(history.events.some((event) => event.payload.persistedKind === 'ToolCallRequested'));
  const completed = history.events.find((event) => event.payload.persistedKind === 'TaskRunCompleted');
  assert.equal(completed?.payload.thinkingText, '先检查项目结构，再运行验证。');
});

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

test('history groups later runs of one conversation by session id', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-session-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '编译exe', cwd: directory });
  await threads.attachRun(thread.id, { runId: 'source-run', sessionId: 'ui-session-1' });
  await events.append({ runId: 'source-run', kind: 'ToolCallRequested', payload: { id: 'call-1', name: 'workspace.list' } });
  await events.append({ runId: 'source-run', kind: 'ToolInvocationCompleted', payload: { name: 'workspace.list', ok: true, outputChars: 12 } });
  // A later launch may pass a new slot id. The conversation keeps the first one.
  await threads.attachRun(thread.id, { runId: 'resume-run', sessionId: 'ui-session-2' });
  await events.append({ runId: 'resume-run', kind: 'TaskRunFailed', payload: { code: 'PLAN_STEP_FAILED', stepId: 'inspect-build-config' } });
  await threads.setCheckpoint(thread.id, { runId: 'foreign-run', phase: 'EXECUTING', state: 'RUNNING' });
  await events.append({ runId: 'foreign-run', kind: 'ToolInvocationCompleted', payload: { name: 'secret.tool', ok: true } });
  const history = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 50 });
  assert.equal(history.thread.sessionId, 'ui-session-1');
  assert.deepEqual([...new Set(history.events.map((event) => event.runId))].sort(), ['resume-run', 'source-run']);
  assert.equal(history.events.some((event) => event.payload.name === 'workspace.list'), true);
  assert.equal(history.events.some((event) => event.payload.persistedKind === 'TaskRunFailed'), true);
  assert.equal(history.events.some((event) => event.runId === 'foreign-run' || event.payload.name === 'secret.tool'), false);
});

test('resumed history keeps tool events from earlier checkpoints of the same thread', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-resume-lineage-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const events = createHarnessEventStore({ storagePath: harnessPath });
  const threads = createThreadStore({ eventStore: events });
  const thread = await threads.create({ title: '编译exe', cwd: directory });
  const other = await threads.create({ title: '其他任务', cwd: directory });
  await events.append({ runId: 'source-run', kind: 'TaskRunCreated', payload: { requestedMode: 'CONTROLLED' } });
  await events.append({ runId: 'source-run', kind: 'ToolCallRequested', payload: { id: 'call-1', name: 'workspace.list' } });
  await events.append({ runId: 'source-run', kind: 'ToolInvocationCompleted', payload: {
    name: 'workspace.list', ok: true, outputChars: 20
  } });
  await threads.setCheckpoint(thread.id, { runId: 'source-run', phase: 'EXECUTING', state: 'RUNNING' });
  await events.append({ runId: 'other-run', kind: 'ToolInvocationCompleted', payload: { name: 'secret.tool', ok: true } });
  await threads.setCheckpoint(other.id, { runId: 'other-run', phase: 'EXECUTING', state: 'RUNNING' });
  await events.append({ runId: 'resume-run', kind: 'TaskRunCreated', payload: { sourceRunId: 'source-run', requestedMode: 'CONTROLLED' } });
  await events.append({ runId: 'resume-run', kind: 'TaskRunFailed', payload: { code: 'PLAN_STEP_FAILED', stepId: 'inspect-build-config' } });
  await threads.setCheckpoint(thread.id, {
    runId: 'resume-run', phase: 'RECOVERING', state: 'FAILED',
    plan: { steps: [{ stepId: 'inspect-build-config', actionKind: 'INSPECT', dependencies: [], status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' }] }
  });
  await threads.appendTurn(thread.id, { runId: 'resume-run', summary: 'failed', state: 'FAILED' });
  const history = await readThreadHistory({ harnessPath, threadId: thread.id, limit: 50 });
  const runIds = new Set(history.events.map((event) => event.runId));
  assert.deepEqual([...runIds].sort(), ['resume-run', 'source-run']);
  assert.equal(history.events.some((event) => event.payload.persistedKind === 'ToolInvocationCompleted' && event.payload.name === 'workspace.list'), true);
  assert.equal(history.events.some((event) => event.payload.persistedKind === 'TaskRunFailed'), true);
  assert.equal(history.events.some((event) => event.runId === 'other-run' || event.payload.name === 'secret.tool'), false);
});

test('a checkpoint with an uncertain side-effect step is reported blocked, not resumable, and clears on replace/clear', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'history-recovery-block-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const harnessPath = join(directory, 'events.db');
  const threads = createThreadStore({ eventStore: createHarnessEventStore({ storagePath: harnessPath }) });
  const uncertainPlan = { steps: [
    { stepId: 'inspect', actionKind: 'READ', dependencies: [], status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
    { stepId: 'inspect', actionKind: 'READ', dependencies: [], status: 'BLOCKED', errorCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN' },
    { stepId: 'build', actionKind: 'WRITE', dependencies: ['inspect'], status: 'BLOCKED', errorCode: 'OTHER_CODE' },
    { stepId: 'pending', actionKind: 'WRITE', dependencies: ['inspect'], status: 'PENDING' }
  ] };
  const healthyPlan = { steps: [{ stepId: 'build', actionKind: 'WRITE', dependencies: [], status: 'FAILED', errorCode: 'EXECUTOR_SPAWN_FAILED' }] };
  const expectedBlock = { reasonCode: 'SIDE_EFFECT_OUTCOME_UNCERTAIN', stepIds: ['inspect'] };
  const thread = await threads.create({ cwd: directory, title: 'blocked-thread' });
  await threads.setCheckpoint(thread.id, { runId: 'blocked-run', phase: 'EXECUTING', state: 'FAILED', plan: uncertainPlan });
  const listed = (await readThreadHistory({ harnessPath, listOnly: true })).threads.find((item) => item.id === thread.id);
  assert.equal(listed.resumeMode, 'PLAN');
  assert.equal(listed.resumable, false);
  assert.deepEqual(listed.recoveryBlock, expectedBlock);
  const summariesOnly = (await readThreadHistory({ harnessPath, threadId: thread.id, summariesOnly: true })).thread;
  assert.equal(summariesOnly.resumeMode, 'PLAN');
  assert.equal(summariesOnly.resumable, false);
  assert.deepEqual(summariesOnly.recoveryBlock, expectedBlock);
  const full = (await readThreadHistory({ harnessPath, threadId: thread.id, limit: 5 })).thread;
  assert.equal(full.resumable, false);
  assert.deepEqual(full.recoveryBlock, expectedBlock);
  // An ordinary failed plan keeps the previous resumable shape.
  await threads.setCheckpoint(thread.id, { runId: 'healthy-run', phase: 'EXECUTING', state: 'FAILED', plan: healthyPlan });
  const healthy = (await readThreadHistory({ harnessPath, threadId: thread.id, summariesOnly: true })).thread;
  assert.equal(healthy.resumeMode, 'PLAN');
  assert.equal(healthy.resumable, true);
  assert.equal(healthy.recoveryBlock, undefined);
  // Re-block, then clearing the checkpoint drops the stale block.
  await threads.setCheckpoint(thread.id, { runId: 'blocked-run-2', phase: 'EXECUTING', state: 'FAILED', plan: uncertainPlan });
  assert.deepEqual((await readThreadHistory({ harnessPath, threadId: thread.id, summariesOnly: true })).thread.recoveryBlock, expectedBlock);
  await threads.clearCheckpoint(thread.id);
  const cleared = (await readThreadHistory({ harnessPath, threadId: thread.id, summariesOnly: true })).thread;
  assert.equal(cleared.resumeMode, 'NONE');
  assert.equal(cleared.resumable, false);
  assert.equal(cleared.recoveryBlock, undefined);
});
