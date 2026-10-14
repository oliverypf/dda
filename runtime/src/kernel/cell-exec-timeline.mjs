import { sanitizeOutput } from '../runtime-safety-monitor.mjs';
import { KERNEL_READ_OPS, KERNEL_BRIDGE_READ_KINDS } from './protocol.mjs';
import { UNCERTAIN_ERROR_CODES } from './effects.mjs';

/** UI push coalescing. Tail ring is dedicated; boundOutput is not used. */
export const CELL_OP_PUSH_INTERVAL_MS = 100;
export const CELL_OP_PUSH_BYTES = 16 * 1024;
export const CELL_OP_TAIL_BYTES = 64 * 1024;

const READ_KIND_SET = new Set([...KERNEL_READ_OPS, ...KERNEL_BRIDGE_READ_KINDS]);
const REFUSED_CODES = new Set([
  'KERNEL_EFFECTS_UNAVAILABLE',
  'KERNEL_SIDE_EFFECT_REFUSED',
  'HOST_REQUEST_REFUSED'
]);
const LOCKED_STATES = new Set(['CANCELLED', 'DECLINED', 'EXPIRED']);

export const classifyCellHostKind = (kind, handles) => {
  if (READ_KIND_SET.has(kind)) return 'read';
  if (typeof handles === 'function' && handles(kind) === true) return 'effect';
  return 'refused';
};

/** kind + approval.requested caps. Never file content or patch bodies. */
export const cellOpTitle = (kind, payload) => {
  const parts = [String(kind ?? '')];
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (typeof payload.path === 'string') parts.push(payload.path.slice(0, 512));
    if (typeof payload.cwd === 'string') parts.push(payload.cwd.slice(0, 512));
    if (kind === 'test.run' && typeof payload.command === 'string') parts.push(payload.command.slice(0, 4096));
  }
  return sanitizeOutput(parts.filter(Boolean).join(' '));
};

/** Keep the last maxBytes on a Unicode scalar boundary (no split surrogates). */
export const takeTailScalars = (text, maxBytes = CELL_OP_TAIL_BYTES) => {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    let prev = start - 1;
    const unit = value.charCodeAt(prev);
    if (unit >= 0xDC00 && unit <= 0xDFFF && prev > 0) {
      const lead = value.charCodeAt(prev - 1);
      if (lead >= 0xD800 && lead <= 0xDBFF) prev -= 1;
    }
    const pieceBytes = Buffer.byteLength(value.slice(prev, start), 'utf8');
    if (bytes + pieceBytes > maxBytes) break;
    bytes += pieceBytes;
    start = prev;
  }
  return value.slice(start);
};

const errorCodeOf = (error) => (typeof error?.code === 'string' ? error.code
  : String(error?.message ?? '').split(':', 1)[0]);

/**
 * Display-only row projector for a Windows desktop cell. Callers on
 * windows-cli and Linux do not construct it, so they emit no row events.
 */
