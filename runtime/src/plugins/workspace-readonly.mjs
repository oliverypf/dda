import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { cordisPlugin } from './cordis-plugin.mjs';
import { preferMappedPath } from '../windows-path.mjs';

const MAX_ENTRIES = 180;
// UNC workspaces can spend several seconds resolving real paths and reading
// metadata even when the same tree is fast from a local drive. Keep the
// operator override, but give the default snapshot enough time to finish
// without collapsing the useful I/O error into WORKSPACE_SNAPSHOT_FAILED.
const LIST_TIMEOUT_MS = (() => { const raw = Number(process.env.HMCODEX_WORKSPACE_TIMEOUT_MS); return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60000; })();
const withTimeout = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`WORKSPACE_IO_TIMEOUT:${label}`)), LIST_TIMEOUT_MS))]);
const MAX_FILE_BYTES = 32 * 1024;
const MAX_READ_CHARS = MAX_FILE_BYTES;
const SENSITIVE_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|credentials?(?:\.[^\\/]+)?|secrets?(?:\.[^\\/]+)?|tokens?(?:\.[^\\/]+)?|passwords?(?:\.[^\\/]+)?|private(?:\.[^\\/]+)?|id_rsa(?:\.[^\\/]+)?)(?:[\\/]|$)/i;

const contractPath = (value) => value.split(sep).join('/');
const logWorkspaceFailure = (operation, requestedPath, root, error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[workspace-failure]', { operation, requestedPath, root, error: message });
};



// Runtime stores are host-owned state, not project context. Keep comparisons
// separator-agnostic and case-insensitive on Windows so a store cannot become
// visible through an alternate spelling of the same path.
const pathKey = (value) => {
  const normalized = String(value ?? '').replace(/[\\/]+/g, '/').replace(/\/$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const sameOrChildPath = (base, candidate) => {
  const left = pathKey(base);
  const right = pathKey(candidate);
  return Boolean(left) && (left === right || right.startsWith(`${left}/`));
};

const inside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..'));
};

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const mappedRealpath = async (value) => {
  const resolved = resolve(value);
  try {
    return preferMappedPath(await realpath(resolved));
  } catch (error) {
    // Windows network providers can report EBUSY for realpath(file) even
    // though stat/readFile can access the same path. Keep the resolved path
    // and let the caller validate it with stat instead of treating it as
    // missing or outside the workspace.
    if (error?.code === 'EBUSY') return preferMappedPath(resolved);
    throw error;
  }
};

const decodeText = (bytes) => {
  if (bytes.includes(0)) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // The tool contract is based on file content, not filename suffix. Web
    // projects commonly use HTML/CSS, source maps, extensionless build files,
    // and framework-specific source extensions. Reject binary control bytes
    // while allowing every real UTF-8 text file covered by that contract.
    // Build logs may contain ANSI colors. Ignore recognized terminal sequences
    // only for classification; preserve the original text for digests and offsets.
    if (/[\u0001-\u0008\u000b\u000e-\u001f\u007f]/u.test(stripVTControlCharacters(text))) return undefined;
    return text;
  } catch {
    return undefined;
  }
};

const normalizeRelativePath = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 512) {
    throw new Error('WORKSPACE_INVALID_PATH: path must be relative to the authorized workspace');
  }
  if (isAbsolute(value)) {
    throw new Error('WORKSPACE_PATH_FORBIDDEN: use a path relative to the authorized workspace, not a drive-letter or UNC absolute path');
  }
  const normalized = value.replace(/[\\/]+/g, sep);
  const parts = normalized.split(sep).filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('WORKSPACE_INVALID_PATH');
  return parts.join(sep);
};

