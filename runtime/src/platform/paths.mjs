import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Path authority for dda stores.
 *
 * Windows keeps the historical `%LOCALAPPDATA%\hmCodex` layout, including when
 * `HMCODEX_DATA_DIR` is set. Linux CLI opts in with `HMCODEX_PLATFORM=linux-cli`
 * and then uses one XDG root for every store. Host OS alone must not flip the
 * layout: the Windows runtime test suite runs on Linux.
 */

export const LINUX_CLI_PLATFORM = 'linux-cli';

export const isLinuxCliPlatform = (env = process.env) => env.HMCODEX_PLATFORM === LINUX_CLI_PLATFORM;

const joinPlatform = (root, ...parts) => {
  if (typeof root === 'string' && root.includes('\\') && !root.includes('/')) {
    return [root.replace(/[\\]+$/u, ''), ...parts].join('\\');
  }
  return join(root, ...parts);
};

const homeDirectory = (env) => {
  const configured = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (configured) return configured;
  if (!isLinuxCliPlatform(env)) return undefined;
  try {
    return homedir();
  } catch {
    return undefined;
  }
};

const xdgPath = (env, name, homeFallback, leaf) => {
  const configured = typeof env[name] === 'string' ? env[name].trim() : '';
  const base = configured || (() => {
    const home = homeDirectory(env);
    return home ? join(home, ...homeFallback) : undefined;
  })();
  return base ? join(base, leaf) : undefined;
};

export function createPlatformPaths(env = process.env, options = {}) {
  const linux = options.platform ? options.platform === LINUX_CLI_PLATFORM : isLinuxCliPlatform(env);
  const dataOverride = typeof options.dataDir === 'string' && options.dataDir.trim()
    ? options.dataDir.trim()
    : (typeof env.HMCODEX_DATA_DIR === 'string' ? env.HMCODEX_DATA_DIR.trim() : '');
  const configOverride = typeof options.configPath === 'string' && options.configPath.trim()
    ? options.configPath.trim()
    : (typeof env.HMCODEX_MODEL_CONFIG === 'string' ? env.HMCODEX_MODEL_CONFIG.trim() : '');

  const configDir = () => {
    if (!linux) {
      const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_CONFIG_HOME;
      return root ? joinPlatform(root, 'hmCodex') : undefined;
    }
    if (options.configDir) return resolve(options.configDir);
    return xdgPath(env, 'XDG_CONFIG_HOME', ['.config'], 'hmcodex');
  };

  const dataDir = () => {
    if (!linux) {
      const root = dataOverride || env.LOCALAPPDATA || env.APPDATA;
      return root ? joinPlatform(root, 'hmCodex') : undefined;
    }
    if (dataOverride) return resolve(dataOverride);
    return xdgPath(env, 'XDG_DATA_HOME', ['.local', 'share'], 'hmcodex');
  };

  const stateDir = () => {
    if (!linux) return dataDir();
    if (options.stateDir) return resolve(options.stateDir);
    return xdgPath(env, 'XDG_STATE_HOME', ['.local', 'state'], 'hmcodex');
  };

  const cacheDir = () => linux
    ? xdgPath(env, 'XDG_CACHE_HOME', ['.cache'], 'hmcodex')
    : dataDir();

  const logDir = () => {
    if (!linux) {
      const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_CONFIG_HOME;
      return root ? joinPlatform(root, 'hmCodex', 'logs') : undefined;
    }
    const state = stateDir();
    return state ? join(state, 'logs') : undefined;
  };

  const pluginDir = () => {
    const data = dataDir();
    return data ? join(data, 'plugins') : undefined;
  };

  const modelConfigPath = () => {
    if (linux && configOverride) return resolve(configOverride);
    if (!linux) {
      const root = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_CONFIG_HOME;
      return root ? joinPlatform(root, 'hmCodex', 'model-config.json') : undefined;
    }
    const dir = configDir();
    return dir ? join(dir, 'model-config.json') : undefined;
  };

  const resolveStore = (name) => {
    if (typeof name !== 'string' || !name.trim() || name.includes('\0') || name.includes('/') || name.includes('\\')) {
      throw new Error('STORE_NAME_INVALID');
    }
    const root = dataDir();
    return root ? joinPlatform(root, name) : undefined;
  };

  return {
    platform: linux ? LINUX_CLI_PLATFORM : 'windows-desktop',
    configDir,
    dataDir,
    stateDir,
    cacheDir,
    logDir,
    pluginDir,
    modelConfigPath,
    resolveStore
  };
}

export const resolveStoreFile = (name, env = process.env) => createPlatformPaths(env).resolveStore(name);

export async function ensurePlatformDirs(paths) {
  const directories = [paths.configDir(), paths.dataDir(), paths.stateDir(), paths.cacheDir(), paths.logDir(), paths.pluginDir()]
    .filter((dir) => typeof dir === 'string' && dir);
  for (const dir of directories) {
    let created = false;
    try {
      await stat(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      created = true;
    }
    if (!created) continue;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
  }
  return directories;
}

export async function directoryPermission(dir) {
  if (!dir) return { exists: false };
  try {
    const info = await stat(dir);
    const mode = info.mode & 0o777;
    return { exists: true, directory: info.isDirectory(), mode, wide: (mode & 0o077) !== 0 };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: false, error: error?.code ?? 'STAT_FAILED' };
  }
}
