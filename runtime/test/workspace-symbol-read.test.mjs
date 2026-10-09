import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { createReadonlyToolRegistry } from '../src/tool-registry.mjs';

test('literal symbol reads locate bounded context and preserve authorization and full-file evidence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dda-symbol-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = '中文源码\n'.repeat(15000);
  const symbol = 'const target =';
  const content = `${prefix}${symbol} 1;\n${symbol} 2;\n`;
  await writeFile(join(root, 'large.ts'), content);
  await writeFile(join(root, '.env'), 'SECRET=private');
  await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  const workspace = new ReadonlyWorkspace(root);
  const registry = createReadonlyToolRegistry(workspace);
  const first = await registry.invoke('workspace.read', { path: 'large.ts', findText: symbol, maxChars: 18 });
  assert.equal(first.found, true);
  assert.equal(first.offsetChars, prefix.length);
  assert.equal(first.content, content.slice(prefix.length, prefix.length + 18));
  assert.equal(first.truncated, true);
  assert.equal(first.digest, (await workspace.read('large.ts')).digest);
  const next = await registry.invoke('workspace.read', { path: 'large.ts', findText: symbol, offsetChars: first.offsetChars + 1 });
  assert.equal(next.offsetChars, content.lastIndexOf(symbol));
  const missing = await registry.invoke('workspace.read', { path: 'large.ts', findText: 'const .* =' });
  assert.equal(missing.found, false);
  assert.equal(missing.content, '');
  assert.equal(missing.truncated, false);
  for (const path of ['.env', '../outside']) {
    await assert.rejects(registry.invoke('workspace.read', { path, findText: 'x' }), /WORKSPACE_(SENSITIVE|INVALID)_PATH/);
  }
  await assert.rejects(registry.invoke('workspace.read', { path: 'binary.dat', findText: 'x' }), /WORKSPACE_BINARY_FILE/);
  for (const findText of ['', 'x'.repeat(513)]) {
    await assert.rejects(workspace.readMatching('large.ts', findText), /WORKSPACE_INVALID_FIND_TEXT/);
    await assert.rejects(registry.invoke('workspace.read', { path: 'large.ts', findText }));
  }
  await assert.rejects(registry.invoke('workspace.read', { path: 'large.ts', findText: symbol, maxChars: 32769 }));
  await assert.rejects(registry.invoke('workspace.read', { path: 'large.ts', findText: symbol, offsetChars: -1 }));
});

test('adapters without literal lookup do not advertise or silently accept findText', async () => {
  const registry = createReadonlyToolRegistry({ list: async () => ({}), read: async () => ({ content: 'old adapter' }) });
  assert.equal((await registry.invoke('workspace.read', { path: 'test' })).content, 'old adapter');
  await assert.rejects(registry.invoke('workspace.read', { path: 'test', findText: 'missing' }));
});