async function walk(root, current, entries, isExcluded) {
  if (entries.length >= MAX_ENTRIES) return;
  let children;
  try {
    children = await withTimeout(readdir(current, { withFileTypes: true }), 'readdir');
  } catch (error) {
    // UNC providers can briefly report a child directory as missing or busy
    // while it is being created, removed, or rehydrated. A stale child must
    // not invalidate the complete workspace snapshot; the root itself is
    // validated before walk() starts and still fails closed.
    if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) {
      logWorkspaceFailure('walk.skip', current, root, error);
      return;
    }
    throw error;
  }
  children.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  for (const child of children) {
    if (entries.length >= MAX_ENTRIES) break;
    if (child.name === 'node_modules' || child.name === '.git' || child.name === 'target') continue;
    const candidate = resolve(current, child.name);
    const real = await withTimeout(mappedRealpath(candidate), 'realpath').catch(() => null);
    if (!real || !inside(root, real)) continue;
    const relativePath = contractPath(relative(root, real));
    if (isExcluded(real, relativePath)) continue;
    if (child.isDirectory()) {
      entries.push({ path: relativePath, kind: 'DIRECTORY' });
      await walk(root, real, entries, isExcluded);
    } else if (child.isFile()) {
      const metadata = await withTimeout(stat(real), 'stat');
      entries.push({ path: relativePath, kind: 'FILE', sizeBytes: metadata.size });
    }
  }
}

async function listDirect(root, current, entries, isExcluded) {
  const children = await readdir(current, { withFileTypes: true });
  children.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  for (const child of children) {
    if (entries.length >= MAX_ENTRIES) break;
    if (child.name === 'node_modules' || child.name === '.git' || child.name === 'target') continue;
    const candidate = resolve(current, child.name);
    const real = await mappedRealpath(candidate).catch(() => null);
    if (!real || !inside(root, real)) continue;
    const relativePath = contractPath(relative(root, real));
    if (isExcluded(real, relativePath)) continue;
    if (SENSITIVE_PATH.test(relativePath)) continue;
    const metadata = await withTimeout(stat(real), 'stat').catch(() => null);
    if (!metadata) continue;
    if (metadata.isDirectory()) {
      entries.push({ path: relativePath, kind: 'DIRECTORY' });
    } else if (metadata.isFile()) {
      entries.push({ path: relativePath, kind: 'FILE', sizeBytes: metadata.size });
    }
  }
}

export class ReadonlyWorkspace {
  #excludedPaths;
  #excludedRelativePaths;

