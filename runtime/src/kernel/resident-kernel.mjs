import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRuntimeEnv } from '../platform/environment-policy.mjs';
import {
  createMessageFramer, encodeMessage,
  isReplaySafeKernelOp, isSessionWriteKernelOp,
  KERNEL_ERROR_CODES, KERNEL_MESSAGE_TYPES, KERNEL_PROTOCOL_VERSION,
  kernelRequest
} from './protocol.mjs';

const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./kernel-worker.mjs', import.meta.url));
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESTARTS = 5;

class KernelRequestError extends Error {
  constructor(code, message = '', details = undefined) {
    super(message ? `${code}:${message}` : code);
    this.name = 'KernelRequestError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Host-side supervisor for a per-session resident kernel.
 *
 * It owns the subprocess lifecycle and the request/response correlation, and it
 * enforces the two recovery invariants from the Phase-1 freeze:
 *
 *  1. On crash, rebuild from durable SessionState. The supervisor re-spawns the
 *     worker and re-initializes it from the authoritative SessionStateStore, so
 *     a crashed kernel never loses committed session state.
 *  2. Never auto-replay side effects. Only deterministic read ops and
 *     already-persisted, idempotent session writes are retried after a rebuild;
 *     a host_request in flight at crash time fails with an uncertain-outcome
 *     error instead of being silently re-issued.
 */
export class ResidentKernel {
  #workspaceRoot;
  #excludedPaths;
  #sessionId;
  #sessionStore;
  #env;
  #nodeBinary;
  #workerPath;
  #requestTimeoutMs;
  #maxRestarts;

  #child = null;
  #framer = null;
  #pending = new Map();
  #nextId = 0;
  #ready = false;
  #startPromise = null;
  #restarts = 0;
  #stopped = false;
  #lastExit = null;

  constructor({
    workspaceRoot,
    excludedPaths = [],
    sessionId,
    sessionStore,
    env = process.env,
    nodeBinary = process.execPath,
    workerPath = DEFAULT_WORKER_PATH,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRestarts = DEFAULT_MAX_RESTARTS
  } = {}) {
    if (!sessionStore || typeof sessionStore.snapshot !== 'function' || typeof sessionStore.set !== 'function') {
      throw new Error('KERNEL_SESSION_STORE_REQUIRED');
    }
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('KERNEL_SESSION_ID_REQUIRED');
    this.#workspaceRoot = typeof workspaceRoot === 'string' && workspaceRoot ? workspaceRoot : null;
    this.#excludedPaths = Array.isArray(excludedPaths) ? excludedPaths : [];
    this.#sessionId = sessionId.trim();
    this.#sessionStore = sessionStore;
    this.#env = env;
    this.#nodeBinary = nodeBinary;
    this.#workerPath = workerPath;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#maxRestarts = maxRestarts;
  }

  get sessionId() {
    return this.#sessionId;
  }

  get running() {
    return this.#ready && this.#child !== null;
  }

  get restarts() {
    return this.#restarts;
  }

  get workerPid() {
    return this.#child?.pid ?? null;
  }

  async start() {
    await this.#ensureWorker();
    return { ready: this.#ready, sessionId: this.#sessionId, restarts: this.#restarts };
  }

  async request(op, params = {}) {
    if (this.#stopped) throw new KernelRequestError(KERNEL_ERROR_CODES.DISABLED, 'kernel has been stopped');
    if (isSessionWriteKernelOp(op)) return this.#sessionWrite(op, params);
    return this.#dispatchWithRecovery(op, params);
  }

  async #sessionWrite(op, params = {}) {
    if (typeof params.key !== 'string') throw new KernelRequestError(KERNEL_ERROR_CODES.INVALID_PARAMS, 'key is required');
    // Persist durably BEFORE the worker ever sees the write. This is what makes
    // a session write idempotent and safe to replay through a rebuild.
    let durable;
    try {
      durable = op === 'session_state.set'
        ? await this.#sessionStore.set(params.key, params.value)
        : await this.#sessionStore.delete(params.key);
    } catch (error) {
      throw new KernelRequestError(KERNEL_ERROR_CODES.SESSION_STATE_INVALID, error?.message ?? 'session write failed');
    }
    const revision = durable.revision;
    const dispatchParams = op === 'session_state.set'
      ? { key: params.key, value: params.value, revision }
      : { key: params.key, revision };
    const result = await this.#dispatchWithRecovery(op, dispatchParams);
    return { ...result, revision };
  }

  async #dispatchWithRecovery(op, params) {
    await this.#ensureWorker();
    try {
      return await this.#post(op, params);
    } catch (error) {
      if (error?.code !== KERNEL_ERROR_CODES.WORKER_CRASHED) throw error;
      // The worker died while this op was in flight.
      if (!isReplaySafeKernelOp(op)) {
        // Never auto-replay a possible side effect; surface the uncertainty.
        throw new KernelRequestError(KERNEL_ERROR_CODES.OUTCOME_UNCERTAIN, 'worker crashed during a non-replayable operation');
      }
      if (this.#restarts >= this.#maxRestarts) throw error;
      await this.#rebuild();
      return this.#post(op, params);
    }
  }

  async #ensureWorker() {
    if (this.#ready && this.#child) return;
    if (!this.#startPromise) {
      this.#startPromise = this.#startWorker().catch((error) => {
        this.#startPromise = null;
        throw error;
      });
    }
    await this.#startPromise;
  }

  async #rebuild() {
    this.#restarts += 1;
    await this.#sessionStore.reload();
    this.#teardownChild();
    this.#startPromise = null;
    await this.#ensureWorker();
  }

