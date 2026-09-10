import { createHash } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import { createHarnessEventStore, validateHarnessEvent } from './harness-event-store.mjs';

const SCHEMA_VERSION = '1.0';
const PROJECTION_VERSION = 8;
const MAX_EVENTS = 100_000;
const MAX_RUNS = 4_096;
// Array input stays bounded; streamed rebuilds can project a larger timeline
// and are served through pageProjectionTimeline.
const MAX_TIMELINE = 1_000_000;
const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);
const RUN_STATES = new Set([
  'CREATED', 'CLASSIFYING', 'PRECHECKING', 'ROUTING', 'ALLOCATING_CONTEXTS',
  'PLANNING', 'SAFETY_EVALUATING', 'WAITING_APPROVAL', 'EXECUTING', 'VERIFYING',
  'DIAGNOSING', 'RECOVERING', 'PAUSING', 'PAUSED', 'PAUSED_UNSUPPORTED',
  'SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED'
]);
const SYSTEM_RUN_PREFIX = /^(?:thread|plugin|evolution|memory)[:_]/iu;
const CRITICAL_EVENT_KINDS = new Set([
  'RunStateChanged',
  'TaskRunCreated',
  'TaskRunCompleted',
  'ActionRequested',
  'TaskRunFailed',
  'ApprovalRequested',
  'ApprovalResolved',
  'ActionAuthorized',
  'ActionLeased',
  'ActionExecuted',
  'ActionFailed'
]);
const KNOWN_EVENT_KINDS = new Set([
  ...CRITICAL_EVENT_KINDS,
  'TaskClassified',
  'TaskSafetyPrechecked',
  'RouteSelected',
  'RoleBindingsResolved',
  'RoleContextsAllocated',
  'RoleContextsReconciled',
  'ModelRouteResolved',
  'CouncilPlanReviewCompleted',
  'PlannerTurnCompleted',
  'PlanStepStateChanged',
  'RoleTurnCompleted',
  'ToolCallRequested',
  'ToolInvocationCompleted',
  'SemanticVerificationCompleted',
  'VerificationCompleted',
  'DiagnosisRequested',
  'RecoveryPhaseEntered',
  'RecoveryStarted',
  'RecoveryCompleted',
  'ExecutionStateReconciled',
  'ExecutionStateChanged',
  'LeaseExecutionFailed',
  'WorkspaceSnapshotCreated',
  'GitStateObserved',
  'TaskRunCreated',
  'TaskRunCompleted',
  'TaskRunFailed',
  'DecisionTraceEvent',
  'FeedbackFactRecorded',
  'FeedbackSubmitted',
  'FeedbackRevised',
  'FeedbackRetracted',
  'ModelScenarioScoreProjected',
  'BayesianAssessmentCreated',
  'ThreadCheckpointCommitted',
  'ThreadCheckpointCleared',
  'TASK_OUTCOME',
  'MemoryProposalCommitted',
  'MemoryStateChanged',
  'RoleContextAllocated',
  'RoleContextStateChanged',
  'PluginDiscovered',
  'PluginStateChangeCommitted',
  'EvolutionProposalCommitted',
  'EvolutionStateChanged',
  'EvolutionOutcomeRecorded',
  'EvolutionEvaluationRecorded',
  'ProfileEvidenceRecorded',
  'ProfileProjectionUpdated',
  'ModelRegistryRecordCommitted',
  'ModelRegistryRecordUpdated',
  'CreditBlameRecorded',
  'ModelEgressRecorded',
  'DreamRunStarted',
  'DreamPhaseCheckpointed',
  'DreamRunFinished',
  'DreamRunReconciled'
  ,'CandidateVerificationSample', 'CandidateVerificationCompleted'
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const text = (value, fallback = '', max = 240) => typeof value === 'string' && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, max)
  : fallback;
// Decision DAG edges stay bounded and de-duplicated so a corrupt or hostile
// snapshot cannot inflate the projection or point a node at itself transitively.
const refIds = (value, max = 64) => {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = text(item, '', 240);
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= max) break;
  }
  return ids;
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const safeNumber = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
const payloadOf = (event) => isObject(event?.payload) ? event.payload : {};
const eventTime = (event) => safeNumber(event?.observedAtMs ?? event?.emittedAtMs, 0);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const projectionUnsigned = (projection) => {
  const { projectionChecksum: _checksum, rebuiltAtMs: _rebuiltAtMs, ...unsigned } = projection;
  return unsigned;
};

