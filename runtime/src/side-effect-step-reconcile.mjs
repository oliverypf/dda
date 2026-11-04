// Decide whether an interrupted plan step may be retried.
//
// Read-only runs keep the historical rule: a killed observation is retried
// only when both the source run and the current run are READ_ONLY, and a step
// already persisted as SIDE_EFFECT_OUTCOME_UNCERTAIN stays blocked.
//
// Controlled runs retry when every side-effect intent for that step was
// rejected before a lease, or failed before the effect actually started.
// `onLeaseFailed` can set the intent FAILED and emit ActionFailed when the
// failure happens after the lease is issued but before the effect journal
// records STARTED. That path did not run the effect. A journal entry in
// LEASED, STARTED, COMPLETED, FAILED, or UNKNOWN means it did start (FAILED
// overwrites STARTED). A missing, unreadable, or ambiguous journal cannot
// prove the difference and stays blocked.
//
// Trajectory intent transitions are evidence even when the record store
// disagrees. EXECUTING or COMPLETED marks the intent executed. FAILED does
// too, except for the journal-proven pre-start path above: that path also
// records the EXECUTING transition from onLeaseIssued, and a readable journal
// with no start row is what shows the effect never ran.

const EXECUTION_INTENT_STATES = new Set(['APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED']);
const SAFE_APPROVAL_STATES = new Set(['EXPIRED', 'DECLINED', 'CANCELLED']);
const SIDE_EFFECT_TOOLS = new Set([
  'file.write', 'file.patch', 'shell.execute', 'test.execute', 'network.request', 'kernel.exec'
]);
const JOURNAL_EXECUTED_STATES = new Set(['LEASED', 'STARTED', 'COMPLETED', 'FAILED', 'UNKNOWN']);
const HARD_EVENT_KINDS = new Set(['ActionExecuted', 'TaskFileWritten', 'TaskWriteEffectUnverified']);
const PRE_START_EVENT_KINDS = new Set(['ActionAuthorized', 'ActionLeased', 'ActionFailed', 'LeaseExecutionFailed']);
const UNCERTAIN_REASON = /UNCERTAIN|SCOPE_VIOLATION/u;

// Eight runs was short enough that a thread resumed across a working session
// walked off the end and locked again. The cap still rejects a truncated log:
// the oldest walked run must have exactly one TaskRunCreated, and a cycle or
// a duplicate creation is unknown. File replay uses the same bound.
export const RECOVERY_LINEAGE_RUN_LIMIT = 64;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uncertain = (reason) => ({ status: 'UNCERTAIN', reason });
const upper = (value) => typeof value === 'string' ? value.toUpperCase() : '';

// Coordinator events are stored with the producer payload one level down.
// Direct trajectory appends keep the fields on the event payload itself.
const unwrap = (event) => {
  const payload = event?.payload;
  if (!isRecord(payload)) return {};
  return isRecord(payload.payload) ? payload.payload : payload;
};

const transitionsOf = (record) => Array.isArray(record?.transitionHistory) ? record.transitionHistory : null;

const transitionReason = (transition) => {
  const reason = transition?.metadata?.reason ?? transition?.reason;
  return typeof reason === 'string' ? reason : '';
};

const historyShowsExecution = (record) => {
  const history = transitionsOf(record);
  if (!history) return true;
  return history.some((transition) => EXECUTION_INTENT_STATES.has(upper(transition?.to))
    || EXECUTION_INTENT_STATES.has(upper(transition?.from))
    || UNCERTAIN_REASON.test(transitionReason(transition)));
};

const approvalGranted = (approval) => {
  if (upper(approval?.state) === 'APPROVED') return true;
  const history = transitionsOf(approval) ?? [];
  return history.some((transition) => upper(transition?.to) === 'APPROVED' || upper(transition?.from) === 'APPROVED');
};

const lineageRunIds = (events, sourceRunId) => {
  if (typeof sourceRunId !== 'string' || !sourceRunId.trim()) return undefined;
  const newestFirst = [];
  const seen = new Set();
  let runId = sourceRunId;
  while (runId) {
    if (seen.has(runId) || newestFirst.length >= RECOVERY_LINEAGE_RUN_LIMIT) return undefined;
    seen.add(runId);
    newestFirst.push(runId);
    const created = events.filter((event) => event?.runId === runId && event?.kind === 'TaskRunCreated');
    if (created.length > 1) return undefined;
    if (created.length === 0) break;
    const next = unwrap(created[0]).sourceRunId;
    if (typeof next !== 'string' || !next.trim() || next === runId) break;
    runId = next;
  }
  const oldest = newestFirst.at(-1);
  const rootCreated = events.filter((event) => event?.runId === oldest && event?.kind === 'TaskRunCreated');
  // The oldest run we could walk to must itself have a creation event.
  // A missing root means the log was truncated and intents may be hidden.
  if (rootCreated.length !== 1) return undefined;
  return newestFirst.reverse();
};

