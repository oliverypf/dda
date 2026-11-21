import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadArkTS } from './sdk-host.mjs';

const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
const { LocalRunJournal, runFingerprint } = loadArkTS('services/LocalRunJournal');
const endpoint = 'https://example.invalid/v1/responses';

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dda-journal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir: root });
  await workspace.initialize();
  const open = () => new LocalRunJournal(workspace, 'local-thread-123');
  return { root, workspace, open, journal: open() };
}

test('role, round, approved receipts and final reply survive restart without private model data', async t => {
  const { workspace, open, journal, root } = await fixture(t);
  const secret = 'private-goal-credential';
  let state = await journal.start('run-1', secret, endpoint, 'private-model-id', 'private-jev-config');
  assert(await journal.matches(state, secret, endpoint, 'private-model-id', 'private-jev-config'));
  for (const change of [[secret, endpoint, 'other', 'private-jev-config'], ['other', endpoint, 'private-model-id', 'private-jev-config'],
    [secret, endpoint + '-other', 'private-model-id', 'private-jev-config'], [secret, endpoint, 'private-model-id', 'other']]) {
    assert.equal(await journal.matches(state, ...change), false);
  }
  assert.equal(await new LocalRunJournal(workspace, 'another-thread').matches(state, secret, endpoint, 'private-model-id', 'private-jev-config'), false);
  const otherWorkspace = new LocalWorkspace({ filesDir: root }, 'p-123');
  assert.equal(await new LocalRunJournal(otherWorkspace, state.threadId).matches(state, secret, endpoint, 'private-model-id', 'private-jev-config'), false);
  state.phase = 'execute';
  state.role = 'implementer';
  state.plan = 'Validate the report.';
  state.round = 2;
  const fingerprint = await runFingerprint('private write arguments');
  state.pending = { id: 'op-1', tool: 'edit_file', path: '/report.txt', fingerprint, content: 'unauthorized input' };
  state.reasoning = 'private thinking';
  state.images = ['data:image/png;base64,AAAA'];
  state.apiKey = 'provider-secret';
  state = await journal.save(state);
  state.receipts.push({ ...state.pending, status: 'ok', output: 'private file contents' });
  delete state.pending;
  state = await journal.save(state);
  state.phase = 'review';
  state.draft = 'Report validated.';
  state.feedback = 'Mention checked columns.';
  state = await journal.save(state);
  assert.deepEqual(await open().load(), state);
  const disk = await workspace.readCheckpoint(state.threadId);
  for (const privateValue of [secret, endpoint, 'private-model-id', 'private-jev-config', 'private write arguments',
    'unauthorized input', 'private thinking', 'data:image', 'provider-secret', 'private file contents']) {
    assert(!disk.includes(privateValue), privateValue);
  }
  assert.deepEqual(await workspace.list('/'), []);
  state.phase = 'done';
  state.draft = 'The report columns were validated.';
  state = await open().save(state);
  assert.equal((await open().load()).draft, state.draft);
  await assert.rejects(journal.save(state), /已提交/);
  assert.equal((await open().start('run-2', 'next', endpoint, 'model')).phase, 'route');
});

