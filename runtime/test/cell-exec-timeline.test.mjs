import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  classifyCellHostKind, cellOpTitle, takeTailScalars, createCellExecTimeline, dispatchCellMessages,
  CELL_OP_PUSH_BYTES, CELL_OP_PUSH_INTERVAL_MS, CELL_OP_TAIL_BYTES
} from '../src/kernel/cell-exec-timeline.mjs';
import {
  createCellHost, KERNEL_WINDOWS_UNSANDBOXED_FLAG, KERNEL_WINDOWS_DESKTOP_CELLS_FLAG
} from '../src/kernel/cell-host.mjs';
import { UNCERTAIN_ERROR_CODES } from '../src/kernel/effects.mjs';

const EPOCH = 'ab'.repeat(16);
const workerPath = fileURLToPath(new URL('./fixtures/fake-cell-worker.mjs', import.meta.url));

const desktopEnv = (mode) => ({
  DDA_PLATFORM: 'windows-desktop',
  DDA_RESIDENT_KERNEL: '1',
  [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1',
  [KERNEL_WINDOWS_DESKTOP_CELLS_FLAG]: '1',
  DDA_FAKE_CELL_MODE: mode
});

const cliEnv = (mode) => ({
  DDA_PLATFORM: 'windows-cli',
  DDA_RESIDENT_KERNEL: '1',
  DDA_KERNEL_CODE_CELLS: '1',
  [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1',
  DDA_FAKE_CELL_MODE: mode
});

test('classification, titles, and tail stay on a scalar boundary', () => {
  const handles = (kind) => ['fs.write', 'shell.exec', 'fs.write_batch'].includes(kind);
  assert.equal(classifyCellHostKind('workspace.read', handles), 'read');
  assert.equal(classifyCellHostKind('host.capabilities', handles), 'read');
  assert.equal(classifyCellHostKind('fs.write', handles), 'effect');
  assert.equal(classifyCellHostKind('shell.exec', handles), 'effect');
  assert.equal(classifyCellHostKind('session_state.set', handles), 'refused');
  const title = cellOpTitle('fs.write', { path: 'notes.txt', content: 'secret body', password: 'hunter2' });
  assert.match(title, /^fs\.write notes\.txt/);
  assert.equal(title.includes('secret body'), false);
  assert.equal(title.includes('hunter2'), false);
  const tail = takeTailScalars(`xxxx\uD83D\uDE00`, 5);
  assert.equal(tail, `x\uD83D\uDE00`);
  assert.equal(takeTailScalars('\uD83D\uDE00', 3), '');
  assert.equal(Buffer.byteLength(tail, 'utf8') <= 5, true);
});

test('read envelope, effect outcome, and locked terminals', () => {
  let clock = 1_000;
  const sinks = new Map();
  const emitted = [];
  const timeline = createCellExecTimeline({
    now: () => clock,
    sinks,
    journalPath: 'C:\\journal.json',
    emit: (payload) => emitted.push(payload),
    schedule: () => ({ unref() {} }),
    clearSchedule: () => {}
  });
  timeline.begin({
    epoch: EPOCH, cellId: 'cell::a', requestId: 'hr-1', toolCallId: 'cell::a::hr-1',
    cellOpIndex: 1, kind: 'workspace.list', classification: 'read', title: 'workspace.list'
  });
  timeline.markEntered(EPOCH, 'cell::a::hr-1');
  timeline.endFromResult(EPOCH, 'cell::a::hr-1', {
    classification: 'read', envelopeOk: true, result: { ok: false }
  });
  assert.equal(timeline.rows()[0].state, 'COMPLETED');
  assert.equal(timeline.rows()[0].toolCallId, 'cell::a::hr-1');

  timeline.begin({
    epoch: EPOCH, cellId: 'cell::a', requestId: 'hr-2', toolCallId: 'cell::a::hr-2',
    cellOpIndex: 2, kind: 'fs.write', classification: 'effect', title: 'fs.write'
  });
  clock = 1_100;
  sinks.get('cell::a::hr-2').onApprovalRequested('approval-9');
  clock = 1_600;
  sinks.get('cell::a::hr-2').onApprovalSettled('APPROVED');
  clock = 1_800;
  timeline.endFromResult(EPOCH, 'cell::a::hr-2', {
    classification: 'effect', result: { ok: true, outcome: 'COMPLETED' }
  });
  const effect = timeline.rows().find((row) => row.requestId === 'hr-2');
  assert.equal(effect.durationMs, 300);
  assert.equal(effect.approvalRequestId, 'approval-9');
  assert.equal(effect.approvalWaiting, false);

  timeline.begin({
    epoch: EPOCH, cellId: 'cell::a', requestId: 'hr-3', toolCallId: 'cell::a::hr-3',
    cellOpIndex: 3, kind: 'test.run', classification: 'effect', title: 'test.run'
  });
  timeline.endFromResult(EPOCH, 'cell::a::hr-3', {
    classification: 'effect', result: { ok: false, outcome: 'UNKNOWN', failed: { errorCode: 'KERNEL_TIMEOUT' } }
  });
  const unknown = timeline.rows().find((row) => row.requestId === 'hr-3');
  assert.equal(unknown.state, 'UNKNOWN');
  assert.equal(unknown.journalPath, 'C:\\journal.json');
  assert.equal(UNCERTAIN_ERROR_CODES.has('KERNEL_TIMEOUT'), true);

  timeline.begin({
    epoch: EPOCH, cellId: 'cell::a', requestId: 'hr-4', toolCallId: 'cell::a::hr-4',
    cellOpIndex: 4, kind: 'fs.write', classification: 'effect', title: 'fs.write'
  });
  sinks.get('cell::a::hr-4').markTerminal('DECLINED');
  timeline.endFromResult(EPOCH, 'cell::a::hr-4', {
    classification: 'effect',
    error: Object.assign(new Error('SAFETY_LEASE_REQUIRED'), { code: 'SAFETY_LEASE_REQUIRED' })
  });
  assert.equal(timeline.rows().find((row) => row.requestId === 'hr-4').state, 'DECLINED');

  timeline.begin({
    epoch: EPOCH, cellId: 'cell::a', requestId: 'hr-5', toolCallId: 'cell::a::hr-5',
    cellOpIndex: 5, kind: 'workspace.read', classification: 'read', title: 'workspace.read'
  });
  timeline.cancelUnentered('cell::a');
  assert.equal(timeline.rows().find((row) => row.requestId === 'hr-5').state, 'CANCELLED');
  assert.equal(timeline.rows().find((row) => row.requestId === 'hr-1').state, 'COMPLETED');

  const seen = [];
  dispatchCellMessages([1, 2], (message) => {
    if (message === 1) throw new Error('boom');
    seen.push(message);
  }, () => {});
  assert.deepEqual(seen, [2]);
  assert.equal(emitted[0].itemId, 'cell-cell::a');
  assert.equal(emitted[0].toolName, 'kernel.exec');
});

test('seq gap stops later deltas and the tail ring truncates', () => {
  const timeline = createCellExecTimeline({
    emit: () => {},
    schedule: (fn) => { fn(); return { unref() {} }; },
    clearSchedule: () => {}
  });
  const row = timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-1', toolCallId: 'c::hr-1',
    cellOpIndex: 1, kind: 'workspace.list', classification: 'read', title: 'workspace.list'
  });
  assert.equal(timeline.noteSeq(row, 1), 'ok');
  timeline.appendChunk(row, 'one');
  assert.equal(timeline.noteSeq(row, 1), 'duplicate');
  assert.equal(timeline.noteSeq(row, 3), 'gap');
  timeline.appendChunk(row, 'after');
  const stored = timeline.rows()[0];
  assert.equal(stored.output, 'one');
  assert.equal(stored.truncated, true);
  const bulky = timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-2', toolCallId: 'c::hr-2',
    cellOpIndex: 2, kind: 'workspace.list', classification: 'read', title: 'workspace.list'
  });
  timeline.appendChunk(bulky, 'x'.repeat(CELL_OP_TAIL_BYTES + 10));
  assert.equal(timeline.rows().find((item) => item.requestId === 'hr-2').truncated, true);
  assert.equal(Buffer.byteLength(timeline.rows().find((item) => item.requestId === 'hr-2').output, 'utf8') <= CELL_OP_TAIL_BYTES, true);
});

