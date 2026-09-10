import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createMeteredHarnessEventStore, readCommitMetrics } from '../src/commit-metrics.mjs';

test('metered harness store records commit attempts, successes, and failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-commit-metrics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metricsPath = join(directory, 'commit-metrics.json');
  const metered = createMeteredHarnessEventStore({ store: createHarnessEventStore(), metricsPath });
  await metered.append({ runId: 'run-1', kind: 'Observed' });
  await metered.appendBatch([
    { runId: 'run-1', kind: 'Observed' },
    { runId: 'run-1', kind: 'Observed' }
  ]);
  const success = await readCommitMetrics(metricsPath);
  assert.equal(success.attempts, 3);
  assert.equal(success.successes, 3);
  assert.equal(success.failures, 0);

  const failing = createMeteredHarnessEventStore({
    store: {
      async append() { throw new Error('DISK_FULL'); },
      async appendBatch() { throw new Error('DISK_FULL'); }
    },
    metricsPath
  });
  await assert.rejects(() => failing.append({ runId: 'run-2', kind: 'Observed' }), /DISK_FULL/);
  const withFailure = await readCommitMetrics(metricsPath);
  assert.equal(withFailure.attempts, 4);
  assert.equal(withFailure.successes, 3);
  assert.equal(withFailure.failures, 1);
  assert.equal(withFailure.lastErrorCode, 'DISK_FULL');
  assert.ok(withFailure.lastFailureAtMs > 0);
});
