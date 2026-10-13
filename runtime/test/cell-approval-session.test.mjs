import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES } from '../src/runtime-safety-monitor.mjs';
import { createExecutionStateStore, executionDigest } from '../src/execution-state-store.mjs';
import { createExecutionScopeSnapshot } from '../src/execution-scope-snapshot.mjs';
import { createTaskRunCoordinator } from '../src/task-run-coordinator.mjs';
import { approvalSubject } from '../src/kernel/cell-approval.mjs';
import { createApprovalSession } from '../src/kernel/approval-session.mjs';
import {
  createKernelEffectsDispatcher, kernelEffectsAvailability, KERNEL_EFFECT_ERROR_CODES
} from '../src/kernel/effects.mjs';

const DIGEST = `sha256:${'ab'.repeat(32)}`;

const waitFor = async (predicate, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
};

const harness = ({ live = true, ttlMs = 120_000, hooks, coordinatorInject } = {}) => {
  const events = [];
  const store = createExecutionStateStore();
  const real = createTaskRunCoordinator({ runId: 'run-cell-approval' });
  real.transition('PLANNING');
  real.transition('EXECUTING');
  const coordinator = {
    get state() { return real.state; },
    transition: (next, options) => real.transition(next, options),
    async transitionAndFlush(next, options) {
      const result = real.transition(next, options);
      if (coordinatorInject) await coordinatorInject(next, real);
      await real.flush();
      return result;
    },
    flush: () => real.flush()
  };
  const approvalContexts = new Map();
  const cellOpSinks = new Map();
  const marks = [];
  const session = createApprovalSession({
    approvalContexts,
    runId: 'run-cell-approval',
    logger: { error() {} },
    emitEvent: (kind, payload) => events.push({ kind, payload }),
    approvalTtlMs: ttlMs,
    cellOpSinks,
    hooks,
    hasLiveApprover: () => live,
    executionState: () => store,
    coordinator: () => coordinator,
    activeSnapshotDigest: () => DIGEST,
    kernelExecBadge: () => ({ warning: 'WINDOWS_NO_OS_SANDBOX', sandbox: 'none' }),
    releaseChannel: () => 'WINDOWS_PHASE1_5_CONTROLLED',
    executorIdentity: () => 'test-executor',
    bindingSnapshot: () => [],
    capabilitySnapshot: () => ({ releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED', capabilities: [], commands: [] }),
    buildScope: (input) => createExecutionScopeSnapshot({
      runId: 'run-cell-approval',
      operationId: input.operationId,
      allowedCapabilities: [input.capability],
      executionMode: 'CONTROLLED',
      releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED',
      policyVersion: 'runtime-safety-1',
      bindingSnapshotDigest: input.bindingSnapshotDigest,
      createdAtMs: 1
    }),
    appendGitAuditCheckpoint: async () => ({ ok: true }),
    appendActionEvent: async () => ({ ok: true })
  });
  const track = (toolCallId) => {
    cellOpSinks.set(toolCallId, {
      markTerminal(state) { marks.push({ toolCallId, state, context: approvalContexts.has([...approvalContexts.keys()].at(-1) ?? '') }); },
      onApprovalRequested(id) { marks.push({ toolCallId, event: 'requested', id }); },
      onApprovalSettled(state) { marks.push({ toolCallId, event: 'settled', state, hasContext: false }); }
    });
  };
  return { events, store, real, coordinator, approvalContexts, cellOpSinks, marks, session, track };
};

const cellContext = (cellId, cellOpIndex, extra = {}) => ({
  cellId,
  toolCallId: `${cellId}::hr-${cellOpIndex}`,
  fromCell: true,
  cellApproval: {
    code: 'return 1',
    cellOpIndex,
    hostRequest: { kind: 'fs.write', payload: { path: `f-${cellOpIndex}.txt` } }
  },
  ...extra
});

const requested = (events) => events.filter((event) => event.kind === 'approval.requested');

test('cell and non-cell digests, and both paths stamp cellId on the pending entry', async () => {
  const { session, store, events } = harness();
  const cell = cellContext('cell::id', 1);
  const pendingCell = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'notes.txt' },
    context: cell,
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 1);
  const entry = [...session.pendingApprovals.values()][0];
  assert.equal(entry.cellId, 'cell::id');
  assert.equal(entry.toolCallId, 'cell::id::hr-1');
  const cellDigest = executionDigest(approvalSubject({
    capability: CAPABILITIES.WRITE_FILE, request: { path: 'notes.txt' }, context: cell
  }));
  const intent = store.list().find((record) => record.recordType === 'intent');
  assert.equal(intent.requestDigest, cellDigest);
  assert.notEqual(cellDigest, executionDigest({ capability: CAPABILITIES.WRITE_FILE, request: { path: 'notes.txt' } }));
  const approval = store.list().find((record) => record.recordType === 'approval');
  assert.equal(approval.requestDigest, cellDigest);

  const plainPromise = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'plain.txt' },
    context: { toolCallId: 'call-plain' },
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 2);
  const plain = [...session.pendingApprovals.values()].find((item) => item.cellId === null);
  assert.equal(plain.toolCallId, 'call-plain');
  const plainIntent = store.list().filter((record) => record.recordType === 'intent')
    .find((record) => record.requestDigest === executionDigest({ capability: CAPABILITIES.WRITE_FILE, request: { path: 'plain.txt' } }));
  assert.ok(plainIntent);
  session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: requested(events)[0].payload.requestId,
    approved: true, displayedDigest: requested(events)[0].payload.requestDigest
  }));
  session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: requested(events)[1].payload.requestId,
    approved: false, displayedDigest: requested(events)[1].payload.requestDigest
  }));
  assert.equal(await pendingCell, true);
  assert.equal(await plainPromise, false);
});

