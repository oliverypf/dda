import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile, access, constants as fsConstants } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { acquirePersistentLock, persistentJsonDefaults } from '../persistent-json-store.mjs';

/**
 * Phase-2b OS sandbox (F3): bwrap preferred → Landlock+seccomp fallback → fail-closed.
 * Default OFF (DDA_KERNEL_SANDBOX). Cells require a real canary + ready handshake.
 */

export const KERNEL_SANDBOX_FLAG = 'DDA_KERNEL_SANDBOX';
export const KERNEL_SANDBOX_OP_WORKER_FLAG = 'DDA_KERNEL_SANDBOX_OP_WORKER';

export const SANDBOX_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  CANARY_FAIL: 'SANDBOX_CANARY_FAIL',
  TIMEOUT: 'SANDBOX_CANARY_TIMEOUT'
});

/** Deny-write canary pass only on real permission/rofs denial — never ENOENT. */
export const isDeniedWriteError = (error) => {
  const code = error?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
};


const NATIVE_DIR = fileURLToPath(new URL('../../native/kernel-sandbox/', import.meta.url));
const ADDON_PATH = join(NATIVE_DIR, 'build', 'Release', 'dda_kernel_sandbox.node');
const SHIM_PATH = join(NATIVE_DIR, 'require-shim.cjs');

const isTruthyFlag = (value) => typeof value === 'string' && ['1', 'true', 'on', 'yes', 'enabled'].includes(value.trim().toLowerCase());
const isFalsyFlag = (value) => typeof value === 'string' && ['0', 'false', 'off', 'no', 'disabled'].includes(value.trim().toLowerCase());

export const isKernelSandboxEnabled = (env = process.env) => isTruthyFlag(env?.[KERNEL_SANDBOX_FLAG]);
export const isSandboxOpWorkerEnabled = (env = process.env) => isTruthyFlag(env?.[KERNEL_SANDBOX_OP_WORKER_FLAG]);

const requireNative = createRequire(import.meta.url);