const normalizeRunState = (value) => RUN_STATES.has(value) ? value : undefined;
const runTitle = (event, payload) => text(payload.title ?? payload.summary ?? payload.taskTitle, `Run ${event.runId}`, 240);
const eventLabel = (event) => text(event.kind, 'Runtime event', 120);
const eventStatus = (event, payload, run) => {
  if (event.kind === 'RunStateChanged') return normalizeRunState(event.to ?? payload.to) ?? run.state;
  if (event.kind === 'TaskRunCompleted') return 'SUCCEEDED';
  if (event.kind === 'TaskRunFailed') return text(payloadOf(event).outcomeStatus, 'FAILED', 40).toUpperCase();
  if (event.kind === 'ActionFailed' || event.kind === 'LeaseExecutionFailed') return 'FAILED';
  if (typeof payload.status === 'string') return text(payload.status, '', 40).toUpperCase();
  return 'INFO';
};

const validateEventOrder = (events) => {
  if (!Array.isArray(events) || events.length > MAX_EVENTS) throw new Error('READ_MODEL_EVENT_LIMIT');
  const ordered = events.map(clone).sort((left, right) => left.runId.localeCompare(right.runId) || left.sequence - right.sequence);
  const runSequences = new Map();
  const aggregateVersions = new Map();
  for (const event of ordered) {
    try { validateHarnessEvent(event, 0); } catch (error) {
      if (error?.message?.includes('DIGEST') || (error?.message?.includes('INVALID_EVENT') && typeof event.payloadDigest === 'string' && typeof event.recordDigest === 'string')) throw new Error('READ_MODEL_DIGEST_INVALID');
      throw new Error('READ_MODEL_EVENT_INVALID');
    }
    if (!isObject(event) || typeof event.runId !== 'string' || !event.runId.trim()
      || !Number.isInteger(event.sequence) || event.sequence < 1
      || !Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1
      || typeof event.aggregateType !== 'string' || typeof event.aggregateId !== 'string'
      || typeof event.kind !== 'string' || !event.kind.trim()) {
      throw new Error('READ_MODEL_EVENT_INVALID');
    }
    const previousSequence = runSequences.get(event.runId) ?? 0;
    if (event.sequence !== previousSequence + 1) throw new Error('READ_MODEL_SEQUENCE_INVALID');
    runSequences.set(event.runId, event.sequence);
    const aggregateKey = JSON.stringify([event.aggregateType, event.aggregateId]);
    const versions = aggregateVersions.get(aggregateKey) ?? [];
    versions.push(event.aggregateVersion);
    aggregateVersions.set(aggregateKey, versions);
  }
  for (const versions of aggregateVersions.values()) {
    versions.sort((a, b) => a - b);
    if (versions.some((version, index) => version !== index + 1)) throw new Error('READ_MODEL_AGGREGATE_VERSION_INVALID');
  }
  return ordered;
};

// Streaming stores yield events ordered by (runId, sequence). Run sequences
// can be validated incrementally; aggregate versions are compared as a set
// because a shared aggregate can be interleaved across run IDs.
const createStreamingValidator = () => {
  const runSequences = new Map();
  const aggregateVersions = new Map();
  let index = 0;
  return {
    validate(event) {
      try {
        validateHarnessEvent(event, index);
      } catch (error) {
        if (error?.message?.includes('DIGEST') || (error?.message?.includes('INVALID_EVENT') && typeof event.payloadDigest === 'string' && typeof event.recordDigest === 'string')) {
          throw new Error('READ_MODEL_DIGEST_INVALID');
        }
        throw new Error('READ_MODEL_EVENT_INVALID');
      }
      if (!isObject(event) || typeof event.runId !== 'string' || !event.runId.trim()
        || !Number.isInteger(event.sequence) || event.sequence < 1
        || !Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1
        || typeof event.aggregateType !== 'string' || typeof event.aggregateId !== 'string'
        || typeof event.kind !== 'string' || !event.kind.trim()) {
        throw new Error('READ_MODEL_EVENT_INVALID');
      }
      const priorSequence = runSequences.get(event.runId) ?? 0;
      if (event.sequence !== priorSequence + 1) throw new Error('READ_MODEL_SEQUENCE_INVALID');
      runSequences.set(event.runId, event.sequence);
      const aggregateKey = JSON.stringify([event.aggregateType, event.aggregateId]);
      const aggregate = aggregateVersions.get(aggregateKey) ?? { versions: new Set(), max: 0 };
      aggregate.versions.add(event.aggregateVersion);
      aggregate.max = Math.max(aggregate.max, event.aggregateVersion);
      aggregateVersions.set(aggregateKey, aggregate);
      index += 1;
    },
    finish() {
      for (const { versions, max } of aggregateVersions.values()) {
        if (!versions.has(1) || versions.size !== max) throw new Error('READ_MODEL_AGGREGATE_VERSION_INVALID');
      }
    }
  };
};

