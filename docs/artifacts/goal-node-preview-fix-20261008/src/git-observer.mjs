import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

export const GIT_OBSERVER_SCHEMA_VERSION = '1.0';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_STATUS_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_PATH_DIGESTS = 256;
const UNTRACKED_FILES_MODES = new Set(['all', 'normal', 'no']);
const ALLOWED_REASONS = new Set(['RUN_STARTED', 'RUN_TERMINAL', 'ACTION_AUTHORIZED', 'ACTION_STARTED', 'ACTION_COMPLETED', 'ACTION_FAILED', 'RESUME_START', 'RESUME_RECONCILED', 'RECOVERY', 'OBSERVATION']);
const HEX_COMMIT = /^[0-9a-f]{7,64}$/i;

const digestBytes = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digestText = (value) => digestBytes(Buffer.from(String(value ?? ''), 'utf8'));
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const safeText = (value, max = 240) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ')
  .trim()
  .slice(0, max);

const normalizeReason = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const reason = safeText(value, 80);
  if (!ALLOWED_REASONS.has(reason)) throw new Error('GIT_OBSERVER_REASON_INVALID');
  return reason;
};

const safeTimeout = (value) => {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 250 || value > 60_000) throw new Error('GIT_OBSERVER_TIMEOUT_INVALID');
  return value;
};

// `all` recursively enumerates every untracked file.  That is prohibitively
// slow on large dependency/build directories and network shares, so the
// default keeps the bounded `normal` mode (one entry per untracked path) and
// lets stricter controlled modes opt back into `all`.
const safeUntrackedFiles = (value) => {
  const mode = value === undefined ? 'normal' : String(value).toLowerCase();
  if (!UNTRACKED_FILES_MODES.has(mode)) throw new Error('GIT_OBSERVER_UNTRACKED_INVALID');
  return mode;
};

const safeRoot = async (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('GIT_WORKSPACE_REQUIRED');
  return realpath(resolve(value)).catch(() => { throw new Error('GIT_WORKSPACE_NOT_FOUND'); });
};

const safeEnvironment = () => {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
};

const runFixedGit = (root, args, { timeoutMs, maxBytes }) => new Promise((resolveResult, reject) => {
  const command = process.platform === 'win32' ? 'git.exe' : 'git';
  let child;
  try {
    child = spawn(command, args, {
      cwd: root,
      env: safeEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    reject(new Error('GIT_NOT_AVAILABLE'));
    return;
  }

  const hash = createHash('sha256');
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let bytes = 0;
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill(); } catch { /* process may already be closed */ }
  }, timeoutMs);
  const append = (target, chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
    if (bytes > maxBytes) {
      try { child.kill(); } catch { /* process may already be closed */ }
      return target;
    }
    return Buffer.concat([target, buffer]);
  };
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderr = Buffer.concat([stderr, buffer]).subarray(0, 16 * 1024);
  });
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error?.code === 'ENOENT' ? new Error('GIT_NOT_AVAILABLE') : new Error('GIT_SPAWN_FAILED'));
  });
  child.once('close', (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (timedOut) {
      reject(new Error('GIT_OBSERVER_TIMEOUT'));
      return;
    }
    if (bytes > maxBytes) {
      reject(new Error('GIT_OBSERVATION_TOO_LARGE'));
      return;
    }
    resolveResult({
      ok: exitCode === 0,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: signal ?? null,
      stdout,
      stderr: safeText(stderr.toString('utf8'), 2000),
      outputBytes: bytes,
      outputDigest: `sha256:${hash.digest('hex')}`
    });
  });
});

const runReadOnlyGit = (root, args, options) => runFixedGit(root, ['--no-optional-locks', ...args], options);