test('late chunks after a terminal row stay in the 64KB tail without changing state', () => {
  const emitted = [];
  const sinks = new Map();
  const timeline = createCellExecTimeline({
    emit: (payload) => emitted.push(payload.row),
    sinks,
    schedule: (fn) => { fn(); return { unref() {} }; },
    clearSchedule: () => {}
  });
  const row = timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-1', toolCallId: 'c::hr-1',
    cellOpIndex: 1, kind: 'workspace.read', classification: 'read', title: 'workspace.read'
  });
  assert.equal(timeline.noteSeq(row, 1), 'ok');
  timeline.appendChunk(row, 'early');
  timeline.endFromResult(EPOCH, 'c::hr-1', { classification: 'read', envelopeOk: true });
  assert.equal(sinks.has('c::hr-1'), false);
  const finished = timeline.rows()[0];
  assert.equal(finished.state, 'COMPLETED');
  assert.equal(finished.output, 'early');
  const durationMs = finished.durationMs;
  assert.equal(timeline.noteSeq(row, 2), 'ok');
  timeline.appendChunk(row, ' late');
  const after = timeline.rows()[0];
  assert.equal(after.state, 'COMPLETED');
  assert.equal(after.output, 'early late');
  assert.equal(after.durationMs, durationMs);
  timeline.appendChunk(row, 'y'.repeat(CELL_OP_TAIL_BYTES));
  const tail = timeline.rows()[0];
  assert.equal(tail.state, 'COMPLETED');
  assert.equal(tail.truncated, true);
  assert.equal(Buffer.byteLength(tail.output, 'utf8') <= CELL_OP_TAIL_BYTES, true);
  assert.equal(tail.output.endsWith('y'), true);
  assert.equal(emitted.at(-1).state, 'COMPLETED');
  assert.equal(emitted.at(-1).output, tail.output);
  assert.equal(timeline.noteSeq(row, 4), 'gap');
  timeline.appendChunk(row, 'dropped');
  assert.equal(timeline.rows()[0].output.includes('dropped'), false);
  assert.equal(timeline.rows()[0].state, 'COMPLETED');
});

