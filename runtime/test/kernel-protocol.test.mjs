import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessageFramer, decodeMessage, encodeMessage,
  isBridgeReadKind, isBridgeSideEffectKind, isKernelOp, isReadOnlyKernelOp,
  isReplaySafeKernelOp, isSessionWriteKernelOp, isBridgeKernelOp,
  KERNEL_ERROR_CODES, KERNEL_MAX_MESSAGE_BYTES, KERNEL_OPS, KERNEL_PROTOCOL_VERSION,
  KernelProtocolError, kernelFailure, kernelRequest, kernelSuccess
} from '../src/kernel/protocol.mjs';

test('classifies the Phase-1 operation surface', () => {
  assert.equal(KERNEL_PROTOCOL_VERSION, '1.0');
  for (const op of KERNEL_OPS) assert.equal(isKernelOp(op), true);
  assert.equal(isKernelOp('shell.execute'), false);

  assert.equal(isReadOnlyKernelOp('workspace.read'), true);
  assert.equal(isReadOnlyKernelOp('session_state.get'), true);
  assert.equal(isSessionWriteKernelOp('session_state.set'), true);
  assert.equal(isSessionWriteKernelOp('session_state.delete'), true);
  assert.equal(isBridgeKernelOp('host_request'), true);

  // Read ops and already-durable session writes may be replayed after a
  // crash; the host_request bridge never may.
  assert.equal(isReplaySafeKernelOp('workspace.list'), true);
  assert.equal(isReplaySafeKernelOp('session_state.set'), true);
  assert.equal(isReplaySafeKernelOp('host_request'), false);
});

test('refuses side-effect host_request kinds and recognizes inert probes', () => {
  for (const kind of ['write_file', 'patch_file', 'shell', 'test', 'network', 'file.write', 'network.request']) {
    assert.equal(isBridgeSideEffectKind(kind), true, kind);
    assert.equal(isBridgeReadKind(kind), false, kind);
  }
  assert.equal(isBridgeReadKind('host.ping'), true);
  assert.equal(isBridgeReadKind('host.capabilities'), true);
  assert.equal(isBridgeSideEffectKind('host.ping'), false);
});

test('encodes and decodes one newline-delimited frame', () => {
  const frame = encodeMessage(kernelRequest('req-1', 'workspace.read', { path: 'a.md' }));
  assert.equal(frame.endsWith('\n'), true);
  assert.equal(frame.includes('\n'), true);
  assert.equal(frame.indexOf('\n'), frame.length - 1);
  const decoded = decodeMessage(frame.trimEnd());
  assert.deepEqual(decoded, { type: 'request', id: 'req-1', op: 'workspace.read', params: { path: 'a.md' } });
});

test('builds success and failure responses', () => {
  assert.deepEqual(kernelSuccess('r', { ok: 1 }), { type: 'response', id: 'r', ok: true, result: { ok: 1 } });
  assert.deepEqual(
    kernelFailure('r', KERNEL_ERROR_CODES.UNKNOWN_OP, 'nope', { op: 'x' }),
    { type: 'response', id: 'r', ok: false, error: { code: 'KERNEL_UNKNOWN_OP', message: 'nope', details: { op: 'x' } } }
  );
});

test('rejects unserializable and oversized frames', () => {
  assert.throws(() => encodeMessage('not an object'), KernelProtocolError);
  const huge = { id: 'x', type: 'request', op: 'workspace.read', params: { blob: 'a'.repeat(KERNEL_MAX_MESSAGE_BYTES) } };
  assert.throws(() => encodeMessage(huge), (error) => error.code === KERNEL_ERROR_CODES.MESSAGE_TOO_LARGE);
  assert.throws(() => decodeMessage('{ not json'), (error) => error.code === KERNEL_ERROR_CODES.INVALID_MESSAGE);
});

test('framer splits multiple frames and buffers partial input', () => {
  const framer = createMessageFramer();
  const first = encodeMessage(kernelRequest('a', 'session_state.list', {}));
  const second = encodeMessage(kernelRequest('b', 'workspace.list', { path: '' }));
  const combined = first + second;
  const half = combined.slice(0, first.length + 5);
  const rest = combined.slice(first.length + 5);

  const batch1 = framer.push(half);
  assert.equal(batch1.length, 1);
  assert.equal(batch1[0].id, 'a');
  assert.ok(framer.pending > 0);

  const batch2 = framer.push(rest);
  assert.equal(batch2.length, 1);
  assert.equal(batch2[0].id, 'b');
  assert.equal(framer.pending, 0);
});

test('framer rejects an unterminated oversized line', () => {
  const framer = createMessageFramer();
  assert.throws(() => framer.push('a'.repeat(KERNEL_MAX_MESSAGE_BYTES + 1)),
    (error) => error.code === KERNEL_ERROR_CODES.MESSAGE_TOO_LARGE);
});
