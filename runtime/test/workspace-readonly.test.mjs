import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';

test('lists and reads bounded workspace content through canonical relative paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-'));
  await writeFile(join(root, 'README.md'), '# hello\n');
  await writeFile(join(root, 'index.html'), '<main>Hello</main>\n');
  await writeFile(join(root, 'styles.css'), 'main { color: blue; }\n');
  await writeFile(join(root, 'Makefile'), 'test:\n\tnode --test\n');
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
  assert.equal((await workspace.read('index.html')).content, '<main>Hello</main>\n');
  assert.equal((await workspace.read('styles.css')).content, 'main { color: blue; }\n');
  assert.equal((await workspace.read('Makefile')).content, 'test:\n\tnode --test\n');
  const snapshot = await workspace.snapshot();
  assert.ok(snapshot.sections.some((section) => section.path === 'index.html'));
  assert.ok(snapshot.sections.some((section) => section.path === 'styles.css'));
  assert.ok(snapshot.sections.some((section) => section.path === 'Makefile'));
  await assert.rejects(workspace.read('.env'), /WORKSPACE_SENSITIVE_PATH/);
});

test('rejects traversal and binary content while paging oversized text reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-reject-'));
  await writeFile(join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  await writeFile(join(root, 'control-bytes.dat'), Buffer.from([1, 2, 3]));
  await writeFile(join(root, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(32 * 1024 + 1));
  const workspace = new ReadonlyWorkspace(root);

  await assert.rejects(workspace.read('../outside'), /WORKSPACE_INVALID_PATH/);
  await assert.rejects(workspace.read('image.bin'), /WORKSPACE_BINARY_FILE:image\.bin/);
  await assert.rejects(workspace.read('control-bytes.dat'), /WORKSPACE_BINARY_FILE:control-bytes\.dat/);
  await assert.rejects(workspace.read('invalid.txt'), /WORKSPACE_BINARY_FILE/);
  const largePage = await workspace.read('large.txt');
  assert.equal(largePage.content.length, 32768);
  assert.equal(largePage.truncated, true);
  await assert.rejects(workspace.list('missing'), /WORKSPACE_NOT_FOUND:missing/);
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

test('reads ANSI-colored build logs without changing file evidence or paging offsets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-ansi-'));
  const text = 'build start\r\n\x1b[32mBUILD SUCCESSFUL\x1b[0m\n';
  await writeFile(join(root, 'build.log'), text);
  await writeFile(join(root, 'large.log'), text.repeat(1500));
  await writeFile(join(root, 'control.log'), text + '\x01');
  await writeFile(join(root, 'escape.log'), 'unfinished escape\x1b');
  const workspace = new ReadonlyWorkspace(root);

  const file = await workspace.read('build.log');
  assert.equal(file.content, text);
  assert.equal(file.sizeBytes, Buffer.byteLength(text));
  const snapshot = await workspace.snapshot();
  assert.equal(snapshot.sections.find((section) => section.path === 'build.log')?.content, text);
  assert.equal(snapshot.sections.find((section) => section.path === 'build.log')?.digest, file.digest);
  const first = await workspace.read('large.log', 32768);
  const next = await workspace.read('large.log', 32768, 32768);
  assert.equal(first.content + next.content, text.repeat(1500).slice(0, 65536));
  assert.equal(first.truncated, true);
  await assert.rejects(workspace.read('control.log'), /WORKSPACE_BINARY_FILE/);
  await assert.rejects(workspace.read('escape.log'), /WORKSPACE_BINARY_FILE/);
});
