import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DESKTOP_BUILD_MANIFEST, stageDesktopBuild } from './stage-desktop-build.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dda-stage-desktop-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const workspace = join(root, 'workspace');
  const desktopRoot = join(workspace, 'desktop');
  const tauriRoot = join(desktopRoot, 'src-tauri');
  await mkdir(join(workspace, 'runtime', 'src'), { recursive: true });
  await writeFile(join(workspace, 'runtime', 'src', 'index.mjs'), 'export {};\n');
  await writeFile(join(workspace, 'runtime', 'package.json'), '{}\n');
  await mkdir(join(tauriRoot, 'target', 'x86_64-pc-windows-msvc', 'debug'), { recursive: true });
  await writeFile(join(tauriRoot, 'target', 'x86_64-pc-windows-msvc', 'debug', 'dda-desktop.exe'), 'exe-bytes');
  await writeFile(join(tauriRoot, 'tauri.conf.json'), JSON.stringify({
    bundle: { resources: {
      '../../runtime/src': 'runtime/src',
      '../../runtime/package.json': 'runtime/package.json'
    } }
  }));
  await writeFile(join(desktopRoot, 'index.html'), '<!doctype html>\n');
  const outputRoot = join(root, 'out');
  return { root, workspace, desktopRoot, tauriRoot, outputRoot };
}

test('stages the executable and bundle resources into a unique build directory outside the workspace', async (t) => {
  const { desktopRoot, workspace, outputRoot } = await fixture(t);
  const staged = await stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot });
  assert.equal(staged.target, 'x86_64-pc-windows-msvc');
  assert.equal(staged.profile, 'debug');
  assert.equal(dirname(staged.buildDirectory), await realpath(outputRoot));
  assert.match(staged.buildDirectory.split(/[\\/]/).pop(), /^build-x86_64-pc-windows-msvc-/);
  assert.equal(await readFile(staged.executable, 'utf8'), 'exe-bytes');
  assert.equal(await readFile(join(staged.buildDirectory, 'runtime', 'src', 'index.mjs'), 'utf8'), 'export {};\n');
  assert.equal((await lstat(join(staged.buildDirectory, 'runtime', 'src', 'index.mjs'))).isSymbolicLink(), false);
  const manifest = JSON.parse(await readFile(join(outputRoot, DESKTOP_BUILD_MANIFEST), 'utf8'));
  assert.deepEqual(manifest, staged);
  assert.deepEqual((await readdir(outputRoot)).filter((name) => name.endsWith('.tmp')), []);
});

test('a second staging creates a new directory and keeps the earlier build', async (t) => {
  const { desktopRoot, workspace, outputRoot } = await fixture(t);
  const first = await stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot });
  const second = await stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot });
  assert.notEqual(first.buildDirectory, second.buildDirectory);
  assert.equal(await readFile(first.executable, 'utf8'), 'exe-bytes');
  assert.equal((await readdir(outputRoot)).filter((name) => name.startsWith('build-')).length, 2);
});

test('rejects output inside the workspace and unsupported targets or profiles', async (t) => {
  const { desktopRoot, workspace } = await fixture(t);
  await assert.rejects(
    stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot: join(workspace, 'staged') }),
    /must be outside the workspace/
  );
  await assert.rejects(
    stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot: join(workspace, '..', 'out'), target: 'i686-pc-windows-msvc' }),
    /unsupported desktop target/
  );
  await assert.rejects(
    stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot: join(workspace, '..', 'out'), profile: 'bench' }),
    /unsupported desktop profile/
  );
});

test('a missing bundle resource fails without writing latest.json or leaving a partial build', async (t) => {
  const { desktopRoot, workspace, tauriRoot, outputRoot } = await fixture(t);
  const config = JSON.parse(await readFile(join(tauriRoot, 'tauri.conf.json'), 'utf8'));
  config.bundle.resources['../../runtime/missing.json'] = 'runtime/missing.json';
  await writeFile(join(tauriRoot, 'tauri.conf.json'), JSON.stringify(config));
  await assert.rejects(
    stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot }),
    /bundle resource missing/
  );
  await assert.rejects(readFile(join(outputRoot, DESKTOP_BUILD_MANIFEST), 'utf8'), { code: 'ENOENT' });
  const leftovers = await readdir(outputRoot).catch(() => []);
  assert.deepEqual(leftovers.filter((name) => name.startsWith('build-')), []);
});

test('a missing built executable names the build command', async (t) => {
  const { desktopRoot, workspace, outputRoot } = await fixture(t);
  await assert.rejects(
    stageDesktopBuild({ desktopRoot, workspaceRoot: workspace, outputRoot, profile: 'release' }),
    /build-controlled\.mjs --fast/
  );
});
