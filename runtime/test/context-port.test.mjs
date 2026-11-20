import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appliedMemoryIds } from '../src/experience-extractor.mjs';
import { createMemoryJournal } from '../src/memory-journal.mjs';
import { createJournalContextPort } from '../src/journal-context-port.mjs';

test('journal context port recalls bounded active records and tracks usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-context-port-'));
  const journal = createMemoryJournal({ storagePath: join(directory, 'memory.json'), now: () => 1000 });

  const record = journal.propose({ runId: 'run-1', statement: 'Use the bounded workspace reader', sourceEventIds: ['event-1'], workspacePath: directory, scope: 'project', confidence: 0.9 });
  journal.verify(record.memoryId, { accepted: true, reason: 'source-backed' });
  journal.activate(record.memoryId);
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: 'workspace reader', workspacePath: directory, scope: 'project' });
  assert.equal(recalled.status, 'AVAILABLE');
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].statement, 'Use the bounded workspace reader');
  const used = await port.used({ runId: 'run-2', memoryIds: [record.memoryId] });
  assert.equal(used.used[0].useCount, 1);
  const committed = await port.commit({ memoryIds: [record.memoryId] });
  assert.deepEqual(committed.memoryIds, [record.memoryId]);
});

test('context port uses recorded skills and memories without a review gate', async () => {
  const journal = createMemoryJournal();
  const lesson = journal.propose({
    runId: 'run-1',
    statement: '安全边界经验：宿主受保护目录禁止读取。',
    sourceEventIds: ['event-1'],
    workspacePath: '/team/app', scope: 'workspace',
    key: 'pitfall:safety-protected-path'
  });
  const scratch = journal.propose({
    runId: 'run-1',
    statement: '项目命令经验：执行 `node .codex-tmp/digest.mjs`。',
    sourceEventIds: ['event-2'],
    workspacePath: '/team/app', scope: 'workspace',
    key: 'workflow:cmd:tmp'
  });
  const outcome = journal.propose({
    runId: 'run-1',
    statement: `Verified task outcome: class=unknown; verifier=PASS; outputDigest=sha256:${'a'.repeat(64)}`,
    sourceEventIds: ['event-3'],
    workspacePath: '/team/app', scope: 'workspace',
    kind: 'TASK_OUTCOME'
  });
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: '', workspacePath: '/team/app', scope: 'workspace' });
  const ids = recalled.items.map((item) => item.memoryId);
  assert.ok(ids.includes(lesson.memoryId));
  assert.equal(ids.includes(scratch.memoryId), false);
  assert.equal(ids.includes(outcome.memoryId), false);
  await assert.rejects(() => port.recall({ limit: 65 }), /CONTEXT_RECALL_OPTIONS_INVALID/);
});

test('journal context port matches unspaced Chinese prompts and ranks matching lessons ahead of general project guidance', async () => {
  const journal = createMemoryJournal({ now: () => 2000 });
  const general = journal.propose({
    runId: 'run-g',
    statement: '安全边界经验：宿主受保护目录禁止读取。',
    sourceEventIds: ['ev-g'],
    workspacePath: '/team/app', scope: 'workspace',
    kind: 'PROJECT',
    confidence: 0.9
  });
  const buildLesson = journal.propose({
    runId: 'run-b',
    statement: '项目命令经验（编译exe）：在工作区 `desktop` 目录执行 `npm run build:windows:full-local` 已核验可成功完成命令/构建。',
    sourceEventIds: ['ev-b'],
    workspacePath: '/team/app', scope: 'workspace',
    kind: 'PROJECT',
    confidence: 0.9
  });
  for (const m of [general, buildLesson]) {
    journal.verify(m.memoryId, { accepted: true });
    journal.activate(m.memoryId);
  }
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: '帮我编译exe文件', workspacePath: '/team/app', scope: 'workspace' });
  assert.equal(recalled.items.length, 1);
  assert.equal(recalled.items[0].memoryId, buildLesson.memoryId, 'Chinese bigram + exe matches the relevant build lesson');
  assert.ok(recalled.items[0].score > 0);
});


test('a stored lesson is recalled only by its own project and legacy ownership must be unambiguous', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-context-project-'));
  const storagePath = join(directory, 'memory.json');
  const journal = createMemoryJournal({ storagePath });
  const port = createJournalContextPort({ journal });
  const input = { runId: 'a', scope: 'workspace', statement: 'Build artifacts with project-build',
    sourceEventIds: ['event-a'], key: 'workflow:cmd:工作区根目录:project-build', kind: 'SKILL' };
  const { memory } = await port.record({ ...input, workspacePath: 'C:/Team/Project-A/' });
  await port.record({ ...input, runId: 'legacy', statement: 'Build legacy artifacts', key: 'legacy-build' });
  await port.commit({ memoryIds: [memory.memoryId] });
  const reloaded = createMemoryJournal({ storagePath });
  await reloaded.load();
  const again = createJournalContextPort({ journal: reloaded });
  const recall = workspacePath => again.recall({ workspacePath, query: 'Build artifacts' });
  assert.equal((await recall('c:\\team\\project-a')).items[0].memoryId, memory.memoryId);
  assert.equal((await recall('c:\\team\\project-a')).items.length, 1);
  assert.deepEqual((await recall('C:/Team/Project-B')).items, []);
  assert.deepEqual((await recall(undefined)).items, []);
  assert.deepEqual((await again.recall({ workspacePath: 'C:/Team/Project-A', query: 'ocean waves' })).items, []);
  const receipts = [{ name: 'shell.execute', state: 'SUCCEEDED', command: 'project-build', args: [] }];
  const items = (await recall('C:/Team/Project-A')).items;
  assert.deepEqual(appliedMemoryIds(items, '', receipts), []);
  assert.deepEqual(appliedMemoryIds(items, memory.statement, []), []);
  const used = appliedMemoryIds(items, memory.statement, receipts);
  assert.deepEqual(used, [memory.memoryId]);
  await again.used({ runId: 'next-run', memoryIds: used });
  await again.used({ runId: 'next-run', memoryIds: used });
  await again.commit({ memoryIds: used });
  assert.equal(reloaded.get(memory.memoryId).useCount, 1);
});
