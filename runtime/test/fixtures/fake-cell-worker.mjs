import {
  CELL_PROTOCOL_VERSION, encodeCellMessage, createCellFramer
} from '../../src/kernel/cell-protocol.mjs';

const send = (message) => {
  process.stdout.write(encodeCellMessage({ v: CELL_PROTOCOL_VERSION, ...message }));
};

send({
  type: 'ready',
  backend: 'unsandboxed',
  sandbox: 'none',
  warning: 'WINDOWS_NO_OS_SANDBOX'
});

const mode = process.env.DDA_FAKE_CELL_MODE ?? 'read';
const framer = createCellFramer();
const pending = new Map();

const replyWhen = (requestId) => new Promise((resolve) => {
  pending.set(requestId, resolve);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  let messages = [];
  try {
    messages = framer.push(chunk);
  } catch {
    return;
  }
  for (const message of messages) {
    if (message.type === 'host_response') {
      pending.get(message.requestId)?.(message);
      pending.delete(message.requestId);
      continue;
    }
    if (message.type !== 'exec') continue;
    const cellId = message.cellId;
    const epoch = message.epoch;
    const execId = message.execId;
    const finish = (ok = true) => {
      send({ type: 'exec_result', execId, cellId, epoch, ok, ...(ok ? { result: null } : { errorCode: 'CELL_EXEC_ERROR' }) });
    };
    if (mode === 'stale') {
      send({
        type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch: 'ab'.repeat(16),
        kind: 'workspace.list', payload: {}
      });
      finish();
      continue;
    }
    if (mode === 'malformed-progress') {
      send({ type: 'op_progress', epoch, seq: 'nope', chunk: 'x' });
      send({
        type: 'op_progress', epoch, requestId: 'hr-1', seq: 1, chunk: 'kept'
      });
      setTimeout(() => {
        send({
          type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch,
          kind: 'workspace.list', payload: { path: 'src' }
        });
      }, 20);
      replyWhen('hr-1').then(() => finish());
      continue;
    }
    if (mode === 'bad-version') {
      process.stdout.write('{"v":"cell-9.9","type":"op_progress"}\n');
      setTimeout(() => {
        send({
          type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch,
          kind: 'host.ping', payload: null
        });
      }, 30);
      replyWhen('hr-1').then(() => finish());
      continue;
    }
    if (mode === 'mid-dispatch') {
      send({
        type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch,
        kind: 'workspace.read', payload: { path: 'a.txt' }
      });
      finish();
      continue;
    }
    if (mode === 'classify') {
      const kinds = ['workspace.list', 'session_state.set', 'fs.write', 'shell.exec'];
      (async () => {
        for (let index = 0; index < kinds.length; index += 1) {
          const requestId = `hr-${index + 1}`;
          send({
            type: 'host_request', requestId, cellOpIndex: index + 1, cellId, epoch,
            kind: kinds[index], payload: kinds[index] === 'fs.write'
              ? { path: 'notes.txt', content: 'secret body' }
              : kinds[index] === 'shell.exec' ? { command: 'rm -rf /' } : { path: 'notes.txt' }
          });
          await replyWhen(requestId);
        }
        finish();
      })().catch(() => finish(false));
      continue;
    }
    if (mode === 'reset') {
      finish();
      setTimeout(() => process.exit(0), 10);
      continue;
    }
    if (mode === 'progress-gap') {
      send({
        type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch,
        kind: 'workspace.list', payload: {}
      });
      send({ type: 'op_progress', epoch, requestId: 'hr-1', seq: 1, chunk: 'one' });
      send({ type: 'op_progress', epoch, requestId: 'hr-1', seq: 1, chunk: 'dup' });
      send({ type: 'op_progress', epoch, requestId: 'hr-1', seq: 3, chunk: 'gap' });
      send({ type: 'op_progress', epoch, requestId: 'hr-1', seq: 4, chunk: 'after' });
      replyWhen('hr-1').then(() => finish());
      continue;
    }
    send({
      type: 'host_request', requestId: 'hr-1', cellOpIndex: 1, cellId, epoch,
      kind: 'host.capabilities', payload: null
    });
    replyWhen('hr-1').then(() => finish());
  }
});