const normalizeRelativePath = (root, value) => {
  const text = String(value ?? '').replaceAll('\\', '/');
  const relativePath = text.startsWith('/') || /^[A-Za-z]:\//u.test(text)
    ? relative(root, resolve(text)).replaceAll(sep, '/')
    : text;
  const normalized = relativePath.replace(/^\.\//u, '').replace(/\/+/gu, '/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return '';
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const pathDigest = (root, value) => {
  const normalized = normalizeRelativePath(root, value);
  return normalized ? digestText(normalized) : undefined;
};

const parseStatus = (root, raw) => {
  const tokens = raw.toString('utf8').split('\0').filter(Boolean);
  const pathDigests = [];
  const statusCodes = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;
  for (const token of tokens) {
    const pathText = token.includes('\t') ? token.slice(token.lastIndexOf('\t') + 1) : token.slice(token.lastIndexOf(' ') + 1);
    if (pathDigests.length >= MAX_PATH_DIGESTS) continue;
    const digest = pathDigest(root, pathText);
    if (digest) pathDigests.push(digest);
    if (token.startsWith('? ')) {
      untrackedCount += 1;
      statusCodes.push('?');
      continue;
    }
    if (token.startsWith('u ')) {
      conflictedCount += 1;
      statusCodes.push('U');
      continue;
    }
    const xy = token.startsWith('1 ') || token.startsWith('2 ')
      ? token.split(' ')[1] ?? '..'
      : '..';
    if (xy[0] && xy[0] !== '.') stagedCount += 1;
    if (xy[1] && xy[1] !== '.') unstagedCount += 1;
    statusCodes.push(xy.slice(0, 2));
  }
  return {
    entryCount: tokens.length,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
    statusCodes: [...new Set(statusCodes)].sort(),
    pathDigests: [...new Set(pathDigests)].sort(),
    pathDigestTruncated: tokens.length > MAX_PATH_DIGESTS
  };
};

const readHead = async (root, timeoutMs) => {
  const result = await runReadOnlyGit(root, ['rev-parse', '--verify', 'HEAD'], { timeoutMs, maxBytes: 4096 });
  const head = result.ok ? safeText(result.stdout.toString('utf8'), 80) : '';
  return HEX_COMMIT.test(head) ? head : undefined;
};

const METADATA_FILES = Object.freeze(['HEAD', 'config', 'index', 'packed-refs', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'ORIG_HEAD', 'FETCH_HEAD', 'shallow']);
const MAX_METADATA_FILE_BYTES = 16 * 1024 * 1024;

const readMetadataEntry = async (filePath) => {
  const metadata = await lstat(filePath).catch(() => null);
  if (!metadata) return { exists: false };
  const entry = {
    exists: true,
    type: metadata.isSymbolicLink() ? 'link' : metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : 'other',
    size: Number.isFinite(metadata.size) ? metadata.size : 0,
    mode: metadata.mode,
    mtimeMs: Number.isFinite(metadata.mtimeMs) ? Math.trunc(metadata.mtimeMs) : 0
  };
  if (metadata.isFile() && metadata.size <= MAX_METADATA_FILE_BYTES) {
    const content = await readFile(filePath).catch(() => null);
    if (content) entry.contentDigest = digestBytes(content);
  }
  return entry;
};

const readGitMetadata = async (root, timeoutMs) => {
  const result = await runReadOnlyGit(root, ['rev-parse', '--git-dir'], { timeoutMs, maxBytes: 4096 });
  if (!result.ok) throw new Error('GIT_METADATA_PATH_FAILED');
  const gitDirText = result.stdout.toString('utf8').trim();
  if (!gitDirText) throw new Error('GIT_METADATA_PATH_FAILED');
  const gitDir = await realpath(resolve(root, gitDirText)).catch(() => resolve(root, gitDirText));
  const entries = {};
  let linkDetected = false;
  for (const name of METADATA_FILES) {
    const entry = await readMetadataEntry(resolve(gitDir, name));
    entries[name] = entry;
    linkDetected ||= entry.type === 'link';
  }
  const hooksDirectory = resolve(gitDir, 'hooks');
  const hookNames = await readdir(hooksDirectory).catch(() => []);
  const boundedHookNames = hookNames.filter((name) => typeof name === 'string').sort().slice(0, MAX_PATH_DIGESTS);
  entries.hooks = {};
  for (const name of boundedHookNames) {
    const entry = await readMetadataEntry(resolve(hooksDirectory, name));
    entries.hooks[digestText(name)] = entry;
    linkDetected ||= entry.type === 'link';
  }
  entries.hooksTruncated = hookNames.length > MAX_PATH_DIGESTS;
  return { metadataDigest: digestText(stableStringify(entries)), metadataLinkDetected: linkDetected };
};

const createObservation = ({ root, repositoryRoot, head, status, index, workingTree, untracked, metadata, now, reason }) => {
  const unsigned = {
    schemaVersion: GIT_OBSERVER_SCHEMA_VERSION,
    repositoryRootDigest: digestText(repositoryRoot ?? root),
    head: head ?? null,
    headDigest: head ? digestText(head) : null,
    indexDigest: index.outputDigest,
    workingTreeDigest: workingTree.outputDigest,
    untrackedDigest: untracked.outputDigest,
    metadataDigest: metadata.metadataDigest,
    metadataLinkDetected: metadata.metadataLinkDetected,
    status,
    observedAtMs: now,
    ...(normalizeReason(reason) ? { reason: normalizeReason(reason) } : {})
  };
  return { ...unsigned, observationDigest: digestText(stableStringify(unsigned)) };
};

export class GitObserver {
  #workspaceRoot;
  #timeoutMs;
  #untrackedFiles;
  #now;

  constructor({ workspaceRoot, timeoutMs = DEFAULT_TIMEOUT_MS, untrackedFiles = 'normal', now = () => Date.now() } = {}) {
    this.#workspaceRoot = workspaceRoot;
    this.#timeoutMs = safeTimeout(timeoutMs);
    this.#untrackedFiles = safeUntrackedFiles(untrackedFiles);
    this.#now = now;
  }

  async snapshot({ reason, now = this.#now() } = {}) {
    const root = await safeRoot(this.#workspaceRoot);
    const repository = await runReadOnlyGit(root, ['rev-parse', '--show-toplevel'], { timeoutMs: this.#timeoutMs, maxBytes: 4096 });
    if (!repository.ok) {
      if (repository.exitCode === 128) {
        const unsigned = { status: 'NOT_A_REPOSITORY', workspaceRootDigest: digestText(root), observedAtMs: now };
        return { schemaVersion: GIT_OBSERVER_SCHEMA_VERSION, available: false, ...unsigned, observationDigest: digestText(stableStringify(unsigned)) };
      }
      throw new Error('GIT_REPOSITORY_UNAVAILABLE');
    }
    const repositoryRoot = await realpath(repository.stdout.toString('utf8').trim()).catch(() => root);
    const head = await readHead(root, this.#timeoutMs).catch(() => undefined);
    const metadata = await readGitMetadata(root, this.#timeoutMs);
    const statusResult = await runReadOnlyGit(root, ['status', '--porcelain=v2', '-z', `--untracked-files=${this.#untrackedFiles}`], { timeoutMs: this.#timeoutMs, maxBytes: MAX_STATUS_BYTES });
    if (!statusResult.ok) throw new Error('GIT_STATUS_FAILED');
    const status = parseStatus(root, statusResult.stdout);
    const [index, workingTree] = await Promise.all([
      runReadOnlyGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-color', '--cached'], { timeoutMs: this.#timeoutMs, maxBytes: MAX_DIFF_BYTES }),
      runReadOnlyGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--raw', '-z', '--no-color'], { timeoutMs: this.#timeoutMs, maxBytes: MAX_DIFF_BYTES })
    ]);
    const untracked = statusResult;
    if (!index.ok || !workingTree.ok || !untracked.ok) throw new Error('GIT_DIFF_OBSERVATION_FAILED');
    return {
      ...createObservation({ root, repositoryRoot, head, status, index, workingTree, untracked, metadata, now, reason }),
      available: true,
      workspaceRootDigest: digestText(root),
      repositoryRootDigest: digestText(repositoryRoot),
    };
  }
}

export const createGitObserver = (options) => new GitObserver(options);
export { digestText as gitDigest, stableStringify as stableGitStringify };
