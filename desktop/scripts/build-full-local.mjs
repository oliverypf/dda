import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
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

export function runFullLocalBuild({ desktopRoot = projectPaths(import.meta.url).desktopRoot, environment = process.env, spawn = spawnSync, fast = false } = {}) {
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
  if (result.error) throw result.error;
  if (result.status === -1073741818) {
    throw new Error('Tauri CLI crashed while loading its native Windows binding. Run the build from a local NTFS checkout (not a UNC/mapped share).');
  }
  return result.status ?? 1;
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
  process.exitCode = runFullLocalBuild({ desktopRoot, fast });
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