export const loadSandboxNative = () => {
  try {
    // Host loads .node directly — never the .cjs shim (F3/30th).
    return requireNative(ADDON_PATH);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
};

export const detectBwrap = async () => {
  try {
    await access('/usr/bin/bwrap', fsConstants.X_OK);
    return { available: true, path: '/usr/bin/bwrap' };
  } catch {
    return { available: false, path: null };
  }
};

/**
 * Resolve sandbox backend availability. No `none` tier — fail closed.
 */
export const detectKernelOsSandbox = async (env = process.env, platform = process.platform) => {
  if (!isKernelSandboxEnabled(env)) {
    return { available: false, reason: 'SANDBOX_DISABLED', backend: null };
  }
  if (platform !== 'linux') {
    return { available: false, reason: 'NON_LINUX_PLATFORM', backend: null };
  }
  const native = loadSandboxNative();
  if (native.error || typeof native.emitStage1Filter !== 'function') {
    return { available: false, reason: 'NATIVE_ADDON_UNAVAILABLE', backend: null, detail: native.error };
  }
  let stage1;
  try {
    stage1 = native.emitStage1Filter();
    if (!Buffer.isBuffer(stage1) || stage1.length === 0 || stage1.length % 8 !== 0) {
      return { available: false, reason: 'STAGE1_FILTER_INVALID', backend: null };
    }
  } catch (error) {
    return { available: false, reason: 'STAGE1_FILTER_EMIT_FAILED', backend: null, detail: error?.message };
  }
  const bwrap = await detectBwrap();
  if (bwrap.available) {
    return { available: true, reason: 'BWRAP', backend: 'bwrap', bwrapPath: bwrap.path, stage1Filter: stage1, native, shimPath: SHIM_PATH, addonPath: ADDON_PATH };
  }
  // Fail-closed: Landlock+seccomp fallback is not complete in this MVP (no C launcher
  // with private-root FS allow-list + ns + stage-1 install). Do NOT report available
  // for a half-sandbox. Full Landlock path stays deferred as explicit unavailable.
  return {
    available: false,
    reason: 'LANDLOCK_INCOMPLETE',
    backend: null,
    detail: 'bwrap missing; Landlock FS allow-list + launcher not implemented — refuse rather than best-effort'
  };
};

/** Normalize excludedPaths to a body-set (strip trailing .lock; no .lock.lock). */
export const normalizeExcludedBodySet = (excludedPaths = []) => {
  const bodies = new Set();
  for (const raw of excludedPaths) {
    if (typeof raw !== 'string' || !raw) continue;
    const path = raw.endsWith('.lock') ? raw.slice(0, -'.lock'.length) : raw;
    if (!path || path.endsWith('.lock')) continue; // refuse .lock.lock
    bodies.add(path);
  }
  return [...bodies];
};

/**
 * Build mount denylist paths: SENSITIVE + dataDir + session + journal + body+`${body}.lock`.
 * coordinatorPath handling is mode-aware at canary plant time (37th), not here.
 */
export const buildMountDenylist = ({ sensitivePaths = [], dataDir, sessionStatePath, journalPath, excludedBodies = [] } = {}) => {
  const list = new Set();
  for (const p of sensitivePaths) if (p) list.add(p);
  if (dataDir) list.add(dataDir);
  if (sessionStatePath) {
    list.add(sessionStatePath);
    list.add(`${sessionStatePath}.lock`);
  }
  if (journalPath) {
    list.add(journalPath);
    list.add(`${journalPath}.lock`);
  }
  for (const body of excludedBodies) {
    list.add(body);
    list.add(`${body}.lock`);
  }
  return [...list];
};

const CANARY_BUDGET_MS = Math.min(12_000, (persistentJsonDefaults.lockTimeoutMs ?? 15_000) - 1);

/**
 * Write stage-1 raw sock_filter[] bytes to an FD for bwrap --seccomp FD.
 * Caller must not let this FD enter the node process (bwrap consumes it).
 */
export const writeSeccompFd = async (filterBytes) => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-seccomp-'));
  const path = join(dir, 'stage1.bpf');
  await writeFile(path, filterBytes);
  const handle = await open(path, 'r');
  return {
    fd: handle.fd,
    handle,
    path,
    dir,
    async close() {
      await handle.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
};

/**
 * Collect absolute paths the canary must probe. Empty set ≠ pass.
 * coordinatorMode: 'A' (eventStore authority — exclude coordinator from required)
 *                  'B' (file authority — required if present; never plant dirty)
 */
export const buildCanaryRequiredPaths = ({
  dataDir,
  sessionStatePath,
  journalPath,
  excludedBodies = [],
  sensitiveSentinel,
  nonSecretWorkspaceFile,
  coordinatorPath,
  coordinatorMode = 'A'
} = {}) => {
  const required = [];
  const push = (p) => {
    if (typeof p === 'string' && p && isAbsolute(p)) required.push(p);
  };
  push(dataDir);
  push(sessionStatePath);
  if (sessionStatePath) push(`${sessionStatePath}.lock`);
  push(journalPath);
  for (const body of excludedBodies) {
    if (coordinatorPath && body === coordinatorPath && coordinatorMode === 'A') continue;
    push(body);
    // Non-PJS: do not require synthetic .lock for canary existence (35th).
    // PJS bodies: session.lock already pushed; journal.lock optional for probe body-only.
  }
  push(sensitiveSentinel);
  push(nonSecretWorkspaceFile);
  if (coordinatorPath && coordinatorMode === 'B') push(coordinatorPath);
  if (required.length === 0) {
    return { ok: false, reason: 'CANARY_PATH_SET_EMPTY', paths: [] };
  }
  for (const p of required) {
    if (!isAbsolute(p)) return { ok: false, reason: 'CANARY_PATH_NOT_ABSOLUTE', paths: required };
  }
  return { ok: true, paths: required };
};

export { CANARY_BUDGET_MS, ADDON_PATH, SHIM_PATH, NATIVE_DIR };
