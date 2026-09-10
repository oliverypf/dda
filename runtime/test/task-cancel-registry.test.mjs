import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskCancelRegistry, taskCancelStorePath } from '../src/task-cancel-registry.mjs';

const storagePath = async () => join(await mkdtemp(join(tmpdir(), 'hmcodex-cancel-')), 'task.cancels.json');

test('records, reads and consumes a durable cancel request without storing the reason text', async () => {
  const path = await storagePath();
  const registry = createTaskCancelRegistry({ storagePath: path, now: () => 1000 });
  const requested = await registry.request('run-cancel-1', { reason: 'user asked to stop', requestedBy: 'desktop' });
  assert.equal(requested.status, 'CANCEL_REQUESTED');
  assert.equal(requested.idempotent, false);
  assert.equal(requested.request.runId, 'run-cancel-1');
  assert.match(requested.request.reasonDigest, /^sha256:[0-9a-f]{64}$/u);

  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('user asked to stop'), false);

  const pending = await registry.get('run-cancel-1');
  assert.equal(pending.status, 'REQUESTED');
  assert.equal((await registry.list()).length, 1);

  const consumed = await registry.consume('run-cancel-1');
  assert.equal(consumed.status, 'CONSUMED');
  assert.equal(await registry.get('run-cancel-1'), undefined);
  const after = await registry.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'CONSUMED');
});

test('cancel requests are idempotent while pending and can be re-requested after consumption', async () => {
  const path = await storagePath();
  const registry = createTaskCancelRegistry({ storagePath: path });
  const first = await registry.request('run-cancel-2', { reason: 'first' });
  const second = await registry.request('run-cancel-2', { reason: 'second' });
  assert.equal(second.status, 'CANCEL_ALREADY_REQUESTED');
  assert.equal(second.idempotent, true);
  assert.equal(second.request.requestedAtMs, first.request.requestedAtMs);
  await registry.consume('run-cancel-2');
  const third = await registry.request('run-cancel-2', { reason: 'third' });
  assert.equal(third.status, 'CANCEL_REQUESTED');
  assert.equal(third.request.status, 'REQUESTED');
});

test('derives the sidecar path from the scoped trajectory store and fails closed on tampering', async () => {
  assert.equal(taskCancelStorePath('C:/data/hmcodex.jsonl'), 'C:/data/hmcodex.jsonl.cancels.json');
  assert.equal(taskCancelStorePath(''), undefined);
  const path = await storagePath();
  await writeFile(path, JSON.stringify({ schemaVersion: '1.0', requests: { 'run-x': { runId: 'run-x', status: 'REQUESTED' } } }));
  const registry = createTaskCancelRegistry({ storagePath: path });
  await assert.rejects(registry.get('run-x'), { message: 'TASK_CANCEL_STORE_INVALID' });
  await assert.rejects(registry.request('run-x'), { message: 'TASK_CANCEL_STORE_INVALID' });
});

test('requires a bounded run id and bounds the consumed history', async () => {
  const registry = createTaskCancelRegistry({ storagePath: await storagePath(), now: () => 1 });
  await assert.rejects(registry.request('   '), { message: 'TASK_CANCEL_RUN_ID_REQUIRED' });
  await assert.rejects(registry.get(''), { message: 'TASK_CANCEL_RUN_ID_REQUIRED' });
});