const emptyProjection = () => ({
  schemaVersion: SCHEMA_VERSION,
  projectionVersion: PROJECTION_VERSION,
  projectionChecksum: undefined,
  lastEventSequence: {},
  runCount: 0,
  runs: [],
  approvals: [],
  timeline: [],
  workspace: { granted: false, rootLabel: 'Default workspace', currentPath: '', entryCount: 0, stale: false },
  verifier: {},
  continuousVerification: [],
  outcomes: [],
  feedback: [],
  decisions: [],
  memories: [],
  executionRecords: [],
  modelScenario: {},
  unknownEventKinds: [],
  unsupportedEvents: []
});

const addTimeline = (projection, event, run) => {
  if (projection.timeline.length >= MAX_TIMELINE) throw new Error('READ_MODEL_TIMELINE_LIMIT');
  const payload = payloadOf(event);
  const status = eventStatus(event, payload, run);
  projection.timeline.push({
    itemId: `event-${event.eventId ?? `${event.runId}-${event.sequence}`}`,
    runId: event.runId,
    kind: event.kind,
    title: eventLabel(event),
    status: text(status, 'INFO', 40),
    createdAtMs: eventTime(event),
    eventId: text(event.eventId, `${event.runId}-${event.sequence}`, 240),
    eventSequence: event.sequence
  });
};

