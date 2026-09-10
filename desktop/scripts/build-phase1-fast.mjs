import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths } from './windows-path.mjs';

// Fast local iteration: debug profile, no MSI/NSIS bundling.  The Phase 1
// release channel is still baked into the binary so the UI keeps the same
// read-only gate while frontend/runtime changes are tested.
export const phase1FastBuildEnvironment = (environment) => {
  const next = { ...environment };
  delete next.NAPI_RS_NATIVE_LIBRARY_PATH;
  delete next.NAPI_RS_FORCE_WASI;
  next.HMCODEX_BUILD_RELEASE_CHANNEL = 'WINDOWS_PHASE1_READ_ONLY';
  return next;
};

export function runPhase1FastBuild({ desktopRoot = projectPaths(import.meta.url).desktopRoot, environment = process.env, spawn = spawnSync } = {}) {
  const result = spawn(process.execPath, [
    join(desktopRoot, 'node_modules/@tauri-apps/cli/tauri.js'),
    'build', '--target', 'x86_64-pc-windows-msvc', '--debug', '--no-bundle'
  ], { cwd: desktopRoot, stdio: 'inherit', windowsHide: true, env: phase1FastBuildEnvironment(environment) });
  if (result.error) throw result.error;
  if (result.status === -1073741818) {
    throw new Error('Tauri CLI crashed while loading its native Windows binding. Run the build from a local NTFS checkout (not a UNC/mapped share).');
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPhase1FastBuild();
}
