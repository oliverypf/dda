// Decide whether an interrupted plan step may be retried.
//
// Read-only runs keep the historical rule: a killed observation is retried
// only when both the source run and the current run are READ_ONLY, and a step
// already persisted as SIDE_EFFECT_OUTCOME_UNCERTAIN stays blocked.
//
// Controlled runs retry only when every side-effect intent recorded for that
// step was rejected, expired, or denied, and none of them has an execution
// started or committed record. Any executed intent, or any intent whose state
// cannot be proved, stays SIDE_EFFECT_OUTCOME_UNCERTAIN.

const EXECUTION_INTENT_STATES = new Set(['APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED']);
const SAFE_APPROVAL_STATES = new Set(['EXPIRED', 'DECLINED', 'CANCELLED']);
const SIDE_EFFECT_TOOLS = new Set([
  'file.write', 'file.patch', 'shell.execute', 'test.execute', 'network.request', 'kernel.exec'
]);
const JOURNAL_EXECUTED_STATES = new Set(['LEASED', 'STARTED', 'COMPLETED', 'FAILED', 'UNKNOWN']);
const UNCERTAIN_REASON = /UNCERTAIN|SCOPE_VIOLATION/u;

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
    if (seen.has(runId) || newestFirst.length >= 8) return undefined;
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
  const executedIntentIds = new Set();
  const stepExecution = new Set();
  let ambiguousExecution = false;
  let activeStepId;
  let currentRunId;

  const ownIntent = (intentId) => {
    if (typeof intentId !== 'string' || !intentId || intentOwner.has(intentId)) return;
    intentOwner.set(intentId, typeof activeStepId === 'string' ? activeStepId : null);
  };
  const markExecuted = (intentId) => {
    if (typeof intentId === 'string' && intentId) {
      executedIntentIds.add(intentId);
      const owner = intentOwner.get(intentId);
      if (typeof owner === 'string') {
        stepExecution.add(owner);
        return;
      }
    }
    if (typeof activeStepId === 'string') stepExecution.add(activeStepId);
    else ambiguousExecution = true;
  };

  for (const event of ordered) {
    if (event.runId !== currentRunId) {
      currentRunId = event.runId;
      activeStepId = undefined;
    }
    const payload = unwrap(event);
    if (event.kind === 'PlanStepStateChanged') activeStepId = activeStepIdFrom(payload);
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'intent') ownIntent(payload.recordId);
    if (event.kind === 'ActionRequested') ownIntent(payload.intentId);
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'intent'
      && EXECUTION_INTENT_STATES.has(upper(payload.state))) {
      markExecuted(payload.recordId);
    }
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'lease') markExecuted(payload.intentId);
    if (event.kind === 'ExecutionStateChanged' && payload.recordType === 'approval' && upper(payload.state) === 'APPROVED') {
      markExecuted(payload.intentId);
    }
    if (['ActionAuthorized', 'ActionLeased', 'ActionExecuted', 'ActionFailed', 'LeaseExecutionFailed',
      'TaskFileWritten', 'TaskWriteEffectUnverified'].includes(event.kind)) {
      markExecuted(payload.intentId);
    }
    if (event.kind === 'ToolInvocationCompleted' && sideEffectInvocationExecuted(payload)) markExecuted(payload.intentId);
  }
  return { intentOwner, executedIntentIds, stepExecution, ambiguousExecution };
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

const journalExecutedCount = (journalEffects, runIds) => {
  if (!Array.isArray(journalEffects) || journalEffects.length === 0) return 0;
  const runs = new Set(runIds);
  let count = 0;
  for (const effect of journalEffects) {
    if (!isRecord(effect) || !JOURNAL_EXECUTED_STATES.has(effect.state)) continue;
    if (typeof effect.runId !== 'string' || !runs.has(effect.runId)) continue;
    count += 1;
  }
  return count;
};

const classifyControlledStep = ({ stepId, events, records, sourceRunId, journalEffects }) => {
  const runIds = lineageRunIds(events, sourceRunId);
  if (!runIds) return uncertain('LINEAGE_UNKNOWN');
  const runs = new Set(runIds);
  const { intentOwner, executedIntentIds, stepExecution, ambiguousExecution } = attributeLineage(events, runIds);
  if (ambiguousExecution) return uncertain('AMBIGUOUS_EXECUTION');
  const lineageIntents = records.filter((record) => record?.recordType === 'intent' && runs.has(record.runId));
  for (const intent of lineageIntents) {
    if (typeof intentOwner.get(intent.recordId) !== 'string') return uncertain('UNATTRIBUTED_INTENT');
  }
  const stepIntentIds = [...intentOwner.entries()]
    .filter(([, owner]) => owner === stepId)
    .map(([intentId]) => intentId);
  if (stepIntentIds.length === 0 || stepExecution.has(stepId)) return uncertain(stepIntentIds.length === 0 ? 'NO_STEP_INTENTS' : 'STEP_EXECUTION_RECORDED');
  const stepIntents = [];
  for (const intentId of stepIntentIds) {
    const intent = records.find((record) => record?.recordType === 'intent' && record.recordId === intentId);
    if (!intent || !runs.has(intent.runId)) return uncertain('MISSING_INTENT_RECORD');
    if (executedIntentIds.has(intentId) || !rejectedBeforeExecution(intent, records)) return uncertain('EXECUTION_OR_UNKNOWN');
    stepIntents.push(intent);
  }
  if (stepIntents.length === 0) return uncertain('NO_STEP_INTENTS');
  const executedRecords = lineageIntents.filter((intent) => executedIntentIds.has(intent.recordId)
    || upper(intent.state) !== 'REJECTED'
    || historyShowsExecution(intent)).length;
  if (journalExecutedCount(journalEffects, runIds) > executedRecords) return uncertain('JOURNAL_EXECUTION_UNACCOUNTED');
  return { status: 'RETRY', reason: 'ALL_INTENTS_REJECTED_BEFORE_EXECUTION' };
};

/**
 * Reconciliation result for one interrupted plan step.
 * `RETRY` is safe to run again. `UNCERTAIN` must stay blocked.
 */
export const reconcileInterruptedPlanStep = ({
  mode,
  readOnlyObservationRetry = false,
  step,
  events = [],
  records = [],
  sourceRunId,
  journalEffects = []
} = {}) => {
  const persistedUncertain = step?.status === 'BLOCKED' && step?.errorCode === 'SIDE_EFFECT_OUTCOME_UNCERTAIN';
  if (mode !== 'CONTROLLED') {
    if (readOnlyObservationRetry === true && !persistedUncertain) return { status: 'RETRY', reason: 'READ_ONLY_OBSERVATION' };
    return uncertain('READ_ONLY_UNCHANGED');
  }
  if (!step || typeof step.stepId !== 'string' || !step.stepId) return uncertain('STEP_INVALID');
  if (!Array.isArray(events) || !Array.isArray(records) || !Array.isArray(journalEffects)) return uncertain('EVIDENCE_INVALID');
  try {
    return classifyControlledStep({
      stepId: step.stepId,
      events,
      records,
      sourceRunId,
      journalEffects
    });
  } catch {
    return uncertain('CLASSIFY_FAILED');
  }
};
