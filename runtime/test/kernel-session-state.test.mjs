import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStateStore, SessionStateStore, sessionStateDigest } from '../src/kernel/session-state.mjs';

const tempState = async () => join(await mkdtemp(join(tmpdir(), 'kernel-state-')), 'session.json');

test('requires a session id', () => {
  assert.throws(() => new SessionStateStore({}), /KERNEL_SESSION_ID_REQUIRED/);
});

test('persists values durably and reloads them in a fresh store', async () => {
  const storagePath = await tempState();
  const store = createSessionStateStore({ storagePath, sessionId: 'sess-1' });
  const first = await store.set('plan.step', { index: 1, note: 'start' });
  assert.equal(first.revision, 1);
  const second = await store.set('cursor', 'README.md');
  assert.equal(second.revision, 2);

  const reopened = createSessionStateStore({ storagePath, sessionId: 'sess-1' });
  assert.deepEqual(await reopened.get('plan.step'), { index: 1, note: 'start' });
  assert.equal(await reopened.get('cursor'), 'README.md');
  assert.deepEqual(await reopened.list(), ['cursor', 'plan.step']);
  assert.equal(reopened.snapshot().revision, 2);
});

test('overwrites keys and deletes them, advancing the revision', async () => {
  const storagePath = await tempState();
  const store = createSessionStateStore({ storagePath, sessionId: 'sess-2' });
  await store.set('k', 1);
  await store.set('k', 2);
  assert.equal(await store.get('k'), 2);
  const del = await store.delete('k');
  assert.equal(del.deleted, true);
  assert.equal(await store.has('k'), false);
  const noop = await store.delete('k');
  assert.equal(noop.deleted, false);
});

test('rejects invalid keys and non-JSON values', async () => {
  const store = createSessionStateStore({ storagePath: await tempState(), sessionId: 'sess-3' });
  await assert.rejects(store.set('../escape', 1), /KERNEL_SESSION_KEY_INVALID/);
  await assert.rejects(store.set('bad key', 1), /KERNEL_SESSION_KEY_INVALID/);
  await assert.rejects(store.set('ok', () => {}), /KERNEL_SESSION_VALUE_INVALID/);
  await assert.rejects(store.set('ok', { x: undefined, fn: Symbol('n') }), /KERNEL_SESSION_VALUE_INVALID/);
});

test('rejects a tampered durable record', async () => {
  const storagePath = await tempState();
  const store = createSessionStateStore({ storagePath, sessionId: 'sess-4' });
  await store.set('k', 'value');
  const { writeFile, readFile } = await import('node:fs/promises');
  const parsed = JSON.parse(await readFile(storagePath, 'utf8'));
  parsed.entries[0].value = 'tampered';
  await writeFile(storagePath, JSON.stringify(parsed));
  const reopened = createSessionStateStore({ storagePath, sessionId: 'sess-4' });
  await assert.rejects(reopened.load(), /KERNEL_SESSION_STATE_INVALID/);
});

test('rejects a record written for a different session id', async () => {
  const storagePath = await tempState();
  await createSessionStateStore({ storagePath, sessionId: 'sess-a' }).set('k', 1);
  const foreign = createSessionStateStore({ storagePath, sessionId: 'sess-b' });
  await assert.rejects(foreign.load(), /KERNEL_SESSION_STATE_INVALID/);
});

test('digest is stable regardless of key order', () => {
  assert.equal(sessionStateDigest({ a: 1, b: 2 }), sessionStateDigest({ b: 2, a: 1 }));
});