for (const mutate of [false, true]) {
  test('process loss after durable intent ' + (mutate ? 'and after file publication' : 'before file publication'), async t => {
    const { root, workspace, open } = await fixture(t);
    const child = [
      "const { loadArkTS } = await import(process.argv[1]);",
      "const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');",
      "const { LocalRunJournal, runFingerprint } = loadArkTS('services/LocalRunJournal');",
      "const ws = new LocalWorkspace({ filesDir: process.argv[2] });",
      "const journal = new LocalRunJournal(ws, 'local-thread-123');",
      "let state = await journal.start('run-original', 'goal', 'endpoint', 'model');",
      "state.phase = 'execute';",
      "state.plan = 'Keep the saved plan';",
      "state.pending = { id: 'op-write', tool: 'create_file', path: '/marker', expectedHash: await runFingerprint('user data'), fingerprint: await runFingerprint('action') };",
      "await journal.save(state);",
      "if (process.argv[3] === 'true') { await ws.createFile('/marker','user data'); }",
      'process.exit(79);'
    ].join('\n');
    await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', child,
      new URL('./sdk-host.mjs', import.meta.url).href, root, String(mutate)], { timeout: 20000 }), { code: 79 });
    assert.equal((await workspace.list('/')).length, mutate ? 1 : 0);
    const recovery = open();
    const saved = await recovery.load();
    assert.equal(saved.pending.id, 'op-write');
    await assert.rejects(recovery.start('run-next', 'goal', endpoint, 'model'), /已有任务断点/);
    // A process with no knowledge of the outcome must not invent a receipt,
    // even when the action appears to have completed on the filesystem.
    const invented = { ...saved, pending: undefined, receipts: [{ ...saved.pending, status: 'ok' }] };
    await assert.rejects(recovery.save(invented), /结果尚未确认/);
    assert.equal((await recovery.load()).revision, saved.revision);
    if (mutate) {
      // Verification performs a host read only, preserving previous role work.
      workspace.createFile = workspace.replaceFile = () => { throw new Error('Unexpected write on recovery'); };
      const confirmed = await recovery.verifyPending(saved);
      assert.equal(confirmed.plan, saved.plan);
      assert.equal(confirmed.pending, undefined);
      assert.equal(confirmed.receipts[0].fingerprint, saved.pending.fingerprint);
      assert.equal(confirmed.receipts[0].verifiedOnRecovery, true);
      assert.equal(confirmed.receipts[0].status, 'ok');
      await assert.rejects(recovery.verifyPending(saved), /已更新/);
      assert.deepEqual(await open().load(), confirmed);
      await recovery.discard(confirmed);
    } else {
      await assert.rejects(recovery.verifyPending(saved), /无法读取/);
      await workspace.createFile('/unrelated', 'other text');
      const forged = { ...saved, pending: { ...saved.pending, path: '/unrelated', expectedHash: await runFingerprint('other text') } };
      await assert.rejects(recovery.verifyPending(forged), /无法读取/);
      await workspace.createFile('/marker', 'different text');
      forged.pending.expectedHash = await runFingerprint('different text');
      await assert.rejects(recovery.verifyPending(forged), /不符/);
      assert.deepEqual(await open().load(), saved);
      await recovery.discard(saved);
    }
    assert.equal(await open().load(), undefined);
    const fresh = await open().start('run-next', 'goal', endpoint, 'model');
    assert.equal(fresh.receipts.length, 0);
    assert.equal(await workspace.read('/marker'), mutate ? 'user data' : 'different text');
  });
}