const applyEvent = (projection, event, runs) => {
  const payload = payloadOf(event);
  let run = runs.get(event.runId);
  if (!run) {
    if (SYSTEM_RUN_PREFIX.test(event.runId)) {
      // System aggregate events remain timeline facts but are not TaskRuns.
      run = {
        runId: event.runId,
        title: runTitle(event, payload),
        state: 'CREATED',
        startedAtMs: eventTime(event),
        lastEventSequence: 0,
        terminal: false
      };
    } else {
      if (runs.size >= MAX_RUNS) throw new Error('READ_MODEL_RUN_LIMIT');
      run = {
        runId: event.runId,
        title: runTitle(event, payload),
        state: 'CREATED',
        startedAtMs: eventTime(event),
        lastEventSequence: 0,
        terminal: false
      };
      runs.set(event.runId, run);
    }
  }
  run.lastEventSequence = event.sequence;
  const unknown = !KNOWN_EVENT_KINDS.has(event.kind);
  if (unknown && !projection.unknownEventKinds.includes(event.kind)) projection.unknownEventKinds.push(event.kind);
  if (unknown && /^(Run|Task|Approval|Action)/u.test(event.kind)) {
    // The immutable envelope remains in the fact store; the projection keeps
    // its exact identity/digest instead of copying potentially sensitive data.
    projection.unsupportedEvents.push({
      eventId: event.eventId, runId: event.runId, sequence: event.sequence,
      aggregateType: event.aggregateType, aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion, kind: event.kind,
      recordDigest: event.recordDigest
    });
    run.state = 'PAUSED_UNSUPPORTED';
    run.terminal = false;
    run.unsupportedEventIds = [...(run.unsupportedEventIds ?? []), event.eventId];
  }
  if (run.unsupportedEventIds?.length) {
    // Unknown semantics cannot be cleared by a later success/approval event.
    // Preserve chronology without applying more authority-bearing state.
    addTimeline(projection, event, run);
    projection.timeline.at(-1).status = 'PAUSED_UNSUPPORTED';
    return;
  }
  if (event.kind === 'TaskRunCreated') {
    run.title = runTitle(event, payload);
    run.startedAtMs = eventTime(event);
  } else if (event.kind === 'RunStateChanged') {
    const next = normalizeRunState(event.to ?? payload.to);
    if (!next) throw new Error('READ_MODEL_STATE_INVALID');
    run.state = next;
    run.terminal = TERMINAL_STATES.has(next);
  } else if (event.kind === 'TaskRunCompleted') {
    run.state = 'SUCCEEDED';
    run.terminal = true;
  } else if (event.kind === 'TaskRunFailed') {
    run.state = text(payload.outcomeStatus, 'FAILED', 40).toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    run.terminal = true;
  }
  if (event.kind === 'ApprovalRequested' || event.kind === 'ApprovalResolved') {
    const requestId = text(payload.requestId ?? payload.approvalId, `approval-${event.runId}-${event.sequence}`, 240);
    const existing = projection.approvals.find((approval) => approval.requestId === requestId);
    const approval = {
      requestId,
      runId: event.runId,
      capability: text(payload.capability, 'unknown', 80),
      requestDigest: /^sha256:[0-9a-f]{64}$/u.test(payload.requestDigest) ? payload.requestDigest : digest({ eventId: event.eventId, requestId }),
      state: text(payload.state, event.kind === 'ApprovalRequested' ? 'REQUESTED' : 'APPROVED', 40).toUpperCase(),
      createdAtMs: safeNumber(payload.createdAtMs, eventTime(event))
    };
    if (existing) Object.assign(existing, approval);
    else projection.approvals.push(approval);
  }
  if (event.kind === 'WorkspaceSnapshotCreated') {
    projection.workspace = {
      granted: true,
      rootLabel: text(payload.rootLabel, 'Workspace', 160),
      currentPath: '',
      entryCount: safeNumber(payload.entryCount, 0),
      stale: false,
      snapshotDigest: /^sha256:[0-9a-f]{64}$/u.test(payload.snapshotDigest) ? payload.snapshotDigest : undefined
    };
  }
  if (event.kind === 'VerificationCompleted' || event.kind === 'SemanticVerificationCompleted') {
    projection.verifier = {
      status: text(payload.status, 'ABSTAIN', 40).toUpperCase(),
      failureCodes: Array.isArray(payload.failureCodes) ? payload.failureCodes.filter((code) => typeof code === 'string').map((code) => code.slice(0, 120)).slice(0, 32) : [],
      lastRunId: event.runId,
      lastEventSequence: event.sequence
    };
  }
  if (event.kind === 'TaskRunCompleted' || event.kind === 'TaskRunFailed') {
    const outcomeId = text(payload.outcomeId, `task-outcome-${event.runId}`, 240);
    const status = text(payload.outcomeStatus, event.kind === 'TaskRunCompleted' ? 'SUCCEEDED' : 'FAILED', 40).toUpperCase();
    const outcome = { outcomeId, runId: event.runId, status, sourceEventIds: [event.eventId], eventSequence: event.sequence };
    const existing = projection.outcomes.find((item) => item.outcomeId === outcomeId);
    if (existing) Object.assign(existing, outcome); else projection.outcomes.push(outcome);
  }
  if (event.kind === 'ModelScenarioScoreProjected') {
    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    projection.modelScenario = {
      eventId: event.eventId,
      eventSequence: event.sequence,
      sourceDigest: /^sha256:[0-9a-f]{64}$/u.test(payload.sourceDigest) ? payload.sourceDigest : undefined,
      profileCount: Math.min(profiles.length, 4096),
      updatedAtMs: safeNumber(payload.updatedAtMs, eventTime(event))
    };
  }
  if (event.kind === 'CandidateVerificationSample' || event.kind === 'CandidateVerificationCompleted') {
    const entry = {
      eventId: event.eventId, runId: event.runId, stepId: text(payload.stepId, '', 240),
      kind: event.kind, modelId: text(payload.modelId, '', 160), eventSequence: event.sequence,
      ...(event.kind === 'CandidateVerificationSample' ? {
        leftId: text(payload.leftId, '', 240), rightId: text(payload.rightId, '', 240),
        leftScore: Number.isFinite(payload.left?.score) ? payload.left.score : undefined,
        rightScore: Number.isFinite(payload.right?.score) ? payload.right.score : undefined,
        leftVariance: Number.isFinite(payload.left?.variance) ? payload.left.variance : undefined,
        rightVariance: Number.isFinite(payload.right?.variance) ? payload.right.variance : undefined
      } : {
        config: isObject(payload.config) ? clone(payload.config) : undefined,
        comparisonCount: safeNumber(payload.comparisonCount), ranking: Array.isArray(payload.ranking) ? payload.ranking.slice(0, 8) : []
      })
    };
    projection.continuousVerification = [...projection.continuousVerification, entry].slice(-256);
  }
  if (event.kind === 'FeedbackFactRecorded') {
    const feedbackId = text(payload.feedbackId, '', 240);
    const eventKind = text(payload.eventKind, '', 40);
    if (feedbackId && eventKind === 'FeedbackRetracted') {
      projection.feedback = projection.feedback.filter((item) => item.feedbackId !== text(payload.targetFeedbackId, '', 240));
    } else if (feedbackId && ['FeedbackSubmitted', 'FeedbackRevised'].includes(eventKind)) {
      if (eventKind === 'FeedbackRevised') projection.feedback = projection.feedback.filter((item) => item.feedbackId !== text(payload.previousFeedbackId, '', 240));
      const summary = {
        feedbackId, runId: text(payload.runId, event.runId, 160), outcomeId: text(payload.outcomeId, '', 240),
        eventId: event.eventId, eventSequence: event.sequence,
        ...(payload.scenarioKey ? { scenarioKey: text(payload.scenarioKey, '', 128) } : {}),
        ...(payload.candidateKey ? { candidateKey: text(payload.candidateKey, '', 240) } : {}),
        ...(payload.outcomeStatus ? { outcomeStatus: text(payload.outcomeStatus, '', 40).toUpperCase() } : {}),
        ...(payload.sourceType ? { sourceType: text(payload.sourceType, '', 40).toUpperCase() } : {})
      };
      projection.feedback = projection.feedback.filter((item) => item.feedbackId !== feedbackId);
      projection.feedback.push(summary);
    }
  }
  if (event.kind === 'DecisionTraceEvent') {
    const decisionId = text(payload.decisionId, '', 240);
    const snapshot = isObject(payload.decisionSnapshot) ? payload.decisionSnapshot : undefined;
    const outcome = isObject(payload.outcomeSnapshot) ? payload.outcomeSnapshot : undefined;
    if (decisionId) {
      const parentDecisionIds = refIds(snapshot?.parentDecisionIds).filter((id) => id !== decisionId);
      // Candidate options stay bounded and digest-only so a fanout decision can
      // be rendered without pulling raw drafts into the read model.
      const options = Array.isArray(snapshot?.options)
        ? snapshot.options.slice(0, 8).map((option) => ({
          optionId: text(option?.optionId, '', 240),
          ...(option?.actionKind ? { actionKind: text(option.actionKind, '', 120) } : {}),
          ...(Number.isFinite(option?.expectedQuality) ? { expectedQuality: Math.min(1, Math.max(0, option.expectedQuality)) } : {}),
          ...(Number.isFinite(option?.expectedCost) ? { expectedCost: option.expectedCost } : {}),
          ...(Number.isFinite(option?.expectedLatencyMs) ? { expectedLatencyMs: option.expectedLatencyMs } : {}),
          rejectionReasonCodes: refIds(option?.rejectionReasonCodes, 16)
        })).filter((option) => option.optionId)
        : [];
      const summary = {
        decisionId,
        runId: event.runId,
        ...(snapshot?.decisionType ? { decisionType: text(snapshot.decisionType, '', 120) } : {}),
        ...(snapshot?.role ? { role: text(snapshot.role, '', 80) } : {}),
        ...(snapshot?.stepId ? { stepId: text(snapshot.stepId, '', 240) } : {}),
        ...(snapshot?.agentInstanceId ? { agentInstanceId: text(snapshot.agentInstanceId, '', 240) } : {}),
        ...(snapshot?.supersedesDecisionId && text(snapshot.supersedesDecisionId, '', 240) && text(snapshot.supersedesDecisionId, '', 240) !== decisionId
          ? { supersedesDecisionId: text(snapshot.supersedesDecisionId, '', 240) }
          : {}),
        ...(parentDecisionIds.length ? { parentDecisionIds } : {}),
        status: text(snapshot?.status, 'UNKNOWN', 40).toUpperCase(),
        optionCount: Array.isArray(snapshot?.options) ? Math.min(snapshot.options.length, 32) : 0,
        ...(options.length ? { options } : {}),
        ...(snapshot?.selectedOptionId ? { selectedOptionId: text(snapshot.selectedOptionId, '', 240) } : {}),
        ...(Array.isArray(snapshot?.reasonCodes) && snapshot.reasonCodes.length ? { reasonCodes: refIds(snapshot.reasonCodes, 16) } : {}),
        ...(Array.isArray(snapshot?.selectionCriteria) && snapshot.selectionCriteria.length ? { selectionCriteria: refIds(snapshot.selectionCriteria, 16) } : {}),
        ...(outcome?.status ? { outcomeStatus: text(outcome.status, '', 40).toUpperCase() } : {}),
        eventId: event.eventId,
        eventSequence: event.sequence,
        updatedAtMs: eventTime(event)
      };
      const existing = projection.decisions.find((item) => item.decisionId === decisionId);
      if (existing) Object.assign(existing, summary);
      else projection.decisions.push(summary);
    }
  }
  if (event.kind === 'MemoryProposalCommitted' || event.kind === 'MemoryStateChanged') {
    const memoryId = text(payload.memoryId, '', 240);
    if (memoryId) {
      const summary = {
        memoryId,
        runId: text(payload.runId, event.runId, 240),
        statement: text(payload.statement, '', 2000),
        status: text(payload.status, 'PROPOSED', 40).toUpperCase(),
        scope: text(payload.scope, '', 256),
        kind: text(payload.kind, '', 64),
        ...(payload.key === undefined ? {} : { key: text(payload.key, '', 256) }),
        confidence: Number.isFinite(payload.confidence) ? Math.max(0, Math.min(1, payload.confidence)) : 0,
        untrainable: payload.untrainable === true,
        sourceEventIds: Array.isArray(payload.sourceEventIds)
          ? payload.sourceEventIds.filter((id) => typeof id === 'string').map((id) => id.slice(0, 240)).slice(0, 32)
          : [],
        ...(DIGEST_PATTERN.test(payload.recordDigest ?? '') ? { recordDigest: payload.recordDigest } : {}),
        ...(DIGEST_PATTERN.test(payload.lifecycleDigest ?? '') ? { lifecycleDigest: payload.lifecycleDigest } : {}),
        createdAtMs: safeNumber(payload.createdAtMs, eventTime(event)),
        updatedAtMs: safeNumber(payload.updatedAtMs, eventTime(event)),
        ...(Number.isFinite(payload.untrainableAtMs) ? { untrainableAtMs: safeNumber(payload.untrainableAtMs, eventTime(event)) } : {}),
        eventId: event.eventId,
        eventSequence: event.sequence
      };
      const existing = projection.memories.find((item) => item.memoryId === memoryId);
      if (existing) Object.assign(existing, summary);
      else projection.memories.push(summary);
    }
  }
  if (event.kind === 'ExecutionStateChanged') {
    const recordId = text(payload.recordId, '', 240);
    const recordType = text(payload.recordType, '', 40).toLowerCase();
    if (recordId && ['intent', 'approval', 'lease'].includes(recordType)) {
      const summary = {
        recordId,
        recordType,
        state: text(payload.state, 'UNKNOWN', 40).toUpperCase(),
        runId: text(payload.runId, event.runId, 240),
        ...(payload.capability ? { capability: text(payload.capability, '', 120) } : {}),
        ...(payload.intentId ? { intentId: text(payload.intentId, '', 240) } : {}),
        ...(payload.approvalId ? { approvalId: text(payload.approvalId, '', 240) } : {}),
        ...(payload.operationId ? { operationId: text(payload.operationId, '', 240) } : {}),
        ...(DIGEST_PATTERN.test(payload.requestDigest ?? '') ? { requestDigest: payload.requestDigest } : {}),
        ...(DIGEST_PATTERN.test(payload.snapshotDigest ?? '') ? { snapshotDigest: payload.snapshotDigest } : {}),
        createdAtMs: eventTime(event),
        updatedAtMs: eventTime(event),
        eventId: event.eventId,
        eventSequence: event.sequence
      };
      const existing = projection.executionRecords.find((item) => item.recordId === recordId);
      if (existing) Object.assign(existing, summary);
      else projection.executionRecords.push(summary);
    }
  }
  addTimeline(projection, event, run);
};

