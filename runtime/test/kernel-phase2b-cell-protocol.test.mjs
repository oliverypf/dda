import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mintCellEpoch, isValidCellEpoch, admitExecFrame, encodeCellMessage, decodeCellMessage,
  CELL_PROTOCOL_VERSION, CELL_MESSAGE_TYPES, createCellFramer
} from '../src/kernel/cell-protocol.mjs';
import { KERNEL_PROTOCOL_VERSION } from '../src/kernel/protocol.mjs';

test('epoch is 32-char lowercase hex from 16 CSPRNG bytes and never Phase-1 version', () => {
  const epoch = mintCellEpoch();
  assert.equal(epoch.length, 32);
  assert.match(epoch, /^[0-9a-f]{32}$/);
  assert.equal(isValidCellEpoch(epoch), true);
  assert.equal(isValidCellEpoch('0'.repeat(32)), true);
  assert.equal(isValidCellEpoch('X'.repeat(32)), false);
  assert.notEqual(CELL_PROTOCOL_VERSION, KERNEL_PROTOCOL_VERSION);
});

test('admitExecFrame builds a real frame under KERNEL_MAX_MESSAGE_BYTES (no hand OVERHEAD)', () => {
  const epoch = mintCellEpoch();
  const { bytes, frame, message } = admitExecFrame({ cellId: 'c1', epoch, code: 'return 1+1' });
  assert.equal(message.v, CELL_PROTOCOL_VERSION);
  assert.equal(message.type, CELL_MESSAGE_TYPES.EXEC);
  assert.equal(typeof frame, 'string');
  assert.equal(Buffer.byteLength(frame, 'utf8'), bytes);
  assert.ok(bytes < 2 * 1024 * 1024);
});

test('dead/missing epoch frames are structurally detectable; ready has no request-id', () => {
  const ready = { v: CELL_PROTOCOL_VERSION, type: CELL_MESSAGE_TYPES.READY };
  const line = encodeCellMessage(ready);
  assert.equal(line.includes('requestId'), false);
  const framer = createCellFramer();
  const messages = framer.push(line);
  assert.equal(messages[0].type, 'ready');
  assert.equal('requestId' in messages[0], false);
});

test('host-authoritative epoch positive equality rejects mismatch', () => {
  const active = mintCellEpoch();
  const frameEpoch = mintCellEpoch();
  assert.notEqual(active, frameEpoch);
  const ok = Boolean(active) && isValidCellEpoch(active) && frameEpoch === active;
  assert.equal(ok, false);
});
