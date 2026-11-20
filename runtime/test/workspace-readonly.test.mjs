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
  await writeFile(join(root, 'trajectory.jsonl.cancels.json'), '{"requests":{}}');
  await writeFile(join(root, 'trajectory.jsonl.cancels.json.lock'), 'host lock');
  const withCancelStore = new ReadonlyWorkspace(root, { excludedPaths: [
    join(root, 'trajectory.jsonl'), join(root, 'trajectory.jsonl.runs'),
    join(root, 'trajectory.jsonl.cancels.json'), join(root, 'trajectory.jsonl.cancels.json.lock')
  ] });
  assert.equal((await withCancelStore.snapshot()).entries.some(entry => entry.path.includes('cancels.json')), false);
  assert.equal((await withCancelStore.list()).entries.some(entry => entry.path.includes('cancels.json')), false);
  await assert.rejects(withCancelStore.read('trajectory.jsonl.cancels.json.lock'), /WORKSPACE_EXCLUDED_PATH/u);
});

test('reads UTF-16 build logs written by PowerShell as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-utf16-'));
  const text = 'node : build start\r\nFinished 2 bundles at:\r\n';
  await writeFile(join(root, 'build-exe.log'), Buffer.from(`\uFEFF${text}`, 'utf16le'));
  await writeFile(join(root, 'build-be.log'), Buffer.concat([
    Buffer.from([0xfe, 0xff]),
    Buffer.from(text, 'utf16le').swap16()
  ]));
  await writeFile(join(root, 'utf16-control.log'), Buffer.from(`\uFEFF${text}\u0001`, 'utf16le'));
  const workspace = new ReadonlyWorkspace(root);

  const file = await workspace.read('build-exe.log');
  assert.equal(file.content, text);
  assert.equal(file.sizeBytes, Buffer.byteLength(`\uFEFF${text}`, 'utf16le'));
  assert.equal((await workspace.read('build-be.log')).content, text);
  const page = await workspace.read('build-exe.log', 4);
  assert.equal(page.content, text.slice(0, 4));
  assert.equal(page.truncated, true);
  await assert.rejects(workspace.read('utf16-control.log'), /WORKSPACE_BINARY_FILE/);
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

test('snapshot walks breadth-first and skips hidden cache/build directories so monorepo manifests stay visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-bfs-'));
  await mkdir(join(root, '.bitfun', '.deveco', '.cxx'), { recursive: true });
  await mkdir(join(root, '.codex', '__pycache__'), { recursive: true });
  await mkdir(join(root, 'desktop', 'src-tauri', 'target-b199'), { recursive: true });
  await mkdir(join(root, 'runtime', 'src'), { recursive: true });
  for (let i = 0; i < 60; i += 1) {
    await writeFile(join(root, '.bitfun', '.deveco', '.cxx', `cache-${i}.json`), '{}');
    await writeFile(join(root, 'desktop', 'src-tauri', 'target-b199', `artifact-${i}.d`), '');
  }
  await writeFile(join(root, '.codex', '__pycache__', 'mod.cpython-314.pyc'), 'pyc');
  await writeFile(join(root, 'desktop', 'package.json'), '{"name":"desktop"}\n');
  await writeFile(join(root, 'desktop', 'src-tauri', 'Cargo.toml'), '[package]\nname = "dda"\n');
  await writeFile(join(root, 'runtime', 'package.json'), '{"name":"runtime"}\n');

  const workspace = new ReadonlyWorkspace(root);
  const snapshot = await workspace.snapshot();
  const paths = snapshot.entries.map((entry) => entry.path);
  assert.equal(paths.some((p) => p.startsWith('.bitfun')), false);
  assert.equal(paths.some((p) => p.includes('__pycache__') || p.endsWith('.pyc')), false);
  assert.equal(paths.some((p) => p.includes('target-b199')), false);
  assert.ok(snapshot.omittedDirectories.includes('.bitfun'));
  assert.ok(snapshot.omittedDirectories.includes('desktop/src-tauri/target-b199'));
  assert.equal(snapshot.omittedDirectories.some((p) => p.includes('artifact-')), false);
  assert.equal(paths.includes('desktop/package.json'), true);
  assert.equal(paths.includes('desktop/src-tauri/Cargo.toml'), true);
  assert.equal(paths.includes('runtime/package.json'), true);
});