export const rebuildReadModel = async ({ events, eventStore, storagePath, runId, now = Date.now } = {}) => {
  const projection = emptyProjection();
  const runs = new Map();
  const apply = (event) => {
    if (runId !== undefined && event.runId !== runId) return;
    applyEvent(projection, event, runs);
    projection.lastEventSequence[event.runId] = event.sequence;
  };
  if (events !== undefined) {
    // Validate the complete authority before selecting a run. Shared aggregate
    // versions may legitimately start above one inside a single-run view.
    for (const event of validateEventOrder(events)) apply(event);
  } else if (eventStore) {
    if (typeof eventStore.iterate === 'function') {
      const validator = createStreamingValidator();
      for await (const event of eventStore.iterate({ limit: 1000 })) {
        validator.validate(event);
        apply(event);
      }
      validator.finish();
    } else {
      for (const event of validateEventOrder(await eventStore.list())) apply(event);
    }
  } else {
    throw new Error('READ_MODEL_EVENT_SOURCE_REQUIRED');
  }
  projection.runs = [...runs.values()].sort((left, right) => left.runId.localeCompare(right.runId));
  projection.runCount = projection.runs.length;
  projection.timeline.sort((left, right) => left.createdAtMs - right.createdAtMs || left.eventId.localeCompare(right.eventId));
  projection.unknownEventKinds.sort();
  projection.rebuiltAtMs = safeNumber(now(), 0);
  projection.projectionChecksum = digest(projectionUnsigned(projection));
  if (storagePath) await persistJsonFile(storagePath, projection);
  return clone(projection);
};