test('one pending approval per cell; the second card waits for approve, decline, and TTL', async () => {
  for (const mode of ['approve', 'decline', 'ttl']) {
    const { session, events } = harness({ ttlMs: mode === 'ttl' ? 80 : 120_000 });
    const first = session.requestApproval({
      capability: CAPABILITIES.WRITE_FILE,
      request: { path: 'a.txt' },
      context: cellContext('cell-1', 1),
      requireApproval: true
    });
    await waitFor(() => requested(events).length === 1);
    const second = session.requestApproval({
      capability: CAPABILITIES.WRITE_FILE,
      request: { path: 'b.txt' },
      context: cellContext('cell-1', 2),
      requireApproval: true
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(requested(events).length, 1);
    assert.equal(session.pendingApprovals.size, 1);
    if (mode === 'approve') {
      const card = requested(events)[0].payload;
      session.handleLine(JSON.stringify({
        type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
      }));
    } else if (mode === 'decline') {
      const card = requested(events)[0].payload;
      session.handleLine(JSON.stringify({
        type: 'approval_response', requestId: card.requestId, approved: false, displayedDigest: card.requestDigest
      }));
    }
    const keepalive = setInterval(() => {}, 20);
    try {
      await first;
    } finally {
      clearInterval(keepalive);
    }
    await waitFor(() => requested(events).length === 2);
    const card = requested(events)[1].payload;
    session.handleLine(JSON.stringify({
      type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
    }));
    assert.equal(await second, true);
  }
});

test('batchGranted items skip the gate and non-cell approvals do not wait', async () => {
  const { session, events } = harness();
  const holder = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'hold.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 1);
  const granted = await Promise.race([
    session.requestApproval({
      capability: CAPABILITIES.WRITE_FILE,
      request: { path: 'item.txt', content: 'x' },
      requireApproval: false,
      context: cellContext('cell-1', 9, {
        kernelEffect: { batchGrant: { consume: () => true } }
      })
    }),
    new Promise((resolve) => setTimeout(() => resolve('deadlock'), 200))
  ]);
  assert.equal(granted, true);
  assert.equal(requested(events).length, 1);
  const other = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'other.txt' },
    context: { toolCallId: 'not-a-cell' },
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 2);
  for (const card of requested(events)) {
    session.handleLine(JSON.stringify({
      type: 'approval_response', requestId: card.payload.requestId, approved: true, displayedDigest: card.payload.requestDigest
    }));
  }
  assert.equal(await holder, true);
  assert.equal(await other, true);
});

