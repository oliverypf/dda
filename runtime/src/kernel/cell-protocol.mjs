import { randomBytes } from 'node:crypto';
import { KERNEL_MAX_MESSAGE_BYTES } from './protocol.mjs';

/**
 * Independent cell wire protocol (F11). Shares KERNEL_MAX_MESSAGE_BYTES UTF-8
 * ceiling but MUST NOT reuse Phase-1 request/response vocabulary or
 * KERNEL_PROTOCOL_VERSION.
 */

export const CELL_PROTOCOL_VERSION = 'cell-1.0';

export const CELL_MESSAGE_TYPES = Object.freeze({
  READY: 'ready',
  CANARY_FAIL: 'canary_fail',
  EXEC: 'exec',
  EXEC_RESULT: 'exec_result',
  HOST_REQUEST: 'host_request',
  HOST_RESPONSE: 'host_response',
  OP_PROGRESS: 'op_progress',
  ERROR: 'error'
});

export const CELL_ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'CELL_INVALID_MESSAGE',
  MESSAGE_TOO_LARGE: 'CELL_MESSAGE_TOO_LARGE',
  EPOCH_REFUSED: 'HOST_REQUEST_REFUSED',
  TIMEOUT: 'CELL_TIMEOUT',
  SANDBOX_UNAVAILABLE: 'SANDBOX_UNAVAILABLE',
  REFUSED: 'CELL_REFUSED'
});

/** 16-byte CSPRNG → 32-char lowercase hex (F4/F7/23rd). */
export const mintCellEpoch = () => randomBytes(16).toString('hex');

export const isValidCellEpoch = (epoch) => typeof epoch === 'string' && /^[0-9a-f]{32}$/.test(epoch);

class CellProtocolError extends Error {
  constructor(code, message = '') {
    super(message ? `${code}:${message}` : code);
    this.name = 'CellProtocolError';
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const encodeCellMessage = (message) => {
  if (!isPlainObject(message)) throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'message must be an object');
  if (message.v !== CELL_PROTOCOL_VERSION) throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'cell protocol version');
  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'not serializable');
  }
  if (serialized === undefined || serialized.includes('\n')) {
    throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'not serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > KERNEL_MAX_MESSAGE_BYTES) {
    throw new CellProtocolError(CELL_ERROR_CODES.MESSAGE_TOO_LARGE, 'exceeds frame limit');
  }
  return `${serialized}\n`;
};

export const decodeCellMessage = (line) => {
  if (typeof line !== 'string') throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'frame must be a string');
  if (Buffer.byteLength(line, 'utf8') > KERNEL_MAX_MESSAGE_BYTES) {
    throw new CellProtocolError(CELL_ERROR_CODES.MESSAGE_TOO_LARGE, 'exceeds limit');
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'not JSON');
  }
  if (!isPlainObject(parsed) || parsed.v !== CELL_PROTOCOL_VERSION) {
    throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'not a cell frame');
  }
  return parsed;
};

export const createCellFramer = () => {
  let buffer = '';
  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > KERNEL_MAX_MESSAGE_BYTES && !buffer.includes('\n')) {
        buffer = '';
        throw new CellProtocolError(CELL_ERROR_CODES.MESSAGE_TOO_LARGE, 'frame exceeds limit');
      }
      const messages = [];
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === '') continue;
        messages.push(decodeCellMessage(line));
      }
      return messages;
    },
    get pending() {
      return buffer.length;
    }
  };
};

/** Hard admission: build a real exec frame and measure UTF-8 bytes (no hand OVERHEAD). */
export const admitExecFrame = ({ cellId, epoch, code }) => {
  if (!isValidCellEpoch(epoch)) throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'epoch');
  if (typeof code !== 'string') throw new CellProtocolError(CELL_ERROR_CODES.INVALID_MESSAGE, 'code');
  const message = {
    v: CELL_PROTOCOL_VERSION,
    type: CELL_MESSAGE_TYPES.EXEC,
    cellId,
    epoch,
    code
  };
  const frame = encodeCellMessage(message);
  return { message, frame, bytes: Buffer.byteLength(frame, 'utf8') };
};

export { CellProtocolError };