const activeStepIdFrom = (payload) => {
  const steps = Array.isArray(payload?.steps) ? payload.steps : null;
  if (!steps) return null;
  const running = steps.filter((step) => upper(step?.status) === 'RUNNING' && typeof step?.stepId === 'string' && step.stepId);
  if (running.length === 1) return running[0].stepId;
  if (running.length === 0) return undefined;
  return null;
};

const sideEffectInvocationExecuted = (payload) => {
  if (!SIDE_EFFECT_TOOLS.has(payload?.name)) return false;
  return payload?.ok === true || payload?.errorCode === 'TOOL_OUTPUT_AFTER_EFFECT' || payload?.effectApplied === true;
};

const attributeLineage = (events, runIds) => {
  const order = new Map(runIds.map((runId, index) => [runId, index]));
  const ordered = events
    .filter((event) => order.has(event?.runId))
    .slice()
    .sort((left, right) => order.get(left.runId) - order.get(right.runId)
      || (left.sequence ?? 0) - (right.sequence ?? 0)
      || String(left.eventId ?? '').localeCompare(String(right.eventId ?? '')));
  const intentOwner = new Map();
  const intentHard = new Set();
  const intentPreStart = new Set();
  const intentTrajectoryStates = new Map();
  const stepHard = new Set();
  let ambiguousHard = false;
  let activeStepId;
  let currentRunId;

  const ownIntent = (intentId) => {
    if (typeof intentId !== 'string' || !intentId || intentOwner.has(intentId)) return;
    intentOwner.set(intentId, typeof activeStepId === 'string' ? activeStepId : null);
  };
  const markHard = (intentId) => {
    if (typeof intentId === 'string' && intentId) {
      ownIntent(intentId);
      intentHard.add(intentId);
      const owner = intentOwner.get(intentId);
      if (typeof owner === 'string') stepHard.add(owner);
      return;
    }
    if (typeof activeStepId === 'string') stepHard.add(activeStepId);
    else ambiguousHard = true;
  };
  const markPreStart = (intentId) => {
    if (typeof intentId !== 'string' || !intentId) {
      ambiguousHard = true;
      return;
    }
    ownIntent(intentId);
    intentPreStart.add(intentId);
  };

  for (const event of ordered) {
    if (event.runId !== currentRunId) {
      currentRunId = event.runId;
      activeStepId = undefined;
    }
    const payload = unwrap(event);
    if (event.kind === 'PlanStepStateChanged') activeStepId = activeStepIdFrom(payload);
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'intent') {
      const intentId = typeof payload.recordId === 'string' && payload.recordId ? payload.recordId : payload.intentId;
      ownIntent(intentId);
      const trajectoryState = upper(payload.state);
      if (trajectoryState === 'EXECUTING' || trajectoryState === 'COMPLETED' || trajectoryState === 'FAILED') {
        if (typeof intentId !== 'string' || !intentId) ambiguousHard = true;
        else {
          const seen = intentTrajectoryStates.get(intentId) ?? new Set();
          seen.add(trajectoryState);
          intentTrajectoryStates.set(intentId, seen);
        }
      }
    }
    if (event.kind === 'ActionRequested') ownIntent(payload.intentId);
    if (typeof payload.errorCode === 'string' && payload.errorCode.includes('SCOPE_VIOLATION')) markHard(payload.intentId);
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'lease' && upper(payload.state) === 'CONSUMED') {
      markHard(payload.intentId);
    }
    if (HARD_EVENT_KINDS.has(event.kind)) markHard(payload.intentId);
    if (event.kind === 'ToolInvocationCompleted' && sideEffectInvocationExecuted(payload)) markHard(payload.intentId);
    if (PRE_START_EVENT_KINDS.has(event.kind)) markPreStart(payload.intentId);
  }
  return { intentOwner, intentHard, intentPreStart, intentTrajectoryStates, stepHard, ambiguousHard };
};

const rejectedBeforeExecution = (intent, records) => {
  if (upper(intent?.state) !== 'REJECTED') return false;
  if (historyShowsExecution(intent)) return false;
  const history = transitionsOf(intent);
  if (!history || history.length === 0) return false;
  const approvals = records.filter((record) => record?.recordType === 'approval' && record.intentId === intent.recordId);
  const leases = records.filter((record) => record?.recordType === 'lease' && record.intentId === intent.recordId);
  if (leases.length > 0) return false;
  const waitedForApproval = history.some((transition) => upper(transition?.to) === 'WAITING_APPROVAL'
    || upper(transition?.from) === 'WAITING_APPROVAL');
  if (approvals.length === 0) return !waitedForApproval;
  return approvals.every((approval) => SAFE_APPROVAL_STATES.has(upper(approval?.state)) && !approvalGranted(approval));
};

