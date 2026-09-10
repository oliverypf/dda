import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { CreditBlameLedger } from '../src/credit-blame-ledger.mjs';

test('credit blame reads durable allocations before JSON cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-credit-'));
  const storagePath = join(directory, 'ledger.json');
  const eventStore = createHarnessEventStore();
  const writer = new CreditBlameLedger({ storagePath, eventStore, idFactory: () => 'allocation-1' });
  const written = await writer.recordDurably({
    decisions: [{ decisionId: 'decision-1', runId: 'run-1', role: 'planner', status: 'COMMITTED' }],
    outcome: { outcomeId: 'outcome-1', runId: 'run-1', status: 'SUCCEEDED', executionEventIds: ['event-1'] }
  });
  await writer.flush();
  const cached = JSON.parse(await readFile(storagePath, 'utf8'));
  cached.records[0].credit = 0;
  await writeFile(storagePath, JSON.stringify(cached));
  const reader = new CreditBlameLedger({ storagePath, eventStore });
  await reader.load();
  assert.deepEqual(reader.list(), written);
});