test('failed rename preserves last valid checkpoint and stale writers cannot replace it', async t => {
  const { journal, open, root, workspace } = await fixture(t);
  let state = await journal.start('run-first', 'task', endpoint, 'model');
  state.phase = 'execute';
  state = await journal.save(state);
  const initial = await workspace.readCheckpoint(state.threadId);
  const oldRename = fs.rename;
  fs.rename = async () => { throw new Error('injected rename failure'); };
  try {
    await assert.rejects(journal.save({ ...state, pending: { id: 'op', tool: 'create_file', path: '/note' } }), /injected/);
  } finally { fs.rename = oldRename; }
  assert.equal(await workspace.readCheckpoint(state.threadId), initial);
  assert(!(await fs.readdir(root)).some(name => name.startsWith('.pending-')));
  const branches = await Promise.allSettled([journal.save({ ...state, round: 1 }), open().save({ ...state, round: 2 })]);
  assert.equal(branches.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(open().discard(state), /已更新/);
});

test('integrity, private content and evidence bounds are checked before the next action', async t => {
  const { journal, open, workspace } = await fixture(t);
  let state = await journal.start('run-1', 'task', endpoint, 'model');
  for (const unsafe of ['data:image/png;base64,aaaa', '<think>internal</think>', 'x'.repeat(131073)]) {
    await assert.rejects(journal.save({ ...state, draft: unsafe }));
  }
  await assert.rejects(journal.save({ ...state, phase: 'execute', pending: { id: 'tool', tool: 'read_file', path: '/../private' } }));
  await assert.rejects(journal.save({ ...state, receipts: [{ id: 'fake', tool: 'create_file', path: '/x', status: 'ok' }] }), /缺少事先登记/);
  const overLimit = Array.from({ length: 129 }, (_, i) => ({ id: 'r-' + i, tool: 'read_file', path: '/x', status: 'ok' }));
  await assert.rejects(journal.save({ ...state, receipts: overLimit }), /上限/);
  const damaged = JSON.parse(await workspace.readCheckpoint(state.threadId));
  damaged.state.phase = 'done';
  await workspace.writeCheckpoint(state.threadId, JSON.stringify(damaged));
  await assert.rejects(open().load(), /校验失败/);
  await assert.rejects(open().start('run-2', 'next', endpoint, 'model'), /校验失败/);
});

test('failure syncing the journal directory after rename leaves an intent with no active writer', async t => {
  const { journal, open, root } = await fixture(t);
  const state = await journal.start('run-1', 'goal', endpoint, 'model');
  const pending = { id: 'write', tool: 'edit_file', path: '/note' };
  const originalOpen = fs.open;
  fs.open = async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === root) { handle.sync = async () => { throw new Error('injected directory fsync failure'); }; }
    return handle;
  };
  try {
    await assert.rejects(journal.save({ ...state, phase: 'execute', pending }), /directory fsync failure/);
  } finally { fs.open = originalOpen; }
  const fenced = await open().load();
  assert.equal(fenced.pending.id, pending.id);
  await assert.rejects(journal.save({ ...fenced, pending: undefined,
    receipts: [{ ...pending, status: 'ok' }] }), /结果尚未确认/);
});

test('directory links cannot make the private journal visible from a project', async t => {
  const { journal, root, workspace } = await fixture(t);
  await journal.start('run-1', 'goal', endpoint, 'model');
  const virtual = 'linked';
  await fs.symlink(root, join(root, 'workspace', virtual), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await workspace.list('/'), []);
  await assert.rejects(workspace.list('/' + virtual), /无效/);
  await assert.rejects(workspace.read('/' + virtual), /无效/);
  if (process.platform === 'win32') {
    await assert.rejects(workspace.list('/.. '), /literal project path/);
  }
});

test('an image-only transport turn resumes only with the original image bytes', async t => {
  const { workspace } = await fixture(t);
  const { LocalModelTransport } = loadArkTS('services/LocalModelTransport');
  const images = ['data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
    'data:image/gif;base64,R0lGODlhAQABAIAAAAD/AP///ywAAAAAAQABAAACAUwAOw=='];
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) { raw += chunk; }
    requests.push(JSON.parse(raw));
    if (requests.length === 1) { res.writeHead(503).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"Image checked."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'vision', apiKey: '' };
  async function transport(image) {
    const client = new LocalModelTransport(workspace);
    client.configure(config);
    client.prepareTurn([], '', [image]);
    await client.connect(() => {});
    return client;
  }
  const initial = await transport(images[0]);
  const thread = await initial.startThread();
  await assert.rejects(initial.sendTurn(thread, ''), /503/);
  const state = await initial.checkpoint(thread);
  assert.equal(state.phase, 'execute');
  assert(!(await workspace.readCheckpoint(thread)).includes('base64'));
  await assert.rejects((await transport(images[1])).resumeTurn(thread, ''), /不符/);
  assert.equal(requests.length, 1);
  const resumed = await transport(images[0]);
  assert.equal(await resumed.resumeTurn(thread, ''), state.runId);
  assert.equal((await resumed.latestCheckpoint(thread)).phase, 'done');
  assert.equal(requests.length, 2);
  for (const body of requests) {
    assert(body.messages.at(-1).content.some(part => part.image_url?.url === images[0]));
  }
});
