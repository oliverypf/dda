import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { openHarnessDatabase, commitHarnessEvent } from '../src/harness-store-schema.mjs';

const schemaUrl = new URL('../src/harness-store-schema.mjs', import.meta.url).href;
const storeUrl = new URL('../src/harness-event-store.mjs', import.meta.url).href;

test('a competing process write lock fails closed and the command can retry after release', { timeout: 20000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-db-lock-'));
  const storagePath = join(directory, 'hmcodex.db');
  const writer = openHarnessDatabase(storagePath);
  writer.exec('PRAGMA busy_timeout=50');
  const result = await createHarnessEventStore().append({ runId: 'locked-run', kind: 'First', commandId: 'locked-command' });
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { openHarnessDatabase } from ${JSON.stringify(schemaUrl)};
    const db = openHarnessDatabase(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    process.on('message', () => {});
    process.send('locked');
  `, storagePath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    writer.close();
    await rm(directory, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    closed.then(() => { throw new Error(`lock holder exited early: ${stderr}`); })
  ]);
  assert.equal(ready, 'locked');
  assert.throws(() => commitHarnessEvent(writer, result.event, result.receipt), /database is locked/i);
  assert.equal(writer.prepare('SELECT count(*) AS n FROM trajectory_events').get().n, 0);
  assert.equal(writer.prepare('SELECT count(*) AS n FROM command_dedup').get().n, 0);
  child.kill('SIGKILL');
  await closed;
  assert.equal(commitHarnessEvent(writer, result.event, result.receipt).idempotent, false);
  assert.equal(commitHarnessEvent(writer, result.event, result.receipt).idempotent, true);
  const reopened = createHarnessEventStore({ storagePath });
  assert.equal((await reopened.list()).length, 1);
  assert.equal((await reopened.verify()).ok, true);
});

test('concurrent cross-process appends fail closed without corrupting the event store', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-db-race-'));
  const storagePath = join(directory, 'hmcodex.db');
  // Create the schema before the children race so the test exercises append
  // contention rather than concurrent first-open migration.
  const bootstrap = createHarnessEventStore({ storagePath });
  await bootstrap.load();
  const childScript = `
    import { createHarnessEventStore } from ${JSON.stringify(storeUrl)};
    const storagePath = process.argv[1];
    const prefix = process.argv[2];
    const store = createHarnessEventStore({ storagePath });
    await store.load();
    process.send({ type: 'ready' });
    await new Promise((resolve) => process.on('message', (message) => { if (message === 'go') resolve(); }));
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      const commandId = prefix + '-' + index;
      const payload = { prefix, index };
      try {
        const result = await store.append({ runId: 'run-race', kind: 'Raced', commandId, payload });
        results.push({ ok: true, commandId, payload, eventId: result.event.eventId });
      } catch (error) {
        results.push({ ok: false, commandId, payload, error: String(error?.message ?? error) });
      }
    }
    process.send({ type: 'done', results }, () => process.exit(0));
  `;
  const waitForMessage = (child, type) => new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('close', onClose);
      child.off('error', onError);
    };
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before ${type}: code=${code} signal=${signal}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.on('message', onMessage);
    child.on('close', onClose);
    child.on('error', onError);
  });
  const children = Array.from({ length: 3 }, (_, index) => spawn(
    process.execPath,
    ['--input-type=module', '-e', childScript, storagePath, `worker-${index}`],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
  ));
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
  for (const child of children) child.send('go');
  const completed = await Promise.all(children.map((child) => waitForMessage(child, 'done')));
  const results = completed.flatMap((message) => message.results);
  const committed = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  assert.ok(committed.length > 0);
  assert.ok(failed.every((result) => /CONCURRENT_CONFLICT|UNIQUE|locked/i.test(result.error)));

  const reopened = createHarnessEventStore({ storagePath });
  const durable = await reopened.list({ runId: 'run-race' });
  assert.equal((await reopened.verify()).ok, true);
  assert.equal(durable.length, committed.length);
  assert.deepEqual(durable.map((event) => event.sequence), durable.map((_, index) => index + 1));
  assert.equal(new Set(durable.map((event) => event.eventId)).size, durable.length);

  for (const failure of failed) {
    await reopened.append({ runId: 'run-race', kind: 'Raced', commandId: failure.commandId, payload: failure.payload });
  }
  const final = await reopened.list({ runId: 'run-race' });
  assert.equal(final.length, 9);
  assert.deepEqual(final.map((event) => event.sequence), final.map((_, index) => index + 1));
  assert.equal((await reopened.verify()).ok, true);
});

for (const phase of ['before-write', 'before-commit', 'after-commit']) {
  test(`process death ${phase} preserves event/receipt transaction boundaries`, { timeout: 20000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hmcodex-db-crash-'));
    const storagePath = join(directory, 'hmcodex.db');
    const script = `
      import { openHarnessDatabase, commitHarnessEvent } from ${JSON.stringify(schemaUrl)};
      import { createHarnessEventStore } from ${JSON.stringify(storeUrl)};
      const db = openHarnessDatabase(process.argv[1]);
      const result = await createHarnessEventStore().append({ runId: 'crash-run', kind: 'TaskRunCreated', commandId: 'crash-command' });
      db.exec('BEGIN IMMEDIATE');
      if (${JSON.stringify(phase)} !== 'before-write') commitHarnessEvent(db, result.event, result.receipt);
      if (${JSON.stringify(phase)} === 'after-commit') db.exec('COMMIT');
      process.on('message', () => {});
      process.send({ phase: ${JSON.stringify(phase)} });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, storagePath], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    const closed = once(child, 'close');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      await rm(directory, { recursive: true, force: true });
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      closed.then(() => { throw new Error(`child exited before fault point: ${stderr}`); })
    ]);
    assert.equal(ready.phase, phase);
    assert.equal(child.kill('SIGKILL'), true);
    await closed;

    const recovered = createHarnessEventStore({ storagePath });
    const events = await recovered.list();
    const committed = phase === 'after-commit';
    assert.equal(events.length, committed ? 1 : 0);
    assert.equal(Boolean(recovered.getReceipt('crash-command')), committed);
    assert.equal((await recovered.verify()).ok, true);
    const retry = await recovered.append({ runId: 'crash-run', kind: 'TaskRunCreated', commandId: 'crash-command' });
    assert.equal(retry.idempotent, committed);
    assert.equal((await recovered.list()).length, 1);
    assert.equal((await recovered.list())[0].sequence, 1);
    const reopened = createHarnessEventStore({ storagePath });
    assert.equal((await reopened.list()).length, 1);
    assert.equal((await reopened.verify()).ok, true);
  });
}
