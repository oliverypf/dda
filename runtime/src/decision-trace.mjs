import { createHash, randomUUID } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

// This store records observable, structured choices. It never stores prompts
// or hidden model reasoning, and its shape does not expose provider fields.
export const DECISION_TRACE_SCHEMA_VERSION = '1.0';
export const DECISION_STATUSES = Object.freeze([
  'PROPOSED', 'COMMITTED', 'REJECTED', 'ABSTAINED', 'INVALIDATED'
]);
export const OUTCOME_STATUSES = Object.freeze([
  'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'NOT_EXECUTED', 'UNKNOWN'
]);

const MAX_DECISIONS = 1000;
// `MAX_DECISIONS` is the per-run guard. Persisted history is retained across
// runs, so using the per-run value as the file-wide limit eventually makes a
// healthy installation unreadable after enough tasks.
const MAX_STORED_DECISIONS = 100000;
const MAX_OUTCOMES = 4096;
const MAX_EVENTS = 8192;
const MAX_OPTIONS = 8;
const MAX_EVIDENCE = 64;
const MAX_TEXT = 2000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SENSITIVITIES = new Set(['PUBLIC', 'INTERNAL', 'SOURCE', 'SENSITIVE', 'SECURITY_AUDIT']);
const STANCES = new Set(['SUPPORTS', 'CONTRADICTS', 'CONTEXT', 'UNKNOWN']);
const ASSUMPTION_SOURCES = new Set(['USER', 'POLICY', 'WORKSPACE', 'MODEL_INFERENCE']);
const OUTCOME_ACTORS = new Set(['coordinator', 'verifier', 'system', 'user']);
const FORBIDDEN_KEY = /(?:^|_)(?:raw_?|system_?|developer_?)?prompt$|(?:^|_)(?:input_?|system_?|developer_?)?(?:message|messages)$|(?:^|_)(?:hidden_?)?reasoning(?:_?summary|_?tokens?)?$|chain[-_ ]?of[-_ ]?thought|(?:^|_)(?:api_?)?key$|(?:^|_)(?:access_?)?token$|authorization|credential|password|private[-_ ]?key/i;
const SECRET_TEXT = /(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}|(?:api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]{6,})/i;
const PRIVATE_TEXT = /chain[-_ ]?of[-_ ]?thought|hidden[-_ ]?(?:reasoning|thought)|(?:raw|system)[-_ ]?prompt/i;