test('gate releases on no-live, closed, and throw paths', async () => {
  const closed = harness({ live: false });
  closed.session.gate.cancel('cell-1');
  const closedResult = await closed.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'x.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  assert.equal(closedResult, false);
  closed.session.reopenCell('cell-1');
  const refused = await closed.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'y.txt' },
    context: cellContext('cell-1', 2),
    requireApproval: true
  });
  assert.equal(refused, false);
  assert.equal(closed.events.some((event) => event.kind === 'approval.refused'), true);

  const thrown = harness();
  const realCreate = thrown.store.createIntent.bind(thrown.store);
  let calls = 0;
  thrown.store.createIntent = async (...args) => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return realCreate(...args);
  };
  const first = await thrown.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-2', 1),
    requireApproval: true
  });
  assert.equal(first, false);
  const second = thrown.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'b.txt' },
    context: cellContext('cell-2', 2),
    requireApproval: true
  });
  await waitFor(() => requested(thrown.events).length === 1);
  const card = requested(thrown.events)[0].payload;
  thrown.session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
  }));
  assert.equal(await second, true);
});

test('cell end settles the pending approval and rejects queued waiters with no card', async () => {
  const { session, events, store, marks, cellOpSinks } = harness();
  const sink = (id) => ({
    markTerminal(state) { marks.push({ id, state }); },
    onApprovalRequested() {},
    onApprovalSettled(state) { marks.push({ id, settled: state }); }
  });
  cellOpSinks.set('cell-1::hr-1', sink('1'));
  cellOpSinks.set('cell-1::hr-2', sink('2'));
  const first = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 1);
  const intentsAtQueue = store.list().filter((record) => record.recordType === 'intent').length;
  const second = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'b.txt' },
    context: cellContext('cell-1', 2),
    requireApproval: true
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await session.cancelCell('cell-1');
  assert.equal(await first, false);
  assert.equal(await second, false);
  assert.equal(store.list().filter((record) => record.recordType === 'intent').length, intentsAtQueue);
  assert.equal(requested(events).length, 1);
  assert.equal(events.some((event) => event.kind === 'approval.resolved' && event.payload.state === 'CANCELLED'), true);
  assert.equal(events.some((event) => event.kind === 'approval.expired'), false);
  assert.equal(events.some((event) => event.kind === 'approval.refused'), false);
  assert.equal(marks.some((mark) => mark.id === '2' && mark.state === 'CANCELLED'), true);
  const approval = store.list().find((record) => record.recordType === 'approval');
  assert.equal(approval.state, 'CANCELLED');
  const intent = store.list().find((record) => record.recordType === 'intent');
  assert.equal(intent.state, 'REJECTED');
});

test('settlement race: one winner, mismatched digest does not settle, catch keeps the promise', async () => {
  const { session, events, store, approvalContexts } = harness();
  let resolveOrder = [];
  const pendingPromise = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true,
  });
  await waitFor(() => requested(events).length === 1);
  const card = requested(events)[0].payload;
  const pending = session.pendingApprovals.get(card.requestId);
  const original = pending.resolve;
  pending.resolve = (value) => {
    resolveOrder.push(approvalContexts.has(pending.requestDigest) ? 'present' : 'gone');
    return original(value);
  };
  session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: 'sha256:nope'
  }));
  assert.equal(session.pendingApprovals.has(card.requestId), true);
  assert.equal(pending.settled, false);
  await session.cancelCell('cell-1');
  session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
  }));
  assert.equal(await pendingPromise, false);
  assert.deepEqual(resolveOrder, ['gone']);
  assert.equal(approvalContexts.size, 0);
  assert.equal(store.get(store.list().find((record) => record.recordType === 'approval').recordId).state, 'CANCELLED');
  assert.equal(events.filter((event) => event.kind === 'approval.resolved').length, 1);

  const raced = harness();
  const again = raced.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'b.txt' },
    context: cellContext('cell-9', 1),
    requireApproval: true
  });
  await waitFor(() => requested(raced.events).length === 1);
  const card2 = requested(raced.events)[0].payload;
  raced.session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card2.requestId, approved: false, displayedDigest: card2.requestDigest
  }));
  await raced.session.cancelCell('cell-9');
  assert.equal(await again, false);
  assert.equal(raced.events.filter((event) => event.kind === 'approval.resolved' && event.payload.state === 'DECLINED').length, 1);
  assert.equal(raced.events.some((event) => event.payload?.state === 'CANCELLED'), false);
});

