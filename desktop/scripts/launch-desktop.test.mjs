import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_BUILD_COMMAND, desktopBuildManifestPath, launchDesktop, loadStagedDesktopBuild } from './launch-desktop.mjs';

async function stagedFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dda-launch-desktop-')));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const outputRoot = join(root, 'desktop-builds');
  const buildDirectory = join(outputRoot, 'build-x86_64-pc-windows-msvc-1');
  await mkdir(join(buildDirectory, 'runtime', 'src'), { recursive: true });
  await writeFile(join(buildDirectory, 'dda-desktop.exe'), 'exe-bytes');
  await writeFile(join(buildDirectory, 'runtime', 'src', 'index.mjs'), 'export {};\n');
  const manifest = {
    executable: join(buildDirectory, 'dda-desktop.exe'),
    buildDirectory,
    target: 'x86_64-pc-windows-msvc',
    profile: 'debug'
  };
  const manifestPath = join(outputRoot, 'latest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, outputRoot, buildDirectory, manifest, manifestPath };
}

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.unrefCalls = 0;
  }

  unref() {
    this.unrefCalls += 1;
  }
}

test('launch manifest path comes from the local app data desktop-builds folder', () => {
  assert.equal(
    desktopBuildManifestPath({ LOCALAPPDATA: join('C:', 'Users', 'me', 'AppData', 'Local') }),
    join('C:', 'Users', 'me', 'AppData', 'Local', 'dda', 'desktop-builds', 'latest.json')
  );
  assert.throws(() => desktopBuildManifestPath({}), /LOCALAPPDATA is not set/);
});

test('a missing manifest errors with the explicit build command instead of a fallback', async (t) => {
  const { root } = await stagedFixture(t);
  await assert.rejects(
    loadStagedDesktopBuild({ manifestPath: join(root, 'nothing', 'latest.json') }),
    (error) => error.message.includes('no staged desktop build found') && error.message.includes(DESKTOP_BUILD_COMMAND)
  );
});

test('the staged manifest is validated for object shape, required fields, absolute paths, and an existing executable and runtime', async (t) => {
  const { manifest, manifestPath, buildDirectory } = await stagedFixture(t);
  await writeFile(manifestPath, '{ not json');
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /not valid JSON/);
  await writeFile(manifestPath, 'null');
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /must be a JSON object/);
  await writeFile(manifestPath, '[]');
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /must be a JSON object/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, target: undefined }));
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /missing "target"/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, buildDirectory: 'relative\\dir' }));
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /must be absolute/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, executable: join(buildDirectory, '..', 'dda-desktop.exe') }));
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /must live in its build directory/);
  await writeFile(manifestPath, JSON.stringify({ ...manifest, executable: join(buildDirectory, 'gone.exe') }));
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /staged executable is missing/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await rm(join(buildDirectory, 'runtime'), { recursive: true, force: true });
  await assert.rejects(loadStagedDesktopBuild({ manifestPath }), /staged runtime entry is missing/);
});

test('launch starts the staged executable detached, from its build directory, with runtime env and no debug port', async (t) => {
  const { manifestPath, buildDirectory, manifest } = await stagedFixture(t);
  const calls = [];
  let child;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    child = new FakeChild(4242);
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  const environment = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', PATH: 'toolchain' };
  const result = await launchDesktop({ manifestPath, environment, workspaceRoot: 'C:\\repo', spawn, activateExisting: async () => undefined });
  assert.deepEqual(result, { pid: 4242, executable: manifest.executable, buildDirectory });
  assert.equal(calls[0].command, manifest.executable);
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.cwd, buildDirectory);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.env.DDA_RUNTIME_ENTRY, join(buildDirectory, 'runtime', 'src', 'index.mjs'));
  assert.equal(calls[0].options.env.DDA_WORKSPACE_ROOT, 'C:\\repo');
  assert.equal(calls[0].options.env.PATH, 'toolchain');
  assert.equal(calls[0].options.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined);
  assert.equal(child.unrefCalls, 1);
  assert.equal(environment.DDA_RUNTIME_ENTRY, undefined, 'caller environment is not mutated');
});

test('a spawn error rejects the launch and never reports success or unrefs the child', async (t) => {
  const { manifestPath } = await stagedFixture(t);
  let child;
  const spawn = () => {
    child = new FakeChild(undefined);
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn dda-desktop.exe EACCES'), { code: 'EACCES' })));
    return child;
  };
  await assert.rejects(
    launchDesktop({ manifestPath, environment: {}, workspaceRoot: 'C:\\repo', spawn, activateExisting: async () => undefined }),
    (error) => error.code === 'EACCES'
  );
  assert.equal(child.unrefCalls, 0);
});

test('an existing healthy window is activated instead of spawning a duplicate', async (t) => {
  const { manifestPath, buildDirectory, manifest } = await stagedFixture(t);
  const spawnCalls = [];
  const spawn = (command) => { spawnCalls.push(command); return new FakeChild(1); };
  const result = await launchDesktop({
    manifestPath,
    environment: {},
    workspaceRoot: 'C:\\repo',
    spawn,
    activateExisting: async () => ({ pid: 15872, executable: manifest.executable, buildDirectory })
  });
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.pid, 15872);
  assert.equal(spawnCalls.length, 0, 'no new process spawned');
});

test('an activation failure refuses the launch rather than blind-spawning', async (t) => {
  const { manifestPath } = await stagedFixture(t);
  const spawnCalls = [];
  const spawn = (command) => { spawnCalls.push(command); return new FakeChild(1); };
  await assert.rejects(
    launchDesktop({
      manifestPath,
      environment: {},
      workspaceRoot: 'C:\\repo',
      spawn,
      activateExisting: async () => { throw new Error('cannot determine existing window'); }
    }),
    /cannot determine existing window/
  );
  assert.equal(spawnCalls.length, 0, 'no new process spawned on activation failure');
});

test('an isolated profile skips activation entirely (no PowerShell child)', async (t) => {
  const { activateExistingDesktop } = await import('./launch-desktop.mjs');
  const spawnCalls = [];
  const spawn = (command) => { spawnCalls.push(command); return new FakeChild(1); };
  const result = await activateExistingDesktop({
    environment: { WEBVIEW2_USER_DATA_FOLDER: 'C:\\iso\\wv2' },
    platform: 'win32',
    spawn
  });
  assert.equal(result, undefined);
  assert.equal(spawnCalls.length, 0, 'isolated profile never activates the real app');
    const nonWin = await activateExistingDesktop({ environment: {}, platform: 'linux', spawn });
  assert.equal(nonWin, undefined);
});

test('launch passes targetExecutable to activation and preserves stale/busy flags when a busy older window cannot close', async (t) => {
  const { manifestPath, buildDirectory, manifest } = await stagedFixture(t);
  let receivedTarget;
  const result = await launchDesktop({
    manifestPath,
    environment: {},
    workspaceRoot: 'C:\\repo',
    spawn: () => { throw new Error('must not spawn when busy stale window remains open'); },
    activateExisting: async ({ targetExecutable }) => {
      receivedTarget = targetExecutable;
      return { pid: 9999, executable: join(buildDirectory, 'older.exe'), buildDirectory, stale: true, busy: true };
    }
  });
  assert.equal(receivedTarget, manifest.executable);
  assert.equal(result.alreadyRunning, true);
  assert.equal(result.stale, true);
  assert.equal(result.busy, true);
});
