/**
 * Resident kernel worker: the per-session subprocess that is the model's
 * primary tool surface in Phase-1.
 *
 * The worker speaks the newline-delimited JSON protocol on stdin/stdout. After
 * an `init` handshake it serves read-only workspace inspection, an in-memory
 * mirror of the host-owned session state, and the host_request bridge stub.
 * It holds no side-effect capability: every write/shell/network/test request is
 * refused here, matching the Phase-1 freeze. The worker must never crash on
 * malformed input; it answers with a structured failure and keeps serving.
 */

import { createHash } from 'node:crypto';
import { createMessageFramer, encodeMessage,
  isBridgeReadKind, isBridgeSideEffectKind,
  KERNEL_ERROR_CODES, KERNEL_MESSAGE_TYPES, KERNEL_PROTOCOL_VERSION,
  kernelFailure, kernelSuccess } from './protocol.mjs';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const canonicalJson = (input) => {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  if (isPlainObject(input)) return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
  return JSON.stringify(input) ?? 'null';
};
const mirrorDigest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;

const safeErrorCode = (error) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (typeof error?.code === 'string' && /^KERNEL_[A-Z0-9_]+$/.test(error.code)) {
    return { code: error.code, message: message.startsWith(`${error.code}:`) ? message.slice(error.code.length + 1) : undefined };
  }
  const prefixed = /^(KERNEL_[A-Z0-9_]+|(?:WORKSPACE|SAFETY|EXECUTOR)_[A-Z0-9_]+)/.exec(message);
  if (prefixed) {
    const code = prefixed[0];
    return { code, message: message.slice(code.length + 1) || undefined };
  }
  return { code: KERNEL_ERROR_CODES.OP_FAILED, message: undefined };
};

/**
 * Pure request handler, exported so tests can exercise the operation surface
 * without spawning a process. `deps.workspace` is a ReadonlyWorkspace-like
 * object; `state` is the worker's mutable session-state mirror.
 */
export const createKernelHandler = ({ workspace, state }) => {
  const requireWorkspace = () => {
    if (!workspace) throw Object.assign(new Error('WORKSPACE_NOT_AUTHORIZED'), { code: 'WORKSPACE_NOT_AUTHORIZED' });
    return workspace;
  };

  const handlers = {
    'workspace.list': async (params) => {
      const path = typeof params.path === 'string' ? params.path : '';
      return requireWorkspace().list(path);
    },
    'workspace.read': async (params) => {
      if (typeof params.path !== 'string') throw new Error('KERNEL_INVALID_PARAMS:path is required');
      const maxChars = params.maxChars === undefined ? undefined : params.maxChars;
      const offsetChars = params.offsetChars === undefined ? 0 : params.offsetChars;
      if (params.findText !== undefined) {
        return requireWorkspace().readMatching(params.path, params.findText, maxChars ?? 32768, offsetChars);
      }
      return requireWorkspace().read(params.path, maxChars ?? 32768, offsetChars);
    },
    'workspace.focus': async (params) => {
      if (typeof params.path !== 'string' || typeof params.findText !== 'string') {
        throw new Error('KERNEL_INVALID_PARAMS:path and findText are required');
      }
      const maxChars = params.maxChars === undefined ? 2000 : params.maxChars;
      return requireWorkspace().readMatching(params.path, params.findText, maxChars, 0, true);
    },
    'session_state.get': async (params) => {
      if (typeof params.key !== 'string') throw new Error('KERNEL_INVALID_PARAMS:key is required');
      const found = state.has(params.key);
      return { key: params.key, found, ...(found ? { value: state.get(params.key) } : {}) };
    },
    'session_state.list': async () => ({ keys: state.list(), revision: state.revision }),
    // Session writes are already persisted durably by the host before dispatch.
    // The worker only mirrors the authoritative value+revision the host sends.
    'session_state.set': async (params) => {
      if (typeof params.key !== 'string') throw new Error('KERNEL_INVALID_PARAMS:key is required');
      if (!Number.isInteger(params.revision)) throw new Error('KERNEL_INVALID_PARAMS:revision is required');
      state.set(params.key, params.value, params.revision);
      return { key: params.key, revision: params.revision, valueDigest: state.digest(params.key) };
    },
    'session_state.delete': async (params) => {
      if (typeof params.key !== 'string') throw new Error('KERNEL_INVALID_PARAMS:key is required');
      if (!Number.isInteger(params.revision)) throw new Error('KERNEL_INVALID_PARAMS:revision is required');
      const deleted = state.delete(params.key, params.revision);
      return { key: params.key, deleted, revision: params.revision };
    },
    // host_request bridge stub. Phase-1 answers only inert probes and refuses
    // every side effect; this is where Phase-2 will route approved effects.
    'host_request': async (params) => {
      const kind = typeof params.kind === 'string' ? params.kind : '';
      if (isBridgeSideEffectKind(kind)) {
        throw Object.assign(
          new Error('KERNEL_SIDE_EFFECT_REFUSED:side effects are not available in Phase-1'),
          { code: KERNEL_ERROR_CODES.SIDE_EFFECT_REFUSED }
        );
      }
      if (isBridgeReadKind(kind)) {
        if (kind === 'host.ping') return { kind, ok: true, phase: 1 };
        return { kind, ok: true, phase: 1, protocolVersion: KERNEL_PROTOCOL_VERSION, sideEffects: false };
      }
      // Fail closed: an unknown bridge kind might be a disguised side effect.
      throw Object.assign(
        new Error('KERNEL_SIDE_EFFECT_REFUSED:unknown host_request kind'),
        { code: KERNEL_ERROR_CODES.SIDE_EFFECT_REFUSED }
      );
    }
  };

  return async (op, params) => {
    const handler = handlers[op];
    if (!handler) throw Object.assign(new Error(`KERNEL_UNKNOWN_OP:${op}`), { code: KERNEL_ERROR_CODES.UNKNOWN_OP });
    return handler(isPlainObject(params) ? params : {});
  };
};

