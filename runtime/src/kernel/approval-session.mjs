import { randomUUID } from 'node:crypto';
import { approvalSubject, cellApprovalPresentation } from './cell-approval.mjs';
import { executionDigest } from '../execution-state-store.mjs';
import { CAPABILITIES } from '../runtime-safety-monitor.mjs';
import { sha256Digest } from '../trajectory-store.mjs';
import { APPROVAL_OUTCOMES, resolveApprovalOutcome } from '../controlled-tools.mjs';

const DEFAULT_APPROVAL_TTL_MS = 120_000;

/**
 * One pending approval per cell. Queued waiters resolve false when the cell
 * ends; the holder observes `closed` after each setup await.
 */
export const createCellApprovalGate = () => {
  const slots = new Map();
  const slot = (cellId) => {
    let entry = slots.get(cellId);
    if (!entry) {
      entry = { holder: false, waiters: [], closed: false };
      slots.set(cellId, entry);
    }
    return entry;
  };
  return {
    async acquire(cellId) {
      const entry = slot(cellId);
      if (entry.closed) return false;
      if (!entry.holder) {
        entry.holder = true;
        return true;
      }
      return new Promise((resolve) => {
        entry.waiters.push(resolve);
      });
    },
    release(cellId) {
      const entry = slots.get(cellId);
      if (!entry || entry.holder !== true) return;
      entry.holder = false;
      if (entry.closed) return;
      const next = entry.waiters.shift();
      if (!next) return;
      entry.holder = true;
      next(true);
    },
    cancel(cellId) {
      const entry = slot(cellId);
      entry.closed = true;
      const waiters = entry.waiters.splice(0);
      for (const resolve of waiters) resolve(false);
    },
    isClosed(cellId) {
      return slots.get(cellId)?.closed === true;
    },
    reopen(cellId) {
      const entry = slots.get(cellId);
      if (!entry) return;
      entry.closed = false;
    }
  };
};

const cellIdOf = (context) => (typeof context?.cellId === 'string' && context.cellId ? context.cellId : null);

/**
 * Live approval requests for one run. Cell calls share a FIFO gate and a
 * single claimable pendingApprovals entry; non-cell calls bypass the gate.
 */
