import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { realpath, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths } from './windows-path.mjs';
import { desktopBuildSourceExecutable, stageDesktopBuild } from './stage-desktop-build.mjs';

export const fullLocalBuildEnvironment = (environment) => {
  const next = { ...environment };
  delete next.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete next.NAPI_RS_FORCE_WASI;
  next.DDA_BUILD_RELEASE_CHANNEL = 'WINDOWS_FULL_LOCAL';
  return next;
};

const timestamp = (date = new Date()) => date.toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14);

export function probeExecutableLock(path, { platform = process.platform, spawn = spawnSync, environment = process.env } = {}) {
  if (platform !== 'win32' || !existsSync(path)) return { exists: existsSync(path), locked: false };
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p=$env:DDA_TARGET_EXE; try { $s=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $s.Dispose(); exit 0 } catch { exit 32 }'],
  { stdio: 'ignore', windowsHide: true, env: { ...environment, DDA_TARGET_EXE: path } });
  return { exists: true, locked: result.status === 32 };
}

export async function prepareBuildTarget({ path, platform = process.platform, spawn = spawnSync, environment = process.env, renameFile = rename, now = new Date() } = {}) {
  const lock = probeExecutableLock(path, { platform, spawn, environment });
  if (!lock.locked) return { path, disposition: lock.exists ? 'REUSED_TARGET' : 'NEW_TARGET' };
  const backup = path.replace(/\.exe$/iu, `.locked-before-${timestamp(now)}.exe`);
  await renameFile(path, backup);
  console.log(`DDA_BUILD_TARGET ${JSON.stringify({ version: 1, disposition: 'RENAMED_LOCKED_TARGET', path, backup })}`);
  return { path, backup, disposition: 'RENAMED_LOCKED_TARGET' };
}

export function runFullLocalBuild({ desktopRoot = projectPaths(import.meta.url).desktopRoot, environment = process.env, spawn = spawnSync, fast = false, stageOnly = false, targetExecutable } = {}) {
  const target = targetExecutable ?? join(desktopRoot, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', fast ? 'debug' : 'release', 'dda-desktop.exe');
  if (stageOnly) {
    if (!existsSync(target)) {
      console.log(`DDA_BUILD_FAILURE ${JSON.stringify({ version: 1, reason: 'missing_executable', exitCode: 2, nextAction: 'run_without_stage_only' })}`);
      return 2;
    }
    console.log(`DDA_BUILD_STAGE_ONLY ${JSON.stringify({ version: 1, executable: target })}`);
    return 0;
  }
  const args = [
    join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--target', 'x86_64-pc-windows-msvc'
  ];
  if (fast) args.push('--debug', '--no-bundle');
  const result = spawn(process.execPath, args, {
    cwd: desktopRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: fullLocalBuildEnvironment(environment)
  });
  if (result.error) {
    console.log(`DDA_BUILD_FAILURE ${JSON.stringify({ version: 1, reason: 'spawn_error', message: result.error.message, nextAction: 'check_build_prerequisites' })}`);
    throw result.error;
  }
  if (result.status === -1073741818) {
    console.log(`DDA_BUILD_FAILURE ${JSON.stringify({ version: 1, reason: 'native_binding_crash', exitCode: result.status, nextAction: 'run_from_local_ntfs_checkout' })}`);
    throw new Error('Tauri CLI crashed while loading its native Windows binding. Run the build from a local NTFS checkout (not a UNC/mapped share).');
  }
  const status = result.status ?? 1;
  if (status !== 0) console.log(`DDA_BUILD_FAILURE ${JSON.stringify({ version: 1, reason: 'tauri_build_failed', exitCode: status, nextAction: 'inspect_prior_output_before_retry' })}`);
  return status;
}

async function describeWorkspaceExecutable(path, root) {
  try {
    const resolved = await realpath(path);
    const relativePath = relative(await realpath(root), resolved);
    if (!relativePath || isAbsolute(relativePath) || /^\.\.(?:[\\/]|$)/u.test(relativePath)) return undefined;
    const before = await stat(resolved);
    if (!before.isFile()) return undefined;
    const hasher = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) hasher.update(chunk);
    const after = await stat(await realpath(path));
    const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'];
    if (!after.isFile() || !fields.every(key => before[key] === after[key])) return undefined;
    return { path, sha256: `sha256:${hasher.digest('hex')}`, identity: fields.map(key => before[key]) };
  } catch { return undefined; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fast = process.argv.includes('--fast');
  const { desktopRoot, workspaceRoot } = projectPaths(import.meta.url);
  const profile = fast ? 'debug' : 'release';
  const cargoTargetDir = process.env.CARGO_TARGET_DIR?.trim() ? resolve(desktopRoot, 'src-tauri', process.env.CARGO_TARGET_DIR.trim()) : undefined;
  const source = desktopBuildSourceExecutable({ desktopRoot, cargoTargetDir, profile });
  const before = process.platform === 'win32' ? await describeWorkspaceExecutable(source, workspaceRoot) : undefined;
  const stageOnly = process.argv.includes('--stage-only');
  if (process.platform === 'win32' && !stageOnly) {
    try {
      await prepareBuildTarget({ path: source });
    } catch (error) {
      console.log(`DDA_BUILD_FAILURE ${JSON.stringify({ version: 1, reason: 'locked_target_unresolved', message: error.message, nextAction: 'close_the_running_desktop_instance_or_free_the_target' })}`);
      process.exitCode = 2;
      process.exit();
    }
  }
  process.exitCode = runFullLocalBuild({ desktopRoot, fast, stageOnly, targetExecutable: source });
  if (process.exitCode === 0 && process.platform === 'win32') {
    const staged = await stageDesktopBuild({ desktopRoot, workspaceRoot, cargoTargetDir, profile });
    const after = await describeWorkspaceExecutable(source, workspaceRoot);
    if (after) {
      const reused = before?.sha256 === after.sha256 && before.identity.every((value, index) => value === after.identity[index]);
      console.log(`DDA_BUILD_ARTIFACT ${JSON.stringify({ version: 1, path: after.path, sha256: after.sha256,
        disposition: reused ? 'REUSED' : 'GENERATED' })}`);
    }
    console.log(`staged runnable desktop: ${staged.executable}`);
  }
}
