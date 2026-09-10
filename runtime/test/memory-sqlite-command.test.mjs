import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

test('Phase 1 memory proposal reads evidence and writes facts in the scoped task database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-memory-db-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const events = createHarnessEventStore({ storagePath: `${trajectory}.db` });
  const { event } = await events.append({ runId: 'r1', kind: 'Observed', payload: {} });
  const env = { ...process.env, HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', HMCODEX_TRAJECTORY_STORE: trajectory, HMCODEX_DATA_DIR: directory };
  delete env.HMCODEX_HARNESS_EVENT_STORE;
  delete env.HMCODEX_MEMORY_STORE;
  delete env.HMCODEX_DREAM_STORE;
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const invoke = async (...args) => JSON.parse((await promisify(execFile)(process.execPath, [cli, 'memory', ...args], { env, windowsHide: true })).stdout);
  const proposed = await invoke('propose', '--run-id', 'r1', '--statement', 'Structured fixture observation', '--source-event-ids', JSON.stringify([event.eventId]));
  assert.equal(proposed.ok, true);
  assert.equal(proposed.memory.status, 'PROPOSED');
  assert.equal((await invoke('list')).memories.length, 1);
  assert.ok((await events.list()).length > 1);
  assert.equal((await events.verify()).ok, true);
  const dream = await promisify(execFile)(process.execPath, [cli, 'dream', 'run'], { env, windowsHide: true });
  assert.equal(JSON.parse(dream.stdout).ok, true);
  const dreamFacts = (await events.list()).filter((item) => item.aggregateType === 'DreamRun' || item.kind.startsWith('Dream'));
  assert.ok(dreamFacts.length > 0);
  assert.ok((await invoke('list')).memories.every((memory) => memory.status === 'PROPOSED'));
  for (const command of ['plugins', 'evolution']) {
    const listed = await promisify(execFile)(process.execPath, [cli, command, 'list'], { env, windowsHide: true });
    assert.equal(JSON.parse(listed.stdout).ok, true);
    await assert.rejects(promisify(execFile)(process.execPath, [cli, command, 'list', '--harness-event-store', join(directory, 'rejected.json')], { env, windowsHide: true }), (error) => {
      assert.match(error.stdout, /RELEASE_CHANNEL_SQLITE_REQUIRED/);
      return true;
    });
  }
  await assert.rejects(readFile(join(directory, 'rejected.json')), { code: 'ENOENT' });
  const managed = await promisify(execFile)(process.execPath, [cli, 'harness-events', 'list', '--run-id', 'r1'], { env, windowsHide: true });
  assert.ok(JSON.parse(managed.stdout).events.some((item) => item.eventId === event.eventId));
  const checked = await promisify(execFile)(process.execPath, [cli, 'harness-events', 'verify'], { env, windowsHide: true });
  assert.equal(JSON.parse(checked.stdout).verification.ok, true);
  const bundlePath = join(directory, 'support.json');
  delete env.HMCODEX_DECISION_TRACE_STORE;
  delete env.HMCODEX_FEEDBACK_STORE;
  await writeFile(`${trajectory}.decision-trace.json`, '{');
  await writeFile(`${trajectory}.feedback.json`, '{');
  await writeFile(`${trajectory}.feedback.json.backup`, '{');
  await promisify(execFile)(process.execPath, [cli, 'support-bundle', '--output', bundlePath], { env, windowsHide: true });
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  assert.equal(bundle.stores.harness.verification.eventCount, (await events.list()).length);
  assert.equal(typeof bundle.stores.decision.errorCode, 'string');
  assert.equal(typeof bundle.stores.feedback.errorCode, 'string');
  const capacity = await promisify(execFile)(process.execPath, [cli, 'capacity', '--storage-max-bytes', '1'], { env, windowsHide: true });
  assert.equal(JSON.parse(capacity.stdout).assessment.level, 'HARD_LIMIT');
  await assert.rejects(promisify(execFile)(process.execPath, [cli, 'support-bundle', '--output', `${trajectory}.db`], { env, windowsHide: true }), (error) => {
    assert.match(error.stdout, /SUPPORT_BUNDLE_OUTPUT_CONFLICT/);
    return true;
  });
  assert.equal((await events.verify()).ok, true);
  await assert.rejects(readFile(trajectory), { code: 'ENOENT' });
  await assert.rejects(readFile(`${trajectory}.harness-events.json`), { code: 'ENOENT' });
});