export const createApprovalSession = (deps) => {
  const pendingApprovals = new Map();
  const gate = createCellApprovalGate();
  const holds = { n: 0 };
  const approvalContexts = deps.approvalContexts;
  const ttlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;

  const takeHold = () => {
    holds.n += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds.n -= 1;
    };
  };

  const sinkFor = (context) => {
    if (context?.cellOpSink && typeof context.cellOpSink.markTerminal === 'function') return context.cellOpSink;
    const id = context?.toolCallId;
    if (typeof id === 'string') return deps.cellOpSinks?.get(id);
    return undefined;
  };

  const claim = (pending, requestId) => {
    if (!pending || pending.settled) return false;
    if (!pendingApprovals.has(requestId)) return false;
    pending.settled = true;
    pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    return true;
  };

  const coordinator = () => deps.coordinator();
  const executionState = () => deps.executionState();

  const maybeReleaseCoordinator = async (callerHolds) => {
    try {
      const current = coordinator();
      if (current.state !== 'WAITING_APPROVAL') return;
      if (pendingApprovals.size !== 0) return;
      const others = holds.n - (callerHolds ? 1 : 0);
      if (others > 0) return;
      await current.transitionAndFlush('EXECUTING', { reason: 'CELL_APPROVAL_RELEASED' });
    } catch {
      // The caller still finishes. A leaked hold is what would stick the run.
    }
  };

  const emitResolved = (pending, requestId, state) => {
    deps.emitEvent('approval.resolved', {
      requestId,
      state,
      displayedDigest: pending.requestDigest,
      ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
      ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
    });
  };

  const settleWinner = (pending, requestId, { state, coordinatorNext, coordinatorReason, deleteContext }) => {
    const releaseHold = takeHold();
    void (async () => {
      try {
        const approved = state === 'APPROVED';
        if (pending.context?.approval) {
          await executionState().transition(pending.context.approval.recordId, approved ? 'APPROVED' : state === 'EXPIRED' ? 'EXPIRED' : 'DECLINED');
        }
        if (pending.context?.intent) {
          await executionState().transition(pending.context.intent.recordId, approved ? 'APPROVED' : 'REJECTED');
        }
        if (deleteContext) approvalContexts.delete(pending.requestDigest);
        if (coordinator().state === 'WAITING_APPROVAL' && coordinatorNext) {
          await coordinator().transitionAndFlush(coordinatorNext, {
            reason: coordinatorReason,
            metadata: { requestId }
          });
        }
        if (state === 'EXPIRED') deps.emitEvent('approval.expired', { requestId });
        else emitResolved(pending, requestId, state);
        if (state === 'DECLINED' || state === 'EXPIRED') pending.cellOpSink?.markTerminal(state);
        pending.cellOpSink?.onApprovalSettled(state);
        pending.resolve(approved);
      } catch {
        pending.resolve(false);
      } finally {
        releaseHold();
      }
    })();
  };

  const handleLine = (line) => {
    try {
      const message = JSON.parse(line);
      if (message?.type !== 'approval_response' || typeof message.requestId !== 'string') return;
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) return;
      if (message.displayedDigest !== pending.requestDigest) return;
      if (!claim(pending, message.requestId)) return;
      const approved = message.approved === true;
      settleWinner(pending, message.requestId, {
        state: approved ? 'APPROVED' : 'DECLINED',
        coordinatorNext: approved ? 'EXECUTING' : 'FAILED',
        coordinatorReason: approved ? 'APPROVAL_GRANTED' : 'APPROVAL_DECLINED',
        deleteContext: !approved
      });
    } catch {
      // Ignore malformed host input; the pending approval will expire safely.
    }
  };

  const armTimer = (pending, requestId) => {
    pending.timer = setTimeout(() => {
      if (!claim(pending, requestId)) return;
      settleWinner(pending, requestId, {
        state: 'EXPIRED',
        coordinatorNext: 'FAILED',
        coordinatorReason: 'APPROVAL_EXPIRED',
        deleteContext: true
      });
    }, ttlMs);
    pending.timer?.unref?.();
  };

  const settleCellEnd = async (cellId) => {
    if (!cellId) return;
    const matches = [...pendingApprovals.entries()].filter(([, pending]) => pending.cellId === cellId && pending.settled !== true);
    for (const [requestId, pending] of matches) {
      if (!claim(pending, requestId)) continue;
      const releaseHold = takeHold();
      try {
        try {
          const approval = pending.context?.approval
            ? executionState().get(pending.context.approval.recordId)
            : undefined;
          if (approval && (approval.state === 'REQUESTED' || approval.state === 'PRESENTED')) {
            await executionState().transition(approval.recordId, 'CANCELLED');
          }
          const intent = pending.context?.intent
            ? executionState().get(pending.context.intent.recordId)
            : undefined;
          if (intent && intent.state === 'WAITING_APPROVAL') {
            await executionState().transition(intent.recordId, 'REJECTED');
          }
        } catch {
          // Store trouble must not skip the desktop cancel or resolve(false).
        }
        await maybeReleaseCoordinator(true);
        emitResolved(pending, requestId, 'CANCELLED');
        pending.cellOpSink?.markTerminal('CANCELLED');
        pending.cellOpSink?.onApprovalSettled('CANCELLED');
        approvalContexts.delete(pending.requestDigest);
        pending.resolve(false);
      } finally {
        releaseHold();
      }
    }
  };

  const requestApproval = async ({ capability, request, requireApproval = false, risk: providedRisk, context: approvalCallContext } = {}) => {
    const requestId = `approval-${randomUUID()}`;
    const batchGranted = requireApproval !== true
      && typeof approvalCallContext?.kernelEffect?.batchGrant?.consume === 'function'
      && approvalCallContext.kernelEffect.batchGrant.consume({ capability, request }) === true;
    const cellId = cellIdOf(approvalCallContext);
    const requestDigest = executionDigest(approvalSubject({ capability, request, context: approvalCallContext }));
    const cellPresentation = approvalCallContext?.cellApproval
      ? cellApprovalPresentation(requestDigest, approvalCallContext.cellApproval)
      : null;
    const risk = providedRisk ?? (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.WRITE_FILE || capability === CAPABILITIES.NETWORK
      ? 'HIGH'
      : capability === CAPABILITIES.TEST ? 'MEDIUM' : 'LOW');
    const activeSnapshot = deps.activeSnapshotDigest?.();
    // approvalExpiresAt is assigned after the per-cell FIFO gate admits.
    // Queue wait must not consume the displayed TTL.
    const safeRequest = {
      capability,
      requestDigest,
      risk,
      policyVersion: 'runtime-safety-1',
      scope: { snapshotDigest: activeSnapshot, capability },
      ...(typeof request?.command === 'string' ? { command: request.command.slice(0, 4096) } : {}),
      ...(typeof request?.path === 'string' ? { path: request.path.slice(0, 512) } : {}),
      ...(typeof request?.cwd === 'string' ? { cwd: request.cwd.slice(0, 512) } : {}),
      ...(Array.isArray(request?.kernelBatchItems) ? {
        kernelBatch: {
          batchId: String(request.kernelBatchId ?? '').slice(0, 80),
          items: request.kernelBatchItems.slice(0, 10).map((item) => ({
            op: String(item?.op ?? '').slice(0, 8), path: String(item?.path ?? '').slice(0, 512),
            bytes: Number(item?.bytes) || 0, contentDigest: String(item?.contentDigest ?? '').slice(0, 80)
          }))
        }
      } : {}),
      ...(cellPresentation ? {
        cellOpIndex: cellPresentation.cellOpIndex,
        fingerprint: cellPresentation.fingerprint,
        codePreview: cellPresentation.codePreview,
        toolName: 'kernel.exec',
        ...(deps.kernelExecBadge?.() ?? {})
      } : {}),
      ...(typeof request?.host === 'string' ? {
        host: request.host.slice(0, 253),
        ...(typeof request?.method === 'string' ? { method: request.method.slice(0, 10) } : {}),
        ...(typeof request?.scheme === 'string' ? { scheme: request.scheme.slice(0, 10) } : {})
      } : {})
    };
    let resolveApproval;
    const approvalPromise = new Promise((resolve) => { resolveApproval = resolve; });
    const pending = {
      resolve: resolveApproval,
      timer: undefined,
      requestDigest,
      context: undefined,
      cellId,
      toolCallId: approvalCallContext?.toolCallId ?? null,
      cellOpSink: sinkFor(approvalCallContext),
      settled: false,
      inserted: false
    };
    let gateHeld = false;
    let keepGate = false;
    const releaseGate = () => {
      if (!gateHeld) return;
      gateHeld = false;
      gate.release(cellId);
    };
    pending.resolve = (value) => {
      releaseGate();
      resolveApproval(value);
    };
    let intentRecord;
    let approvalRecord;
    let intentState;
    let approvalState;
    let setupHoldRelease = null;
    let aborted = false;

    const rollbackClosed = async () => {
      if (aborted) return;
      aborted = true;
      try {
        if (approvalRecord && (approvalState === 'REQUESTED' || approvalState === 'PRESENTED')) {
          await executionState().transition(approvalRecord.recordId, 'CANCELLED');
          approvalState = 'CANCELLED';
        }
        if (intentRecord && (intentState === 'PROPOSED' || intentState === 'SAFETY_EVALUATING' || intentState === 'WAITING_APPROVAL')) {
          await executionState().transition(intentRecord.recordId, 'REJECTED');
          intentState = 'REJECTED';
        }
        await maybeReleaseCoordinator(setupHoldRelease !== null);
      } catch {
        // Nested: a rollback throw must not reach the outer catch.
      } finally {
        if (setupHoldRelease) {
          setupHoldRelease();
          setupHoldRelease = null;
        }
        approvalContexts.delete(requestDigest);
        pending.cellOpSink?.markTerminal('CANCELLED');
      }
    };

    const checkpoint = async (label) => {
      if (typeof deps.hooks?.afterAwait === 'function') await deps.hooks.afterAwait(label);
      if (!cellId || !gate.isClosed(cellId)) return false;
      await rollbackClosed();
      return true;
    };

    try {
      if (cellId && !batchGranted) {
        const admitted = await gate.acquire(cellId);
        if (!admitted) {
          pending.cellOpSink?.markTerminal('CANCELLED');
          return false;
        }
        gateHeld = true;
      }
      if (await checkpoint('gate')) return false;

      const approvalExpiresAt = now() + ttlMs;
      safeRequest.approvalExpiresAt = approvalExpiresAt;

      const operationId = `operation-${requestId}`;
      const bindingSnapshot = deps.bindingSnapshot();
      const bindingSnapshotDigest = sha256Digest(JSON.stringify(bindingSnapshot));
      const capabilitySnapshot = deps.capabilitySnapshot();
      const scopeSnapshot = deps.buildScope({ capability, request, operationId, bindingSnapshotDigest });
      safeRequest.scope = { snapshotDigest: scopeSnapshot.snapshotDigest, capability };
      intentRecord = await executionState().createIntent({
        runId: deps.runId,
        capability,
        request,
        requestDigest,
        snapshotDigest: activeSnapshot,
        scope: scopeSnapshot,
        operationId,
        bindingSnapshot,
        capabilitySnapshot,
        releaseChannel: deps.releaseChannel(),
        executorIdentity: deps.executorIdentity(),
        policyVersion: 'runtime-safety-1'
      });
      intentState = 'PROPOSED';
      if (await checkpoint('createIntent')) return false;
      await executionState().transition(intentRecord.recordId, 'SAFETY_EVALUATING');
      intentState = 'SAFETY_EVALUATING';
      if (await checkpoint('safetyEvaluating')) return false;
      approvalRecord = await executionState().createApproval({
        runId: deps.runId,
        intentId: intentRecord.recordId,
        capability,
        requestDigest,
        displayedDigest: requestDigest,
        snapshotDigest: activeSnapshot,
        expiresAt: approvalExpiresAt,
        bindingSnapshot,
        capabilitySnapshot,
        releaseChannel: deps.releaseChannel(),
        policyVersion: 'runtime-safety-1'
      });
      approvalState = 'REQUESTED';
      if (await checkpoint('createApproval')) return false;
      await executionState().transition(approvalRecord.recordId, 'PRESENTED');
      approvalState = 'PRESENTED';
      if (await checkpoint('presented')) return false;
      await executionState().transition(intentRecord.recordId, 'WAITING_APPROVAL');
      intentState = 'WAITING_APPROVAL';
      if (await checkpoint('waitingApproval')) return false;
      pending.context = {
        intent: intentRecord,
        approval: approvalRecord,
        capability,
        request,
        scopeSnapshot,
        capabilitySnapshot
      };
      approvalContexts.set(requestDigest, pending.context);
      const live = deps.hasLiveApprover() === true;
      if (live && !batchGranted) {
        setupHoldRelease = takeHold();
        if (coordinator().state === 'EXECUTING') {
          await coordinator().transitionAndFlush('WAITING_APPROVAL', {
            reason: 'APPROVAL_REQUIRED',
            metadata: { requestId, capability }
          });
        }
      }
      if (await checkpoint('coordinator')) return false;
      if (await checkpoint('beforeActionIntent')) return false;
      deps.emitEvent('action_intent.created', {
        intentId: intentRecord.intentId ?? intentRecord.recordId,
        capability,
        requestDigest,
        snapshotDigest: activeSnapshot,
        policyVersion: 'runtime-safety-1'
      });
      await deps.appendGitAuditCheckpoint('ACTION_REQUESTED', {
        operationId: intentRecord.operationId,
        intentId: intentRecord.recordId,
        approvalId: approvalRecord.recordId
      }, { capability, scopeSnapshotDigest: scopeSnapshot.snapshotDigest });
      if (await checkpoint('audit')) return false;
      await deps.appendActionEvent('ActionRequested', {
        operationId: intentRecord.operationId,
        intentId: intentRecord.recordId,
        approvalId: approvalRecord.recordId,
        capability,
        requestDigest,
        scopeSnapshotDigest: scopeSnapshot.snapshotDigest
      });
      if (await checkpoint('actionEvent')) return false;
      if (batchGranted) {
        await executionState().transition(approvalRecord.recordId, 'APPROVED', { reason: 'KERNEL_BATCH_APPROVAL' });
        approvalState = 'APPROVED';
        if (await checkpoint('batchApproval')) return false;
        await executionState().transition(intentRecord.recordId, 'APPROVED', { reason: 'KERNEL_BATCH_APPROVAL' });
        intentState = 'APPROVED';
        if (await checkpoint('batchIntent')) return false;
        return true;
      }
      if (!live) {
        if (resolveApprovalOutcome({ requireApproval, hasLiveApprover: false }) === APPROVAL_OUTCOMES.REFUSE) {
          await executionState().transition(approvalRecord.recordId, 'DECLINED', { reason: 'APPROVAL_REQUIRED_NO_LIVE_APPROVER' });
          approvalState = 'DECLINED';
          if (await checkpoint('noLiveDeclined')) return false;
          await executionState().transition(intentRecord.recordId, 'REJECTED', { reason: 'APPROVAL_REQUIRED_NO_LIVE_APPROVER' });
          intentState = 'REJECTED';
          if (await checkpoint('noLiveRejected')) return false;
          approvalContexts.delete(requestDigest);
          if (await checkpoint('beforeRefused')) return false;
          deps.emitEvent('approval.refused', {
            requestId,
            capability,
            requestDigest,
            risk,
            reason: 'NO_LIVE_APPROVER',
            ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
            ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
          });
          return false;
        }
        await executionState().transition(approvalRecord.recordId, 'APPROVED', { reason: 'EXPLICIT_HOST_POLICY' });
        approvalState = 'APPROVED';
        if (await checkpoint('explicitApproval')) return false;
        await executionState().transition(intentRecord.recordId, 'APPROVED', { reason: 'EXPLICIT_HOST_POLICY' });
        intentState = 'APPROVED';
        if (await checkpoint('explicitIntent')) return false;
        return true;
      }
      if (await checkpoint('beforeInsert')) return false;
      armTimer(pending, requestId);
      pending.inserted = true;
      pendingApprovals.set(requestId, pending);
      if (setupHoldRelease) {
        setupHoldRelease();
        setupHoldRelease = null;
      }
      pending.cellOpSink?.onApprovalRequested(requestId);
      deps.emitEvent('approval.requested', {
        requestId,
        ...safeRequest,
        ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
        ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
      });
      keepGate = true;
      if (typeof deps.hooks?.afterClaimableInsert === 'function') deps.hooks.afterClaimableInsert({ pending, requestId });
      return approvalPromise;
    } catch (error) {
      if (pending.settled) return approvalPromise;
      logger.error?.(`approval request failed | requestId=${requestId} | error=${error?.stack ?? error}`);
      clearTimeout(pending.timer);
      pendingApprovals.delete(requestId);
      pending.resolve(false);
      return approvalPromise;
    } finally {
      if (!keepGate && setupHoldRelease) {
        setupHoldRelease();
        setupHoldRelease = null;
      }
      if (!keepGate) releaseGate();
    }
  };

  return {
    pendingApprovals,
    gate,
    holds,
    requestApproval,
    handleLine,
    settleCellEnd,
    cancelCell(cellId) {
      gate.cancel(cellId);
      return settleCellEnd(cellId);
    },
    reopenCell(cellId) {
      gate.reopen(cellId);
    },
    failAllPending() {
      for (const pending of pendingApprovals.values()) {
        clearTimeout(pending.timer);
        if (!pending.settled) {
          pending.settled = true;
          pending.resolve(false);
        }
      }
      pendingApprovals.clear();
    }
  };
};
