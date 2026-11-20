import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths } from './windows-path.mjs';
import { DESKTOP_BUILD_MANIFEST, defaultDesktopBuildRoot } from './stage-desktop-build.mjs';

export const DESKTOP_BUILD_COMMAND = 'node desktop/scripts/build-controlled.mjs --fast';

export const desktopBuildManifestPath = (environment = process.env, outputRoot = defaultDesktopBuildRoot(environment)) =>
  join(outputRoot, DESKTOP_BUILD_MANIFEST);

export async function loadStagedDesktopBuild({ manifestPath = desktopBuildManifestPath() } = {}) {
  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`no staged desktop build found at ${manifestPath}. Build it with: ${DESKTOP_BUILD_COMMAND}`);
    }
    throw error;
  }
  let build;
  try {
    build = JSON.parse(text);
  } catch {
    throw new Error(`staged desktop manifest is not valid JSON: ${manifestPath}. Rebuild with: ${DESKTOP_BUILD_COMMAND}`);
  }
  if (build === null || typeof build !== 'object' || Array.isArray(build)) {
    throw new Error(`staged desktop manifest must be a JSON object: ${manifestPath}. Rebuild with: ${DESKTOP_BUILD_COMMAND}`);
  }
  for (const key of ['executable', 'buildDirectory', 'target', 'profile']) {
    if (typeof build[key] !== 'string' || build[key].length === 0) {
      throw new Error(`staged desktop manifest is missing "${key}": ${manifestPath}. Rebuild with: ${DESKTOP_BUILD_COMMAND}`);
    }
  }
  if (!isAbsolute(build.executable) || !isAbsolute(build.buildDirectory)) {
    throw new Error(`staged desktop manifest paths must be absolute: ${manifestPath}`);
  }
  if (resolve(dirname(build.executable)) !== resolve(build.buildDirectory)) {
    throw new Error(`staged executable must live in its build directory: ${build.executable}`);
  }
  await access(build.executable).catch(() => {
    throw new Error(`staged executable is missing: ${build.executable}. Rebuild with: ${DESKTOP_BUILD_COMMAND}`);
  });
  const runtimeEntry = join(build.buildDirectory, 'runtime', 'src', 'index.mjs');
  await access(runtimeEntry).catch(() => {
    throw new Error(`staged runtime entry is missing: ${runtimeEntry}. Rebuild with: ${DESKTOP_BUILD_COMMAND}`);
  });
  return build;
}

const ACTIVATE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'activate-desktop-window.ps1');

// Activates an existing healthy dda window only under the default profile —
// isolated profiles (WEBVIEW2_USER_DATA_FOLDER set) must not hijack an
// unrelated real app. Returns undefined when no healthy window is found, or
// { pid, executable, buildDirectory }. Throws when the helper cannot decide.
export const activateExistingDesktop = async ({
  environment = process.env,
  platform = process.platform,
  spawn = spawnChild,
  targetExecutable
} = {}) => {
  if (platform !== 'win32') return undefined;
  if (typeof environment.WEBVIEW2_USER_DATA_FOLDER === 'string' && environment.WEBVIEW2_USER_DATA_FOLDER.trim()) return undefined;
  const scriptResult = await new Promise((resolvePromise, rejectPromise) => {
    let stdout = '';
    let stderr = '';
    const helper = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ACTIVATE_SCRIPT
    ], {
      env: {
        ...environment,
        DDA_LAUNCH_BUILD_ROOT: defaultDesktopBuildRoot(environment),
        ...(typeof targetExecutable === 'string' && targetExecutable ? { DDA_LAUNCH_TARGET_EXE: targetExecutable } : {})
      },
      windowsHide: true
    });
    const killTimer = setTimeout(() => {
      helper.kill('SIGKILL');
      rejectPromise(new Error('activate-desktop-window helper timed out'));
    }, 12000);
    helper.stdout?.on('data', (chunk) => { stdout += chunk; });
    helper.stderr?.on('data', (chunk) => { stderr += chunk; });
    helper.once('error', (error) => { clearTimeout(killTimer); rejectPromise(error); });
    helper.once('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) rejectPromise(new Error(`activate-desktop-window helper failed (${code}): ${stderr.slice(0, 200)}`));
      else resolvePromise(stdout.trim());
    });
  });
  let parsed;
  try { parsed = JSON.parse(scriptResult); }
  catch { throw new Error('activate-desktop-window helper returned invalid output'); }
  // Malformed output must refuse, never fall back to spawning a duplicate.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.existing !== 'boolean') {
    throw new Error('activate-desktop-window helper returned invalid output');
  }
  if (parsed.existing === false) return undefined;
  const pid = parsed.pid;
  if (!Number.isInteger(pid) || pid <= 0 || !isAbsolute(parsed.executable ?? '') || !isAbsolute(parsed.buildDirectory ?? '') || resolve(dirname(parsed.executable)) !== resolve(parsed.buildDirectory)) {
    throw new Error('activate-desktop-window helper returned invalid output');
  }
  return {
    pid,
    executable: parsed.executable,
    buildDirectory: parsed.buildDirectory,
    ...(parsed.stale === true ? { stale: true } : {}),
    ...(parsed.busy === true ? { busy: true } : {})
  };
};

export async function launchDesktop({
  manifestPath = desktopBuildManifestPath(),
  environment = process.env,
  workspaceRoot = projectPaths(import.meta.url).workspaceRoot,
  spawn = spawnChild,
  activateExisting = activateExistingDesktop
} = {}) {
  const build = await loadStagedDesktopBuild({ manifestPath });
  // Prefer activating a healthy existing window over spawning a duplicate;
  // a failed determination must refuse rather than blind-spawn.
  const existing = await activateExisting({ environment, platform: process.platform, spawn, targetExecutable: build.executable });
  if (existing) {
    return {
      pid: existing.pid,
      executable: existing.executable,
      buildDirectory: existing.buildDirectory,
      alreadyRunning: true,
      ...(existing.stale === true ? { stale: true } : {}),
      ...(existing.busy === true ? { busy: true } : {})
    };
  }
  const child = await new Promise((resolve, reject) => {
    const started = spawn(build.executable, [], {
      cwd: build.buildDirectory,
      env: {
        ...environment,
        DDA_RUNTIME_ENTRY: join(build.buildDirectory, 'runtime', 'src', 'index.mjs'),
        DDA_WORKSPACE_ROOT: workspaceRoot
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    started.once('error', reject);
    started.once('spawn', () => resolve(started));
  });
  child.unref();
  return { pid: child.pid, executable: build.executable, buildDirectory: build.buildDirectory };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const launched = await launchDesktop();
    if (launched.stale) {
      console.log(`existing dda window is running an older build with an active task pid=${launched.pid} (${launched.executable})`);
      process.exitCode = 2;
    } else {
      console.log(launched.alreadyRunning
        ? `activated existing dda window pid=${launched.pid} (${launched.executable})`
        : `launched ${launched.executable} pid=${launched.pid}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