export const replayRun = async ({ runId, events, eventStore, storagePath, now = Date.now } = {}) => {
  if (typeof runId !== 'string' || !runId.trim()) throw new Error('READ_MODEL_RUN_ID_REQUIRED');
  if (events === undefined && !eventStore) throw new Error('READ_MODEL_EVENT_SOURCE_REQUIRED');
  return rebuildReadModel({ events, eventStore, runId, storagePath, now });
};

export const projectionCheck = async ({ runId, events, eventStore, storagePath, now = Date.now } = {}) => {
  if (!storagePath) throw new Error('READ_MODEL_PATH_REQUIRED');
  const persisted = await readPersistentJsonFile(storagePath);
  if (!persisted) return { ok: false, errorCode: 'READ_MODEL_NOT_FOUND' };
  const rebuilt = await rebuildReadModel({ events, eventStore, runId, now: () => persisted.rebuiltAtMs ?? 0 });
  const expected = digest(projectionUnsigned(persisted));
  const actual = digest(projectionUnsigned(rebuilt));
  return {
    ok: persisted.projectionChecksum === expected && expected === actual,
    expectedChecksum: expected,
    actualChecksum: actual,
    lastEventSequence: rebuilt.lastEventSequence
  };
};

export const pageProjectionTimeline = (projection, { cursor = 0, limit = 200 } = {}) => {
  if (!isObject(projection) || !Array.isArray(projection.timeline)) throw new Error('READ_MODEL_PROJECTION_INVALID');
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > projection.timeline.length) throw new Error('READ_MODEL_TIMELINE_CURSOR_INVALID');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error('READ_MODEL_TIMELINE_LIMIT_INVALID');
  const items = projection.timeline.slice(cursor, cursor + limit);
  const nextCursor = cursor + items.length;
  return {
    projectionVersion: projection.projectionVersion,
    projectionChecksum: projection.projectionChecksum,
    lastEventSequence: projection.lastEventSequence,
    runCount: projection.runCount,
    timelinePage: {
      items: clone(items),
      cursor,
      limit,
      total: projection.timeline.length,
      hasMore: nextCursor < projection.timeline.length,
      ...(nextCursor < projection.timeline.length ? { nextCursor } : {})
    }
  };
};

export const createReadModelRebuilder = (options = {}) => ({
  rebuild: (input = {}) => rebuildReadModel({ ...options, ...input }),
  replayRun: (input = {}) => replayRun({ ...options, ...input }),
  projectionCheck: (input = {}) => projectionCheck({ ...options, ...input }),
  pageTimeline: (projection, input = {}) => pageProjectionTimeline(projection, input)
});

export { createHarnessEventStore };