const clone = (value) => structuredClone(value);
const fail = (code) => { throw new Error(code); };
const replayUnavailableDetail = (durable, payload, extra = '') => {
  const source = durable?.sourceRef
    ? `${durable.sourceRef.store}:${durable.sourceRef.eventId}`
    : 'none';
  return [
    `event=${durable?.eventId ?? 'unknown'}`,
    `run=${durable?.runId ?? 'unknown'}`,
    `sequence=${durable?.sequence ?? '?'}`,
    `keys=${Object.keys(payload ?? {}).join(',')}`,
    `source=${source}`,
    ...(extra ? [extra] : [])
  ].join('|');
};
const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const decisionTraceDigest = (value) =>
  `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

const inspectForbidden = (value, seen = new Set()) => {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail('DECISION_CYCLIC_INPUT');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'promptTemplateVersion' && FORBIDDEN_KEY.test(key)) fail('DECISION_FORBIDDEN_CONTENT');
    inspectForbidden(child, seen);
  }
  seen.delete(value);
};

const cleanText = (value, code, { required = true, max = MAX_TEXT } = {}) => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || SECRET_TEXT.test(value) || PRIVATE_TEXT.test(value)) fail(code);
  return value.trim();
};

const cleanId = (value, code, max = 240) => cleanText(value, code, { max });
const cleanDigest = (value, code) => {
  const result = cleanText(value, code, { max: 80 });
  if (!DIGEST_PATTERN.test(result)) fail(code);
  return result;
};
const cleanNumber = (value, code, min, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(code);
  return value;
};
const cleanMs = (value, code) => {
  if (!Number.isInteger(value) || value < 0) fail(code);
  return value;
};
const cleanIds = (value, code, max = 128) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(code);
  const result = value.map((entry) => cleanId(entry, code));
  if (new Set(result).size !== result.length) fail(code);
  return result;
};
const cleanCodes = (value, code, max = 128) => {
  const result = cleanIds(value, code, max);
  if (result.some((entry) => !/^[A-Za-z0-9_.:-]+$/.test(entry))) fail(code);
  return result;
};

const normalizeEvidence = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) fail('DECISION_INVALID_EVIDENCE');
  const result = value.map((ref) => {
    if (!isRecord(ref) || !STANCES.has(ref.stance)) fail('DECISION_INVALID_EVIDENCE');
    const output = {
      evidenceId: cleanId(ref.evidenceId, 'DECISION_INVALID_EVIDENCE'),
      evidenceType: cleanId(ref.evidenceType, 'DECISION_INVALID_EVIDENCE', 120),
      stance: ref.stance,
      freshnessAtMs: cleanMs(ref.freshnessAtMs, 'DECISION_INVALID_EVIDENCE')
    };
    if (ref.eventId !== undefined) output.eventId = cleanId(ref.eventId, 'DECISION_INVALID_EVIDENCE');
    if (ref.artifactDigest !== undefined) output.artifactDigest = cleanDigest(ref.artifactDigest, 'DECISION_INVALID_EVIDENCE');
    if (ref.scopeRef !== undefined) output.scopeRef = cleanId(ref.scopeRef, 'DECISION_INVALID_EVIDENCE');
    return output;
  });
  if (new Set(result.map((item) => item.evidenceId)).size !== result.length) fail('DECISION_INVALID_EVIDENCE');
  return result;
};

const normalizeAssumptions = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail('DECISION_INVALID_ASSUMPTIONS');
  const result = value.map((item) => {
    if (!isRecord(item) || !ASSUMPTION_SOURCES.has(item.source) || typeof item.testable !== 'boolean') fail('DECISION_INVALID_ASSUMPTIONS');
    const output = {
      assumptionId: cleanId(item.assumptionId, 'DECISION_INVALID_ASSUMPTIONS'),
      statement: cleanText(item.statement, 'DECISION_INVALID_ASSUMPTIONS', { max: 500 }),
      source: item.source,
      testable: item.testable
    };
    if (item.verificationRef !== undefined) output.verificationRef = cleanId(item.verificationRef, 'DECISION_INVALID_ASSUMPTIONS');
    return output;
  });
  if (new Set(result.map((item) => item.assumptionId)).size !== result.length) fail('DECISION_INVALID_ASSUMPTIONS');
  return result;
};

const normalizeOptions = (value, evidenceIds) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_OPTIONS) fail('DECISION_INVALID_OPTIONS');
  const result = value.map((item) => {
    if (!isRecord(item)) fail('DECISION_INVALID_OPTIONS');
    const evidenceRefs = cleanIds(item.evidenceRefs, 'DECISION_INVALID_OPTIONS', MAX_EVIDENCE);
    if (evidenceRefs.some((ref) => !evidenceIds.has(ref))) fail('DECISION_EVIDENCE_NOT_FOUND');
    const output = {
      optionId: cleanId(item.optionId, 'DECISION_INVALID_OPTIONS'),
      actionKind: cleanId(item.actionKind, 'DECISION_INVALID_OPTIONS', 120),
      summary: cleanText(item.summary, 'DECISION_INVALID_OPTIONS', { max: 500 }),
      requiredCapabilityIds: cleanCodes(item.requiredCapabilityIds, 'DECISION_INVALID_OPTIONS', 32),
      evidenceRefs,
      riskCodes: cleanCodes(item.riskCodes, 'DECISION_INVALID_OPTIONS', 32),
      rejectionReasonCodes: cleanCodes(item.rejectionReasonCodes, 'DECISION_INVALID_OPTIONS', 32)
    };
    for (const [key, min, max] of [
      ['expectedInformationGain', 0, 1], ['expectedQuality', 0, 1],
      ['expectedCost', 0, undefined], ['expectedLatencyMs', 0, undefined]
    ]) {
      const number = cleanNumber(item[key], 'DECISION_INVALID_OPTIONS', min, max);
      if (number !== undefined) output[key] = number;
    }
    if (item.outputDraftDigest !== undefined) output.outputDraftDigest = cleanDigest(item.outputDraftDigest, 'DECISION_INVALID_OPTIONS');
    return output;
  });
  if (new Set(result.map((item) => item.optionId)).size !== result.length) fail('DECISION_INVALID_OPTIONS');
  return result;
};

const normalizeExpectation = (value) => {
  if (!isRecord(value)) fail('DECISION_INVALID_EXPECTATION');
  const result = {
    successCriteriaRefs: cleanIds(value.successCriteriaRefs, 'DECISION_INVALID_EXPECTATION', 64),
    predictedOutcomeCode: cleanId(value.predictedOutcomeCode, 'DECISION_INVALID_EXPECTATION', 120),
    predictedRiskCodes: cleanCodes(value.predictedRiskCodes, 'DECISION_INVALID_EXPECTATION', 32)
  };
  const progress = cleanNumber(value.predictedProgress, 'DECISION_INVALID_EXPECTATION', 0, 1);
  const cost = cleanNumber(value.predictedCost, 'DECISION_INVALID_EXPECTATION', 0);
  if (progress !== undefined) result.predictedProgress = progress;
  if (cost !== undefined) result.predictedCost = cost;
  return result;
};

const immutableDecision = (record) => {
  const {
    status: _status, createdAtMs: _createdAtMs,
    updatedAtMs: _updatedAtMs, committedAtMs: _committedAtMs,
    lifecycleReasonCode: _lifecycleReasonCode, recordDigest: _recordDigest,
    ...immutable
  } = record;
  return immutable;
};

const normalizeDecision = (input, { decisionId, createdAtMs }) => {
  if (!isRecord(input)) fail('DECISION_INVALID_INPUT');
  inspectForbidden(input);
  const evidenceRefs = normalizeEvidence(input.evidenceRefs);
  const options = normalizeOptions(input.options, new Set(evidenceRefs.map((item) => item.evidenceId)));
  const selectedOptionId = input.selectedOptionId === undefined ? undefined : cleanId(input.selectedOptionId, 'DECISION_INVALID_SELECTION');
  if (selectedOptionId !== undefined && !options.some((option) => option.optionId === selectedOptionId)) fail('DECISION_INVALID_SELECTION');
  const result = {
    decisionId,
    schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
    runId: cleanId(input.runId, 'DECISION_INVALID_RUN'),
    stepId: cleanId(input.stepId, 'DECISION_INVALID_STEP'),
    parentDecisionIds: cleanIds(input.parentDecisionIds, 'DECISION_INVALID_PARENTS', 64),
    agentInstanceId: cleanId(input.agentInstanceId, 'DECISION_INVALID_AGENT'),
    role: cleanId(input.role, 'DECISION_INVALID_ROLE', 120),
    roleContextId: cleanId(input.roleContextId, 'DECISION_INVALID_ROLE_CONTEXT'),
    bindingSnapshotId: cleanId(input.bindingSnapshotId, 'DECISION_INVALID_BINDING'),
    decisionType: cleanId(input.decisionType, 'DECISION_INVALID_TYPE', 120),
    objectiveRef: cleanId(input.objectiveRef, 'DECISION_INVALID_OBJECTIVE'),
    constraintSnapshotId: cleanId(input.constraintSnapshotId, 'DECISION_INVALID_CONSTRAINTS'),
    featureSnapshotId: cleanId(input.featureSnapshotId, 'DECISION_INVALID_FEATURES'),
    evidenceRefs,
    assumptions: normalizeAssumptions(input.assumptions),
    options,
    decisionSummary: cleanText(input.decisionSummary, 'DECISION_INVALID_SUMMARY', { max: 1000 }),
    selectionCriteria: cleanIds(input.selectionCriteria, 'DECISION_INVALID_CRITERIA', 32),
    reasonCodes: cleanCodes(input.reasonCodes, 'DECISION_INVALID_REASON_CODES', 32),
    uncertaintyCodes: cleanCodes(input.uncertaintyCodes, 'DECISION_INVALID_UNCERTAINTY', 32),
    expectedOutcome: normalizeExpectation(input.expectedOutcome),
    outputRefs: cleanIds(input.outputRefs, 'DECISION_INVALID_OUTPUT_REFS', 64),
    sensitivity: input.sensitivity ?? 'INTERNAL',
    createdAtMs,
    status: 'PROPOSED'
  };
  if (!SENSITIVITIES.has(result.sensitivity)) fail('DECISION_INVALID_SENSITIVITY');
  for (const key of ['operationId', 'modelInvocationId', 'promptTemplateVersion']) {
    if (input[key] !== undefined) result[key] = cleanId(input[key], 'DECISION_INVALID_METADATA');
  }
  if (input.supersedesDecisionId !== undefined) result.supersedesDecisionId = cleanId(input.supersedesDecisionId, 'DECISION_INVALID_SUPERSEDES');
  if (selectedOptionId !== undefined) result.selectedOptionId = selectedOptionId;
  const confidence = cleanNumber(input.claimedConfidence, 'DECISION_INVALID_CONFIDENCE', 0, 1);
  if (confidence !== undefined) result.claimedConfidence = confidence;
  result.recordDigest = decisionTraceDigest(immutableDecision(result));
  return result;
};

const normalizeAssignment = (value, code) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail(code);
  return value.map((item) => {
    if (!isRecord(item)) fail(code);
    const result = { subjectId: cleanId(item.subjectId, code) };
    if (item.role !== undefined) result.role = cleanId(item.role, code, 120);
    if (item.reasonCode !== undefined) result.reasonCode = cleanId(item.reasonCode, code, 120);
    const weight = cleanNumber(item.weight, code, -1, 1);
    if (weight !== undefined) result.weight = weight;
    return result;
  });
};

const unsignedOutcome = ({ outcomeDigest: _outcomeDigest, ...unsigned }) => unsigned;
const normalizeOutcome = (decision, input, { outcomeId, linkedAtMs }) => {
  if (!isRecord(input)) fail('DECISION_INVALID_OUTCOME');
  inspectForbidden(input);
  if (!Number.isInteger(linkedAtMs) || linkedAtMs < 0) fail('DECISION_INVALID_OUTCOME');
  if (typeof outcomeId !== 'string' || !outcomeId) fail('DECISION_INVALID_OUTCOME');
  if (!OUTCOME_ACTORS.has(input.sourceType)) fail('DECISION_OUTCOME_ACTOR_FORBIDDEN');
  if (!OUTCOME_STATUSES.includes(input.status)) fail('DECISION_INVALID_OUTCOME');
  if (decision.status !== 'COMMITTED' && input.status !== 'NOT_EXECUTED') fail('DECISION_OUTCOME_REQUIRES_COMMIT');
  const result = {
    outcomeId: input.outcomeId === undefined ? outcomeId : cleanId(input.outcomeId, 'DECISION_INVALID_OUTCOME'),
    schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
    decisionId: decision.decisionId,
    runId: decision.runId,
    status: input.status,
    sourceType: input.sourceType,
    sourceId: cleanId(input.sourceId ?? input.sourceType, 'DECISION_INVALID_OUTCOME'),
    executionEventIds: cleanIds(input.executionEventIds, 'DECISION_INVALID_OUTCOME'),
    verifierReportIds: cleanIds(input.verifierReportIds, 'DECISION_INVALID_OUTCOME', 64),
    userFeedbackEventIds: cleanIds(input.userFeedbackEventIds, 'DECISION_INVALID_OUTCOME', 64),
    observedEffects: cleanIds(input.observedEffects, 'DECISION_INVALID_OUTCOME', 64),
    safetyOutcomeCodes: cleanCodes(input.safetyOutcomeCodes, 'DECISION_INVALID_OUTCOME', 32),
    creditAssignments: normalizeAssignment(input.creditAssignments, 'DECISION_INVALID_OUTCOME'),
    blameAssignments: normalizeAssignment(input.blameAssignments, 'DECISION_INVALID_OUTCOME'),
    evaluatorVersion: cleanId(input.evaluatorVersion ?? 'deterministic-v1', 'DECISION_INVALID_OUTCOME', 120),
    linkedAtMs
  };
  for (const [key, min, max] of [
    ['progressDelta', -1, 1], ['qualityScore', 0, 1],
    ['actualCost', 0, undefined], ['actualLatencyMs', 0, undefined]
  ]) {
    const number = cleanNumber(input[key], 'DECISION_INVALID_OUTCOME', min, max);
    if (number !== undefined) result[key] = number;
  }
  result.outcomeDigest = decisionTraceDigest(unsignedOutcome(result));
  return result;
};

const durableDecisionSnapshot = (decision) => {
  const snapshot = clone(decision);
  snapshot.decisionSummary = 'DECISION_SUMMARY_REDACTED';
  snapshot.assumptions = (snapshot.assumptions ?? []).map((assumption) => ({
    ...assumption,
    statement: 'ASSUMPTION_REDACTED'
  }));
  snapshot.options = (snapshot.options ?? []).map((option) => ({
    ...option,
    summary: 'OPTION_SUMMARY_REDACTED'
  }));
  const { recordDigest: _ignored, ...unsigned } = snapshot;
  snapshot.recordDigest = decisionTraceDigest(immutableDecision(unsigned));
  return snapshot;
};

const validateStoredDecision = (record) => {
  if (!isRecord(record) || typeof record.decisionId !== 'string' || !record.decisionId || record.schemaVersion !== DECISION_TRACE_SCHEMA_VERSION || !DECISION_STATUSES.includes(record.status) ||
      typeof record.recordDigest !== 'string' || record.recordDigest !== decisionTraceDigest(immutableDecision(record))) fail('DECISION_STORE_INVALID');
  if (!Number.isInteger(record.createdAtMs) || record.createdAtMs < 0 ||
      (record.updatedAtMs !== undefined && (!Number.isInteger(record.updatedAtMs) || record.updatedAtMs < 0)) ||
      (record.committedAtMs !== undefined && (!Number.isInteger(record.committedAtMs) || record.committedAtMs < 0)) ||
      (record.lifecycleReasonCode !== undefined && !/^[A-Za-z0-9_.:-]+$/.test(record.lifecycleReasonCode))) fail('DECISION_STORE_INVALID');
  const rebuilt = normalizeDecision(record, { decisionId: record.decisionId, createdAtMs: record.createdAtMs });
  if (rebuilt.recordDigest !== record.recordDigest) fail('DECISION_STORE_INVALID');
  return clone(record);
};

const validateStoredOutcome = (record, decision) => {
  if (!isRecord(record) || record.schemaVersion !== DECISION_TRACE_SCHEMA_VERSION || !OUTCOME_STATUSES.includes(record.status) ||
      typeof record.outcomeDigest !== 'string' || record.outcomeDigest !== decisionTraceDigest(unsignedOutcome(record))) fail('DECISION_STORE_INVALID');
  if (!decision || decision.runId !== record.runId) fail('DECISION_STORE_INVALID');
  const rebuilt = normalizeOutcome(decision, record, { outcomeId: record.outcomeId, linkedAtMs: record.linkedAtMs });
  if (rebuilt.outcomeDigest !== record.outcomeDigest) fail('DECISION_STORE_INVALID');
  return clone(record);
};

const createEvent = (kind, decision, payload, { eventId, atMs }) => {
  const unsigned = {
    eventId, schemaVersion: DECISION_TRACE_SCHEMA_VERSION, kind,
    decisionId: decision.decisionId, runId: decision.runId, payload, atMs
  };
  return { ...unsigned, eventDigest: decisionTraceDigest(unsigned) };
};

const validateStoredEvent = (event) => {
  if (!isRecord(event) || typeof event.eventId !== 'string' || typeof event.kind !== 'string' ||
      typeof event.decisionId !== 'string' || typeof event.runId !== 'string' || !Number.isInteger(event.atMs) || !isRecord(event.payload)) fail('DECISION_STORE_INVALID');
  try { inspectForbidden(event.payload); } catch { fail('DECISION_STORE_INVALID'); }
  const { eventDigest, ...unsigned } = event;
  if (eventDigest !== decisionTraceDigest(unsigned)) fail('DECISION_STORE_INVALID');
  return clone(event);
};

const mergeById = (existing, incoming, collection, key, version, digestKey) => {
  const result = new Map();
  for (const item of [...(Array.isArray(existing?.[collection]) ? existing[collection] : []), ...(incoming[collection] ?? [])]) {
    if (!isRecord(item) || typeof item[key] !== 'string') continue;
    const previous = result.get(item[key]);
    if (previous && digestKey && previous[digestKey] !== item[digestKey]) fail('DECISION_STORE_CONFLICT');
    if (!previous || version(item) >= version(previous)) result.set(item[key], item);
  }
  return [...result.values()];
};

export class AgentDecisionTrace {
  #decisions = new Map();
  #outcomes = new Map();
  #events = new Map();
  #storagePath;
  #now;
  #idFactory;
  #maxDecisionsPerRun;
  #loaded = false;
  #writeQueue = Promise.resolve();
  #eventStore;

  constructor({ storagePath, eventStore, now = () => Date.now(), idFactory = randomUUID, maxDecisionsPerRun = MAX_DECISIONS } = {}) {
    this.#storagePath = storagePath;
    this.#eventStore = eventStore;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#maxDecisionsPerRun = maxDecisionsPerRun;
  }

  async load() {
    if (this.#loaded) return;
    if (this.#eventStore?.list) {
      const durableEvents = await this.#eventStore.list({ aggregateType: 'TaskRun' });
      const traceEvents = durableEvents.filter((event) => event.kind === 'DecisionTraceEvent');
      // The configured event store is authoritative even when empty (including
      // after purge). A legacy cache must never resurrect removed decisions.
      try {
        await this.#loadDurableEvents(traceEvents);
      } catch (error) {
        // A failed replay must not expose a successfully parsed prefix through
        // synchronous query methods or poison the next load with duplicates.
        this.#decisions.clear();
        this.#outcomes.clear();
        this.#events.clear();
        throw error;
      }
      this.#loaded = true;
      return;
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      fail('DECISION_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (!isRecord(parsed) || parsed.schemaVersion !== DECISION_TRACE_SCHEMA_VERSION ||
        !Array.isArray(parsed.decisions) || parsed.decisions.length > MAX_STORED_DECISIONS ||
        !Array.isArray(parsed.outcomes) || parsed.outcomes.length > MAX_OUTCOMES ||
        !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) fail('DECISION_STORE_INVALID');
    for (const raw of parsed.decisions) {
      const record = validateStoredDecision(raw);
      if (this.#decisions.has(record.decisionId)) fail('DECISION_STORE_INVALID');
      this.#decisions.set(record.decisionId, record);
    }
    for (const raw of parsed.outcomes) {
      const decision = this.#decisions.get(raw?.decisionId);
      const record = validateStoredOutcome(raw, decision);
      if (this.#outcomes.has(record.outcomeId)) fail('DECISION_STORE_INVALID');
      this.#outcomes.set(record.outcomeId, record);
    }
    for (const raw of parsed.events) {
      const event = validateStoredEvent(raw);
      const decision = this.#decisions.get(event.decisionId);
      if (this.#events.has(event.eventId) || !decision || decision.runId !== event.runId) fail('DECISION_STORE_INVALID');
      this.#events.set(event.eventId, event);
    }
    this.#validateGraph();
    this.#loaded = true;
  }

  async #loadDurableEvents(events) {
    if (!Array.isArray(events) || events.length > MAX_EVENTS) fail('DECISION_STORE_REPLAY_INVALID');
    const ordered = events.slice().sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    for (const durable of ordered) {
      const payload = durable?.payload;
      if (!isRecord(payload) || !isRecord(payload.traceEvent) || !isRecord(payload.decisionSnapshot)) {
        fail(`DECISION_STORE_REPLAY_UNAVAILABLE:${replayUnavailableDetail(durable, payload)}`);
      }
      const traceEvent = validateStoredEvent(payload.traceEvent);
      const decision = validateStoredDecision(payload.decisionSnapshot);
      if (traceEvent.decisionId !== decision.decisionId || traceEvent.runId !== decision.runId
        || payload.decisionId !== decision.decisionId || durable.runId !== decision.runId) fail('DECISION_STORE_REPLAY_INVALID');
      if (payload.decisionTraceEventId !== traceEvent.eventId || payload.traceKind !== traceEvent.kind
        || payload.traceEventDigest !== traceEvent.eventDigest
        || decisionTraceDigest(payload.tracePayload) !== decisionTraceDigest(traceEvent.payload)) fail('DECISION_STORE_REPLAY_INVALID');
      if (this.#events.has(traceEvent.eventId)) fail('DECISION_STORE_REPLAY_INVALID');
      const previous = this.#decisions.get(decision.decisionId);
      if (previous && (previous.recordDigest !== decision.recordDigest
        || previous.createdAtMs !== decision.createdAtMs)) fail('DECISION_STORE_REPLAY_INVALID');
      const targetStatus = {
        DecisionProposed: 'PROPOSED', DecisionCommitted: 'COMMITTED',
        DecisionRejected: 'REJECTED', DecisionAbstained: 'ABSTAINED',
        DecisionInvalidated: 'INVALIDATED', DecisionRevised: 'PROPOSED',
        DecisionOutcomeLinked: 'COMMITTED'
      }[traceEvent.kind];
      if (!targetStatus || decision.status !== targetStatus) fail('DECISION_STORE_REPLAY_INVALID');
      if (traceEvent.kind === 'DecisionProposed') {
        if (previous) fail('DECISION_STORE_REPLAY_INVALID');
      } else {
        const allowed = traceEvent.kind === 'DecisionOutcomeLinked' ? ['COMMITTED']
          : traceEvent.kind === 'DecisionInvalidated' ? ['PROPOSED', 'COMMITTED'] : ['PROPOSED'];
        if (!previous || !allowed.includes(previous.status)) fail('DECISION_STORE_REPLAY_INVALID');
      }
      if (traceEvent.kind !== 'DecisionOutcomeLinked' && traceEvent.kind !== 'DecisionRevised'
        && traceEvent.payload.status !== targetStatus) fail('DECISION_STORE_REPLAY_INVALID');
      if (targetStatus === 'COMMITTED' && !decision.selectedOptionId) fail('DECISION_STORE_REPLAY_INVALID');
      this.#events.set(traceEvent.eventId, traceEvent);
      this.#decisions.set(decision.decisionId, decision);
      if (traceEvent.kind === 'DecisionOutcomeLinked') {
        if (!isRecord(payload.outcomeSnapshot)) {
          fail(`DECISION_STORE_REPLAY_UNAVAILABLE:${replayUnavailableDetail(durable, payload, `traceKind=${payload.traceKind ?? '?'}`)}`);
        }
        const outcome = validateStoredOutcome(payload.outcomeSnapshot, decision);
        if (outcome.decisionId !== decision.decisionId || traceEvent.payload.outcomeId !== outcome.outcomeId
          || traceEvent.payload.status !== outcome.status) fail('DECISION_STORE_REPLAY_INVALID');
        const existing = this.#outcomes.get(outcome.outcomeId);
        if (existing && existing.outcomeDigest !== outcome.outcomeDigest) fail('DECISION_STORE_CONFLICT');
        this.#outcomes.set(outcome.outcomeId, outcome);
      }
    }
    this.#validateGraph();
  }

  async propose(input) {
    await this.load();
    if ([...this.#decisions.values()].filter((record) => record.runId === input?.runId).length >= this.#maxDecisionsPerRun) fail('DECISION_RUN_LIMIT');
    const normalized = normalizeDecision(input, {
      decisionId: `decision-${this.#idFactory()}`,
      createdAtMs: this.#now()
    });
    const record = this.#eventStore ? durableDecisionSnapshot(normalized) : normalized;
    if (this.#decisions.has(record.decisionId)) fail('DECISION_ID_CONFLICT');
    this.#validateReferences(record);
    await this.#appendEvent('DecisionProposed', record, { status: record.status });
    this.#decisions.set(record.decisionId, record);
    await this.#persist();
    return clone(record);
  }

  async revise(decisionId, input) {
    await this.load();
    const previous = this.#requireDecision(decisionId);
    const revision = await this.propose({ ...input, runId: previous.runId, supersedesDecisionId: decisionId });
    await this.#appendEvent('DecisionRevised', revision, { supersedesDecisionId: decisionId });
    await this.#persist();
    return revision;
  }

  commit(decisionId) { return this.#transition(decisionId, 'COMMITTED', undefined, true); }
  reject(decisionId, reasonCode = 'REJECTED_BY_POLICY') { return this.#transition(decisionId, 'REJECTED', reasonCode); }
  abstain(decisionId, reasonCode = 'ABSTAINED') { return this.#transition(decisionId, 'ABSTAINED', reasonCode); }
  invalidate(decisionId, reasonCode = 'INVALIDATED') { return this.#transition(decisionId, 'INVALIDATED', reasonCode, false, true); }

  async linkOutcome(decisionId, input) {
    await this.load();
    const decision = this.#requireDecision(decisionId);
    const requestedOutcomeId = input?.outcomeId === undefined ? undefined : cleanId(input.outcomeId, 'DECISION_INVALID_OUTCOME');
    const candidateOutcomeId = requestedOutcomeId ?? `outcome-${this.#idFactory()}`;
    const existing = this.#outcomes.get(candidateOutcomeId);
    const outcome = normalizeOutcome(decision, input, {
      outcomeId: candidateOutcomeId,
      linkedAtMs: existing?.linkedAtMs ?? this.#now()
    });
    if (existing) {
      if (existing.outcomeDigest === outcome.outcomeDigest) return clone(existing);
      fail('DECISION_OUTCOME_ID_CONFLICT');
    }
    await this.#appendEvent('DecisionOutcomeLinked', decision, { outcomeId: outcome.outcomeId, status: outcome.status }, { outcome });
    this.#outcomes.set(outcome.outcomeId, outcome);
    await this.#persist();
    return clone(outcome);
  }

  get(decisionId) { const record = this.#decisions.get(decisionId); return record ? clone(record) : undefined; }
  list({ runId, status, decisionType } = {}) {
    return [...this.#decisions.values()]
      .filter((record) => (runId === undefined || record.runId === runId) && (status === undefined || record.status === status) && (decisionType === undefined || record.decisionType === decisionType))
      .map(clone);
  }
  getOutcome(outcomeId) { const record = this.#outcomes.get(outcomeId); return record ? clone(record) : undefined; }
  listOutcomes(decisionId) { return [...this.#outcomes.values()].filter((item) => decisionId === undefined || item.decisionId === decisionId).map(clone); }
  listEvents({ runId, decisionId } = {}) {
    return [...this.#events.values()]
      .filter((event) => (runId === undefined || event.runId === runId) && (decisionId === undefined || event.decisionId === decisionId))
      .sort((left, right) => left.atMs - right.atMs)
      .map(clone);
  }
  assertCommitted(decisionId) {
    const record = this.#requireDecision(decisionId);
    if (record.status !== 'COMMITTED') fail('DECISION_NOT_COMMITTED');
    return clone(record);
  }
  summary() {
    return { store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY', decisionCount: this.#decisions.size, outcomeCount: this.#outcomes.size, eventCount: this.#events.size };
  }
  async flush() { await this.#writeQueue; }

  #requireDecision(decisionId) {
    const record = this.#decisions.get(decisionId);
    if (!record) fail('DECISION_NOT_FOUND');
    return record;
  }

  #validateReferences(record) {
    for (const parentId of record.parentDecisionIds) {
      const parent = this.#decisions.get(parentId);
      if (!parent || parent.runId !== record.runId || parentId === record.decisionId) fail('DECISION_INVALID_PARENTS');
    }
    if (record.supersedesDecisionId !== undefined) {
      const previous = this.#decisions.get(record.supersedesDecisionId);
      if (!previous || previous.runId !== record.runId || previous.decisionId === record.decisionId) fail('DECISION_INVALID_SUPERSEDES');
    }
    this.#validateGraph(record);
  }

  #validateGraph(extra) {
    const records = new Map(this.#decisions);
    if (extra) records.set(extra.decisionId, extra);
    const visiting = new Set();
    const visited = new Set();
    const visit = (decisionId) => {
      if (visiting.has(decisionId)) fail('DECISION_GRAPH_CYCLE');
      if (visited.has(decisionId)) return;
      const record = records.get(decisionId);
      if (!record) fail('DECISION_INVALID_PARENTS');
      visiting.add(decisionId);
      const dependencies = [...(record.parentDecisionIds ?? [])];
      if (record.supersedesDecisionId !== undefined) dependencies.push(record.supersedesDecisionId);
      for (const parentId of dependencies) {
        const parent = records.get(parentId);
        if (!parent || parent.runId !== record.runId) fail('DECISION_INVALID_PARENTS');
        visit(parentId);
      }
      visiting.delete(decisionId);
      visited.add(decisionId);
    };
    for (const decisionId of records.keys()) visit(decisionId);
  }

  async #transition(decisionId, status, reasonCode, requireSelection = false, allowCommitted = false) {
    await this.load();
    const current = this.#requireDecision(decisionId);
    if (current.status !== 'PROPOSED' && !(allowCommitted && current.status === 'COMMITTED')) fail('DECISION_INVALID_TRANSITION');
    if (requireSelection && current.selectedOptionId === undefined) fail('DECISION_SELECTION_REQUIRED');
    const next = { ...current, status, updatedAtMs: this.#now() };
    if (status === 'COMMITTED') next.committedAtMs = next.updatedAtMs;
    if (reasonCode !== undefined) next.lifecycleReasonCode = cleanId(reasonCode, 'DECISION_INVALID_REASON_CODE', 120);
    const kind = { COMMITTED: 'DecisionCommitted', REJECTED: 'DecisionRejected', ABSTAINED: 'DecisionAbstained', INVALIDATED: 'DecisionInvalidated' }[status];
    await this.#appendEvent(kind, next, { status, ...(reasonCode === undefined ? {} : { reasonCode }) });
    this.#decisions.set(decisionId, next);
    await this.#persist();
    return clone(next);
  }

  async #appendEvent(kind, decision, payload, { outcome } = {}) {
    if (this.#events.size >= MAX_EVENTS) fail('DECISION_EVENT_LIMIT');
    const event = createEvent(kind, decision, payload, {
      eventId: `decision-event-${this.#idFactory()}`,
      atMs: this.#now()
    });
    if (this.#eventStore) {
      const request = {
        runId: decision.runId,
        aggregateType: 'TaskRun',
        aggregateId: decision.runId,
        kind: 'DecisionTraceEvent',
        payload: {
          decisionTraceEventId: event.eventId,
          decisionId: decision.decisionId,
          traceKind: event.kind,
          tracePayload: event.payload,
          traceEventDigest: event.eventDigest,
          traceEvent: event,
          decisionSnapshot: durableDecisionSnapshot(decision),
          ...(outcome ? { outcomeSnapshot: outcome } : {})
        },
        sensitivity: 'DECISION_TRACE',
        commandId: `decision-trace:${event.eventId}`
      };
      const { receipt, event: durable } = await this.#eventStore.append(request) ?? {};
      if (receipt?.status !== 'COMMITTED' || receipt.commandId !== request.commandId
        || !durable?.eventId || !Array.isArray(receipt.eventIds) || !receipt.eventIds.includes(durable.eventId)
        || durable.runId !== request.runId || durable.kind !== request.kind
        || durable.aggregateType !== request.aggregateType || durable.aggregateId !== request.aggregateId
        || decisionTraceDigest(durable.payload) !== decisionTraceDigest(request.payload)) fail('DURABLE_COMMIT_REQUIRED');
    }
    this.#events.set(event.eventId, event);
    return event;
  }

  async #persist() {
    if (!this.#storagePath) return;
    const incoming = {
      schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
      decisions: this.list(), outcomes: this.listOutcomes(), events: this.listEvents()
    };
    const write = async () => persistJsonFile(this.#storagePath, incoming, {
      merge: (existing, fresh) => ({
        schemaVersion: DECISION_TRACE_SCHEMA_VERSION,
        decisions: mergeById(existing, fresh, 'decisions', 'decisionId', (item) => item.updatedAtMs ?? item.createdAtMs, 'recordDigest'),
        outcomes: mergeById(existing, fresh, 'outcomes', 'outcomeId', (item) => item.linkedAtMs, 'outcomeDigest'),
        events: mergeById(existing, fresh, 'events', 'eventId', (item) => item.atMs, 'eventDigest')
      })
    });
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }
}

export const createAgentDecisionTrace = (options) => new AgentDecisionTrace(options);