const handles = (kind) => ['fs.write', 'fs.patch', 'test.run', 'fs.write_batch', 'shell.exec', 'net.fetch'].includes(kind);

const runHost = async ({ env, platform = 'win32', mode, cellId = 'cell-1', dispatch, beforeStop, readonlyBridge } = {}) => {
  const events = [];
  const terminals = [];
  const host = createCellHost({
    env: { ...env, DDA_FAKE_CELL_MODE: mode },
    platform,
    journal: { available: true },
    sessionKeep: true,
    nodeVersion: 'v24.0.0',
    residentAvailable: true,
    workerPath,
    cellTimeoutMs: 8_000,
    journalPath: 'C:\\journal.json',
    readonlyBridge: readonlyBridge ?? (async (kind, payload) => ({ kind, path: payload?.path ?? null })),
    effectsDispatcher: {
      handles,
      dispatch: dispatch ?? (async (call) => {
        if (call.kind === 'shell.exec') {
          throw Object.assign(new Error('KERNEL_SIDE_EFFECT_REFUSED'), { code: 'KERNEL_SIDE_EFFECT_REFUSED' });
        }
        if (call.kind === 'fs.write') return { ok: false, outcome: 'FAILED', errorCode: 'EXECUTOR_RESULT_FAILED' };
        return { ok: true, outcome: 'COMPLETED' };
      })
    },
    onEmit: (kind, payload) => events.push({ kind, payload }),
    onCellTerminal: (info) => terminals.push(info)
  });
  const started = await host.start({});
  assert.equal(started.ready, true, started.reason);
  try {
    await host.exec({ code: 'return 1;', cellId });
    if (beforeStop) await beforeStop(events);
  } finally {
    await host.stop().catch(() => {});
  }
  return { events, terminals, started };
};

