import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { cordisPlugin } from './cordis-plugin.mjs';
import { preferMappedPath } from '../windows-path.mjs';

const MAX_ENTRIES = 180;
const LIST_TIMEOUT_MS = (() => { const raw = Number(process.env.HMCODEX_WORKSPACE_TIMEOUT_MS); return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 15000; })();
const withTimeout = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`WORKSPACE_IO_TIMEOUT:${label}`)), LIST_TIMEOUT_MS))]);
const MAX_FILE_BYTES = 32 * 1024;
const MAX_READ_CHARS = MAX_FILE_BYTES;
const TEXT_FILES = new Set(['.md', '.txt', '.json', '.json5', '.yaml', '.yml', '.toml', '.ts', '.tsx', '.js', '.mjs', '.rs']);
const SENSITIVE_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|credentials?(?:\.[^\\/]+)?|secrets?(?:\.[^\\/]+)?|tokens?(?:\.[^\\/]+)?|passwords?(?:\.[^\\/]+)?|private(?:\.[^\\/]+)?|id_rsa(?:\.[^\\/]+)?)(?:[\\/]|$)/i;

const contractPath = (value) => value.split(sep).join('/');

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
const mappedRealpath = async (value) => preferMappedPath(await realpath(value));

const decodeText = (bytes) => {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const extensionOf = (name) => {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
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
  const children = await withTimeout(readdir(current, { withFileTypes: true }), 'readdir');
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
      for (const entry of entries.filter((item) => item.kind === 'FILE').slice(0, 18)) {
        const ext = extensionOf(entry.path);
        if (!TEXT_FILES.has(ext) || entry.sizeBytes > MAX_FILE_BYTES || SENSITIVE_PATH.test(entry.path)) continue;
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
      throw new Error('WORKSPACE_SNAPSHOT_FAILED');
    }
  }

  async #resolvePath(relativePath, { directory = false } = {}) {
    if (!this.root) throw new Error('WORKSPACE_NOT_AUTHORIZED');
    const root = await mappedRealpath(this.root).catch(() => { throw new Error('WORKSPACE_NOT_FOUND'); });
    const normalized = normalizeRelativePath(relativePath);
    const candidate = resolve(root, normalized || '.');
    const real = await mappedRealpath(candidate).catch(() => null);
    if (!real || !inside(root, real)) throw new Error('WORKSPACE_PATH_FORBIDDEN');
    const path = contractPath(relative(root, real));
    if (this.#isExcluded(real, path)) throw new Error('WORKSPACE_EXCLUDED_PATH');
    if (SENSITIVE_PATH.test(path)) throw new Error('WORKSPACE_SENSITIVE_PATH');
    const metadata = await stat(real).catch(() => { throw new Error('WORKSPACE_PATH_FORBIDDEN'); });
    if (directory && !metadata.isDirectory()) throw new Error('WORKSPACE_NOT_DIRECTORY');
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
      if (error instanceof Error && /^WORKSPACE_[A-Z0-9_]+$/.test(error.message)) throw error;
      throw new Error('WORKSPACE_LIST_FAILED');
    }
  }

  async read(relativePath, maxChars = MAX_READ_CHARS) {
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_READ_CHARS) {
      throw new Error('WORKSPACE_INVALID_READ_LIMIT');
    }
    const target = await this.#resolvePath(relativePath);
    if (!target.metadata.isFile()) throw new Error('WORKSPACE_NOT_FILE');
    if (target.metadata.size > MAX_FILE_BYTES) throw new Error('WORKSPACE_FILE_TOO_LARGE');
    const path = target.relativePath;
    if (!TEXT_FILES.has(extensionOf(path))) throw new Error('WORKSPACE_UNSUPPORTED_FILE');
    const bytes = await readFile(target.real).catch(() => { throw new Error('WORKSPACE_READ_FAILED'); });
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('WORKSPACE_FILE_TOO_LARGE');
    const content = decodeText(bytes);
    if (content === undefined) throw new Error('WORKSPACE_BINARY_FILE');
    return {
      path,
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      content: content.slice(0, maxChars),
      truncated: content.length > maxChars
    };
  }
}

export const readonlyWorkspacePlugin = (workspace) => cordisPlugin((ctx) => {
  ctx.provide('workspaceReadonly', workspace);
}, 'workspace-readonly');