export const createCellExecTimeline = ({
  emit = () => {},
  sinks = null,
  badge = () => ({}),
  journalPath,
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  clearSchedule = (timer) => clearTimeout(timer)
} = {}) => {
  const rows = new Map();
  const dropped = [];
  let pendingBytes = 0;
  let pushTimer = null;
  let dirty = false;

  const keyOf = (epoch, toolCallId) => `${epoch}\n${toolCallId}`;

  const publicRow = (row) => ({
    epoch: row.epoch,
    toolCallId: row.toolCallId,
    requestId: row.requestId,
    cellId: row.cellId,
    cellOpIndex: row.cellOpIndex,
    classification: row.classification,
    kind: row.kind,
    title: row.title,
    state: row.state,
    ...(row.errorCode ? { errorCode: row.errorCode } : {}),
    ...(row.approvalRequestId ? { approvalRequestId: row.approvalRequestId } : {}),
    approvalWaiting: row.approvalWaiting === true,
    approvalWaitMs: row.approvalWaitMs,
    ...(row.approvalStartedAt ? { approvalStartedAt: row.approvalStartedAt } : {}),
    startedAtMs: row.startedAtMs,
    ...(row.durationMs !== undefined ? { durationMs: row.durationMs } : {}),
    output: row.output,
    outputBytes: row.outputBytes,
    truncated: row.truncated === true,
    ...(row.state === 'UNKNOWN' && journalPath ? { journalPath } : {})
  });

  const emitRow = (row) => {
    const fields = typeof badge === 'function' ? badge() : {};
    emit({
      toolName: 'kernel.exec',
      itemId: `cell-${row.cellId}`,
      row: publicRow(row),
      ...(fields && typeof fields === 'object' ? fields : {})
    });
  };

  const flush = () => {
    if (pushTimer) {
      clearSchedule(pushTimer);
      pushTimer = null;
    }
    pendingBytes = 0;
    if (!dirty) return;
    dirty = false;
    for (const row of rows.values()) {
      if (row.dirty) {
        row.dirty = false;
        emitRow(row);
      }
    }
  };

  const touch = (row, { immediate = false, bytes = 0, coalesce = false } = {}) => {
    row.dirty = true;
    dirty = true;
    // Terminal rows normally flush immediately. Late op_progress opts into
    // the same 100ms / 16KB coalescing used while the row is RUNNING.
    if (!coalesce && (immediate || row.state !== 'RUNNING')) {
      flush();
      return;
    }
    pendingBytes += bytes;
    if (pendingBytes >= CELL_OP_PUSH_BYTES) {
      flush();
      return;
    }
    if (!pushTimer) {
      pushTimer = schedule(() => {
        pushTimer = null;
        flush();
      }, CELL_OP_PUSH_INTERVAL_MS);
      pushTimer?.unref?.();
    }
  };

  const closeWait = (row, at = now()) => {
    if (row.approvalWaiting !== true) return;
    const started = row.approvalStartedAt ?? at;
    row.approvalWaitMs += Math.max(0, at - started);
    row.approvalWaiting = false;
    row.approvalStartedAt = undefined;
  };

  const finish = (row, state, extra = {}) => {
    if (row.state !== 'RUNNING') return false;
    if (LOCKED_STATES.has(row.state)) return false;
    closeWait(row);
    const end = now();
    row.state = state;
    if (extra.errorCode) row.errorCode = extra.errorCode;
    row.durationMs = Math.max(0, end - row.startedAtMs - row.approvalWaitMs);
    touch(row, { immediate: true });
    if (sinks && row.toolCallId) sinks.delete(row.toolCallId);
    return true;
  };

  const sinkFor = (row) => ({
    markTerminal(state) {
      closeWait(row);
      finish(row, state);
    },
    onApprovalRequested(approvalRequestId) {
      if (typeof approvalRequestId === 'string' && approvalRequestId) row.approvalRequestId = approvalRequestId;
      if (row.state !== 'RUNNING') return;
      row.approvalWaiting = true;
      row.approvalStartedAt = now();
      touch(row, { immediate: true });
    },
    onApprovalSettled(state) {
      closeWait(row);
      if (state === 'DECLINED' || state === 'EXPIRED' || state === 'CANCELLED') finish(row, state);
      else if (row.state === 'RUNNING') touch(row, { immediate: true });
    }
  });

  return {
    dropped,
    flush,
    rows: () => [...rows.values()].map(publicRow),
    drop(reason) {
      dropped.push(reason);
    },
    begin({ epoch, cellId, requestId, toolCallId, cellOpIndex, kind, classification, title }) {
      const row = {
        epoch,
        cellId,
        requestId,
        toolCallId,
        cellOpIndex,
        kind,
        classification,
        title,
        state: 'RUNNING',
        entered: false,
        output: '',
        outputBytes: 0,
        truncated: false,
        approvalWaitMs: 0,
        approvalWaiting: false,
        seq: 0,
        acceptDeltas: true,
        startedAtMs: now(),
        dirty: true
      };
      rows.set(keyOf(epoch, toolCallId), row);
      if (sinks && toolCallId) sinks.set(toolCallId, sinkFor(row));
      touch(row, { immediate: true });
      return row;
    },
    markEntered(epoch, toolCallId) {
      const row = rows.get(keyOf(epoch, toolCallId));
      if (row) row.entered = true;
    },
    find(epoch, toolCallId) {
      return rows.get(keyOf(epoch, toolCallId));
    },
    findByRequest(epoch, requestId) {
      for (const row of rows.values()) {
        if (row.epoch === epoch && row.requestId === requestId) return row;
      }
      return undefined;
    },
    appendChunk(row, chunk) {
      // Fast host_response finishes the row before late op_progress arrives.
      // Keep those chunks in the 64KB tail and do not change a terminal state.
      // A burst after the row is terminal must share the coalesced UI flush
      // instead of emitting once per chunk.
      if (!row || row.acceptDeltas !== true) return;
      const sanitized = sanitizeOutput(chunk);
      const produced = Buffer.byteLength(sanitized, 'utf8');
      row.outputBytes += produced;
      const combined = row.output + sanitized;
      const next = takeTailScalars(combined, CELL_OP_TAIL_BYTES);
      if (next.length !== combined.length || Buffer.byteLength(combined, 'utf8') > CELL_OP_TAIL_BYTES) row.truncated = true;
      row.output = next;
      touch(row, { bytes: produced, coalesce: row.state !== 'RUNNING' });
    },
    noteSeq(row, seq) {
      if (!row || row.acceptDeltas !== true) return 'drop';
      if (!Number.isInteger(seq) || seq < 1) return 'malformed';
      if (seq === row.seq) return 'duplicate';
      if (seq !== row.seq + 1) {
        row.truncated = true;
        row.acceptDeltas = false;
        touch(row, { immediate: true });
        return 'gap';
      }
      row.seq = seq;
      return 'ok';
    },
    endFromResult(epoch, toolCallId, { classification, envelopeOk, error, result } = {}) {
      const row = rows.get(keyOf(epoch, toolCallId));
      if (!row || row.state !== 'RUNNING') return row;
      if (error) {
        const code = errorCodeOf(error);
        if (REFUSED_CODES.has(code)) finish(row, 'REFUSED', { errorCode: code });
        else if (UNCERTAIN_ERROR_CODES.has(code)) finish(row, 'UNKNOWN', { errorCode: code });
        else finish(row, 'FAILED', { errorCode: code });
        return row;
      }
      if ((classification ?? row.classification) === 'read') {
        if (envelopeOk === true) finish(row, 'COMPLETED');
        else {
          const errorCode = typeof result?.error?.code === 'string' ? result.error.code : undefined;
          finish(row, 'FAILED', { errorCode });
        }
        return row;
      }
      if (result?.outcome === 'UNKNOWN' || UNCERTAIN_ERROR_CODES.has(result?.failed?.errorCode)) {
        finish(row, 'UNKNOWN', { errorCode: result?.failed?.errorCode });
        return row;
      }
      if (result?.ok === false) finish(row, 'FAILED', { errorCode: result?.failed?.errorCode ?? result?.errorCode });
      else finish(row, 'COMPLETED');
      return row;
    },
    cancelUnentered(cellId) {
      for (const row of rows.values()) {
        if (row.cellId === cellId && row.entered !== true && row.state === 'RUNNING') finish(row, 'CANCELLED');
      }
    }
  };
};

/** Per-message isolation so one bad frame cannot escape the stdout listener. */
export const dispatchCellMessages = (messages, handle, onError = () => {}) => {
  for (const message of messages) {
    try {
      handle(message);
    } catch (error) {
      onError(error, message);
    }
  }
};