const opRows = (events) => events.filter((event) => event.kind === 'kernel.cell_op').map((event) => event.payload.row);

test('desktop host projects rows; windows-cli does not', async () => {
  const desktop = await runHost({ env: desktopEnv('classify'), mode: 'classify', cellId: 'a::b' });
  assert.equal(desktop.started.windowsDesktop, true);
  const rows = opRows(desktop.events);
  const byRequest = new Map();
  for (const row of rows) byRequest.set(row.requestId, row);
  assert.equal(byRequest.get('hr-1').state, 'COMPLETED');
  assert.equal(byRequest.get('hr-1').classification, 'read');
  assert.equal(byRequest.get('hr-1').toolCallId, 'a::b::hr-1');
  assert.equal(byRequest.get('hr-2').state, 'REFUSED');
  assert.equal(byRequest.get('hr-3').state, 'FAILED');
  assert.equal(byRequest.get('hr-3').title.includes('secret body'), false);
  assert.match(byRequest.get('hr-3').title, /fs\.write notes\.txt/);
  assert.equal(byRequest.get('hr-4').state, 'REFUSED');
  assert.equal(desktop.events.some((event) => event.kind === 'kernel.cell_op' && event.payload.itemId === 'cell-a::b'), true);
  assert.equal(desktop.events.some((event) => event.kind === 'kernel.cell_op' && event.payload.warning === 'WINDOWS_NO_OS_SANDBOX'), true);
  assert.equal(desktop.terminals.some((info) => info.cellId === 'a::b'), true);

  const cli = await runHost({ env: cliEnv('read'), mode: 'read' });
  assert.equal(cli.events.some((event) => event.kind === 'kernel.cell_op'), false);
  assert.equal(cli.started.windowsDesktop, false);
});

test('stale epoch opens no row; malformed and gapped progress are dropped', async () => {
  const stale = await runHost({ env: desktopEnv('stale'), mode: 'stale' });
  assert.equal(opRows(stale.events).length, 0);

  const gap = await runHost({ env: desktopEnv('progress-gap'), mode: 'progress-gap' });
  const last = opRows(gap.events).at(-1);
  assert.equal(last.state, 'COMPLETED');
  assert.equal(last.output, 'one');
  assert.equal(last.truncated, true);

  const bad = await runHost({ env: desktopEnv('malformed-progress'), mode: 'malformed-progress' });
  const badRow = opRows(bad.events).at(-1);
  assert.equal(badRow.state, 'COMPLETED');
  assert.equal(badRow.output ?? '', '');

  const version = await runHost({ env: desktopEnv('bad-version'), mode: 'bad-version' });
  assert.equal(version.events.some((event) => event.kind === 'kernel.cell_frame_error'), true);
  assert.equal(opRows(version.events).at(-1).state, 'COMPLETED');
  assert.equal(opRows(version.events).at(-1).kind, 'host.ping');
});

test('late op_progress after fast host_response stays on the completed row', async () => {
  const desktop = await runHost({ env: desktopEnv('late-progress'), mode: 'late-progress' });
  const deadline = Date.now() + 500;
  let last = opRows(desktop.events).at(-1);
  while (last?.output !== 'late-tail' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    last = opRows(desktop.events).at(-1);
  }
  assert.equal(last.state, 'COMPLETED');
  assert.equal(last.kind, 'workspace.read');
  assert.equal(last.output, 'late-tail');
});