  async #startWorker() {
    const env = buildRuntimeEnv(this.#env);
    const child = spawn(this.#nodeBinary, [this.#workerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env
    });
    this.#child = child;
    this.#framer = createMessageFramer();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* worker diagnostics are not trusted content */ });
    child.on('exit', (code, signal) => this.#onExit(code, signal));
    child.on('error', () => this.#onExit(null, null));

    await this.#sessionStore.load();
    const snapshot = this.#sessionStore.snapshot();
    const initResult = await this.#post('init', {
      protocolVersion: KERNEL_PROTOCOL_VERSION,
      sessionId: this.#sessionId,
      ...(this.#workspaceRoot ? { workspaceRoot: this.#workspaceRoot } : {}),
      excludedPaths: this.#excludedPaths,
      sessionState: { revision: snapshot.revision, entries: snapshot.entries.map(({ key, value, valueDigest }) => ({ key, value, valueDigest })) }
    }, { allowBeforeReady: true });
    if (!initResult?.ready) {
      this.#teardownChild();
      throw new KernelRequestError(KERNEL_ERROR_CODES.NOT_READY, 'kernel failed to initialize');
    }
    this.#ready = true;
    return initResult;
  }

  #onStdout(chunk) {
    let messages;
    try {
      messages = this.#framer.push(chunk);
    } catch {
      return;
    }
    for (const message of messages) {
      if (!message || message.type !== KERNEL_MESSAGE_TYPES.RESPONSE || typeof message.id !== 'string') continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new KernelRequestError(message.error?.code ?? KERNEL_ERROR_CODES.OP_FAILED, message.error?.message ?? '', message.error?.details));
    }
  }

  #onExit(code, signal) {
    this.#lastExit = { code, signal };
    this.#ready = false;
    const child = this.#child;
    this.#child = null;
    this.#framer = null;
    if (child) child.removeAllListeners();
    const crash = new KernelRequestError(KERNEL_ERROR_CODES.WORKER_CRASHED, `worker exited (code=${code}, signal=${signal})`);
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(crash);
    }
    this.#pending.clear();
  }

  #post(op, params, { allowBeforeReady = false } = {}) {
    const child = this.#child;
    if (!child || (!allowBeforeReady && !this.#ready)) {
      return Promise.reject(new KernelRequestError(KERNEL_ERROR_CODES.WORKER_CRASHED, 'worker is not available'));
    }
    const id = `req-${this.#nextId += 1}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new KernelRequestError(KERNEL_ERROR_CODES.TIMEOUT, `operation ${op} timed out`));
      }, this.#requestTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.#pending.set(id, { resolve, reject, timer, op });
      try {
        child.stdin.write(encodeMessage(kernelRequest(id, op, params)));
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new KernelRequestError(KERNEL_ERROR_CODES.OP_FAILED, error?.message ?? 'failed to write request'));
      }
    });
  }

  #teardownChild() {
    const child = this.#child;
    this.#ready = false;
    this.#child = null;
    this.#framer = null;
    if (!child) return;
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  async stop() {
    this.#stopped = true;
    const child = this.#child;
    this.#ready = false;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new KernelRequestError(KERNEL_ERROR_CODES.DISABLED, 'kernel stopped'));
    }
    this.#pending.clear();
    if (!child) return;
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    this.#child = null;
    try {
      child.stdin.write(encodeMessage(kernelRequest(`req-${this.#nextId += 1}`, 'shutdown', {})));
      child.stdin.end();
    } catch { /* fall through to kill */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 1000);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

export const createResidentKernel = (options) => new ResidentKernel(options);
export { KernelRequestError };
