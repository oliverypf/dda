import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';

const invoke = (args, env) => promisify(execFile)(process.execPath, [
  fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
  ...args
], { env, windowsHide: true });

test('export-data redacts forbidden fields for run, thread, and all-local scopes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-export-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const threadPath = join(directory, 'threads.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-export', kind: 'TaskRunCreated', commandId: 'created', payload: { title: 'export' } });
  await eventStore.append({
    runId: 'run-export',
    kind: 'WorkspaceRead',
    commandId: 'read',
    payload: { file: 'README.md', command: 'secret command', content: 'source code body' }
  });
  await eventStore.append({ runId: 'run-other', kind: 'TaskRunCreated', commandId: 'other', payload: { title: 'other' } });
  const threads = createThreadStore({ storagePath: threadPath });
  const thread = await threads.create({ cwd: directory, title: 'export thread' });
  await threads.appendTurn(thread.id, { runId: 'run-export', summary: 'fixture', state: 'SUCCEEDED' });
  const env = {
    ...process.env,
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_HARNESS_EVENT_STORE: harness,
    HMCODEX_THREAD_STORE: threadPath
  };

  const runOutput = join(directory, 'run-export.json');
  const runResult = JSON.parse((await invoke(['export-data', '--run-id', 'run-export', '--output', runOutput], env)).stdout);
  assert.equal(runResult.ok, true);
  assert.equal(runResult.scope.type, 'RUN');
  assert.equal(runResult.eventCount, 2);
  assert.ok(runResult.redaction.removedFieldCount >= 2);
  assert.deepEqual(runResult.privacy.scan, { ok: true, violations: [] });
  const runBundle = JSON.parse(await readFile(runOutput, 'utf8'));
  assert.equal(runBundle.events.length, 2);
  assert.equal(JSON.stringify(runBundle).includes('secret command'), false);
  assert.equal(JSON.stringify(runBundle).includes('source code body'), false);
  assert.equal(Object.hasOwn(runBundle.events[1].payload, 'command'), false);
  assert.equal(Object.hasOwn(runBundle.events[1].payload, 'content'), false);
  assert.equal(runBundle.events[1].payload.file, 'README.md');

  const threadOutput = join(directory, 'thread-export.json');
  const threadResult = JSON.parse((await invoke(['export-data', '--thread-id', thread.id, '--output', threadOutput], env)).stdout);
  assert.equal(threadResult.scope.type, 'THREAD');
  assert.deepEqual(threadResult.scope.runIds, ['run-export']);
  assert.equal(threadResult.eventCount, 2);

  const allOutput = join(directory, 'all-export.json');
  const allResult = JSON.parse((await invoke(['export-data', '--output', allOutput], env)).stdout);
  assert.equal(allResult.scope.type, 'ALL_LOCAL_DATA');
  assert.equal(allResult.eventCount, 3);
});
