/**
 * Wire protocol for the Phase-1 resident kernel.
 *
 * The resident kernel is a per-session Node (>=24) subprocess that the model
 * talks to as its primary tool surface. Host and kernel exchange
 * newline-delimited JSON messages over the worker's stdin/stdout. This module
 * is intentionally dependency-free so both the host supervisor and the worker
 * subprocess can share one definition of the frame format, the operation set
 * and the error vocabulary.
 *
 * Phase-1 scope is read-only: workspace inspection, durable session-state
 * read/write (session state is host-owned metadata, not a workspace side
 * effect) and a host_request bridge stub. Every write/shell/network/test side
 * effect is deferred to Phase-2 and MUST be refused here, so the classification
 * tables below are the single source of truth for what the kernel may do.
 */

export const KERNEL_PROTOCOL_VERSION = '1.0';

// Hard ceiling on a single framed message. A resident kernel handles untrusted
// model output for a whole session, so an unbounded line must never be able to
// exhaust host or worker memory.
export const KERNEL_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export const KERNEL_MESSAGE_TYPES = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response'
});

/**
 * Read-only operations the kernel executes directly. These are deterministic
 * and side-effect free, so the host may transparently rebuild a crashed kernel
 * and retry them without ever replaying a side effect.
 */
export const KERNEL_READ_OPS = Object.freeze([
  'workspace.list',
  'workspace.read',
  'workspace.focus',
  'session_state.get',
  'session_state.list'
]);

/**
 * Session-state writes. These mutate host-owned durable session metadata, not
 * the workspace or the outside world, so they remain in Phase-1 scope. The host
 * persists the durable record before dispatching to the kernel, which keeps the
 * operation idempotent and therefore safe to re-apply after a crash rebuild.
 */
export const KERNEL_SESSION_WRITE_OPS = Object.freeze([
  'session_state.set',
  'session_state.delete'
]);

/**
 * The host_request bridge. In Phase-1 this only answers inert metadata probes
 * and MUST refuse anything that would cause a side effect. It is never
 * replay-safe: a crash mid-request leaves the outcome uncertain, so the host
 * must fail rather than silently re-issue it.
 */
export const KERNEL_BRIDGE_OPS = Object.freeze(['host_request']);

export const KERNEL_OPS = Object.freeze([
  ...KERNEL_READ_OPS,
  ...KERNEL_SESSION_WRITE_OPS,
  ...KERNEL_BRIDGE_OPS
]);

// host_request kinds. Phase-1 allows only inert introspection; every
// side-effecting kind is listed so the refusal is explicit and auditable
// rather than a catch-all default.
export const KERNEL_BRIDGE_READ_KINDS = Object.freeze(['host.ping', 'host.capabilities']);
export const KERNEL_BRIDGE_SIDE_EFFECT_KINDS = Object.freeze([
  'write_file',
  'patch_file',
  'shell',
  'test',
  'network',
  'file.write',
  'file.patch',
  'shell.execute',
  'test.execute',
  'network.request'
]);

export const KERNEL_ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'KERNEL_INVALID_MESSAGE',
  MESSAGE_TOO_LARGE: 'KERNEL_MESSAGE_TOO_LARGE',
  UNKNOWN_OP: 'KERNEL_UNKNOWN_OP',
  INVALID_PARAMS: 'KERNEL_INVALID_PARAMS',
  OP_FAILED: 'KERNEL_OP_FAILED',
  NOT_READY: 'KERNEL_NOT_READY',
  ALREADY_READY: 'KERNEL_ALREADY_READY',
  SIDE_EFFECT_REFUSED: 'KERNEL_SIDE_EFFECT_REFUSED',
  SESSION_STATE_INVALID: 'KERNEL_SESSION_STATE_INVALID',
  WORKER_CRASHED: 'KERNEL_WORKER_CRASHED',
  OUTCOME_UNCERTAIN: 'KERNEL_OUTCOME_UNCERTAIN',
  TIMEOUT: 'KERNEL_TIMEOUT',
  UNSUPPORTED: 'KERNEL_UNSUPPORTED',
  DISABLED: 'KERNEL_DISABLED'
});

