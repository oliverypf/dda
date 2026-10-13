/**
 * Unsandboxed Windows cell worker entry (Phase-2b follow-on, Prime-aligned).
 *
 * Selected only by the win32 spawn path in cell-host.mjs. Do NOT share a
 * skip-canary env flag with the Linux cell-worker.mjs.
 *
 * Startup: emit protocol `ready` only — no FS deny-write / net / exec canary
 * (those depend on an OS sandbox that Windows does not provide here).
 *
 * NOT a security sandbox: code runs with the host user permissions. Node vm
 * is also not a security boundary.
 */
import vm from 'node:vm';
import {
  CELL_PROTOCOL_VERSION, CELL_MESSAGE_TYPES, CELL_ERROR_CODES,
  encodeCellMessage, createCellFramer, isValidCellEpoch
} from './cell-protocol.mjs';

const send = (message) => {
  process.stdout.write(encodeCellMessage(message));
};

const main = async () => {
  send({
    v: CELL_PROTOCOL_VERSION,
    type: CELL_MESSAGE_TYPES.READY,
    backend: 'unsandboxed',
    warning: 'WINDOWS_NO_OS_SANDBOX'
  });

  const context = vm.createContext(Object.create(null), { name: 'dda-cell-windows' });
  context.console = {
    log: (...args) => {
      process.stderr.write(args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ') + '\n');
    }
  };

  let activeEpoch = null;
  let hostRequestOrdinal = 0;
  const pendingHost = new Map();
  const framer = createCellFramer();

  const bindHostRequest = (epoch, cellId) => {
    hostRequestOrdinal = 0;
    const capturedEpoch = epoch;
    const hostRequest = (kind, payload) => {
      if (!isValidCellEpoch(capturedEpoch)) {
        return Promise.reject(Object.assign(new Error(CELL_ERROR_CODES.EPOCH_REFUSED), { code: CELL_ERROR_CODES.EPOCH_REFUSED }));
      }
      const requestId = `hr-${++hostRequestOrdinal}`;
      return new Promise((resolve, reject) => {
        pendingHost.set(requestId, { resolve, reject });
        send({
          v: CELL_PROTOCOL_VERSION,
          type: CELL_MESSAGE_TYPES.HOST_REQUEST,
          requestId,
          cellId,
          epoch: capturedEpoch,
          kind,
          payload: payload ?? null
        });
      });
    };
    Object.defineProperty(context, 'host', {
      value: Object.freeze({ request: hostRequest }),
      writable: true,
      configurable: true,
      enumerable: true
    });
  };

  const clearHostRequest = () => {
    Object.defineProperty(context, 'host', {
      value: Object.freeze({
        request: () => Promise.reject(Object.assign(new Error(CELL_ERROR_CODES.EPOCH_REFUSED), { code: CELL_ERROR_CODES.EPOCH_REFUSED }))
      }),
      writable: true,
      configurable: true,
      enumerable: true
    });
  };

  const runExec = async (message) => {
    const { cellId, epoch, code, execId } = message;
    if (!isValidCellEpoch(epoch)) {
      send({ v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.EXEC_RESULT, execId, cellId, ok: false, errorCode: CELL_ERROR_CODES.EPOCH_REFUSED });
      return;
    }
    activeEpoch = epoch;
    bindHostRequest(epoch, cellId);
    let result;
    let ok = true;
    let errorCode;
    let errorMessage;
    try {
      result = await vm.runInContext(
        `(async () => { ${code}\n })()`,
        context,
        { timeout: 30_000, displayErrors: true, filename: `dda-cell:${cellId}` }
      );
    } catch (error) {
      ok = false;
      errorCode = error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? CELL_ERROR_CODES.TIMEOUT : (error?.code ?? 'CELL_EXEC_ERROR');
      errorMessage = error?.message ?? String(error);
    }
    clearHostRequest();
    activeEpoch = null;
    for (const [id, waiter] of pendingHost) {
      waiter.reject(Object.assign(new Error(CELL_ERROR_CODES.EPOCH_REFUSED), { code: CELL_ERROR_CODES.EPOCH_REFUSED }));
      pendingHost.delete(id);
    }
    send({
      v: CELL_PROTOCOL_VERSION,
      type: CELL_MESSAGE_TYPES.EXEC_RESULT,
      execId,
      cellId,
      epoch,
      ok,
      ...(ok ? { result: result === undefined ? null : result } : { errorCode, errorMessage })
    });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    let messages;
    try {
      messages = framer.push(chunk);
    } catch (error) {
      send({ v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.ERROR, errorCode: error?.code ?? CELL_ERROR_CODES.INVALID_MESSAGE });
      return;
    }
    for (const message of messages) {
      if (message.type === CELL_MESSAGE_TYPES.EXEC) {
        runExec(message).catch((error) => {
          send({ v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.EXEC_RESULT, execId: message.execId, cellId: message.cellId, ok: false, errorCode: error?.code ?? 'CELL_EXEC_ERROR', errorMessage: error?.message });
        });
      } else if (message.type === CELL_MESSAGE_TYPES.HOST_RESPONSE) {
        const waiter = pendingHost.get(message.requestId);
        if (!waiter) continue;
        pendingHost.delete(message.requestId);
        if (message.ok === false) {
          waiter.reject(Object.assign(new Error(message.errorCode ?? 'HOST_REQUEST_FAILED'), { code: message.errorCode, details: message.error }));
        } else {
          waiter.resolve(message.result);
        }
      }
    }
  });
};

main().catch((error) => {
  process.stderr.write(`windows cell worker boot failed: ${error?.message ?? String(error)}\n`);
  process.exit(1);
});