test('late op_progress on a terminal row uses the 100ms coalesced flush', () => {
  const emitted = [];
  const timers = [];
  const timeline = createCellExecTimeline({
    emit: (payload) => emitted.push({ ...payload.row }),
    schedule: (fn, ms) => {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearSchedule: () => {}
  });
  const row = timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-1', toolCallId: 'c::hr-1',
    cellOpIndex: 1, kind: 'workspace.read', classification: 'read', title: 'workspace.read'
  });
  assert.equal(emitted.length, 1);
  assert.equal(timeline.noteSeq(row, 1), 'ok');
  timeline.appendChunk(row, 'run');
  assert.equal(emitted.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, CELL_OP_PUSH_INTERVAL_MS);
  timers[0].fn();
  assert.equal(emitted.at(-1).output, 'run');
  timeline.endFromResult(EPOCH, 'c::hr-1', { classification: 'read', envelopeOk: true });
  assert.equal(emitted.at(-1).state, 'COMPLETED');
  const afterFinish = emitted.length;
  assert.equal(timeline.noteSeq(row, 2), 'ok');
  timeline.appendChunk(row, 'a');
  timeline.appendChunk(row, 'b');
  timeline.appendChunk(row, 'c');
  assert.equal(emitted.length, afterFinish);
  assert.equal(timers.length, 2);
  assert.equal(timers[1].ms, CELL_OP_PUSH_INTERVAL_MS);
  assert.equal(timeline.rows()[0].output, 'runabc');
  assert.equal(timeline.rows()[0].state, 'COMPLETED');
  assert.equal(timeline.rows()[0].durationMs, emitted.at(-1).durationMs);
  timers[1].fn();
  assert.equal(emitted.length, afterFinish + 1);
  assert.equal(emitted.at(-1).output, 'runabc');
  assert.equal(emitted.at(-1).state, 'COMPLETED');
  timeline.appendChunk(row, 'z'.repeat(CELL_OP_PUSH_BYTES));
  assert.equal(emitted.length, afterFinish + 2);
  assert.equal(emitted.at(-1).state, 'COMPLETED');
  assert.equal(emitted.at(-1).output.endsWith('z'), true);
  assert.equal(timers.length, 2);
});

test('readonly ok:false carries result.error.code onto the FAILED row', () => {
  const timeline = createCellExecTimeline({
    emit: () => {},
    schedule: () => ({ unref() {} }),
    clearSchedule: () => {}
  });
  timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-1', toolCallId: 'c::hr-1',
    cellOpIndex: 1, kind: 'workspace.read', classification: 'read', title: 'workspace.read'
  });
  timeline.endFromResult(EPOCH, 'c::hr-1', {
    classification: 'read',
    envelopeOk: false,
    result: { ok: false, error: { code: 'KERNEL_OP_FAILED' } }
  });
  assert.equal(timeline.rows()[0].state, 'FAILED');
  assert.equal(timeline.rows()[0].errorCode, 'KERNEL_OP_FAILED');

  timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId: 'hr-2', toolCallId: 'c::hr-2',
    cellOpIndex: 2, kind: 'session_state.get', classification: 'read', title: 'session_state.get'
  });
  timeline.endFromResult(EPOCH, 'c::hr-2', {
    classification: 'read',
    envelopeOk: false,
    result: { ok: false }
  });
  const missing = timeline.rows().find((row) => row.requestId === 'hr-2');
  assert.equal(missing.state, 'FAILED');
  assert.equal(missing.errorCode, undefined);
});

