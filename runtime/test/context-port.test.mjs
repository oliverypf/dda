import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryJournal } from '../src/memory-journal.mjs';
import { createJournalContextPort } from '../src/journal-context-port.mjs';

test('journal context port recalls bounded active records and tracks usage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-context-port-'));
  const journal = createMemoryJournal({ storagePath: join(directory, 'memory.json'), now: () => 1000 });
  const record = journal.propose({ runId: 'run-1', statement: 'Use the bounded workspace reader', sourceEventIds: ['event-1'], scope: 'project', confidence: 0.9 });
  journal.verify(record.memoryId, { accepted: true, reason: 'source-backed' });
  journal.activate(record.memoryId);
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: 'workspace reader', scope: 'project' });
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
    scope: 'workspace',
    key: 'pitfall:safety-protected-path'
  });
  const scratch = journal.propose({
    runId: 'run-1',
    statement: '项目命令经验：执行 `node .codex-tmp/digest.mjs`。',
    sourceEventIds: ['event-2'],
    scope: 'workspace',
    key: 'workflow:cmd:tmp'
  });
  const outcome = journal.propose({
    runId: 'run-1',
    statement: `Verified task outcome: class=unknown; verifier=PASS; outputDigest=sha256:${'a'.repeat(64)}`,
    sourceEventIds: ['event-3'],
    scope: 'workspace',
    kind: 'TASK_OUTCOME'
  });
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: '', scope: 'workspace' });
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
    scope: 'workspace',
    kind: 'PROJECT',
    confidence: 0.9
  });
  const buildLesson = journal.propose({
    runId: 'run-b',
    statement: '项目命令经验（编译exe）：在工作区 `desktop` 目录执行 `npm run build:windows:full-local` 已核验可成功完成命令/构建。',
    sourceEventIds: ['ev-b'],
    scope: 'workspace',
    kind: 'PROJECT',
    confidence: 0.9
  });
  for (const m of [general, buildLesson]) {
    journal.verify(m.memoryId, { accepted: true });
    journal.activate(m.memoryId);
  }
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: '帮我编译exe文件', scope: 'workspace' });
  assert.equal(recalled.items.length, 2);
  assert.equal(recalled.items[0].memoryId, buildLesson.memoryId, 'Chinese bigram + exe match ranks the build lesson first');
  assert.ok(recalled.items[0].score > 0);
});
