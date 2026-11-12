import { withWorkspaceIoTimeout } from '../workspace-io-timeout.mjs';
import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { MAX_PE_HEADER_OFFSET, MAX_PE_HEADER_READ_BYTES } from '../binary-inspection-contract.mjs';
import { resolve, relative, sep, isAbsolute, join } from 'node:path';
import { cordisPlugin } from './cordis-plugin.mjs';
import { resolveAuthorizedPath } from '../filesystem-access.mjs';
import { preferMappedPath } from '../platform/workspace-path.mjs';
import { uniqueExcerptOffset } from '../task-harness.mjs';

const MAX_ENTRIES = 200;
// UNC workspaces can spend several seconds resolving real paths and reading
// metadata even when the same tree is fast from a local drive. Keep the
// operator override, but give the default snapshot enough time to finish
// without collapsing the useful I/O error into WORKSPACE_SNAPSHOT_FAILED.
const LIST_TIMEOUT_MS = (() => { const raw = Number(process.env.DDA_WORKSPACE_TIMEOUT_MS); return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 60000; })();
const withTimeout = (promise, label) => withWorkspaceIoTimeout(promise, label, LIST_TIMEOUT_MS);
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

const hasDisallowedControls = (text) => /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(stripVTControlCharacters(text));

// PowerShell's default redirection writes UTF-16 LE with a BOM. Those build
// logs are text. Decode a BOM before the NUL-byte check; files without a
// UTF-16 BOM stay on the UTF-8 path.
const decodeUtf16 = (bytes) => {
  if (!bytes || bytes.length < 2 || bytes.length % 2 !== 0) return undefined;
  const little = bytes[0] === 0xff && bytes[1] === 0xfe;
  const big = bytes[0] === 0xfe && bytes[1] === 0xff;
  if (!little && !big) return undefined;
  const body = bytes.subarray(2);
  if (body.length === 0) return '';
  let text;
  try {
    text = new TextDecoder(little ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
  if (hasDisallowedControls(text)) return undefined;
  return text;
};

const decodeText = (bytes) => {
  const utf16 = decodeUtf16(bytes);
  if (utf16 !== undefined) return utf16;
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

const IGNORED_SNAPSHOT_DIRS = new Set([
  'node_modules',
  'oh_modules',
  '.git',
  'target',
  'dist',
  '__pycache__',
  '.bitfun',
  '.deveco',
  '.hvigor',
  '.cxx',
  '.cache',
  '.workbuddy-ai',
  '.pytest_cache',
  '.turbo',
  '.next',
  'coverage'
]);

const PRIORITY_MANIFEST_NAMES = new Set([
  'package.json',
  'cargo.toml',
  'tauri.conf.json',
  'readme.md',
  'agents.md',
  'pyproject.toml',
  'go.mod',
  'makefile',
  'cmakelists.txt',
  'build-profile.json5'
]);

const isIgnoredSnapshotDir = (name) =>
  IGNORED_SNAPSHOT_DIRS.has(name) || /^target-[a-z0-9_-]+$/iu.test(name);

const snapshotChildRank = (entry) => {
  if (entry.name.startsWith('.')) return 3;
  if (entry.isFile() && PRIORITY_MANIFEST_NAMES.has(entry.name.toLowerCase())) return 0;
  if (entry.isDirectory()) return 1;
  return 2;
};

const sortSnapshotChildren = (children) =>
  children.sort((a, b) => {
    const rankDiff = snapshotChildRank(a) - snapshotChildRank(b);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });

async function walk(root, initial, entries, isExcluded) {
  const queue = [initial];
  while (queue.length > 0 && entries.length < MAX_ENTRIES) {
    const current = queue.shift();
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
        continue;
      }
      throw error;
    }
    sortSnapshotChildren(children);
    for (const child of children) {
      if (entries.length >= MAX_ENTRIES) break;
      if (isIgnoredSnapshotDir(child.name)) continue;
      if (child.isFile() && /\.pyc$/iu.test(child.name)) continue;
      const candidate = resolve(current, child.name);
      if (isExcluded(candidate, contractPath(relative(root, candidate)))) continue;
      const real = await withTimeout(mappedRealpath(candidate), 'realpath').catch(() => null);
      if (!real || !inside(root, real)) continue;
      const relativePath = contractPath(relative(root, real));
      if (isExcluded(real, relativePath)) continue;
      if (child.isDirectory()) {
        entries.push({ path: relativePath, kind: 'DIRECTORY' });
        queue.push(real);
      } else if (child.isFile()) {
        const metadata = await withTimeout(stat(real), 'stat');
        entries.push({ path: relativePath, kind: 'FILE', sizeBytes: metadata.size });
      }
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
    if (isExcluded(candidate, contractPath(relative(root, candidate)))) continue;
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
  #getAccessMode;
  #protectedPaths;
  #excludedRelativePaths;

  constructor(rootPath, { excludedPaths = [], getAccessMode, protectedPaths = [] } = {}) {
    this.root = rootPath ? resolve(rootPath) : null;
    if (!Array.isArray(excludedPaths)) throw new Error('WORKSPACE_EXCLUDED_PATHS_INVALID');
    this.#getAccessMode = typeof getAccessMode === 'function' ? getAccessMode : undefined;
    this.#protectedPaths = Array.isArray(protectedPaths) ? protectedPaths.filter((v) => typeof v === 'string' && v.trim()) : [];
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
      || this.#protectedPaths.some((protectedPath) => sameOrChildPath(resolve(protectedPath), candidate))
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
    const accessMode = await (async () => {
      try { return await this.#getAccessMode?.(); } catch { return undefined; }
    })();
    if (accessMode === 'FULL_ACCESS') {
      const resolved = await resolveAuthorizedPath(relativePath ?? '', {
        workspaceRoot: this.root,
        getAccessMode: this.#getAccessMode,
        protectedPaths: [...this.#protectedPaths, ...this.#excludedPaths],
        allowEmpty: true
      }).catch((error) => {
        // The guard's precise NOT_FOUND code maps to the read contract so
        // write preconditions treat it as a new file; every other denial
        // (protected, forbidden, permission) keeps its code.
        if (error?.code === 'SAFETY_WORKSPACE_NOT_FOUND') {
          throw new Error(`WORKSPACE_NOT_FOUND:${relativePath}`);
        }
        throw new Error(error?.code ?? 'WORKSPACE_PATH_FORBIDDEN');
      });
      const metadata = await stat(resolved.absolutePath).catch(() => { throw new Error(`WORKSPACE_NOT_FOUND:${resolved.path}`); });
      if (directory && !metadata.isDirectory()) throw new Error(`WORKSPACE_NOT_DIRECTORY:${resolved.path}`);
      return { root: resolved.root, real: resolved.absolutePath, relativePath: resolved.path, metadata, outside: !inside(resolved.root, resolved.absolutePath) };
    }
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
      // Outside lists traverse the outside directory itself as containment
      // root; entry paths become absolute resolved paths, never '..' escapes.
      const traversalRoot = target.outside ? target.real : target.root;
      await listDirect(traversalRoot, target.real, entries, (candidate, path) => this.#isExcluded(candidate, path));
      if (target.outside) {
        for (const entry of entries) entry.path = join(target.real, entry.path).split(sep).join('/');
      }
      return {
        granted: true,
        rootLabel: (target.outside ? target.real : target.root).split(/[\\/]/).filter(Boolean).at(-1) ?? target.real,
        path: target.relativePath,
        entries,
        truncated: entries.length >= MAX_ENTRIES
      };
    } catch (error) {
      logWorkspaceFailure('list', relativePath, this.root, error);
      if (error instanceof Error && (error.message.startsWith('WORKSPACE_') || error.message.startsWith('SAFETY_') || error.code === 'EACCES' || error.code === 'EPERM')) throw error;
      throw new Error('WORKSPACE_LIST_FAILED');
    }
  }

  async inspectBinary(requestedPath) {
    const CREDENTIAL_DIRS = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config[\\/]gcloud)(?:[\\/]|$)/i;
    const resolve = async (path) => {
      const resolved = await resolveAuthorizedPath(path, {
        workspaceRoot: this.root,
        getAccessMode: this.#getAccessMode,
        protectedPaths: [...this.#protectedPaths, ...this.#excludedPaths],
        allowEmpty: false
      });
      const key = resolved.path ?? path;
      if (this.#isExcluded(resolved.absolutePath, key)) throw new Error(`WORKSPACE_EXCLUDED_PATH:${key}`);
      if ([path, key].some(value => SENSITIVE_PATH.test(value) || CREDENTIAL_DIRS.test(value))) throw new Error('WORKSPACE_SENSITIVE_PATH');
      return { ...resolved, real: resolved.absolutePath };
    };
    const target = await resolve(requestedPath);
    const identity = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    let handle;
    try {
      const initial = await withWorkspaceIoTimeout(stat(target.real), 'stat');
      if (!initial.isFile()) throw new Error(`WORKSPACE_BINARY_NOT_FILE:${target.path ?? target.real}`);
      const openRequest = open(target.real, 'r');
      try {
        handle = await withWorkspaceIoTimeout(openRequest, 'open');
      } catch (openError) {
        // The IO timeout abandoned the open — still close the late FileHandle.
        openRequest.then((h) => h?.close?.().catch(() => {})).catch(() => {});
        throw openError;
      }
      const opened = await withWorkspaceIoTimeout(handle.stat(), 'stat');
      if (identity(opened) !== identity(initial)) throw new Error('WORKSPACE_BINARY_CHANGED');
      const size = opened.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('WORKSPACE_BINARY_HEADER_LIMIT');
      let headerReadBytes = 0;
      const readAt = async (buffer, offset) => {
        if (headerReadBytes + buffer.length > MAX_PE_HEADER_READ_BYTES) throw new Error('WORKSPACE_BINARY_HEADER_LIMIT');
        headerReadBytes += buffer.length;
        const { bytesRead } = await withWorkspaceIoTimeout(handle.read(buffer, 0, buffer.length, offset), 'read');
        if (bytesRead < buffer.length) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
        return buffer;
      };
      const dos = await readAt(Buffer.alloc(64), 0);
      if (dos[0] !== 0x4d || dos[1] !== 0x5a) throw new Error('WORKSPACE_BINARY_UNSUPPORTED_FORMAT');
      const peOffset = dos.readUInt32LE(0x3c);
      if (peOffset < 64) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      if (peOffset > MAX_PE_HEADER_OFFSET) throw new Error('WORKSPACE_BINARY_HEADER_LIMIT');
      if (peOffset + 24 > size) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      const coff = await readAt(Buffer.alloc(24), peOffset);
      if (coff[0] !== 0x50 || coff[1] !== 0x45 || coff[2] !== 0 || coff[3] !== 0) throw new Error('WORKSPACE_BINARY_UNSUPPORTED_FORMAT');
      const machineCode = coff.readUInt16LE(4);
      const sectionCount = coff.readUInt16LE(6);
      const optSize = coff.readUInt16LE(20);
      const characteristics = coff.readUInt16LE(22);
      if (sectionCount < 1) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      if (optSize < 2) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      const opt = await readAt(Buffer.alloc(Math.min(optSize, MAX_PE_HEADER_READ_BYTES - 88)), peOffset + 24);
      const magic = opt.readUInt16LE(0);
      const optMin = magic === 0x10b ? 96 : magic === 0x20b ? 112 : undefined;
      if (optMin === undefined || optSize < optMin || opt.length < optMin) throw new Error('WORKSPACE_BINARY_UNSUPPORTED_FORMAT');
      if (peOffset + 24 + optSize + sectionCount * 40 > size) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      const bits = magic === 0x10b ? 32 : 64;
      const ARCH = { 0x14c: 'X86', 0x8664: 'X64', 0x1c0: 'ARM', 0x1c2: 'ARM', 0x1c4: 'ARM', 0xaa64: 'ARM64', 0xa641: 'ARM64EC', 0xa64e: 'ARM64X', 0x200: 'IA64' };
      const SUB = { 1: 'NATIVE', 2: 'WINDOWS_GUI', 3: 'WINDOWS_CUI', 10: 'EFI_APPLICATION', 11: 'EFI_BOOT_SERVICE_DRIVER', 12: 'EFI_RUNTIME_DRIVER', 14: 'XBOX', 16: 'WINDOWS_BOOT_APPLICATION' };
      const architecture = ARCH[machineCode] ?? 'UNKNOWN';
      const expectedBits = { X86: 32, X64: 64, ARM: 32, ARM64: 64, ARM64EC: 64, ARM64X: 64, IA64: 64 }[architecture];
      if (expectedBits !== undefined && expectedBits !== bits) throw new Error('WORKSPACE_BINARY_INVALID_HEADER');
      const subsystemCode = opt.readUInt16LE(68);
      // Final identity check: the handle must still describe the same file the
      // path resolved to — a mid-read swap or revocation cannot leak data.
      const final = await withWorkspaceIoTimeout(handle.stat(), 'stat');
      const verify = await resolve(requestedPath);
      const current = await withWorkspaceIoTimeout(stat(verify.real), 'stat');
      if (identity(current) !== identity(opened) || identity(final) !== identity(opened)) throw new Error('WORKSPACE_BINARY_CHANGED');
      await resolve(requestedPath);
      return {
        schemaVersion: '1.0',
        path: verify.path,
        format: 'PE',
        sizeBytes: size,
        mz: 'MZ',
        peSignature: 'PE',
        peOffset,
        optionalHeaderMagic: magic,
        bits,
        machineCode,
        machineHex: `0x${machineCode.toString(16).padStart(4, '0')}`,
        architecture,
        executable: (characteristics & 0x0002) !== 0,
        characteristicsCode: characteristics,
        dll: (characteristics & 0x2000) !== 0,
        subsystemCode,
        subsystem: SUB[subsystemCode] ?? 'UNKNOWN',
        sectionCount
      };
    } finally {
      if (handle) await withWorkspaceIoTimeout(handle.close(), 'close').catch(() => {});
    }
  }

  async readMatching(relativePath, findText, maxChars = MAX_READ_CHARS, offsetChars = 0, requireUnique = false) {
    if (typeof findText !== 'string' || findText.length < 1 || findText.length > 512) {
      throw new Error('WORKSPACE_INVALID_FIND_TEXT');
    }
    return this.read(relativePath, maxChars, offsetChars, findText, requireUnique);
  }

  async read(relativePath, maxChars = MAX_READ_CHARS, offsetChars = 0, findText, requireUnique = false) {
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
    const match = findText === undefined ? undefined : requireUnique
      ? uniqueExcerptOffset(content, findText, offsetChars) : content.indexOf(findText, offsetChars);
    const start = match === undefined ? offsetChars : match < 0 ? content.length : match;
    return {
      path,
      sizeBytes: bytes.byteLength,
      digest: digest(bytes),
      content: content.slice(start, start + maxChars),
      truncated: start + maxChars < content.length,
      ...(match === undefined ? {} : { found: match >= 0, offsetChars: start })
    };
  }
}

export const readonlyWorkspacePlugin = (workspace) => cordisPlugin((ctx) => {
  ctx.provide('workspaceReadonly', workspace);
}, 'workspace-readonly');
