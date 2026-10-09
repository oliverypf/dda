import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RuntimeSafetyMonitor, RestrictedWindowsExecutor, CAPABILITIES, EXECUTION_MODES } from '../src/safety-executor.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { textDigest, MAX_PATCH_TEXT, MAX_PATCH_FILE_BYTES } from '../src/text-patch.mjs';

const setup = async (t, content, extra = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-real-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), content);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const workspace = new ReadonlyWorkspace(root);
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), {
    workspace, leaseProvider: createExplicitLeaseProvider({ monitor, capabilities: [CAPABILITIES.WRITE_FILE] }), ...extra
  });
  return { root, registry, workspace };
};

test('real workspace patch and diff handle small files and bare SHA-256 digests', async t => {
  const { root, registry } = await setup(t, 'before\n');
  const diff = await registry.invoke('file.diff', { path: 'source.txt', baseContent: 'after\n' });
  assert.match(diff.diff, /\+before/u);
  const result = await registry.invoke('file.patch', { path: 'source.txt', expectedDigest: textDigest('before\n').slice(7),
    replacements: [{ oldText: 'before', newText: 'after' }] });
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'after\n');
  assert.equal(result.afterDigest, textDigest('after\n'));
});

test('patch past the 32 KiB page boundary preserves all text and diff sees the tail', async t => {
  const before = `${'a'.repeat(40 * 1024)}\nTAIL\n${'后'.repeat(12000)}\n`;
  const { root, registry } = await setup(t, before);
  const after = before.replace('TAIL', 'CHANGED');
  await registry.invoke('file.patch', { path: 'source.txt', expectedDigest: textDigest(before),
    replacements: [{ oldText: 'TAIL', newText: 'CHANGED' }] });
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), after);
  const diff = await registry.invoke('file.diff', { path: 'source.txt', baseContent: before });
  assert.equal(diff.afterDigest, textDigest(after));
  assert.match(diff.diff, /\+CHANGED/u);
  await assert.rejects(registry.invoke('file.diff', { path: 'source.txt', baseContent: before, maxChars: 100 }), /PATCH_TOO_LARGE/u);
});

test('stale digest and oversized source cannot write even with an approved capability', async t => {
  const { root, registry } = await setup(t, 'current');
  const request = { path: 'source.txt', replacements: [{ oldText: 'current', newText: 'modified' }] };
  await assert.rejects(registry.invoke('file.patch', { ...request, expectedDigest: '0'.repeat(64) }), /PATCH_STALE_DIGEST/u);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'current');
  const large = `current${'x'.repeat(MAX_PATCH_FILE_BYTES)}`;
  await writeFile(join(root, 'source.txt'), large);
  await assert.rejects(registry.invoke('file.patch', request), /PATCH_TOO_LARGE/u);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), large);
  await assert.rejects(registry.invoke('file.patch', { ...request, path: '../outside.txt' }), /WORKSPACE/u);
});

test('small exact patches edit a real multibyte source above 256 KiB without rewriting other text', async t => {
  const before = `${'中'.repeat(125000)}\nTARGET\nEND\n`;
  assert.ok(Buffer.byteLength(before) > MAX_PATCH_TEXT);
  const { root, registry } = await setup(t, before);
  const result = await registry.invoke('file.patch', { path: 'source.txt', expectedDigest: textDigest(before),
    replacements: [{ oldText: 'TARGET', newText: 'ARCHIVE' }] });
  const after = before.replace('TARGET', 'ARCHIVE');
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), after);
  assert.equal(result.afterDigest, textDigest(after));
  assert.match(result.diff, /ARCHIVE/u);
});

test('patch file, result and replacement byte ceilings remain bounded', async t => {
  const before = `${'x'.repeat(MAX_PATCH_FILE_BYTES - 6)}TARGET`;
  const { root, registry } = await setup(t, before);
  const patch = newText => registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: 'TARGET', newText }] });
  await assert.rejects(patch('TOO-LONG'), /PATCH_TOO_LARGE/u);
  await assert.rejects(patch('x'.repeat(MAX_PATCH_TEXT + 1)), /PATCH_TOO_LARGE/u);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), before);
  const result = await patch('CHANGE');
  assert.equal(result.diffTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 64 * 1024);
  assert.equal(Buffer.byteLength(await readFile(join(root, 'source.txt'), 'utf8')), MAX_PATCH_FILE_BYTES);
  const multibyte = '中'.repeat(Math.floor(MAX_PATCH_FILE_BYTES / 3) + 1);
  await writeFile(join(root, 'source.txt'), multibyte);
  await assert.rejects(registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: '中', newText: 'a' }] }), /PATCH_TOO_LARGE/u);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), multibyte);
});

test('a changed file while approval is pending is never overwritten by the old patch', async t => {
  let target;
  const { root, registry } = await setup(t, 'before', { onLeaseStarted: () => writeFile(target, 'newer edit') });
  target = join(root, 'source.txt');
  await assert.rejects(registry.invoke('file.patch', { path: 'source.txt',
    replacements: [{ oldText: 'before', newText: 'after' }] }), /PATCH_STALE_DIGEST/u);
  assert.equal(await readFile(target, 'utf8'), 'newer edit');
});

test('a source changing between pages is rejected before requesting a write lease', async t => {
  const before = 'a'.repeat(40 * 1024);
  const { root, workspace } = await setup(t, before);
  const registry = new ToolRegistry({ allowSideEffects: true });
  let leases = 0, pages = 0;
  registerExecutorTools(registry, { shell() {}, test() {}, writeFile() { assert.fail('must not write'); } }, {
    workspace: { read: async (...args) => {
      if (++pages === 2) await writeFile(join(root, 'source.txt'), before.replace('a', 'b'));
      return workspace.read(...args);
    } }, leaseProvider: async () => { leases++; return {}; }
  });
  await assert.rejects(registry.invoke('file.patch', { path: 'source.txt', replacements: [{ oldText: 'aa', newText: '' }] }), /PATCH_STALE_DIGEST/u);
  assert.equal(leases, 0);
});
