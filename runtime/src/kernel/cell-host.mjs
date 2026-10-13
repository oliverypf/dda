import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm, access, constants as fsConstants, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildRuntimeEnv } from '../platform/environment-policy.mjs';
import {
  detectKernelOsSandbox, writeSeccompFd, buildCanaryRequiredPaths, normalizeExcludedBodySet,
  CANARY_BUDGET_MS, SHIM_PATH, ADDON_PATH, NATIVE_DIR, SANDBOX_ERROR_CODES
} from './sandbox.mjs';
import {
  CELL_PROTOCOL_VERSION, CELL_MESSAGE_TYPES, CELL_ERROR_CODES,
  encodeCellMessage, createCellFramer, mintCellEpoch, isValidCellEpoch, admitExecFrame, CellProtocolError
} from './cell-protocol.mjs';
import { KERNEL_READ_OPS, KERNEL_BRIDGE_READ_KINDS } from './protocol.mjs';
import { JOURNAL_BITS } from './journal-als.mjs';

const DEFAULT_WORKER = fileURLToPath(new URL('./cell-worker.mjs', import.meta.url));
const DEFAULT_CELL_TIMEOUT_MS = 30_000;
const DEFAULT_READY_TIMEOUT_MS = CANARY_BUDGET_MS;

const READ_KIND_SET = new Set([...KERNEL_READ_OPS, ...KERNEL_BRIDGE_READ_KINDS]);

/**
 * Host supervisor for sandboxed Node vm code cells (Phase-2b).
 *
 * - Spawns worker under bwrap (preferred) or Landlock backend with --require shim
 * - Unlocks only on first cell-protocol `ready` after canary
 * - Mints host-authoritative epoch per cell (16B→32 hex); rejects dead-epoch frames
 * - Reverse channel: read kinds → Phase-1 readonly bridge; write kinds → effects dispatcher
 */
export const KERNEL_CODE_CELLS_FLAG = 'DDA_KERNEL_CODE_CELLS';
export const KERNEL_CELL_TIMEOUT_FLAG = 'DDA_KERNEL_CELL_TIMEOUT_MS';

const isTruthyFlag = (value) => typeof value === 'string' && ['1', 'true', 'on', 'yes', 'enabled'].includes(value.trim().toLowerCase());

export const isCodeCellsEnabled = (env = process.env) => isTruthyFlag(env?.[KERNEL_CODE_CELLS_FLAG]);

export const codeCellsAvailability = async ({
  env = process.env,
  journalAvailable = false,
  residentAvailable = false
} = {}) => {
  if (!isCodeCellsEnabled(env)) return { available: false, reason: 'CODE_CELLS_DISABLED' };
  if (!residentAvailable) return { available: false, reason: 'KERNEL_NOT_ATTACHED' };
  if (!journalAvailable) return { available: false, reason: 'JOURNAL_UNAVAILABLE' };
  const sandbox = await detectKernelOsSandbox(env);
  if (!sandbox.available) return { available: false, reason: sandbox.reason ?? SANDBOX_ERROR_CODES.UNAVAILABLE, sandbox };
  return { available: true, reason: 'AVAILABLE', sandbox };
};

export class CellHost {
  #env;
  #nodeBinary;
  #workerPath;
  #workspaceRoot;
  #excludedPaths;
  #sessionId;
  #sessionStore;
  #workspace;
  #effectsDispatcher;
  #readonlyBridge;
  #journal;
  #cellTimeoutMs;
  #onEmit;

  #child = null;
  #framer = null;
  #ready = false;
  #backend = null;
  #activeCellEpoch = null;
  #usedEpochs = new Set();
  #pendingExec = new Map();
  #seccomp = null;
  #privateTmp = null;
  #computeDeadline = null;
  #computePaused = false;
  #computeRemainingMs = null;
  #suppressedDigests = new Map(); // cellId → Set(digest)

