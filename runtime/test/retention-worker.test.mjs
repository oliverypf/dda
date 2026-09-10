import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRetentionProgressStore, createRetentionWorker, parseRetentionWorkerBatchSize, parseRetentionWorkerFailureLimit, parseRetentionWorkerInterval } from '../src/retention-worker.mjs';
import { evaluateThirtyDayRetention } from '../src/retention-acceptance.mjs';

test('bounds retention worker configuration', () => {
  assert.equal(parseRetentionWorkerInterval(undefined), 15 * 60 * 1000);
  assert.equal(parseRetentionWorkerBatchSize(undefined), 10);
  assert.equal(parseRetentionWorkerFailureLimit(undefined), 3);
  assert.throws(() => parseRetentionWorkerInterval(999), /RETENTION_WORKER_INTERVAL_INVALID/);
  assert.throws(() => parseRetentionWorkerBatchSize(0), /RETENTION_WORKER_BATCH_INVALID/);
  assert.throws(() => parseRetentionWorkerFailureLimit(21), /RETENTION_WORKER_FAILURE_LIMIT_INVALID/);
});

test('persists progress and retries failed purges without becoming the source of truth', async () => {
  const controller = new AbortController();
  const saved = [];
  const calls = [];
  let attempt = 0;
  const worker = createRetentionWorker({
    intervalMs: 1000,
    batchSize: 2,
    delayImpl: async () => controller.abort(),
    listExpired: async () => ['expired-a', 'expired-b'],
    purgeRun: async (runId) => {
      calls.push(runId);
      if (runId === 'expired-a' && attempt++ === 0) throw new Error('HARNESS_STORE_LOCKED');
      return { status: 'COMMITTED' };
    },
    progressStore: { load: async () => undefined, save: async (value) => saved.push(value) }
  });
  const result = await worker.start({ signal: controller.signal });
  assert.equal(result.state, 'STOPPED');
  assert.deepEqual(calls, ['expired-a', 'expired-b']);
  assert.equal(saved.at(-1).completed.includes('expired-b'), true);
  assert.equal(saved.at(-1).failed.includes('expired-a'), true);
  assert.equal(saved.some((snapshot) => snapshot.failed.includes('expired-a') && !snapshot.completed.includes('expired-b')), true);
  assert.equal(saved.some((snapshot) => snapshot.completed.includes('expired-b')), true);
});

test('retries remaining work on a later start using durable progress', async () => {
  let progress = { schemaVersion: '1.0', completed: ['expired-b'], failed: ['expired-a'], updatedAtMs: 1 };
  const calls = [];
  const worker = createRetentionWorker({
    batchSize: 2,
    listExpired: async () => ['expired-a', 'expired-b'],
    purgeRun: async (runId) => { calls.push(runId); return { status: 'COMMITTED', idempotent: true }; },
    progressStore: { load: async () => progress, save: async (value) => { progress = value; } }
  });
  const result = await worker.start();
  assert.deepEqual(calls, ['expired-a']);
  assert.equal(result.progress.failed.length, 0);
  assert.deepEqual(result.progress.completed.sort(), ['expired-a', 'expired-b']);
});


test('fails closed after the configured number of failed purge cycles', async () => {
  let cycles = 0;
  const worker = createRetentionWorker({
    intervalMs: 1000,
    failureLimit: 2,
    delayImpl: async () => { cycles += 1; },
    listExpired: async () => ['permanently-failing-run'],
    purgeRun: async () => { throw new Error('HARNESS_STORE_UNAVAILABLE'); }
  });
  await assert.rejects(() => worker.start(), /RETENTION_WORKER_FAILURE_LIMIT/);
  assert.equal(worker.cycleCount, 2);
  assert.equal(worker.consecutiveFailures, 2);
  assert.equal(cycles, 1);
  assert.equal(worker.running, false);
});


test('file progress merges concurrent snapshots without losing completed runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-retention-progress-'));
  const store = createFileRetentionProgressStore(join(directory, 'progress.json'));
  await store.save({ schemaVersion: '1.0', completed: ['run-a'], failed: [], updatedAtMs: 1 });
  await store.save({ schemaVersion: '1.0', completed: ['run-b'], failed: ['run-a'], updatedAtMs: 2 });
  assert.deepEqual((await store.load()).completed.sort(), ['run-a', 'run-b']);
  assert.deepEqual((await store.load()).failed, []);
});

test('retention acceptance remains partial before real 30-day window', () => { const result = evaluateThirtyDayRetention({ observationStartedAtMs: 0, nowMs: 29 * 24 * 60 * 60 * 1000, workerProgress: { completed: [], failed: [] } }); assert.equal(result.status, 'PARTIAL'); });
test('retention acceptance is unknown without an observation start', () => {
  assert.equal(evaluateThirtyDayRetention({ workerProgress: { completed: [], failed: [] } }).status, 'UNKNOWN');
});
test('retention acceptance fails after 30 days when worker progress is incomplete', () => {
  const result = evaluateThirtyDayRetention({ observationStartedAtMs: 0, nowMs: 30 * 24 * 60 * 60 * 1000, expectedRunCount: 2, workerProgress: { completed: ['run-a'], failed: ['run-b'] } });
  assert.equal(result.status, 'FAIL');
});
test('retention acceptance passes only with complete 30-day evidence', () => {
  const result = evaluateThirtyDayRetention({ observationStartedAtMs: 0, nowMs: 30 * 24 * 60 * 60 * 1000, expectedRunCount: 2, workerProgress: { completed: ['run-a', 'run-b'], failed: [] } });
  assert.equal(result.status, 'PASS');
});

test('retention acceptance rejects missing evidence, invalid clocks and inflated counts', () => {
  const complete = { observationStartedAtMs: 0, nowMs: 30 * 24 * 60 * 60 * 1000, expectedRunCount: 2, workerProgress: { completed: ['a', 'b'], failed: [] } };
  for (const override of [
    { nowMs: NaN }, { nowMs: Infinity }, { nowMs: -1 },
    { expectedRunCount: undefined }, { expectedRunCount: 0 }, { expectedRunCount: -1 },
    { expectedRunCount: NaN }, { expectedRunCount: 1.5 }, { failureCount: NaN },
    { workerProgress: undefined }, { workerProgress: { completed: ['a', 'a'], failed: [] } },
    { workerProgress: { completed: ['a', 'b'] } },
    { workerProgress: { completed: ['a', 'b'], failed: ['a'] } },
    { workerProgress: { completed: ['a', ''], failed: [] } }
  ]) assert.equal(evaluateThirtyDayRetention({ ...complete, ...override }).status, 'UNKNOWN');
});