test('kernel result error codes are sanitized before they are stored', () => {
  const timeline = createCellExecTimeline({
    emit: () => {},
    schedule: () => ({ unref() {} }),
    clearSchedule: () => {}
  });
  const begin = (requestId, cellOpIndex) => timeline.begin({
    epoch: EPOCH, cellId: 'c', requestId, toolCallId: `c::${requestId}`,
    cellOpIndex, kind: 'workspace.read', classification: 'read', title: 'workspace.read'
  });
  begin('hr-1', 1);
  timeline.endFromResult(EPOCH, 'c::hr-1', {
    classification: 'read',
    envelopeOk: false,
    result: { ok: false, error: { code: `KERNEL_OP_FAILED <injected>\n${'A'.repeat(80)}` } }
  });
  const noisy = timeline.rows().find((row) => row.requestId === 'hr-1');
  const expected = `KERNEL_OP_FAILEDinjected${'A'.repeat(80)}`.slice(0, 64);
  assert.equal(noisy.state, 'FAILED');
  assert.equal(noisy.errorCode, expected);
  assert.equal(noisy.errorCode.length, 64);
  assert.match(noisy.errorCode, /^[A-Za-z0-9_.:-]+$/);

  begin('hr-2', 2);
  timeline.endFromResult(EPOCH, 'c::hr-2', {
    classification: 'read',
    envelopeOk: false,
    result: { ok: false, error: { code: 'ok.code:part_2-tail' } }
  });
  assert.equal(timeline.rows().find((row) => row.requestId === 'hr-2').errorCode, 'ok.code:part_2-tail');

  begin('hr-3', 3);
  timeline.endFromResult(EPOCH, 'c::hr-3', {
    classification: 'read',
    envelopeOk: false,
    result: { ok: false, error: { code: '< >!' } }
  });
  const emptied = timeline.rows().find((row) => row.requestId === 'hr-3');
  assert.equal(emptied.state, 'FAILED');
  assert.equal(emptied.errorCode, undefined);
});

test('readonly bridge error envelope finishes workspace and session_state rows as FAILED', async () => {
  const desktop = await runHost({
    env: desktopEnv('bridge-error'),
    mode: 'bridge-error',
    readonlyBridge: async () => ({ ok: false, error: { code: 'KERNEL_OP_FAILED' } })
  });
  const byRequest = new Map();
  for (const row of opRows(desktop.events)) byRequest.set(row.requestId, row);
  assert.equal(byRequest.get('hr-1').kind, 'workspace.read');
  assert.equal(byRequest.get('hr-1').state, 'FAILED');
  assert.equal(byRequest.get('hr-1').errorCode, 'KERNEL_OP_FAILED');
  assert.equal(byRequest.get('hr-2').kind, 'session_state.get');
  assert.equal(byRequest.get('hr-2').state, 'FAILED');
  assert.equal(byRequest.get('hr-2').errorCode, 'KERNEL_OP_FAILED');
});

test('exec_result does not end a row that already entered the bridge', async () => {
  const desktop = await runHost({
    env: desktopEnv('mid-dispatch'),
    mode: 'mid-dispatch',
    cellId: 'mid'
  });
  const last = opRows(desktop.events).at(-1);
  assert.equal(last.state, 'COMPLETED');
  assert.equal(last.kind, 'workspace.read');
  assert.equal(desktop.events.some((event) => event.kind === 'kernel.cell_reset'), false);
});

test('worker exit still emits kernel.cell_reset and does not invent a row', async () => {
  const reset = await runHost({
    env: desktopEnv('reset'),
    mode: 'reset',
    beforeStop: async (events) => {
      for (let i = 0; i < 50 && !events.some((event) => event.kind === 'kernel.cell_reset'); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  });
  assert.equal(reset.events.some((event) => event.kind === 'kernel.cell_reset'), true);
  assert.equal(opRows(reset.events).length, 0);
  const card = reset.events.find((event) => event.kind === 'kernel.cell_reset');
  assert.equal(card.payload.itemId, undefined);
  assert.equal(card.payload.title, 'cell 环境已重置，变量已丢失');
});