  constructor(rootPath, { excludedPaths = [] } = {}) {
    this.root = rootPath ? resolve(rootPath) : null;
    if (!Array.isArray(excludedPaths)) throw new Error('WORKSPACE_EXCLUDED_PATHS_INVALID');
    this.#excludedPaths = [...new Set(excludedPaths
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => resolve(this.root ?? process.cwd(), value)))];
    this.#excludedRelativePaths = this.#excludedPaths
      .map((value) => {
        if (!this.root) return undefined;
        const candidate = relative(this.root, value);
        if (!candidate || candidate === '..' || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) return undefined;
        return pathKey(contractPath(candidate));
      })
      .filter(Boolean);
  }

  #isExcluded(candidate, relativePath) {
    const relativeKey = pathKey(relativePath);
    return this.#excludedPaths.some((excluded) => sameOrChildPath(excluded, candidate))
      || this.#excludedRelativePaths.some((excluded) => relativeKey === excluded || relativeKey.startsWith(`${excluded}/`));
  }

  async snapshot() {
    if (!this.root) return { granted: false, entries: [], sections: [] };
    const root = await mappedRealpath(this.root).catch(() => { throw new Error('WORKSPACE_NOT_FOUND'); });
    const metadata = await stat(root).catch(() => { throw new Error('WORKSPACE_UNAVAILABLE'); });
    if (!metadata.isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
    try {
      const entries = [];
      await walk(root, root, entries, (candidate, relativePath) => this.#isExcluded(candidate, relativePath));
      const sections = [];
      for (const entry of entries.filter((item) => item.kind === 'FILE')) {
        if (sections.length >= 18) break;
        if (entry.sizeBytes > MAX_FILE_BYTES || SENSITIVE_PATH.test(entry.path)) continue;
        const candidate = resolve(root, entry.path);
        const real = await mappedRealpath(candidate).catch(() => null);
        if (!real || !inside(root, real)) continue;
        if (this.#isExcluded(real, entry.path)) continue;
        const bytes = await readFile(real);
        if (bytes.byteLength > MAX_FILE_BYTES) continue;
        const content = decodeText(bytes);
        if (content === undefined) continue;
        sections.push({
          path: entry.path,
          digest: digest(bytes),
          content: content.slice(0, MAX_FILE_BYTES)
        });
      }
      return {
        granted: true,
        root,
        rootLabel: root.split(/[\\/]/).filter(Boolean).at(-1) ?? root,
        entries,
        sections,
        snapshotDigest: digest(Buffer.from(JSON.stringify({ root, entries, sections })))
      };
    } catch (error) {
      if (error instanceof Error && /^WORKSPACE_[A-Z0-9_]+$/.test(error.message)) throw error;
      logWorkspaceFailure('snapshot', '', root, error);
      throw new Error('WORKSPACE_SNAPSHOT_FAILED');
    }
  }

  async #resolvePath(relativePath, { directory = false } = {}) {
    if (!this.root) throw new Error('WORKSPACE_NOT_AUTHORIZED');
    const root = await mappedRealpath(this.root).catch(() => { throw new Error('WORKSPACE_NOT_FOUND'); });
    const normalized = normalizeRelativePath(relativePath);
    const candidate = resolve(root, normalized || '.');
    const real = await mappedRealpath(candidate).catch(() => null);
    if (!real) throw new Error(`WORKSPACE_NOT_FOUND:${contractPath(normalized || '.')}`);
    if (!inside(root, real)) throw new Error('WORKSPACE_PATH_FORBIDDEN');
    const path = contractPath(relative(root, real));
    if (this.#isExcluded(real, path)) throw new Error(`WORKSPACE_EXCLUDED_PATH:${path}`);
    if (SENSITIVE_PATH.test(path)) throw new Error('WORKSPACE_SENSITIVE_PATH');
    const metadata = await stat(real).catch(() => { throw new Error(`WORKSPACE_NOT_FOUND:${path}`); });
    if (directory && !metadata.isDirectory()) throw new Error(`WORKSPACE_NOT_DIRECTORY:${path}`);
    return { root, real, relativePath: path, metadata };
  }

  async list(relativePath = '') {
    try {
      const target = await this.#resolvePath(relativePath, { directory: true });
      const entries = [];
      await listDirect(target.root, target.real, entries, (candidate, path) => this.#isExcluded(candidate, path));
      return {
        granted: true,
        rootLabel: target.root.split(/[\\/]/).filter(Boolean).at(-1) ?? target.root,
        path: target.relativePath,
        entries,
        truncated: entries.length >= MAX_ENTRIES
      };
    } catch (error) {
      logWorkspaceFailure('list', relativePath, this.root, error);
      if (error instanceof Error && error.message.startsWith('WORKSPACE_')) throw error;
      throw new Error('WORKSPACE_LIST_FAILED');
    }
  }

  async read(relativePath, maxChars = MAX_READ_CHARS, offsetChars = 0) {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_CHARS) {
      throw new Error('WORKSPACE_INVALID_READ_LIMIT');
    }
    if (!Number.isInteger(offsetChars) || offsetChars < 0) {
      throw new Error('WORKSPACE_INVALID_READ_OFFSET');
    }
    let target;
    try { target = await this.#resolvePath(relativePath); } catch (error) { logWorkspaceFailure('read.resolve', relativePath, this.root, error); throw error; }
    if (!target.metadata.isFile()) throw new Error(`WORKSPACE_NOT_FILE:${target.relativePath}`);
    const path = target.relativePath;
    const bytes = await readFile(target.real).catch((error) => { logWorkspaceFailure('read.file', relativePath, this.root, error); throw new Error('WORKSPACE_READ_FAILED'); });
    const content = decodeText(bytes);
    if (content === undefined) throw new Error(`WORKSPACE_BINARY_FILE:${path}`);
    return {
      path,
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      content: content.slice(offsetChars, offsetChars + maxChars),
      truncated: offsetChars + maxChars < content.length
    };
  }
}

export const readonlyWorkspacePlugin = (workspace) => cordisPlugin((ctx) => {
  ctx.provide('workspaceReadonly', workspace);
}, 'workspace-readonly');
