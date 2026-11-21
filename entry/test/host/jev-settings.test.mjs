import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadArkTS } from './sdk-host.mjs';

const { WorkbenchStore, decodeWorkbenchState, restoreTurnInput, stageStoredTurn } = loadArkTS('services/WorkbenchStore');

test('staging binds the run ID to the actual user turn and restoring omits partial tool and assistant output', () => {
  const image = { id: '833b60d8-0c57-4247-b4a7-7c0c474d56f8.jpg', name: '原图.jpg', mime: 'image/jpeg' };
  const earlier = [{ role: 'user', text: 'previous', id: 'u1' }, { role: 'assistant', text: 'answer', id: 'a1' }];
  const current = { threadId: 'thread', messages: earlier, draft: 'unsent', queued: ['next', 'later'], draftImages: [image] };
  const nextTurn = { role: 'user', text: 'next', id: 'u2', images: [] };
  stageStoredTurn(current, nextTurn, 'title', 'run-1', true);
  assert.equal(current.runId, 'run-1');
  assert.equal(current.incomplete, true);
  assert.deepEqual(current.queued, ['later']);
  assert.equal(current.draft, 'unsent');
  assert.deepEqual(current.draftImages, [image]);
  const imageOnly = { role: 'user', text: '', id: 'u3', images: [image] };
  stageStoredTurn(current, imageOnly, 'title', 'run-2', false);
  current.messages.push({ role: 'tool', id: 'tool', text: 'read' }, { role: 'assistant', id: 'a3', text: 'partial' });
  assert.deepEqual(restoreTurnInput(current.messages), { history: [...earlier, nextTurn], prompt: '', images: [image] });
  assert.deepEqual(current.draftImages, []);
  assert.equal(current.draft, '');
  assert.deepEqual(current.queued, ['later']);
  assert.equal(restoreTurnInput([{ id: 'x', role: 'system', text: 'ready' }]), undefined);
});

test('Jev and task credentials have distinct aliases even for the same endpoint', async t => {
  const filesDir = await mkdtemp(join(tmpdir(), 'dda-jev-settings-'));
  t.after(() => rm(filesDir, { force: true, recursive: true }));
  const store = new WorkbenchStore({ filesDir });
  const endpoint = 'https://models.example/v1';
  await store.saveKey(endpoint, 'task-credential');
  assert.equal(await store.loadKey(endpoint, true), '');
  await store.saveKey(endpoint, 'routing-credential', true);
  assert.equal(await store.loadKey(endpoint), 'task-credential');
  assert.equal(await store.loadKey(endpoint, true), 'routing-credential');
  assert.equal(await store.loadKey(endpoint + '/other', true), '');
  const legacy = { current: { title: 'work', threadId: 'thread-1', messages: [], draft: 'later' },
    tasks: [], instructions: '', memories: [], baseUrl: endpoint, model: 'task' };
  assert.equal(decodeWorkbenchState(JSON.stringify(legacy)).jevEnabled, undefined);
  const current = { ...legacy.current, runId: 'run-1', incomplete: true, queued: ['follow up'] };
  const state = { ...legacy, current, jevEnabled: true, jevHasSavedKey: true, jevEndpoint: endpoint, jevModel: 'router' };
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  const raw = await readFile(join(filesDir, 'workbench-v1.json'), 'utf8');
  assert.doesNotMatch(raw, /task-credential|routing-credential/);
  assert.throws(() => decodeWorkbenchState(JSON.stringify({ ...state, jevEnabled: 'yes' })));
  await store.saveKey(endpoint, '', true);
  assert.equal(await store.loadKey(endpoint, true), '');
  assert.equal(await store.loadKey(endpoint), 'task-credential');
});