test('catch with settled returns the existing promise', async () => {
  const { session } = harness({
    hooks: {
      afterClaimableInsert({ pending }) {
        pending.settled = true;
        throw new Error('after insert');
      }
    }
  });
  const pending = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  const winner = await Promise.race([
    pending.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 40))
  ]);
  assert.equal(winner, 'pending');
});

test('setup close rolls back this call and emits no approval.requested, refused, or expired', async () => {
  for (const label of ['createIntent', 'coordinator', 'audit', 'noLiveDeclined', 'noLiveRejected', 'beforeRefused']) {
    const live = !label.startsWith('noLive') && label !== 'beforeRefused';
    const { session, events, store, marks, cellOpSinks } = harness({
      live,
      hooks: {
        afterAwait(name) {
          if (name === label) session.gate.cancel('cell-1');
        }
      }
    });
    cellOpSinks.set('cell-1::hr-1', {
      markTerminal(state) { marks.push(state); },
      onApprovalRequested() {},
      onApprovalSettled() {}
    });
    const result = await session.requestApproval({
      capability: CAPABILITIES.WRITE_FILE,
      request: { path: 'a.txt' },
      context: cellContext('cell-1', 1),
      requireApproval: true
    });
    assert.equal(result, false, label);
    assert.equal(events.some((event) => event.kind === 'approval.requested'), false, label);
    assert.equal(events.some((event) => event.kind === 'approval.refused'), false, label);
    assert.equal(events.some((event) => event.kind === 'approval.expired'), false, label);
    assert.equal(marks.includes('CANCELLED'), true, label);
    for (const record of store.list()) {
      if (record.recordType === 'intent') {
        assert.ok(['REJECTED', 'DECLINED'].includes(record.state) || record.state === 'REJECTED', `${label} ${record.state}`);
        assert.equal(record.state, 'REJECTED', label);
      }
      if (record.recordType === 'approval' && label !== 'noLiveDeclined' && label !== 'noLiveRejected' && label !== 'beforeRefused') {
        assert.equal(record.state, 'CANCELLED', label);
      }
      if (record.recordType === 'approval' && (label === 'noLiveDeclined' || label === 'noLiveRejected' || label === 'beforeRefused')) {
        assert.equal(record.state, 'DECLINED', label);
      }
    }
  }
});

test('coordinator hold, cell-end injection, and VERIFYING after release', async () => {
  const seen = [];
  const { session, real, events } = harness({
    coordinatorInject: async (next) => {
      seen.push({ next, holds: session.holds.n, state: real.state, pending: session.pendingApprovals.size });
      if (next === 'WAITING_APPROVAL') {
        session.gate.cancel('cell-hold');
        await session.settleCellEnd('cell-hold');
        assert.equal(real.state, 'WAITING_APPROVAL');
      }
    }
  });
  const result = await session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-hold', 1),
    requireApproval: true
  });
  assert.equal(result, false);
  assert.equal(seen[0].holds >= 1, true);
  assert.equal(seen[0].pending, 0);
  assert.equal(real.state, 'EXECUTING');
  assert.equal(session.holds.n, 0);
  assert.equal(events.some((event) => event.kind === 'approval.requested'), false);
  real.transition('VERIFYING');
  assert.equal(real.state, 'VERIFYING');
});

test('cell-end between flush and insert does not release, and a non-cell pending approval stays WAITING_APPROVAL', async () => {
  const { session, real, events } = harness({
    hooks: {
      async afterAwait(label) {
        if (label !== 'audit') return;
        assert.equal(real.state, 'WAITING_APPROVAL');
        assert.equal(session.pendingApprovals.size, 0);
        session.gate.cancel('cell-1');
        await session.settleCellEnd('cell-1');
        assert.equal(real.state, 'WAITING_APPROVAL');
      }
    }
  });
  const result = await session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  assert.equal(result, false);
  assert.equal(real.state, 'EXECUTING');
  assert.equal(session.holds.n, 0);
  real.transition('VERIFYING');

  const shared = harness();
  const nonCell = shared.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'plain.txt' },
    context: { toolCallId: 'plain' },
    requireApproval: true
  });
  await waitFor(() => requested(shared.events).length === 1);
  const cell = shared.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'cell.txt' },
    context: cellContext('cell-2', 1),
    requireApproval: true
  });
  await waitFor(() => requested(shared.events).length === 2);
  assert.equal(shared.real.state, 'WAITING_APPROVAL');
  await shared.session.cancelCell('cell-2');
  assert.equal(await cell, false);
  assert.equal(shared.real.state, 'WAITING_APPROVAL');
  assert.equal(shared.session.holds.n, 0);
  const card = requested(shared.events)[0].payload;
  shared.session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
  }));
  assert.equal(await nonCell, true);
  assert.equal(shared.session.holds.n, 0);
});

