/**
 * Sandboxed cell worker entry (runs under bwrap/Landlock + --require shim).
 *
 * Startup order (F3/F11):
 *   1. --require shim already installed stage-2 (NO_NEW_PRIVS + seccomp TSYNC)
 *   2. Run canary probes against handoff absolute paths
 *   3. On full pass → emit single no-request-id `ready` (cell encoder)
 *   4. On fail → `canary_fail` then exit
 *   5. Accept `exec` frames; run in a persistent vm context; host.request reverse channel
 */
import vm from 'node:vm';
import { createWriteStream } from 'node:fs';
import { open as openFs, readFile, writeFile, access, constants as fsConstants } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import {
  CELL_PROTOCOL_VERSION, CELL_MESSAGE_TYPES, CELL_ERROR_CODES,
  encodeCellMessage, createCellFramer, isValidCellEpoch
} from './cell-protocol.mjs';

const send = (message) => {
  process.stdout.write(encodeCellMessage(message));
};

const failCanary = (reason, detail) => {
  send({ v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.CANARY_FAIL, reason, ...(detail ? { detail } : {}) });
  process.exit(1);
};

const parseHandoff = () => {
  const raw = process.env.DDA_KERNEL_SANDBOX_HANDOFF_JSON;
  if (!raw) failCanary('HANDOFF_MISSING');
  let handoff;
  try {
    handoff = JSON.parse(raw);
  } catch {
    failCanary('HANDOFF_INVALID_JSON');
  }
  if (!handoff || typeof handoff !== 'object') failCanary('HANDOFF_INVALID');
  return handoff;
};

const runCanary = async (handoff) => {
  const paths = Array.isArray(handoff.canaryPaths) ? handoff.canaryPaths : [];
  if (paths.length === 0) failCanary('CANARY_PATH_SET_EMPTY');
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith('/')) failCanary('CANARY_PATH_NOT_ABSOLUTE', p);
  }

  // (a) Denied-write / denied-read of sensitive absolute paths: open for write must fail.
  for (const p of paths) {
    try {
      const handle = await openFs(p, 'a');
      await handle.close();
      // If we can append, the path is writable — fail closed for denylist targets
      // marked as denyWrite. Non-deny paths may be readable.
      if (Array.isArray(handoff.denyWritePaths) && handoff.denyWritePaths.includes(p)) {
        failCanary('CANARY_WRITE_UNEXPECTEDLY_ALLOWED', p);
      }
    } catch {
      // expected for denied paths
    }
  }

  // Network must fail (stage-1/2 deny socket/connect).
  await new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 1 });
    const timer = setTimeout(() => {
      socket.destroy();
      failCanary('CANARY_NET_TIMEOUT');
    }, 800);
    socket.on('error', (error) => {
      clearTimeout(timer);
      if (error?.code === 'EPERM' || error?.code === 'EACCES' || error?.code === 'ECONNREFUSED') {
        // ECONNREFUSED would mean socket worked — fail. EPERM/EACCES = denied.
        if (error.code === 'ECONNREFUSED') failCanary('CANARY_NET_SOCKET_WORKED', error.code);
        resolve();
        return;
      }
      // Other errors: treat EPERM-ish as pass; unknown as fail-closed.
      if (error?.errno === -1) {
        resolve();
        return;
      }
      failCanary('CANARY_NET_UNEXPECTED', error?.code ?? String(error));
    });
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      failCanary('CANARY_NET_CONNECTED');
    });
  });

  // Exec must fail (stage-2).
  const execResult = spawnSync('/bin/true', [], { encoding: 'utf8' });
  if (!execResult.error) failCanary('CANARY_EXEC_UNEXPECTEDLY_ALLOWED');
  if (execResult.error.code !== 'EPERM' && execResult.error.code !== 'EACCES') {
    failCanary('CANARY_EXEC_UNEXPECTED_ERROR', execResult.error.code);
  }

  // Handoff FD hygiene (bwrap): optional closedFd list — close() → EBADF = pass.
  if (Array.isArray(handoff.closedFds)) {
    for (const fd of handoff.closedFds) {
      if (typeof fd !== 'number' || fd < 3) continue;
      try {
        const { closeSync } = await import('node:fs');
        closeSync(fd);
        failCanary('CANARY_FD_STILL_OPEN', String(fd));
      } catch (error) {
        if (error?.code !== 'EBADF') failCanary('CANARY_FD_UNEXPECTED', error?.code);
      }
    }
  }
};

const main = async () => {
  const handoff = parseHandoff();
  process.env.DDA_KERNEL_SANDBOX_BACKEND = handoff.backend || process.env.DDA_KERNEL_SANDBOX_BACKEND || 'bwrap';
  if (handoff.privateTmp) process.env.DDA_KERNEL_SANDBOX_PRIVATE_TMP = handoff.privateTmp;

  try {
    await runCanary(handoff);
  } catch (error) {
    failCanary('CANARY_EXCEPTION', error?.message ?? String(error));
  }

  // Single-type ready (no request-id). Host unlocks cells only on first ready.
  send({ v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.READY, backend: handoff.backend ?? 'bwrap' });

  const context = vm.createContext(Object.create(null), { name: 'dda-cell' });
  // Persistent bindings across cells (F4). host.request rebound per cell with captured epoch.
  context.console = {
    log: (...args) => {
      // stdout is the cell protocol; surface logs on stderr for host diagnostics.
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
    // End of cell: stub host.request + clear active epoch locally (host clears authoritative).
    clearHostRequest();
    activeEpoch = null;
    // Reject any still-pending host requests from this cell.
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

main().catch((error) => failCanary('WORKER_BOOT_FAILED', error?.message ?? String(error)));
