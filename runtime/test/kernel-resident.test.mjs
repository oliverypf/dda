import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResidentKernel } from '../src/kernel/resident-kernel.mjs';
import { createSessionStateStore } from '../src/kernel/session-state.mjs';
import { KERNEL_ERROR_CODES } from '../src/kernel/protocol.mjs';

const workspaceWithFiles = async () => {
  const root = await mkdtemp(join(tmpdir(), 'kernel-ws-'));
  await writeFile(join(root, 'README.md'), '# Title\nalpha beta gamma\nunique_marker here\n');
  return root;
};

const startKernel = async (root, { sessionId = 'sess', storagePath } = {}) => {
  const sessionStore = createSessionStateStore({ storagePath, sessionId });
  const kernel = createResidentKernel({ workspaceRoot: root, sessionId, sessionStore, requestTimeoutMs: 5000 });
  await kernel.start();
  return { kernel, sessionStore };
};

test('serves read-only workspace and session ops as the primary surface', async () => {
  const root = await workspaceWithFiles();
  const storagePath = join(root, '.state.json');
  const { kernel } = await startKernel(root, { storagePath });
  try {
    const listing = await kernel.request('workspace.list', { path: '' });
    assert.equal(listing.granted, true);
    assert.ok(listing.entries.some((entry) => entry.path === 'README.md'));

    const read = await kernel.request('workspace.read', { path: 'README.md', maxChars: 7 });
    assert.equal(read.content, '# Title');
    assert.equal(read.truncated, true);

    const focus = await kernel.request('workspace.focus', { path: 'README.md', findText: 'unique_marker' });
    assert.ok(focus.content.includes('unique_marker'));
    assert.match(focus.digest, /^sha256:[0-9a-f]{64}$/);

    const set = await kernel.request('session_state.set', { key: 'plan', value: { step: 2 } });
    assert.equal(set.revision, 1);
    const get = await kernel.request('session_state.get', { key: 'plan' });
    assert.deepEqual(get, { key: 'plan', found: true, value: { step: 2 } });
    const list = await kernel.request('session_state.list', {});
    assert.deepEqual(list.keys, ['plan']);
    const del = await kernel.request('session_state.delete', { key: 'plan' });
    assert.equal(del.deleted, true);
    assert.equal((await kernel.request('session_state.get', { key: 'plan' })).found, false);
  } finally {
    await kernel.stop();
  }
});

test('refuses side-effect host_request kinds and answers inert probes', async () => {
  const root = await workspaceWithFiles();
  const { kernel } = await startKernel(root);
  try {
    for (const kind of ['write_file', 'shell', 'network', 'file.patch', 'surprise']) {
      await assert.rejects(
        kernel.request('host_request', { kind }),
        (error) => error.code === KERNEL_ERROR_CODES.SIDE_EFFECT_REFUSED,
        `expected ${kind} to be refused`
      );
    }
    const ping = await kernel.request('host_request', { kind: 'host.ping' });
    assert.equal(ping.ok, true);
    assert.equal(ping.phase, 1);
  } finally {
    await kernel.stop();
  }
});

test('reports unknown ops without crashing the resident kernel', async () => {
  const root = await workspaceWithFiles();
  const { kernel } = await startKernel(root);
  try {
    await assert.rejects(kernel.request('workspace.read', {}), (error) => error.code === KERNEL_ERROR_CODES.INVALID_PARAMS || /path/.test(error.message));
    // The kernel is still alive and serving after a bad request.
    const listing = await kernel.request('workspace.list', { path: '' });
    assert.equal(listing.granted, true);
  } finally {
    await kernel.stop();
  }
});

test('rebuilds from durable session state after a crash and never loses committed state', async () => {
  const root = await workspaceWithFiles();
  const storagePath = join(root, '.state.json');
  const { kernel } = await startKernel(root, { storagePath });
  try {
    await kernel.request('session_state.set', { key: 'cursor', value: 'README.md:42' });
    const pid = kernel.workerPid;
    assert.ok(Number.isInteger(pid));

    // Simulate a hard crash of the resident kernel subprocess.
    process.kill(pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The next read op transparently rebuilds the worker from durable state.
    const recovered = await kernel.request('session_state.get', { key: 'cursor' });
    assert.deepEqual(recovered, { key: 'cursor', found: true, value: 'README.md:42' });
    assert.ok(kernel.restarts >= 1, 'kernel should have rebuilt at least once');
    assert.notEqual(kernel.workerPid, pid);

    // Workspace reads continue to work on the rebuilt worker.
    assert.equal((await kernel.request('workspace.read', { path: 'README.md', maxChars: 7 })).content, '# Title');
  } finally {
    await kernel.stop();
  }
});

test('never auto-replays a non-replay-safe op that was in flight at crash time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kernel-crash-'));
  // A fake worker that initializes, then exits without answering the first op
  // it receives, simulating a crash mid-operation.
  const workerPath = join(root, 'crash-worker.mjs');
  await writeFile(workerPath, `
    import { createMessageFramer, encodeMessage, kernelSuccess, KERNEL_PROTOCOL_VERSION } from ${JSON.stringify(join(process.cwd(), 'src/kernel/protocol.mjs'))};
    const framer = createMessageFramer();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      for (const message of framer.push(chunk)) {
        if (message.op === 'init') { process.stdout.write(encodeMessage(kernelSuccess(message.id, { ready: true, protocolVersion: KERNEL_PROTOCOL_VERSION }))); continue; }
        if (message.op === 'shutdown') { process.exit(0); }
        // Crash in-flight: exit without responding.
        process.exit(1);
      }
    });
  `);
  const sessionStore = createSessionStateStore({ sessionId: 'crash' });
  const kernel = createResidentKernel({ workspaceRoot: root, sessionId: 'crash', sessionStore, workerPath, requestTimeoutMs: 3000, maxRestarts: 2 });
  await kernel.start();
  try {
    // host_request is never replay-safe: an in-flight crash must surface an
    // uncertain-outcome error instead of being silently re-issued.
    await assert.rejects(
      kernel.request('host_request', { kind: 'host.ping' }),
      (error) => error.code === KERNEL_ERROR_CODES.OUTCOME_UNCERTAIN
    );
  } finally {
    await kernel.stop();
  }
});