const resolveJournal = (journalStatus, journalEffects) => {
  if (journalStatus === 'unreadable') return { status: 'unreadable', effects: [] };
  if (journalStatus === 'absent') {
    if (Array.isArray(journalEffects) && journalEffects.length > 0) return { status: 'invalid', effects: [] };
    return { status: 'absent', effects: [] };
  }
  if (journalStatus === 'ready' || journalStatus === undefined) {
    return Array.isArray(journalEffects)
      ? { status: 'ready', effects: journalEffects }
      : { status: 'invalid', effects: [] };
  }
  return { status: 'invalid', effects: [] };
};

const journalLink = (effect, records, events) => {
  if (typeof effect.intentId === 'string' && effect.intentId) return { kind: 'id', intentId: effect.intentId };
  if (typeof effect.leaseId === 'string' && effect.leaseId) {
    const lease = records.find((record) => record?.recordType === 'lease' && record.recordId === effect.leaseId);
    if (typeof lease?.intentId === 'string' && lease.intentId) return { kind: 'id', intentId: lease.intentId };
    for (const event of events) {
      const payload = unwrap(event);
      if (payload.leaseId === effect.leaseId && typeof payload.intentId === 'string' && payload.intentId) {
        return { kind: 'id', intentId: payload.intentId };
      }
    }
    return { kind: 'ambiguous' };
  }
  if (typeof effect.operationId === 'string' && effect.operationId) {
    const intent = records.find((record) => record?.recordType === 'intent' && record.operationId === effect.operationId);
    if (typeof intent?.recordId === 'string') return { kind: 'id', intentId: intent.recordId };
    return { kind: 'ambiguous' };
  }
  return { kind: 'unlinked' };
};

const journalExecution = (journal, records, events, runIds) => {
  const started = new Set();
  const knownIntents = new Set(records.filter((record) => record?.recordType === 'intent').map((record) => record.recordId));
  let unlinked = 0;
  let ambiguous = false;
  if (journal.status !== 'ready') return { started, unlinked, ambiguous };
  const runs = new Set(runIds);
  for (const effect of journal.effects) {
    if (!isRecord(effect) || !JOURNAL_EXECUTED_STATES.has(effect.state)) continue;
    if (typeof effect.runId !== 'string' || !effect.runId) {
      ambiguous = true;
      continue;
    }
    if (!runs.has(effect.runId)) continue;
    const link = journalLink(effect, records, events);
    if (link.kind === 'ambiguous' || (link.kind === 'id' && !knownIntents.has(link.intentId))) {
      ambiguous = true;
      continue;
    }
    if (link.kind === 'id') started.add(link.intentId);
    else unlinked += 1;
  }
  return { started, unlinked, ambiguous };
};

const journalProvenPreStart = (intent, records, journal, journalFacts) => {
  if (upper(intent?.state) !== 'FAILED' || journal.status !== 'ready') return false;
  if (journalFacts.started.has(intent.recordId)) return false;
  const leases = records.filter((record) => record?.recordType === 'lease' && record.intentId === intent.recordId);
  if (leases.some((lease) => upper(lease?.state) === 'CONSUMED')) return false;
  const history = transitionsOf(intent);
  if (!history || history.length === 0) return false;
  if (history.some((transition) => transitionReason(transition).includes('SCOPE_VIOLATION'))) return false;
  return true;
};

const intentVerdict = (intent, records, attributed, journal, journalFacts) => {
  if (attributed.intentHard.has(intent.recordId)) return 'executed';
  const state = upper(intent.state);
  if (state === 'APPROVED' || state === 'EXECUTING' || state === 'COMPLETED') return 'executed';
  const leases = records.filter((record) => record?.recordType === 'lease' && record.intentId === intent.recordId);
  if (leases.some((lease) => upper(lease?.state) === 'CONSUMED')) return 'executed';
  if (journalFacts.started.has(intent.recordId)) return 'journal-started';
  // The record store cannot explain away a trajectory transition. COMPLETED
  // always ran. EXECUTING and FAILED ran unless this intent is the
  // journal-proven pre-start failure, which records both of those states
  // before the effect starts.
  const trajectory = attributed.intentTrajectoryStates.get(intent.recordId);
  const preStartProven = journalProvenPreStart(intent, records, journal, journalFacts);
  if (trajectory?.has('COMPLETED')) return 'executed';
  if (trajectory?.has('EXECUTING') && !preStartProven) return 'executed';
  if (trajectory?.has('FAILED') && !preStartProven) return 'executed';
  if (preStartProven) return 'before-start';
  if (attributed.intentPreStart.has(intent.recordId)) return 'unknown';
  if (rejectedBeforeExecution(intent, records)) return 'rejected';
  return 'unknown';
};