test('snapshot skips noisy cache dirs, ranks nested manifests, and stays bounded without fabricating root manifests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-snapshot-'));
  await mkdir(join(root, '.bitfun', 'logs'), { recursive: true });
  await writeFile(join(root, '.bitfun', 'logs', 'trace.json'), '{}');
  await mkdir(join(root, '.deveco', 'cache'), { recursive: true });
  await writeFile(join(root, '.deveco', 'cache', 'idx.db'), 'x');
  // Nested manifests only — the root itself has no package.json/Cargo.toml and
  // the snapshot must not fabricate one.
  await mkdir(join(root, 'desktop'), { recursive: true });
  await writeFile(join(root, 'desktop', 'package.json'), '{}');
  await mkdir(join(root, 'runtime'), { recursive: true });
  await writeFile(join(root, 'runtime', 'Cargo.toml'), '[package]\n');
  // A flood of plain files must not push the bounded snapshot past its cap.
  await mkdir(join(root, 'zz-bulk'), { recursive: true });
  for (let i = 0; i < 260; i += 1) await writeFile(join(root, 'zz-bulk', `f${String(i).padStart(3, '0')}.txt`), 'x');
  const workspace = new ReadonlyWorkspace(root);

  const snapshot = await workspace.snapshot();
  const paths = snapshot.entries.map((entry) => entry.path);
  assert.ok(snapshot.entries.length <= 200);
  assert.equal(paths.some((path) => path.includes('.bitfun')), false);
  assert.equal(paths.some((path) => path.includes('.deveco')), false);
  assert.ok(snapshot.omittedDirectories.includes('.bitfun'));
  assert.ok(snapshot.omittedDirectories.includes('.deveco'));
  assert.equal(paths.includes('package.json'), false, 'no fabricated root manifest');
  assert.equal(paths.includes('Cargo.toml'), false, 'no fabricated root manifest');
  assert.ok(paths.includes('desktop/package.json'));
  assert.ok(paths.includes('runtime/Cargo.toml'));

  // Explicit reads of an authorized cache-dir path still resolve; the ignore
  // list only bounds the snapshot, it is not a permission boundary.
  const cached = await workspace.read('.bitfun/logs/trace.json');
  assert.equal(cached.path, '.bitfun/logs/trace.json');
  const cachedList = await workspace.list('.deveco');
  assert.ok(cachedList.entries.some((entry) => entry.path === '.deveco/cache'));
  const rootList = await workspace.list();
  const bitfun = rootList.entries.find((entry) => entry.path === '.bitfun');
  assert.equal(bitfun?.kind, 'DIRECTORY');
  assert.equal(bitfun?.contentsOmitted, true);
});

test('reports generated build directories as present without indexing their contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-generated-'));
  await mkdir(join(root, 'desktop', 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'desktop', 'node_modules', 'left-pad', 'package.json'), '{}\n');
  await mkdir(join(root, 'desktop', 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'desktop', 'dist', 'index.html'), '<html></html>\n');
  await mkdir(join(root, 'desktop', 'src-tauri', 'target', 'release'), { recursive: true });
  await writeFile(join(root, 'desktop', 'src-tauri', 'target', 'release', 'dda-desktop.exe'), 'MZ');
  await mkdir(join(root, 'desktop', 'src-tauri', 'target-b199', 'debug'), { recursive: true });
  await writeFile(join(root, 'desktop', 'package.json'), '{}\n');
  const workspace = new ReadonlyWorkspace(root);

  const snapshot = await workspace.snapshot();
  assert.deepEqual(snapshot.omittedDirectories, [
    'desktop/dist',
    'desktop/node_modules',
    'desktop/src-tauri/target',
    'desktop/src-tauri/target-b199'
  ]);
  const indexed = snapshot.entries.map((entry) => entry.path);
  assert.equal(indexed.some((path) => path.includes('left-pad') || path.includes('index.html') || path.endsWith('.exe')), false);
  assert.equal(indexed.includes('desktop/package.json'), true);

  const desktop = await workspace.list('desktop');
  const listed = Object.fromEntries(desktop.entries.map((entry) => [entry.path, entry]));
  assert.equal(listed['desktop/node_modules']?.contentsOmitted, true);
  assert.equal(listed['desktop/dist']?.contentsOmitted, true);
  const modules = await workspace.list('desktop/node_modules');
  const packageEntry = modules.entries.find((entry) => entry.path === 'desktop/node_modules/left-pad');
  assert.equal(packageEntry?.kind, 'DIRECTORY');
  assert.equal(packageEntry?.contentsOmitted, undefined);
  const tauri = await workspace.list('desktop/src-tauri');
  const tauriEntries = Object.fromEntries(tauri.entries.map((entry) => [entry.path, entry]));
  assert.equal(tauriEntries['desktop/src-tauri/target']?.contentsOmitted, true);
  assert.equal(tauriEntries['desktop/src-tauri/target-b199']?.contentsOmitted, true);
});

test('reads and focuses minified JS bundles containing sparse literal control characters while rejecting NUL or dense binary bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-minified-js-'));
  const bundleBody = [
    'const header = "' + 'a'.repeat(800) + '";',
    'const ctrlTable = "\\x00" + "\x01\x03\x1f\x7f";',
    'function connectChatGptAccount() { return "connected"; }',
    'const footer = "' + 'b'.repeat(800) + '";'
  ].join('\n');
  await writeFile(join(root, 'workbench.desktop.main.js'), bundleBody, 'utf8');
  await writeFile(join(root, 'nul-bytes.js'), Buffer.concat([Buffer.from('const x = 1;\n'.repeat(80)), Buffer.from([0])]));
  await writeFile(join(root, 'dense-binary.js'), '\x01'.repeat(600), 'utf8');

  const workspace = new ReadonlyWorkspace(root);
  const focused = await workspace.readMatching('workbench.desktop.main.js', 'function connectChatGptAccount()', 120, 0, true);
  assert.equal(focused.found, true);
  assert.ok(focused.content.startsWith('function connectChatGptAccount()'));

  await assert.rejects(workspace.read('nul-bytes.js'), /WORKSPACE_BINARY_FILE/);
  await assert.rejects(workspace.read('dense-binary.js'), /WORKSPACE_BINARY_FILE/);
});