const READ_OP_SET = new Set(KERNEL_READ_OPS);
const SESSION_WRITE_OP_SET = new Set(KERNEL_SESSION_WRITE_OPS);
const BRIDGE_OP_SET = new Set(KERNEL_BRIDGE_OPS);
const OP_SET = new Set(KERNEL_OPS);
const SIDE_EFFECT_KIND_SET = new Set(KERNEL_BRIDGE_SIDE_EFFECT_KINDS);
const READ_KIND_SET = new Set(KERNEL_BRIDGE_READ_KINDS);

export const isKernelOp = (op) => typeof op === 'string' && OP_SET.has(op);
export const isReadOnlyKernelOp = (op) => READ_OP_SET.has(op);
export const isSessionWriteKernelOp = (op) => SESSION_WRITE_OP_SET.has(op);
export const isBridgeKernelOp = (op) => BRIDGE_OP_SET.has(op);

/**
 * Whether an in-flight operation may be transparently replayed after the host
 * rebuilds a crashed kernel. Read ops are pure; session writes are persisted
 * durably before dispatch and are idempotent. The host_request bridge is never
 * replay-safe because a future side effect could have already happened.
 */
export const isReplaySafeKernelOp = (op) => READ_OP_SET.has(op) || SESSION_WRITE_OP_SET.has(op);

export const isBridgeSideEffectKind = (kind) => SIDE_EFFECT_KIND_SET.has(kind);
export const isBridgeReadKind = (kind) => READ_KIND_SET.has(kind);

export class KernelProtocolError extends Error {
  constructor(code, message = '', details = undefined) {
    super(message ? `${code}:${message}` : code);
    this.name = 'KernelProtocolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Serialize one message to a single newline-terminated JSON frame. */
export const encodeMessage = (message) => {
  if (!isPlainObject(message)) throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'message must be an object');
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'message is not serializable');
  }
  if (serialized === undefined || serialized.includes('\n')) {
    throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'message is not serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > KERNEL_MAX_MESSAGE_BYTES) {
    throw new KernelProtocolError(KERNEL_ERROR_CODES.MESSAGE_TOO_LARGE, 'message exceeds frame limit');
  }
  return `${serialized}\n`;
};

/** Parse one JSON frame (without the trailing newline) into a message object. */
export const decodeMessage = (line) => {
  if (typeof line !== 'string') throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'frame must be a string');
  if (Buffer.byteLength(line, 'utf8') > KERNEL_MAX_MESSAGE_BYTES) {
    throw new KernelProtocolError(KERNEL_ERROR_CODES.MESSAGE_TOO_LARGE, 'frame exceeds limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'frame is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new KernelProtocolError(KERNEL_ERROR_CODES.INVALID_MESSAGE, 'frame must be an object');
  return parsed;
};

/**
 * Incremental newline-delimited JSON reader. Feed raw stdout/stdin chunks and
 * receive decoded messages. Rejects any single frame larger than the limit so a
 * peer cannot grow the buffer without bound.
 */
export const createMessageFramer = () => {
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > KERNEL_MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
        buffer = '';
        throw new KernelProtocolError(KERNEL_ERROR_CODES.MESSAGE_TOO_LARGE, 'frame exceeds limit');
      }
      const messages = [];
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === '') continue;
        messages.push(decodeMessage(line));
      }
      return messages;
    },
    get pending() {
      return buffer.length;
    }
  };
};

export const kernelRequest = (id, op, params = {}) => ({
  type: KERNEL_MESSAGE_TYPES.REQUEST,
  id,
  op,
  params
});

export const kernelSuccess = (id, result) => ({
  type: KERNEL_MESSAGE_TYPES.RESPONSE,
  id,
  ok: true,
  result
});

export const kernelFailure = (id, code, message = '', details = undefined) => ({
  type: KERNEL_MESSAGE_TYPES.RESPONSE,
  id,
  ok: false,
  error: {
    code,
    ...(message ? { message } : {}),
    ...(details === undefined ? {} : { details })
  }
});
