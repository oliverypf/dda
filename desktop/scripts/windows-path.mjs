import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferMappedPath } from '../../runtime/src/windows-path.mjs';

/**
 * Resolve one coherent desktop/workspace/runtime tree. On Windows, a mapped
 * drive is preferred over its equivalent UNC spelling to avoid slow network
 * filesystem canonicalization and inconsistent child-process cwd values.
 */
export function projectPaths(moduleUrl = import.meta.url, options = {}) {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const candidates = [
    env.HMCODEX_DESKTOP_ROOT,
    env.HMCODEX_WORKSPACE_ROOT,
    env.INIT_CWD,
    env.npm_config_local_prefix,
    cwd,
    moduleDir
  ].filter(Boolean);

  const seen = new Set();
  const desktopRoot = candidates
    .map((candidate) => {
      try {
        return resolve(preferMappedPath(candidate, { mappings: options.mappings }));
      } catch {
        return null;
      }
    })
    .filter((candidate) => candidate && !seen.has(candidate) && seen.add(candidate))
    .map((candidate) => findDesktopRoot(candidate))
    .find(Boolean)
    ?? resolve(moduleDir);

  return {
    desktopRoot,
    workspaceRoot: dirname(desktopRoot),
    runtimeRoot: resolve(desktopRoot, '..', 'runtime'),
    moduleDir
  };
}

function findDesktopRoot(start) {
  let current = start;
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(current, 'index.html')) && existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
