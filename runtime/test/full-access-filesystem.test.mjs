import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeSafetyMonitor } from '../src/runtime-safety-monitor.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';

const make = async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'full-access-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'note.txt'), 'outside-data');
  await writeFile(join(project, 'local.txt'), 'local-data');
  return { base, project, outside };
};

test('outside read/list works only under FULL_ACCESS', async (t) => {
  const { project, outside } = await make(t);
  let mode = 'REQUIRE_APPROVAL';
  const getAccessMode = () => mode;
  const ws = new ReadonlyWorkspace(project, { getAccessMode });
  await assert.rejects(() => ws.read(join(outside, 'note.txt')), /WORKSPACE_PATH_FORBIDDEN|WORKSPACE_/);
  mode = 'FULL_ACCESS';
  const read = await ws.read(join(outside, 'note.txt'));
  assert.equal(read.content.includes('outside-data') ? 'outside-data' : read.content, 'outside-data');
  const list = await ws.list(outside);
  assert.equal(list.granted, true);
  assert.ok(list.entries.some((e) => e.path.endsWith('note.txt')));
  // Relative inside paths still work unchanged.
  const local = await ws.read('local.txt');
  assert.equal(local.content.includes('local-data') ? 'local-data' : local.content, 'local-data');
  // Revoke: next outside read fails before I/O.
  mode = 'REQUIRE_APPROVAL';
  await assert.rejects(() => ws.read(join(outside, 'note.txt')), /WORKSPACE_/);
});

test('monitor canonicalPath authorizes outside writes only under FULL_ACCESS', async (t) => {
  const { project, outside } = await make(t);
  let mode = 'REQUIRE_APPROVAL';
  const getAccessMode = () => mode;
  const monitor = new RuntimeSafetyMonitor({ mode: 'CONTROLLED', workspaceRoot: project, getAccessMode });
  const target = join(outside, 'created.txt');
  await assert.rejects(() => monitor.canonicalPath(target, { forWrite: true }), /SAFETY_/);
  mode = 'FULL_ACCESS';
  const resolved = await monitor.canonicalPath(target, { forWrite: true });
  assert.ok(resolved.absolutePath.toLowerCase().includes('outside'));
  await writeFile(resolved.absolutePath, 'written-outside');
  const back = await monitor.canonicalPath(target);
  assert.equal(back.exists, true);
  // forWrite on a directory fails.
  await assert.rejects(() => monitor.canonicalPath(outside, { forWrite: true }), /WORKSPACE_|SAFETY_/);
  mode = 'REQUIRE_APPROVAL';
  await assert.rejects(() => monitor.canonicalPath(target, { forWrite: true }), /WORKSPACE_|SAFETY_/);
});

test('protected paths, secrets, .git and links stay denied even under FULL_ACCESS', async (t) => {
  const { project, outside } = await make(t);
  const protectedDir = join(outside, 'protected');
  await mkdir(protectedDir);
  await writeFile(join(protectedDir, 'x.txt'), 'x');
  let mode = 'FULL_ACCESS';
  const monitor = new RuntimeSafetyMonitor({ mode: 'CONTROLLED', workspaceRoot: project,
    getAccessMode: () => mode, protectedPaths: [protectedDir] });
  await assert.rejects(() => monitor.canonicalPath(join(protectedDir, 'x.txt')), /PROTECTED|WORKSPACE_|SAFETY_/);
  const ws = new ReadonlyWorkspace(project, { getAccessMode: () => mode, protectedPaths: [protectedDir] });
  await assert.rejects(() => ws.read(join(protectedDir, 'x.txt')), /WORKSPACE_|PROTECTED|SAFETY_/);
  const secret = join(outside, '.env');
  await writeFile(secret, 'KEY=x');
  await assert.rejects(() => ws.read(secret), /WORKSPACE_|SECRET|SAFETY_/);
  const gitMeta = join(outside, '.git', 'config');
  await mkdir(join(outside, '.git'), { recursive: true });
  await writeFile(gitMeta, '[core]');
  await assert.rejects(() => ws.read(gitMeta), /WORKSPACE_|SAFETY_/);
  const link = join(project, 'link-out');
  let linked = true;
  try {
    await symlink(join(outside, 'note.txt'), link);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    linked = false;
  }
  if (linked) await assert.rejects(() => ws.read(link), /WORKSPACE_|LINK|SAFETY_/);
});

test('insideRoot containment rejects same-length and prefix siblings', async () => {
  const { insideRoot } = await import('../src/filesystem-access.mjs');
  const { resolve } = await import('node:path');
  const root = resolve('C:/work/project');
  assert.equal(insideRoot(root, resolve('C:/work/project2')), false);
  assert.equal(insideRoot(root, resolve('C:/work/project/sub')), true);
  assert.equal(insideRoot(root, resolve('C:/work/project2/sub')), false);
});