const classifyControlledStep = ({ stepId, events, records, sourceRunId, journalStatus, journalEffects }) => {
  const journal = resolveJournal(journalStatus, journalEffects);
  if (journal.status === 'invalid') return uncertain('EVIDENCE_INVALID');
  if (journal.status === 'unreadable') return uncertain('JOURNAL_UNREADABLE');
  const runIds = lineageRunIds(events, sourceRunId);
  if (!runIds) return uncertain('LINEAGE_UNKNOWN');
  const { intentOwner, intentHard, intentPreStart, intentTrajectoryStates, stepHard, ambiguousHard } = attributeLineage(events, runIds);
  if (ambiguousHard) return uncertain('AMBIGUOUS_EXECUTION');
  const lineageIntents = records.filter((record) => record?.recordType === 'intent' && runIds.includes(record.runId));
  for (const intent of lineageIntents) {
    if (typeof intentOwner.get(intent.recordId) !== 'string') return uncertain('UNATTRIBUTED_INTENT');
  }
  const journalFacts = journalExecution(journal, records, events, runIds);
  if (journalFacts.ambiguous) return uncertain('JOURNAL_AMBIGUOUS');
  const attributed = { intentHard, intentPreStart, intentTrajectoryStates };
  const stepIntentIds = [...intentOwner.entries()]
    .filter(([, owner]) => owner === stepId)
    .map(([intentId]) => intentId);
  if (stepIntentIds.length === 0) return uncertain('NO_STEP_INTENTS');
  if (stepHard.has(stepId) || stepIntentIds.some((intentId) => intentHard.has(intentId))) {
    return uncertain('STEP_EXECUTION_RECORDED');
  }
  const stepIntents = [];
  let stoppedBeforeStart = false;
  for (const intentId of stepIntentIds) {
    const intent = records.find((record) => record?.recordType === 'intent' && record.recordId === intentId);
    if (!intent || !runIds.includes(intent.runId)) return uncertain('MISSING_INTENT_RECORD');
    const verdict = intentVerdict(intent, records, attributed, journal, journalFacts);
    if (verdict === 'before-start') stoppedBeforeStart = true;
    else if (verdict === 'journal-started') return uncertain('JOURNAL_EFFECT_STARTED');
    else if (verdict === 'executed') return uncertain('STEP_EXECUTION_RECORDED');
    else if (verdict !== 'rejected') return uncertain('EXECUTION_OR_UNKNOWN');
    stepIntents.push(intent);
  }
  if (stepIntents.length === 0) return uncertain('NO_STEP_INTENTS');
  const unsafe = lineageIntents.filter((intent) => {
    const verdict = intentVerdict(intent, records, attributed, journal, journalFacts);
    return verdict !== 'rejected' && verdict !== 'before-start';
  }).length;
  if (journalFacts.unlinked > unsafe) return uncertain('JOURNAL_EXECUTION_UNACCOUNTED');
  return {
    status: 'RETRY',
    reason: stoppedBeforeStart ? 'FAILED_BEFORE_START' : 'ALL_INTENTS_REJECTED_BEFORE_EXECUTION'
  };
};

/**
 * Reconciliation result for one interrupted plan step.
 * `RETRY` is safe to run again. `UNCERTAIN` must stay blocked.
 *
 * `journalStatus` is `ready` after a successful list, `absent` when this run
 * has no effect journal, and `unreadable` when the list failed. Omitting it
 * treats an array of effects as a successful read.
 */
export const reconcileInterruptedPlanStep = ({
  mode,
  readOnlyObservationRetry = false,
  step,
  events = [],
  records = [],
  sourceRunId,
  journalEffects = [],
  journalStatus
} = {}) => {
  const persistedUncertain = step?.status === 'BLOCKED' && step?.errorCode === 'SIDE_EFFECT_OUTCOME_UNCERTAIN';
  if (mode !== 'CONTROLLED') {
    if (readOnlyObservationRetry === true && !persistedUncertain) return { status: 'RETRY', reason: 'READ_ONLY_OBSERVATION' };
    return uncertain('READ_ONLY_UNCHANGED');
  }
  if (!step || typeof step.stepId !== 'string' || !step.stepId) return uncertain('STEP_INVALID');
  if (!Array.isArray(events) || !Array.isArray(records)) return uncertain('EVIDENCE_INVALID');
  try {
    return classifyControlledStep({
      stepId: step.stepId,
      events,
      records,
      sourceRunId,
      journalStatus,
      journalEffects
    });
  } catch {
    return uncertain('CLASSIFY_FAILED');
  }
};
