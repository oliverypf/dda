import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectPaths } from './windows-path.mjs';

export const ALLOWED_DESKTOP_TARGETS = Object.freeze(['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']);
export const ALLOWED_DESKTOP_PROFILES = Object.freeze(['debug', 'release']);
export const DESKTOP_BUILD_MANIFEST = 'latest.json';

export const desktopBuildSourceExecutable = ({ desktopRoot, cargoTargetDir, target = 'x86_64-pc-windows-msvc', profile }) =>
  join(cargoTargetDir ?? join(desktopRoot, 'src-tauri', 'target'), target, profile, 'dda-desktop.exe');

export const defaultDesktopBuildRoot = (environment = process.env) => {
  if (!environment.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set; pass outputRoot explicitly to stage the desktop build');
  return join(environment.LOCALAPPDATA, 'dda', 'desktop-builds');
};

const isInside = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

export async function stageDesktopBuild({
  desktopRoot,
  target = 'x86_64-pc-windows-msvc',
  profile = 'debug',
  outputRoot = defaultDesktopBuildRoot(),
  workspaceRoot,
  cargoTargetDir
} = {}) {
  const defaultDesktopRoot = projectPaths(import.meta.url).desktopRoot;
  const resolvedDesktopRoot = desktopRoot ?? defaultDesktopRoot;
  const resolvedWorkspaceRoot = workspaceRoot ?? dirname(resolvedDesktopRoot);
  if (!ALLOWED_DESKTOP_TARGETS.includes(target)) {
    throw new Error(`unsupported desktop target "${target}"; allowed: ${ALLOWED_DESKTOP_TARGETS.join(', ')}`);
  }
  if (!ALLOWED_DESKTOP_PROFILES.includes(profile)) {
    throw new Error(`unsupported desktop profile "${profile}"; allowed: ${ALLOWED_DESKTOP_PROFILES.join(', ')}`);
  }

  const tauriRoot = join(resolvedDesktopRoot, 'src-tauri');
  const effectiveTargetRoot = cargoTargetDir
    ?? (desktopRoot === undefined && process.env.CARGO_TARGET_DIR?.trim()
      ? resolve(tauriRoot, process.env.CARGO_TARGET_DIR.trim())
      : join(tauriRoot, 'target'));
  const sourceExecutable = desktopBuildSourceExecutable({ desktopRoot: resolvedDesktopRoot, cargoTargetDir: effectiveTargetRoot, target, profile });
  await access(sourceExecutable).catch(() => {
    throw new Error(`desktop executable not built: ${sourceExecutable}. Build first with: node desktop/scripts/build-controlled.mjs --fast`);
  });

  const config = JSON.parse(await readFile(join(tauriRoot, 'tauri.conf.json'), 'utf8'));
  const resources = Object.entries(config.bundle?.resources ?? {});

  await mkdir(outputRoot, { recursive: true });
  const realOutputRoot = await realpath(outputRoot);
  const realWorkspaceRoot = await realpath(resolvedWorkspaceRoot);
  if (isInside(realWorkspaceRoot, realOutputRoot)) {
    throw new Error(`desktop build output must be outside the workspace: ${realOutputRoot} is inside ${realWorkspaceRoot}`);
  }

  const buildDirectory = await mkdtemp(join(realOutputRoot, `build-${target}-`));
  try {
    await cp(sourceExecutable, join(buildDirectory, 'dda-desktop.exe'), { dereference: true });
    const siblingServer = join(dirname(sourceExecutable), 'openviking-server.exe');
    if (await access(siblingServer).then(() => true, () => false)) {
      await cp(siblingServer, join(buildDirectory, 'openviking-server.exe'), { dereference: true });
    }
    for (const [source, destination] of resources) {
      const from = resolve(tauriRoot, source);
      const to = resolve(buildDirectory, destination);
      if (!isInside(buildDirectory, to) || to === buildDirectory) {
        throw new Error(`resource destination escapes the build directory: ${destination}`);
      }
      await access(from).catch(() => {
        throw new Error(`bundle resource missing: ${from}`);
      });
      await cp(from, to, { recursive: true, dereference: true });
    }
  } catch (error) {
    await rm(buildDirectory, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }

  const result = {
    executable: join(buildDirectory, 'dda-desktop.exe'),
    buildDirectory,
    target,
    profile
  };
  const manifestPath = join(realOutputRoot, DESKTOP_BUILD_MANIFEST);
  const temporaryPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, manifestPath);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const staged = await stageDesktopBuild({
    target: process.argv.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ?? 'x86_64-pc-windows-msvc',
    profile: process.argv.find((arg) => arg.startsWith('--profile='))?.slice('--profile='.length) ?? 'debug'
  });
  console.log(`staged runnable desktop: ${staged.executable}`);
}
