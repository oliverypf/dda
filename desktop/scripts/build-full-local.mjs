import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths } from './windows-path.mjs';

export const fullLocalBuildEnvironment = (environment) => {
  const next = { ...environment };
  delete next.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete next.NAPI_RS_FORCE_WASI;
  next.HMCODEX_BUILD_RELEASE_CHANNEL = 'WINDOWS_FULL_LOCAL';
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runFullLocalBuild({ fast: process.argv.includes('--fast') });
}
