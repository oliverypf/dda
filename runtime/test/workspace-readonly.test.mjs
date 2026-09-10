import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';

test('lists and reads bounded workspace content through canonical relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-'));
  await writeFile(join(root, 'README.md'), '# hello\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'main.ts'), 'export {}\n');
  await writeFile(join(root, '.env'), 'SECRET=do-not-read\n');
  const workspace = new ReadonlyWorkspace(root);

  const listing = await workspace.list();
  assert.equal(listing.granted, true);
  assert.ok(listing.entries.some((entry) => entry.path === 'README.md'));
  assert.equal(listing.entries.some((entry) => entry.path === '.env'), false);
  const nested = await workspace.list('src');
  assert.deepEqual(nested.entries.map((entry) => entry.path), ['src/main.ts']);

  const file = await workspace.read('README.md', 4);
  assert.equal(file.path, 'README.md');
  assert.equal(file.content, '# he');
  assert.equal(file.truncated, true);
  await assert.rejects(workspace.read('.env'), /WORKSPACE_SENSITIVE_PATH/);
});

test('rejects traversal, unsupported and oversized reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-reject-'));
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(32 * 1024 + 1));
  const workspace = new ReadonlyWorkspace(root);

  await assert.rejects(workspace.read('../outside'), /WORKSPACE_INVALID_PATH/);
  await assert.rejects(workspace.read('image.bin'), /WORKSPACE_UNSUPPORTED_FILE|WORKSPACE_BINARY_FILE/);
  await assert.rejects(workspace.read('invalid.txt'), /WORKSPACE_BINARY_FILE/);
  await assert.rejects(workspace.read('large.txt'), /WORKSPACE_FILE_TOO_LARGE/);
  await assert.rejects(workspace.list('missing'), /WORKSPACE_PATH_FORBIDDEN/);
});

test('keeps a full bounded UTF-8 text file usable through the registry-sized limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-utf8-'));
  await writeFile(join(root, 'notes.txt'), '\u6d4b'.repeat(10 * 1024));
  const workspace = new ReadonlyWorkspace(root);
  const file = await workspace.read('notes.txt');
  assert.equal(file.content.length, 10 * 1024);
  assert.equal(file.truncated, false);
});

test('reports an unauthorized workspace without touching the filesystem', async () => {
  const workspace = new ReadonlyWorkspace('');
  await assert.rejects(workspace.list(), /WORKSPACE_NOT_AUTHORIZED/);
  await assert.rejects(workspace.read('README.md'), /WORKSPACE_NOT_AUTHORIZED/);
});

test('excludes host-owned runtime stores from snapshot, listing and reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-excluded-'));
  await writeFile(join(root, 'README.md'), '# project\n');
  await writeFile(join(root, 'trajectory.jsonl'), '{"prompt":"must stay private"}\n');
  await mkdir(join(root, 'trajectory.jsonl.runs'));
  await writeFile(join(root, 'trajectory.jsonl.runs', 'run.json'), '{"state":"SUCCEEDED"}\n');
  const workspace = new ReadonlyWorkspace(root, {
    excludedPaths: [join(root, 'trajectory.jsonl'), join(root, 'trajectory.jsonl.runs')]
  });

  const snapshot = await workspace.snapshot();
  assert.equal(snapshot.entries.some((entry) => entry.path.startsWith('trajectory.jsonl')), false);
  assert.equal(snapshot.sections.some((section) => section.path.startsWith('trajectory.jsonl')), false);
  const listing = await workspace.list();
  assert.equal(listing.entries.some((entry) => entry.path.startsWith('trajectory.jsonl')), false);
  await assert.rejects(workspace.read('trajectory.jsonl'), /WORKSPACE_EXCLUDED_PATH/);
  await assert.rejects(workspace.list('trajectory.jsonl.runs'), /WORKSPACE_EXCLUDED_PATH/);
});