  constructor({
    env = process.env,
    nodeBinary = process.execPath,
    workerPath = DEFAULT_WORKER,
    workspaceRoot,
    excludedPaths = [],
    sessionId,
    sessionStore,
    workspace,
    effectsDispatcher,
    readonlyBridge,
    journal,
    cellTimeoutMs,
    onEmit = () => {}
  } = {}) {
    this.#env = env;
    this.#nodeBinary = nodeBinary;
    this.#workerPath = workerPath;
    this.#workspaceRoot = workspaceRoot;
    this.#excludedPaths = excludedPaths;
    this.#sessionId = sessionId;
    this.#sessionStore = sessionStore;
    this.#workspace = workspace;
    this.#effectsDispatcher = effectsDispatcher;
    this.#readonlyBridge = readonlyBridge;
    this.#journal = journal;
    this.#cellTimeoutMs = Number(env?.[KERNEL_CELL_TIMEOUT_FLAG] ?? cellTimeoutMs ?? DEFAULT_CELL_TIMEOUT_MS) || DEFAULT_CELL_TIMEOUT_MS;
    this.#onEmit = onEmit;
  }

  get ready() {
    return this.#ready;
  }

  get activeCellEpoch() {
    return this.#activeCellEpoch;
  }

  async start({
    dataDir,
    sessionStatePath,
    journalPath,
    sensitiveSentinel,
    nonSecretWorkspaceFile,
    coordinatorPath,
    coordinatorMode = 'A',
    denyWritePaths = []
  } = {}) {
    if (this.#child) return { ready: this.#ready };

    const availability = await codeCellsAvailability({
      env: this.#env,
      journalAvailable: this.#journal?.available === true,
      residentAvailable: true
    });
    if (!availability.available) {
      return { ready: false, reason: availability.reason };
    }
    const sandbox = availability.sandbox;
    this.#backend = sandbox.backend;

    this.#privateTmp = await mkdtemp(join(tmpdir(), 'dda-cell-'));
    const bodies = normalizeExcludedBodySet(this.#excludedPaths);
    const canary = buildCanaryRequiredPaths({
      dataDir,
      sessionStatePath,
      journalPath,
      excludedBodies: bodies,
      sensitiveSentinel: sensitiveSentinel ?? join(this.#privateTmp, 'sensitive-sentinel'),
      nonSecretWorkspaceFile: nonSecretWorkspaceFile ?? join(this.#privateTmp, 'canary-workspace-file.txt'),
      coordinatorPath,
      coordinatorMode
    });
    if (!canary.ok) {
      await this.#cleanupScratch();
      return { ready: false, reason: canary.reason };
    }

    // Plant minimal canary targets that live under private tmp (always safe).
    await writeFile(join(this.#privateTmp, 'sensitive-sentinel'), '');
    await writeFile(join(this.#privateTmp, 'canary-workspace-file.txt'), 'ok\n');

    const handoff = {
      backend: sandbox.backend,
      privateTmp: this.#privateTmp,
      canaryPaths: canary.paths,
      denyWritePaths: [
        ...denyWritePaths,
        ...bodies.flatMap((body) => [body, `${body}.lock`]),
        ...(dataDir ? [dataDir] : []),
        ...(sessionStatePath ? [sessionStatePath, `${sessionStatePath}.lock`] : []),
        ...(journalPath ? [journalPath, `${journalPath}.lock`] : [])
      ],
      closedFds: []
    };

    const nodeArgs = [
      `--require=${SHIM_PATH}`,
      this.#workerPath
    ];

    const runtimeEnv = {
      ...buildRuntimeEnv(this.#env, { extraKeys: [] }),
      DDA_KERNEL_SANDBOX_BACKEND: sandbox.backend,
      DDA_KERNEL_SANDBOX_PRIVATE_TMP: this.#privateTmp,
      DDA_KERNEL_SANDBOX_HANDOFF_JSON: JSON.stringify(handoff),
      // Ensure worker can resolve relative imports of cell-protocol from worker path.
      NODE_OPTIONS: undefined
    };
    // Strip secrets-ish extras: buildRuntimeEnv already filters; force no inherit of host tokens.
    delete runtimeEnv.NODE_OPTIONS;

    this.#framer = createCellFramer();
    const readyWait = this.#waitReady(DEFAULT_READY_TIMEOUT_MS);

    if (sandbox.backend === 'bwrap') {
      this.#seccomp = await writeSeccompFd(sandbox.stage1Filter);
      // Pass the seccomp FileHandle as stdio FD 3 so bwrap can read raw sock_filter[]
      // bytes; that FD must NOT be inherited into the inner node process (bwrap consumes it).
      const seccompStdioFd = 3;
      const bwrapArgs = this.#buildBwrapArgs({
        seccompFd: seccompStdioFd,
        nodeBinary: this.#nodeBinary,
        nodeArgs,
        privateTmp: this.#privateTmp
      });
      this.#child = spawn(sandbox.bwrapPath, bwrapArgs, {
        stdio: ['pipe', 'pipe', 'pipe', this.#seccomp.handle],
        env: runtimeEnv,
        detached: false
      });
      // Parent can release the handle after spawn; bwrap has its own dup.
      await this.#seccomp.close().catch(() => {});
      this.#seccomp = null;
    } else {
      // Landlock backend must never be selected until detectKernelOsSandbox proves a
      // complete Landlock+seccomp fallback (pair-programming: fail-closed, no half-sandbox).
      await this.#cleanupScratch();
      return { ready: false, reason: 'LANDLOCK_INCOMPLETE' };
    }

    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.#child.stderr.on('data', (chunk) => {
      this.#onEmit('kernel.cell_worker_stderr', { chunk: String(chunk).slice(0, 2000) });
    });
    this.#child.on('exit', (code, signal) => {
      this.#ready = false;
      this.#failAllPending('WORKER_EXIT', { code, signal });
      this.#child = null;
    });

    try {
      await readyWait;
      this.#ready = true;
      return { ready: true, backend: this.#backend };
    } catch (error) {
      await this.stop().catch(() => {});
      return { ready: false, reason: error?.code ?? error?.message ?? SANDBOX_ERROR_CODES.UNAVAILABLE };
    }
  }

  #buildBwrapArgs({ seccompFd, nodeBinary, nodeArgs, privateTmp }) {
    // Minimal binds: node + libs + cell worker JS + .node + shim + /proc /dev + private tmp.
    // Do NOT ro-bind whole workspace or runtime/ (F3).
    const out = [
      '--unshare-all', '--die-with-parent', '--new-session',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', privateTmp, privateTmp, '--chdir', privateTmp
    ];
    const roBind = (hostPath, guestPath = hostPath) => {
      if (!existsSync(hostPath)) return false;
      out.push('--ro-bind', hostPath, guestPath);
      return true;
    };
    roBind(nodeBinary);
    roBind(this.#workerPath);
    roBind(join(dirname(this.#workerPath), 'cell-protocol.mjs'));
    roBind(join(dirname(this.#workerPath), 'protocol.mjs'));
    roBind(ADDON_PATH);
    roBind(SHIM_PATH);
    for (const p of ['/usr', '/lib', '/lib64']) roBind(p);
    // bwrap reads raw sock_filter[] from this FD and must not pass it into node.
    out.push('--seccomp', String(seccompFd));
    out.push(nodeBinary, ...nodeArgs);
    return out;
  }

  #waitReady(timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(Object.assign(new Error(SANDBOX_ERROR_CODES.TIMEOUT), { code: SANDBOX_ERROR_CODES.TIMEOUT }));
      }, timeoutMs);
      this.#readyResolver = {
        resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
    });
  }

  #readyResolver = null;

  #onStdout(chunk) {
    let messages;
    try {
      messages = this.#framer.push(chunk);
    } catch (error) {
      this.#onEmit('kernel.cell_frame_error', { code: error?.code });
      return;
    }
    for (const message of messages) this.#handleMessage(message);
  }

  #handleMessage(message) {
    if (message.type === CELL_MESSAGE_TYPES.READY) {
      if (!this.#ready && this.#readyResolver) {
        this.#readyResolver.resolve(message);
        this.#readyResolver = null;
      }
      // Ignore duplicate ready after unlock (F11).
      return;
    }
    if (message.type === CELL_MESSAGE_TYPES.CANARY_FAIL) {
      if (this.#readyResolver) {
        this.#readyResolver.reject(Object.assign(new Error(SANDBOX_ERROR_CODES.CANARY_FAIL), { code: SANDBOX_ERROR_CODES.CANARY_FAIL, detail: message }));
        this.#readyResolver = null;
      }
      return;
    }
    if (message.type === CELL_MESSAGE_TYPES.EXEC_RESULT) {
      const pending = this.#pendingExec.get(message.execId);
      if (!pending) return;
      this.#pendingExec.delete(message.execId);
      // Clear authoritative epoch at cell terminal.
      this.#activeCellEpoch = null;
      this.#stopComputeClock();
      if (message.ok) pending.resolve(message);
      else pending.reject(Object.assign(new Error(message.errorCode ?? 'CELL_EXEC_ERROR'), { code: message.errorCode, details: message }));
      return;
    }
    if (message.type === CELL_MESSAGE_TYPES.HOST_REQUEST) {
      this.#handleHostRequest(message).catch((error) => {
        this.#send({
          v: CELL_PROTOCOL_VERSION,
          type: CELL_MESSAGE_TYPES.HOST_RESPONSE,
          requestId: message.requestId,
          ok: false,
          errorCode: error?.code ?? 'HOST_REQUEST_FAILED',
          error: error?.message
        });
      });
    }
  }

  async #handleHostRequest(message) {
    // Positive equality BEFORE any dispatch (incl. readonly bridge) — F7/I12.
    if (!this.#activeCellEpoch || !isValidCellEpoch(this.#activeCellEpoch)
      || message.epoch !== this.#activeCellEpoch) {
      throw Object.assign(new Error(CELL_ERROR_CODES.EPOCH_REFUSED), { code: CELL_ERROR_CODES.EPOCH_REFUSED });
    }
    const kind = message.kind;
    // Pause compute clock for the whole host_request round-trip (approval+exec).
    this.#pauseComputeClock();
    try {
      if (READ_KIND_SET.has(kind)) {
        // Phase-1 readonly bridge — same ReadonlyWorkspace / SessionState; no #15/effects.
        if (typeof this.#readonlyBridge !== 'function') {
          throw Object.assign(new Error('READONLY_BRIDGE_UNAVAILABLE'), { code: 'READONLY_BRIDGE_UNAVAILABLE' });
        }
        const result = await this.#readonlyBridge(kind, message.payload);
        this.#send({
          v: CELL_PROTOCOL_VERSION,
          type: CELL_MESSAGE_TYPES.HOST_RESPONSE,
          requestId: message.requestId,
          ok: true,
          result
        });
        return;
      }
      // Write kinds → effects dispatcher (requires DDA_KERNEL_EFFECTS gate).
      if (!this.#effectsDispatcher?.handles?.(kind)) {
        throw Object.assign(new Error('KERNEL_SIDE_EFFECT_REFUSED'), { code: 'KERNEL_SIDE_EFFECT_REFUSED' });
      }
      const cellId = message.cellId ?? 'unknown-cell';
      const ordinal = message.requestId;
      const toolCallId = `${cellId}::${ordinal}`;
      const result = await this.#effectsDispatcher.dispatch(
        { kind, payload: message.payload },
        { toolCallId, cellId, fromCell: true, journalBit: JOURNAL_BITS.CELL }
      );
      this.#send({
        v: CELL_PROTOCOL_VERSION,
        type: CELL_MESSAGE_TYPES.HOST_RESPONSE,
        requestId: message.requestId,
        ok: true,
        result
      });
    } finally {
      this.#resumeComputeClock();
    }
  }

  #send(message) {
    if (!this.#child?.stdin) return;
    this.#child.stdin.write(encodeCellMessage(message));
  }

  #startComputeClock(timeoutMs) {
    this.#computeRemainingMs = timeoutMs;
    this.#computePaused = false;
    this.#armComputeTimer();
  }

  #armComputeTimer() {
    if (this.#computeDeadline) clearTimeout(this.#computeDeadline);
    if (this.#computePaused) return;
    const started = Date.now();
    this.#computeDeadline = setTimeout(() => {
      const pending = [...this.#pendingExec.values()];
      this.#pendingExec.clear();
      this.#activeCellEpoch = null;
      for (const p of pending) {
        p.reject(Object.assign(new Error(CELL_ERROR_CODES.TIMEOUT), { code: CELL_ERROR_CODES.TIMEOUT }));
      }
      // Kill worker on compute timeout — restart on next exec.
      this.#child?.kill('SIGKILL');
    }, this.#computeRemainingMs);
    this.#computeDeadline.startedAt = started;
  }

  #pauseComputeClock() {
    if (this.#computePaused || !this.#computeDeadline) return;
    const elapsed = Date.now() - (this.#computeDeadline.startedAt ?? Date.now());
    this.#computeRemainingMs = Math.max(0, (this.#computeRemainingMs ?? 0) - elapsed);
    clearTimeout(this.#computeDeadline);
    this.#computeDeadline = null;
    this.#computePaused = true;
  }

  #resumeComputeClock() {
    if (!this.#computePaused) return;
    this.#computePaused = false;
    this.#armComputeTimer();
  }

  #stopComputeClock() {
    if (this.#computeDeadline) clearTimeout(this.#computeDeadline);
    this.#computeDeadline = null;
    this.#computePaused = false;
    this.#computeRemainingMs = null;
  }

  #failAllPending(code, detail) {
    for (const [, pending] of this.#pendingExec) {
      pending.reject(Object.assign(new Error(code), { code, detail }));
    }
    this.#pendingExec.clear();
    this.#activeCellEpoch = null;
    this.#stopComputeClock();
  }

  async exec({ code, cellId = `cell-${randomUUID()}` } = {}) {
    if (!this.#ready || !this.#child) {
      throw Object.assign(new Error(SANDBOX_ERROR_CODES.UNAVAILABLE), { code: SANDBOX_ERROR_CODES.UNAVAILABLE });
    }
    // Refuse frames while epoch is being cleared / before next mint.
    if (this.#activeCellEpoch) {
      throw Object.assign(new Error('CELL_BUSY'), { code: 'CELL_BUSY' });
    }
    let epoch;
    do {
      epoch = mintCellEpoch();
    } while (this.#usedEpochs.has(epoch));
    this.#usedEpochs.add(epoch);
    this.#activeCellEpoch = epoch;

    const execId = `exec-${randomUUID()}`;
    const { frame } = admitExecFrame({ cellId, epoch, code });
    // Re-encode with execId
    const message = {
      v: CELL_PROTOCOL_VERSION,
      type: CELL_MESSAGE_TYPES.EXEC,
      cellId,
      epoch,
      execId,
      code
    };
    const wire = encodeCellMessage(message);
    if (Buffer.byteLength(wire, 'utf8') > Buffer.byteLength(frame, 'utf8') + 80) {
      // sanity — still bounded by encodeCellMessage
    }

    this.#startComputeClock(this.#cellTimeoutMs);
    const resultPromise = new Promise((resolvePromise, reject) => {
      this.#pendingExec.set(execId, { resolve: resolvePromise, reject });
    });
    this.#child.stdin.write(wire);
    return resultPromise;
  }

  async stop() {
    this.#stopComputeClock();
    this.#ready = false;
    this.#activeCellEpoch = null;
    if (this.#child) {
      this.#child.kill('SIGKILL');
      this.#child = null;
    }
    if (this.#seccomp) {
      await this.#seccomp.close().catch(() => {});
      this.#seccomp = null;
    }
    await this.#cleanupScratch();
  }

  async #cleanupScratch() {
    if (this.#privateTmp) {
      await rm(this.#privateTmp, { recursive: true, force: true }).catch(() => {});
      this.#privateTmp = null;
    }
  }
}

export const createCellHost = (options) => new CellHost(options);