test('already EXECUTING is not transitioned, and a throwing release still finishes cell-end', async () => {
  let throwRelease = false;
  const calls = [];
  const { session, real, events, store, approvalContexts } = harness({
    coordinatorInject: async (next) => {
      calls.push(next);
      if (throwRelease && next === 'EXECUTING') throw new Error('flush failed');
    }
  });
  const pending = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'a.txt' },
    context: cellContext('cell-1', 1),
    requireApproval: true
  });
  await waitFor(() => requested(events).length === 1);
  throwRelease = true;
  await session.cancelCell('cell-1');
  assert.equal(await pending, false);
  assert.equal(calls.includes('EXECUTING'), true);
  assert.equal(real.state, 'EXECUTING');
  assert.equal(session.holds.n, 0);
  assert.equal(events.some((event) => event.kind === 'approval.resolved' && event.payload.state === 'CANCELLED'), true);
  assert.equal(approvalContexts.size, 0);
  real.transition('VERIFYING');
  assert.equal(store.list().find((record) => record.recordType === 'approval').state, 'CANCELLED');

  const later = [];
  const idle = harness({
    coordinatorInject: async (next) => { later.push(next); }
  });
  const waiting = idle.session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'b.txt' },
    context: cellContext('cell-3', 1),
    requireApproval: true
  });
  await waitFor(() => requested(idle.events).length === 1);
  const card = requested(idle.events)[0].payload;
  idle.session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: card.requestId, approved: true, displayedDigest: card.requestDigest
  }));
  assert.equal(await waiting, true);
  assert.equal(idle.real.state, 'EXECUTING');
  later.length = 0;
  await idle.session.cancelCell('cell-3');
  assert.equal(later.includes('EXECUTING'), false);
  assert.equal(idle.real.state, 'EXECUTING');
  idle.real.transition('VERIFYING');
});

test('batch approval context has no batchGrant and a declined batch throws KERNEL_BATCH_REFUSED', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dda-batch-context-'));
  const seen = [];
  try {
    const env = {
      DDA_RESIDENT_KERNEL: '1',
      DDA_PLATFORM: 'linux-cli',
      DDA_KERNEL_EFFECTS: 'fs.write',
      DDA_KERNEL_WRITE_BATCH: '1',
      DDA_KERNEL_APPROVAL: 'host-policy-audit'
    };
    const dispatcher = createKernelEffectsDispatcher({
      availability: kernelEffectsAvailability({
        env,
        executionMode: 'CONTROLLED',
        canLease: () => true
      }),
      executionMode: 'CONTROLLED',
      workspaceRoot: root,
      workspace: { async read() { throw new Error('no read'); } },
      invokeTool: async () => { throw new Error('should not write'); },
      canLease: () => true,
      hasLiveApprover: () => true,
      requestBatchApproval: async (args) => {
        seen.push(args);
        return false;
      },
      runId: 'run-batch'
    });
    await assert.rejects(
      () => dispatcher.dispatch({
        kind: 'fs.write_batch',
        payload: { items: [{ op: 'write', path: 'notes.txt', content: 'hi', expectedBaseDigest: null }] }
      }, {
        toolCallId: 'cell-1::hr-3',
        cellId: 'cell-1',
        cellApproval: { code: 'x', cellOpIndex: 3, hostRequest: { kind: 'fs.write_batch' } },
        kernelEffect: { batchGrant: { consume: () => true } }
      }),
      (error) => error.code === KERNEL_EFFECT_ERROR_CODES.BATCH_REFUSED
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].context.cellId, 'cell-1');
    assert.equal(seen[0].context.toolCallId, 'cell-1::hr-3');
    assert.equal(seen[0].context.cellApproval.cellOpIndex, 3);
    assert.equal(seen[0].context.kernelEffect, undefined);
    assert.equal(seen[0].context.batchGrant, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
