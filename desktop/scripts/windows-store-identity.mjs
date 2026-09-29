import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Physical identity of the harness store file.
 *
 * The Codex desktop app is delivered as an MSIX package. A process that runs
 * inside the package (for example an agent shell started from the app) sees a
 * per-package copy of `%LOCALAPPDATA%`: the first time the package writes to a
 * file below that root, Windows keeps a package-local copy under
 * `...\Packages\<family>\LocalCache\Local\...` and the packaged process keeps
 * reading that copy. A process started outside the package (Task Scheduler,
 * Explorer, an installed product) keeps reading the real user profile file.
 *
 * Both files are real, but they are different files at the same logical path.
 * Evidence that names only `C:\Users\<user>\AppData\Local\...` therefore does
 * not say which physical file produced the numbers. This module resolves that
 * ambiguity so every record can carry the file it actually read.
 */

const WINDOWS_ALIAS_ROOT = '\\\\localhost\\C$';

const isUnder = (child, parent) => {
  const normalizedChild = resolve(child).toLowerCase();
  const normalizedParent = resolve(parent).toLowerCase();
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`);
};

const statOf = (path) => {
  try {
    const stats = statSync(path, { bigint: true });
    return { exists: true, sizeBytes: Number(stats.size), modifiedAtMs: Number(stats.mtimeMs), ino: stats.ino.toString(), dev: stats.dev.toString() };
  } catch {
    return { exists: false };
  }
};

const sameFile = (left, right) => Boolean(left?.exists && right?.exists && left.ino === right.ino && left.dev === right.dev);

/**
 * Package-local copies Windows keeps for the same relative path. The list is
 * empty when the path is not below `%LOCALAPPDATA%` or no package exists.
 */
export const packageLocalCacheTwins = (requestedPath, { localAppData = process.env.LOCALAPPDATA } = {}) => {
  if (!requestedPath || !localAppData) return [];
  const base = resolve(localAppData);
  const full = resolve(requestedPath);
  if (!isUnder(full, base) || full === base) return [];
  const relative = full.slice(base.length + 1);
  const packagesRoot = join(base, 'Packages');
  let families = [];
  try {
    families = readdirSync(packagesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  return families.map((packageFamily) => ({
    packageFamily,
    path: join(packagesRoot, packageFamily, 'LocalCache', 'Local', relative)
  }));
};

/** The same file as seen through the local C$ administrative share. */
export const aliasPathFor = (requestedPath, { aliasRoot = WINDOWS_ALIAS_ROOT } = {}) => {
  if (!requestedPath || !aliasRoot) return undefined;
  try {
    const full = resolve(requestedPath);
    const drive = full.slice(0, 2);
    if (!/^[a-z]:$/iu.test(drive) || full.length < 4) return undefined;
    return `${aliasRoot}\\${full.slice(3)}`;
  } catch {
    return undefined;
  }
};

/**
 * Describe which physical file a store path resolves to, and which other
 * physical files share the same logical path.
 */
export const describeStorePath = (requestedPath, options = {}) => {
  if (!requestedPath) return { requestedPath: null, exists: false };
  const record = { requestedPath, resolvedPath: resolve(requestedPath) };
  const requested = statOf(requestedPath);
  Object.assign(record, requested);
  if (requested.exists) {
    try { record.canonicalPath = realpathSync.native(requestedPath); } catch { /* keep the requested spelling */ }
  }
  const twins = packageLocalCacheTwins(requestedPath, options)
    .map((twin) => ({ ...twin, ...statOf(twin.path) }));
  const redirectedTo = twins.find((twin) => sameFile(requested, twin));
  if (redirectedTo) {
    record.redirection = {
      kind: 'MSIX_PACKAGE_LOCAL_CACHE',
      packageFamily: redirectedTo.packageFamily,
      localCachePath: redirectedTo.path
    };
  }
  record.packageLocalCacheCopies = twins
    .filter((twin) => twin.exists && !sameFile(requested, twin))
    .map((twin) => ({ packageFamily: twin.packageFamily, path: twin.path, exists: true, sizeBytes: twin.sizeBytes, modifiedAtMs: twin.modifiedAtMs }));
  const aliasPath = options.aliasRoot === null ? undefined : aliasPathFor(requestedPath, options);
  if (aliasPath) {
    const alias = statOf(aliasPath);
    // Only report the alias when it is a different physical file; otherwise it
    // is just another spelling of the same file.
    if (alias.exists && !sameFile(requested, alias)) {
      record.unredactedProfileAlias = { path: aliasPath, exists: true, sizeBytes: alias.sizeBytes, modifiedAtMs: alias.modifiedAtMs };
    }
  }
  return record;
};



