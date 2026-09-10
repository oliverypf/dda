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

test('context port refuses unbounded recall and keeps proposed memory out of recall', async () => {
  const journal = createMemoryJournal();
  const record = journal.propose({ runId: 'run-1', statement: 'proposed fact', sourceEventIds: ['event-1'], scope: 'workspace' });
  const port = createJournalContextPort({ journal });
  const recalled = await port.recall({ query: 'proposed fact' });
  assert.equal(recalled.items.length, 0);
  await assert.rejects(() => port.recall({ limit: 65 }), /CONTEXT_RECALL_OPTIONS_INVALID/);
  assert.equal((await port.used({ memoryIds: [record.memoryId] })).used.length, 0);
});
