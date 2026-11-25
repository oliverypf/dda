import { randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { approvalSubject, cellApprovalPresentation } from './cell-approval.mjs';
import { executionDigest } from '../execution-state-store.mjs';
import { CAPABILITIES, parseCommand } from '../runtime-safety-monitor.mjs';
import { currentAccessMode } from '../filesystem-access.mjs';
import { sha256Digest } from '../trajectory-store.mjs';
import { APPROVAL_ERROR_CODES, APPROVAL_OUTCOMES, resolveApprovalOutcome, assessRequestRisk, classifySessionCommand, COMMAND_OUTSIDE_SESSION_LEASE } from '../controlled-tools.mjs';


const requireDirectory = async (path) => {
  if (!(await lstat(path)).isDirectory()) throw new Error('COMMAND_APPROVAL_STORE_INVALID');
};

// Each grant is an empty directory named by the digest of its scope. Creating
// it is atomic across runtime processes, and no command arguments are stored.
const commandApprovals = (directory) => {
  const has = async (key) => {
    try {
      await requireDirectory(dirname(directory));
      await requireDirectory(directory);
      await requireDirectory(join(directory, key));
      return true;
    } catch { return false; }
  };
  const save = async (key) => {
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    await requireDirectory(dirname(directory));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await requireDirectory(directory);
    try {
      await mkdir(join(directory, key), { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST' || !(await has(key))) throw error;
    }
  };
  return { has, save };
};

const commandApprovalKey = async ({ workspaceRoot, capability, command, args, cwd = '.' }) => {
  try {
    const root = await realpath(workspaceRoot);
    const directory = await realpath(resolve(root, cwd));
    const subpath = relative(root, directory);
    if (isAbsolute(subpath) || subpath === '..' || subpath.startsWith(`..${sep}`)) return undefined;
    if (!(await stat(directory)).isDirectory()) return undefined;
    return executionDigest({ version: 1, root, directory, capability, command, args }).slice('sha256:'.length);
  } catch { return undefined; }
};

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
  // No TTL by default: a pending approval waits for the user's answer, a
  // cancelled task, or the end of its cell. A host may still pass a bound.
  const ttlMs = Number.isFinite(deps.approvalTtlMs) && deps.approvalTtlMs > 0 ? deps.approvalTtlMs : undefined;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;
  const savedApprovals = deps.commandApprovalDirectory ? commandApprovals(deps.commandApprovalDirectory) : undefined;

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

  const emitResolved = (pending, requestId, state, alwaysAllowSaved) => {
    deps.emitEvent('approval.resolved', {
      requestId,
      state,
      displayedDigest: pending.requestDigest,
      ...(alwaysAllowSaved === undefined ? {} : { alwaysAllowSaved }),
      ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
      ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
    });
  };

  const settleWinner = (pending, requestId, { state, coordinatorNext, coordinatorReason, deleteContext, alwaysAllow }) => {
    const releaseHold = takeHold();
    void (async () => {
      try {
        const approved = state === 'APPROVED';
        const decisionReason = approved ? 'USER_APPROVED' : state === 'EXPIRED' ? 'APPROVAL_EXPIRED' : 'USER_DECLINED';
        if (pending.context?.approval) {
          await executionState().transition(pending.context.approval.recordId, approved ? 'APPROVED' : state === 'EXPIRED' ? 'EXPIRED' : 'DECLINED', { reason: decisionReason });
        }
        if (pending.context?.intent) {
          await executionState().transition(pending.context.intent.recordId, approved ? 'APPROVED' : 'REJECTED', { reason: decisionReason });
        }
        if (deleteContext) approvalContexts.delete(pending.requestDigest);
        if (coordinator().state === 'WAITING_APPROVAL' && coordinatorNext) {
          await coordinator().transitionAndFlush(coordinatorNext, {
            reason: coordinatorReason,
            metadata: { requestId }
          });
        }
        let alwaysAllowSaved;
        if (approved && alwaysAllow) {
          try {
            await savedApprovals.save(pending.commandApprovalKey);
            alwaysAllowSaved = true;
          } catch {
            alwaysAllowSaved = false;
          }
        }
        if (state === 'EXPIRED') deps.emitEvent('approval.expired', { requestId });
        else emitResolved(pending, requestId, state, alwaysAllowSaved);
        if (state === 'DECLINED' || state === 'EXPIRED') pending.cellOpSink?.markTerminal(state);
        pending.cellOpSink?.onApprovalSettled(state);
        if (state === 'EXPIRED' || state === 'DECLINED') {
          // Keep the public return value boolean for existing callers, while
          // allowing the lease provider to preserve the reason a live card
          // failed. A no-live refusal never reaches this settlement path and
          // therefore remains an ordinary missing-lease failure.
          pending.onApprovalFailure?.({
            code: state === 'EXPIRED' ? APPROVAL_ERROR_CODES.EXPIRED : APPROVAL_ERROR_CODES.DENIED,
            requestId,
            state
          });
        }
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
      const approved = message.approved === true;
      const alwaysAllow = message.alwaysAllow === true;
      if (alwaysAllow && (!approved || !pending.commandApprovalKey || pending.context.approval.expiresAt <= now())) return;
      if (!claim(pending, message.requestId)) return;
      settleWinner(pending, message.requestId, {
        state: approved ? 'APPROVED' : 'DECLINED',
        coordinatorNext: approved ? 'EXECUTING' : 'FAILED',
        coordinatorReason: approved ? 'APPROVAL_GRANTED' : 'APPROVAL_DECLINED',
        deleteContext: !approved,
        alwaysAllow
      });
    } catch {
      // Ignore malformed host input; the pending approval will expire safely.
    }
  };

  const armTimer = (pending, requestId) => {
    if (ttlMs === undefined) return;
    pending.timer = setTimeout(() => {
      if (!claim(pending, requestId)) return;
      settleWinner(pending, requestId, {
        state: 'EXPIRED',
        // Expiry rejects this effect, but leaves the run available for the
        // model to handle the observation or request approval again.
        coordinatorNext: 'EXECUTING',
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
            await executionState().transition(approval.recordId, 'CANCELLED', { reason: 'CELL_ENDED_BEFORE_DECISION' });
          }
          const intent = pending.context?.intent
            ? executionState().get(pending.context.intent.recordId)
            : undefined;
          if (intent && intent.state === 'WAITING_APPROVAL') {
            await executionState().transition(intent.recordId, 'REJECTED', { reason: 'CELL_ENDED_BEFORE_DECISION' });
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

  const requestApproval = async ({ capability, request, requireApproval = false, mandatoryApproval = false, allowRememberedCommand = !mandatoryApproval, jevAllowsOutsideCommand = false, risk: providedRisk, dangerReasons, policyReasonCodes = [], context: approvalCallContext, onApprovalFailure } = {}) => {
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
      onApprovalFailure: undefined,
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
    pending.onApprovalFailure = typeof onApprovalFailure === 'function' ? onApprovalFailure : undefined;
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
          await executionState().transition(approvalRecord.recordId, 'CANCELLED', { reason: 'APPROVAL_INTERRUPTED' });
          approvalState = 'CANCELLED';
        }
        if (intentRecord && (intentState === 'PROPOSED' || intentState === 'SAFETY_EVALUATING' || intentState === 'WAITING_APPROVAL')) {
          await executionState().transition(intentRecord.recordId, 'REJECTED', { reason: 'APPROVAL_INTERRUPTED' });
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

      const approvalExpiresAt = ttlMs === undefined ? undefined : now() + ttlMs;
      if (approvalExpiresAt !== undefined) safeRequest.approvalExpiresAt = approvalExpiresAt;

      const operationId = `operation-${requestId}`;
      const bindingSnapshot = deps.bindingSnapshot();
      const bindingSnapshotDigest = sha256Digest(JSON.stringify(bindingSnapshot));
      const capabilitySnapshot = deps.capabilitySnapshot();
      const resolvedAccessMode = typeof deps.getWorkspaceAccessMode === 'function'
        ? await deps.getWorkspaceAccessMode()
        : undefined;
      const scopeSnapshot = await deps.buildScope({
        capability,
        request,
        operationId,
        bindingSnapshotDigest,
        accessMode: resolvedAccessMode
      });
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
      // A persisted FULL_ACCESS grant covers ordinary controlled requests.
      // Dangerous requests, mandatory gates, and anything the host cannot
      // classify stay on the human path. assessRequestRisk already treats an
      // inline interpreter inside a git workspace as ordinary under FULL_ACCESS.
      // The session re-assesses the request itself — caller-supplied flags are
      // never trusted — and fails closed when the assessment cannot prove the
      // request ordinary or the shape is not a known meaningful request.
      const ORDINARY_CAPS = new Set(['shell.execute', 'file.write', 'test.execute', 'network.request']);
      const kernelBatchOrdinary = async () => {
        if (!Array.isArray(request?.kernelBatchItems)) return true;
        for (const item of request.kernelBatchItems) {
          let safe = false;
          try {
            safe = typeof deps.isSafeKernelBatchItem === 'function'
              && await deps.isSafeKernelBatchItem(item) === true;
          } catch { safe = false; }
          if (!safe) return false;
        }
        return true;
      };
      const meaningfulRequest = () => {
        if (!ORDINARY_CAPS.has(capability)) return false;
        if (capability === CAPABILITIES.WRITE_FILE) {
          return (typeof request?.path === 'string' && request.path.trim().length > 0)
            || (Array.isArray(request?.kernelBatchItems) && request.kernelBatchItems.length > 0);
        }
        if (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST) {
          return typeof request?.command === 'string' && request.command.trim().length > 0;
        }
        if (capability === CAPABILITIES.NETWORK) {
          return typeof request?.host === 'string' && request.host.trim().length > 0;
        }
        return false;
      };
      const liveMode = await currentAccessMode(deps.getWorkspaceAccessMode);
      let independent;
      try {
        const assessor = typeof deps.assessRequestRisk === 'function' ? deps.assessRequestRisk : assessRequestRisk;
        independent = assessor({ capability, request, workspaceRoot: deps.workspaceRoot, accessMode: liveMode });
      } catch { independent = undefined; }
      const snapshotCommands = (() => {
        try {
          const snap = typeof deps.capabilitySnapshot === 'function' ? deps.capabilitySnapshot() : undefined;
          return Array.isArray(snap?.commands) ? snap.commands : [];
        } catch {
          return [];
        }
      })();
      const outsideLease = (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST)
        && classifySessionCommand(snapshotCommands, request).outside === true;
      // The lease provider sets this only after a real Jev ALLOW. Danger is
      // rechecked here; a caller flag cannot cover a dangerous command.
      const jevCoversOutside = jevAllowsOutsideCommand === true && independent?.dangerous === false;
      const outsideNeedsHuman = outsideLease && !jevCoversOutside;
      const fullAccessAuto = !batchGranted && requireApproval !== true && mandatoryApproval !== true && !outsideNeedsHuman
        && meaningfulRequest()
        && independent?.dangerous === false
        && liveMode === 'FULL_ACCESS'
        && await kernelBatchOrdinary();
      // Host-authored review reasons come only from the independent
      // assessment — never the caller's claimed danger flags. The preview is
      // JSON argv for human review, never re-evaluated as a shell line.
      const reasonCodes = (() => {
        const codes = [];
        if (outsideNeedsHuman) codes.push(COMMAND_OUTSIDE_SESSION_LEASE);
        if (independent?.dangerous === true && Array.isArray(independent.reasons)) {
          for (const code of independent.reasons) {
            if (typeof code === 'string' && /^[A-Z_]{3,48}$/.test(code) && !codes.includes(code)) codes.push(code);
            if (codes.length >= 8) break;
          }
        }
        // Only host gate metadata reaches this parameter. Model danger claims
        // still cannot classify an action as dangerous or remove a host reason.
        for (const code of Array.isArray(policyReasonCodes) ? policyReasonCodes : []) {
          if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*(?::[a-zA-Z0-9_.-]+)?$/.test(code)
            && code.length <= 160 && !codes.includes(code)) codes.push(code);
        }
        if (codes.length) return codes.slice(0, 16);
        if (mandatoryApproval === true) return ['MANDATORY_SAFETY_REVIEW'];
        if (!independent) return ['SAFETY_ASSESSMENT_UNAVAILABLE'];
        return ['HOST_SAFETY_REVIEW_REQUIRED'];
      })();
      safeRequest.reasonCodes = reasonCodes;
      // Capability-level HIGH means a side effect needs care, not that a
      // concrete dangerous operation was found. Keep lease/risk policy intact.
      safeRequest.reviewKind = independent?.reasons?.some((code) => /^(DANGEROUS_|EXTREME_)/.test(code))
        ? 'DANGER' : independent ? 'REVIEW' : 'UNKNOWN';
      if (independent?.dangerous === true) safeRequest.risk = 'HIGH';
      if (capability === CAPABILITIES.WRITE_FILE && typeof request?.content === 'string') {
        const fileReview = approvalCallContext?.hostFileReview;
        const matches = fileReview?.path === request.path
          && fileReview?.contentDigest === sha256Digest(request.content)
          && typeof fileReview?.diff === 'string';
        const preview = matches ? fileReview.diff : request.content;
        safeRequest.filePreviewKind = matches ? 'DIFF' : 'CONTENT';
        safeRequest.filePreview = preview.slice(0, 16384);
        safeRequest.filePreviewTruncated = preview.length > 16384 || (matches && fileReview.diffTruncated === true);
        safeRequest.contentBytes = Buffer.byteLength(request.content, 'utf8');
      }
      if (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST) {
        try {
          const parsed = parseCommand(request);
          if (parsed) {
            const preview = JSON.stringify({ command: parsed.command, args: parsed.args, cwd: request.cwd ?? '.' }, null, 2);
            if (preview.length <= 16384) {
              safeRequest.commandPreview = preview;
              if (savedApprovals && !cellId && !approvalCallContext?.kernelEffect
                && independent?.dangerous === false
                && (liveMode !== 'FULL_ACCESS' || !assessRequestRisk({ capability, request, workspaceRoot: deps.workspaceRoot }).dangerous)) {
                pending.commandApprovalKey = await commandApprovalKey({
                  ...parsed, capability, workspaceRoot: deps.workspaceRoot, cwd: request.cwd
                });
                if (pending.commandApprovalKey) safeRequest.canAlwaysAllow = true;
              }
            } else {
              safeRequest.commandPreview = preview.slice(0, 16384);
              safeRequest.commandPreviewTruncated = true;
            }
          }
        } catch { /* unparsed commands get no preview */ }
      }
      const rememberedCommandAuto = !batchGranted && allowRememberedCommand && pending.commandApprovalKey
        && await savedApprovals.has(pending.commandApprovalKey);
      const live = deps.hasLiveApprover() === true;
      if (live && !batchGranted && !fullAccessAuto && !rememberedCommandAuto) {
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
      if (fullAccessAuto || rememberedCommandAuto) {
        // A grant removed during approval setup falls back to a live review.
        const useSavedApproval = rememberedCommandAuto && await savedApprovals.has(pending.commandApprovalKey);
        const grantNow = fullAccessAuto && await currentAccessMode(deps.getWorkspaceAccessMode) === 'FULL_ACCESS';
        if (useSavedApproval || grantNow) {
          const reason = useSavedApproval ? 'SAVED_COMMAND_APPROVAL' : 'COMPUTER_FULL_ACCESS';
          await executionState().transition(approvalRecord.recordId, 'APPROVED', { reason });
          approvalState = 'APPROVED';
          if (await checkpoint('fullAccessApproval')) return false;
          await executionState().transition(intentRecord.recordId, 'APPROVED', { reason });
          intentState = 'APPROVED';
          if (await checkpoint('fullAccessIntent')) return false;
          deps.emitEvent('approval.auto_approved', {
            requestId,
            approvalId: approvalRecord.recordId,
            intentId: intentRecord.recordId,
            requestDigest,
            ...(useSavedApproval
              ? { mode: 'ALWAYS_ALLOW', scope: 'WORKSPACE_COMMAND' }
              : { mode: 'FULL_ACCESS', scope: 'USER_FILESYSTEM' }),
            workspaceRootDigest: sha256Digest(String(deps.workspaceRoot ?? ''))
          });
          return true;
        }
        // Revoked between assessment and commit: acquire the hold the early
        // check skipped so the UI/run state matches a real pending approval.
        if (live) {
          setupHoldRelease = takeHold();
          if (coordinator().state === 'EXECUTING') {
            await coordinator().transitionAndFlush('WAITING_APPROVAL', {
              reason: 'APPROVAL_REQUIRED',
              metadata: { requestId, capability }
            });
          }
        }
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