/** The worker's in-memory session-state mirror. The host owns durability. */
export const createStateMirror = () => {
  const entries = new Map();
  let revision = 0;
  return {
    load(snapshotEntries = [], snapshotRevision = 0) {
      entries.clear();
      for (const entry of snapshotEntries) {
        if (entry && typeof entry.key === 'string') entries.set(entry.key, { value: entry.value, valueDigest: entry.valueDigest });
      }
      revision = Number.isInteger(snapshotRevision) ? snapshotRevision : 0;
    },
    has: (key) => entries.has(key),
    get: (key) => structuredClone(entries.get(key)?.value),
    list: () => [...entries.keys()].sort(),
    get revision() { return revision; },
    digest: (key) => entries.get(key)?.valueDigest,
    set(key, value, nextRevision) {
      entries.set(key, { value: structuredClone(value), valueDigest: mirrorDigest(value) });
      revision = nextRevision;
    },
    delete(key, nextRevision) {
      const existed = entries.delete(key);
      revision = nextRevision;
      return existed;
    }
  };
};

/** Start the stdio serving loop. Exported for completeness; invoked on run. */
export const runWorker = async ({ input = process.stdin, output = process.stdout } = {}) => {
  const { ReadonlyWorkspace } = await import('../plugins/workspace-readonly.mjs');

  let ready = false;
  let handle = null;
  const state = createStateMirror();
  const framer = createMessageFramer();

  const write = (message) => {
    try {
      output.write(encodeMessage(message));
    } catch {
      // A frame that cannot be serialized (e.g. oversized workspace result) is
      // reported as an op failure rather than crashing the resident kernel.
      output.write(encodeMessage(kernelFailure(message.id, KERNEL_ERROR_CODES.OP_FAILED, 'response could not be encoded')));
    }
  };

  const onMessage = async (message) => {
    if (!isPlainObject(message) || message.type !== KERNEL_MESSAGE_TYPES.REQUEST || typeof message.id !== 'string') {
      return;
    }
    if (message.op === 'init') {
      if (ready) {
        write(kernelFailure(message.id, KERNEL_ERROR_CODES.ALREADY_READY, 'kernel already initialized'));
        return;
      }
      const params = isPlainObject(message.params) ? message.params : {};
      if (params.protocolVersion !== KERNEL_PROTOCOL_VERSION) {
        write(kernelFailure(message.id, KERNEL_ERROR_CODES.INVALID_PARAMS, 'unsupported protocol version'));
        return;
      }
      const workspace = typeof params.workspaceRoot === 'string' && params.workspaceRoot
        ? new ReadonlyWorkspace(params.workspaceRoot, { excludedPaths: Array.isArray(params.excludedPaths) ? params.excludedPaths : [] })
        : null;
      const snapshot = isPlainObject(params.sessionState) ? params.sessionState : {};
      state.load(Array.isArray(snapshot.entries) ? snapshot.entries : [], snapshot.revision);
      handle = createKernelHandler({ workspace, state });
      ready = true;
      write(kernelSuccess(message.id, {
        ready: true,
        protocolVersion: KERNEL_PROTOCOL_VERSION,
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
        pid: process.pid,
        nodeVersion: process.version,
        revision: state.revision
      }));
      return;
    }
    if (message.op === 'shutdown') {
      write(kernelSuccess(message.id, { stopped: true }));
      setImmediate(() => process.exit(0));
      return;
    }
    if (!ready || !handle) {
      write(kernelFailure(message.id, KERNEL_ERROR_CODES.NOT_READY, 'kernel has not been initialized'));
      return;
    }
    try {
      const result = await handle(message.op, message.params);
      write(kernelSuccess(message.id, result));
    } catch (error) {
      const { code, message: detail } = safeErrorCode(error);
      write(kernelFailure(message.id, code, detail));
    }
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    let messages;
    try {
      messages = framer.push(chunk);
    } catch {
      return;
    }
    for (const message of messages) void onMessage(message);
  });
  input.on('end', () => process.exit(0));

  return { onMessage };
};


const isMainModule = () => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('kernel-worker.mjs');
  } catch {
    return false;
  }
};

if (isMainModule()) {
  runWorker().catch((error) => {
    try {
      process.stdout.write(encodeMessage(kernelFailure('startup', KERNEL_ERROR_CODES.OP_FAILED, String(error?.message ?? error))));
    } catch {
      // nothing else we can safely report
    }
    process.exit(1);
  });
}
