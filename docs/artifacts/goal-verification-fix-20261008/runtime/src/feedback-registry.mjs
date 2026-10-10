import { createHash, randomUUID } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_EVENTS = 100_000;
const MAX_FEEDBACK = 20_000;
const MAX_TEXT = 240;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EVENT_KINDS = new Set(['FeedbackSubmitted', 'FeedbackRevised', 'FeedbackRetracted']);
const SOURCE_TYPES = new Set(['USER', 'VERIFIER', 'COORDINATOR', 'SYSTEM']);
const OUTCOME_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN', 'NOT_EXECUTED']);
const REASON_CODE = /^[A-Za-z0-9_.:-]{1,120}$/u;
const FORBIDDEN = /prompt|reasoning|chain[-_ ]?of[-_ ]?thought|credential|password|authorization|api[_-]?key|secret|private[-_ ]?key|stdout|stderr|command(?:_text)?/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const text = (value, code, max = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || FORBIDDEN.test(value)) throw new Error(code);
  return value.replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max);
};
const optionalText = (value, code, max = MAX_TEXT) => value === undefined ? undefined : text(value, code, max);
const commandValue = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new Error('FEEDBACK_COMMAND_INVALID');
  return value.trim();
};
const requiredDigest = (value, code) => {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(code);
  return value;
};
const boundedCodes = (value, code, max = 32) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !REASON_CODE.test(item))) throw new Error(code);
  return [...new Set(value)];
};
const boundedRefs = (value, code, max = 64) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(code);
  return [...new Set(value.map((item) => text(item, code, 240)))];
};
const finite = (value, code, min, max) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(code);
  return value;
};

const normalizeModelIdentity = (value) => {
  if (!isObject(value)) throw new Error('FEEDBACK_MODEL_IDENTITY_REQUIRED');
  const result = {
    provider: text(value.provider, 'FEEDBACK_MODEL_IDENTITY_INVALID', 80),
    protocol: text(value.protocol, 'FEEDBACK_MODEL_IDENTITY_INVALID', 80),
    model: text(value.model, 'FEEDBACK_MODEL_IDENTITY_INVALID', 200),
    modelVersion: text(value.modelVersion ?? 'unknown', 'FEEDBACK_MODEL_IDENTITY_INVALID', 120),
    role: text(value.role ?? 'unknown', 'FEEDBACK_MODEL_IDENTITY_INVALID', 120),
    pluginVersion: text(value.pluginVersion ?? 'unknown', 'FEEDBACK_MODEL_IDENTITY_INVALID', 120),
    modelRegistryDigest: requiredDigest(value.modelRegistryDigest ?? 'sha256:' + '0'.repeat(64), 'FEEDBACK_MODEL_IDENTITY_INVALID')
  };
  result.candidateKey = [result.provider, result.protocol, result.model, result.modelVersion, result.role, result.pluginVersion].join('/');
  return result;
};

const normalizeScenario = (value) => {
  if (!isObject(value)) throw new Error('FEEDBACK_SCENARIO_REQUIRED');
  const result = {
    taskClass: text(value.taskClass ?? 'unknown', 'FEEDBACK_SCENARIO_INVALID', 80),
    riskClass: text(value.riskClass ?? 'unknown', 'FEEDBACK_SCENARIO_INVALID', 80),
    operationClass: text(value.operationClass ?? 'unknown', 'FEEDBACK_SCENARIO_INVALID', 80),
    requiredCapabilities: boundedCodes(value.requiredCapabilities, 'FEEDBACK_SCENARIO_INVALID', 32).sort(),
    workspaceCapabilityClass: text(value.workspaceCapabilityClass ?? 'unknown', 'FEEDBACK_SCENARIO_INVALID', 80),
    platform: text(value.platform ?? 'WINDOWS', 'FEEDBACK_SCENARIO_INVALID', 40),
    policyClass: text(value.policyClass ?? 'default', 'FEEDBACK_SCENARIO_INVALID', 80)
  };
  result.scenarioKey = digest(result);
  return result;
};

const normalizeDimensions = (value) => {
  if (!isObject(value)) throw new Error('FEEDBACK_DIMENSIONS_REQUIRED');
  const result = {};
  for (const [key, min, max] of [
    ['userSatisfaction', 0, 1], ['quality', 0, 1], ['cost', 0, Number.MAX_SAFE_INTEGER], ['latency', 0, Number.MAX_SAFE_INTEGER]
  ]) {
    const number = finite(value[key], 'FEEDBACK_DIMENSIONS_INVALID', min, max);
    if (number !== undefined) result[key] = number;
  }
  for (const key of ['objectiveSuccess', 'verifierPass', 'safetyIncident']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error('FEEDBACK_DIMENSIONS_INVALID');
      result[key] = value[key];
    }
  }
  if (value.rating !== undefined) {
    if (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 5) throw new Error('FEEDBACK_RATING_INVALID');
    result.rating = value.rating;
    result.userSatisfaction = (value.rating - 1) / 4;
  }
  if (value.usable !== undefined) {
    if (typeof value.usable !== 'boolean') throw new Error('FEEDBACK_DIMENSIONS_INVALID');
    result.usable = value.usable;
  }
  if (!Object.keys(result).length) throw new Error('FEEDBACK_DIMENSIONS_EMPTY');
  return result;
};

const normalizeFeedback = (input, { feedbackId, submittedAtMs, eventKind, previousFeedbackId } = {}) => {
  if (!isObject(input)) throw new Error('FEEDBACK_INPUT_INVALID');
  for (const key of Object.keys(input)) if (FORBIDDEN.test(key)) throw new Error('FEEDBACK_FORBIDDEN_CONTENT');
  const runId = text(input.runId, 'FEEDBACK_RUN_REQUIRED', 160);
  const outcomeId = text(input.outcomeId, 'FEEDBACK_OUTCOME_REQUIRED', 240);
  const result = {
    schemaVersion: SCHEMA_VERSION,
    feedbackId: text(feedbackId, 'FEEDBACK_ID_INVALID', 240),
    runId,
    taskId: text(input.taskId ?? runId, 'FEEDBACK_TASK_REQUIRED', 240),
    ...(input.threadId === undefined ? {} : { threadId: text(input.threadId, 'FEEDBACK_THREAD_INVALID', 160) }),
    ...(input.decisionId === undefined ? {} : { decisionId: text(input.decisionId, 'FEEDBACK_DECISION_INVALID', 240) }),
    outcomeId,
    ...(input.outcomeStatus === undefined ? {} : { outcomeStatus: text(input.outcomeStatus, 'FEEDBACK_OUTCOME_STATUS_INVALID', 40).toUpperCase() }),
    modelIdentity: normalizeModelIdentity(input.modelIdentity),
    scenario: normalizeScenario(input.scenario),
    sourceType: text(input.sourceType ?? 'USER', 'FEEDBACK_SOURCE_INVALID', 40).toUpperCase(),
    dimensions: normalizeDimensions(input.dimensions),
    reasonCodes: boundedCodes(input.reasonCodes, 'FEEDBACK_REASON_INVALID'),
    evidenceRefs: boundedRefs(input.evidenceRefs, 'FEEDBACK_EVIDENCE_INVALID'),
    independenceGroup: text(input.independenceGroup ?? `${runId}/${outcomeId}`, 'FEEDBACK_INDEPENDENCE_INVALID', 240),
    submittedAtMs: Number.isInteger(submittedAtMs) && submittedAtMs >= 0 ? submittedAtMs : Date.now(),
    eventKind,
    ...(previousFeedbackId ? { previousFeedbackId: text(previousFeedbackId, 'FEEDBACK_PREVIOUS_INVALID', 240) } : {})
  };
  if (!SOURCE_TYPES.has(result.sourceType)) throw new Error('FEEDBACK_SOURCE_INVALID');
  if (result.outcomeStatus !== undefined && !OUTCOME_STATUSES.has(result.outcomeStatus)) throw new Error('FEEDBACK_OUTCOME_STATUS_INVALID');
  result.recordDigest = digest(result);
  return result;
};

const feedbackEventPayload = (event) => Object.fromEntries(Object.entries({
  feedbackId: event.feedback.feedbackId,
  targetFeedbackId: event.targetFeedbackId,
  runId: event.feedback.runId,
  outcomeId: event.feedback.outcomeId,
  eventKind: event.kind,
  recordDigest: event.feedback.recordDigest,
  previousFeedbackId: event.feedback.previousFeedbackId,
  scenarioKey: event.feedback.scenario?.scenarioKey,
  candidateKey: event.feedback.modelIdentity?.candidateKey,
  modelRegistryDigest: event.feedback.modelIdentity?.modelRegistryDigest,
  sourceType: event.feedback.sourceType,
  outcomeStatus: event.feedback.outcomeStatus,
  dimensions: event.feedback.dimensions,
  evidenceRefs: event.feedback.evidenceRefs
}).filter(([, value]) => value !== undefined));

const validateEvent = (event) => {
  if (!isObject(event) || !EVENT_KINDS.has(event.kind) || !isObject(event.feedback) || typeof event.eventId !== 'string'
    || !event.eventId || !Number.isInteger(event.atMs) || event.atMs < 0) throw new Error('FEEDBACK_STORE_INVALID_EVENT');
  const feedback = event.feedback;
  const { recordDigest, ...unsigned } = feedback;
  if (recordDigest !== digest(unsigned)) throw new Error('FEEDBACK_STORE_INVALID_DIGEST');
  if (event.kind === 'FeedbackRetracted' && typeof event.targetFeedbackId !== 'string') throw new Error('FEEDBACK_STORE_INVALID_EVENT');
  if (event.requestDigest !== undefined && !DIGEST.test(event.requestDigest)) throw new Error('FEEDBACK_STORE_INVALID_DIGEST');
};

const validateStore = (parsed) => {
  if (!isObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.events) || parsed.events.length > MAX_EVENTS) throw new Error('FEEDBACK_STORE_INVALID');
  const ids = new Set();
  for (const event of parsed.events) {
    validateEvent(event);
    if (ids.has(event.eventId)) throw new Error('FEEDBACK_STORE_DUPLICATE_EVENT');
    ids.add(event.eventId);
  }
  return parsed;
};

const project = (events) => {
  const records = new Map();
  const retracted = new Set();
  for (const event of events.slice().sort((left, right) => left.atMs - right.atMs || left.eventId.localeCompare(right.eventId))) {
    if (event.kind === 'FeedbackRetracted') {
      retracted.add(event.targetFeedbackId);
      records.delete(event.targetFeedbackId);
      continue;
    }
    const feedback = clone(event.feedback);
    if (event.kind === 'FeedbackRevised' && feedback.previousFeedbackId) records.delete(feedback.previousFeedbackId);
    records.set(feedback.feedbackId, feedback);
  }
  return [...records.values()].filter((record) => !retracted.has(record.feedbackId));
};

export class FeedbackRegistry {
  #storagePath;
  #now;
  #idFactory;
  #events = [];
  #records = new Map();
  #queue = Promise.resolve();
  #loaded = false;
  #eventStore;

  constructor({ storagePath, eventStore, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.#storagePath = storagePath;
    this.#eventStore = eventStore;
    this.#now = now;
    this.#idFactory = idFactory;
  }

  async load() {
    if (this.#loaded) return this.summary();
    if (!this.#storagePath) { this.#loaded = true; return this.summary(); }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); } catch { throw new Error('FEEDBACK_STORE_READ_FAILED'); }
    if (parsed !== undefined) {
      validateStore(parsed);
      this.#events = parsed.events.map(clone);
      this.#records = new Map(project(this.#events).map((record) => [record.feedbackId, record]));
    }
    this.#loaded = true;
    return this.summary();
  }

  async reload() {
    await this.#queue.catch(() => {});
    this.#events = [];
    this.#records = new Map();
    this.#loaded = false;
    return this.load();
  }

  async submit(input, { commandId } = {}) {
    return this.#append('FeedbackSubmitted', input, { commandId });
  }

  async revise(feedbackId, input, { commandId } = {}) {
    await this.load();
    if (!this.#records.has(feedbackId)) throw new Error('FEEDBACK_NOT_FOUND');
    return this.#append('FeedbackRevised', input, { commandId, previousFeedbackId: feedbackId });
  }

  async retract(feedbackId, { commandId } = {}) {
    await this.load();
    if (!this.#records.has(feedbackId)) {
      const prior = this.#events.find((event) => event.kind === 'FeedbackRetracted' && event.targetFeedbackId === feedbackId);
      if (prior && (!commandId || prior.commandId === commandId)) return { event: clone(prior), idempotent: true };
      throw new Error('FEEDBACK_NOT_FOUND');
    }
    const operation = async () => {
      const source = this.#records.get(feedbackId);
      const atMs = this.#now();
      const feedback = {
        schemaVersion: SCHEMA_VERSION,
        feedbackId: `retraction-${feedbackId}`,
        runId: source.runId,
        outcomeId: source.outcomeId,
        eventKind: 'FeedbackRetracted',
        submittedAtMs: atMs
      };
      const event = {
        schemaVersion: SCHEMA_VERSION,
        eventId: `feedback-event-${this.#idFactory()}`,
        kind: 'FeedbackRetracted',
        targetFeedbackId: feedbackId,
        feedback: { ...feedback, recordDigest: digest(feedback) },
        ...(commandId ? { commandId: commandValue(commandId) } : {}),
        atMs
      };
      return this.#commit(event);
    };
    this.#queue = this.#queue.then(operation, operation);
    return this.#queue;
  }

  list({ runId, scenarioKey, candidateKey, includeRetracted = false } = {}) {
    return [...(includeRetracted ? this.#events.map((event) => event.feedback) : this.#records.values())]
      .filter((record) => (!runId || record.runId === runId)
        && (!scenarioKey || record.scenario?.scenarioKey === scenarioKey)
        && (!candidateKey || record.modelIdentity?.candidateKey === candidateKey)).map(clone);
  }
  listEvents({ runId } = {}) { return this.#events.filter((event) => !runId || event.feedback.runId === runId).map(clone); }
  async listDurableSummaries({ runId } = {}) {
    if (!this.#eventStore?.list) throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const events = (await this.#eventStore.list({ aggregateType: 'TaskRun' }))
      .filter((event) => event.kind === 'FeedbackFactRecorded' && (!runId || event.aggregateId === runId))
      .sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    const summaries = new Map();
    for (const event of events) {
      const payload = event.payload;
      if (!isObject(payload) || typeof payload.feedbackId !== 'string' || typeof payload.runId !== 'string'
        || payload.runId !== event.aggregateId || typeof payload.outcomeId !== 'string'
        || typeof payload.recordDigest !== 'string' || !DIGEST.test(payload.recordDigest)
        || typeof payload.eventKind !== 'string' || !['FeedbackSubmitted', 'FeedbackRevised', 'FeedbackRetracted'].includes(payload.eventKind)
        || !Number.isInteger(event.sequence) || event.sequence < 1) throw new Error('FEEDBACK_STORE_INVALID_EVENT');
      if (payload.eventKind === 'FeedbackRetracted') {
        if (typeof payload.targetFeedbackId !== 'string') throw new Error('FEEDBACK_STORE_INVALID_EVENT');
        summaries.delete(payload.targetFeedbackId);
        continue;
      }
      if (payload.eventKind === 'FeedbackRevised' && payload.previousFeedbackId !== undefined && typeof payload.previousFeedbackId !== 'string') throw new Error('FEEDBACK_STORE_INVALID_EVENT');
      if (payload.eventKind === 'FeedbackRevised' && payload.previousFeedbackId) summaries.delete(payload.previousFeedbackId);
      summaries.set(payload.feedbackId, clone({
        eventId: event.eventId, sequence: event.sequence, feedbackId: payload.feedbackId, runId: payload.runId,
        outcomeId: payload.outcomeId, eventKind: payload.eventKind, recordDigest: payload.recordDigest,
        ...(payload.scenarioKey ? { scenarioKey: payload.scenarioKey } : {}), ...(payload.candidateKey ? { candidateKey: payload.candidateKey } : {}),
        ...(payload.modelRegistryDigest ? { modelRegistryDigest: requiredDigest(payload.modelRegistryDigest, 'FEEDBACK_STORE_INVALID_DIGEST') } : {}),
        ...(payload.sourceType ? { sourceType: payload.sourceType } : {}), ...(payload.outcomeStatus ? { outcomeStatus: payload.outcomeStatus } : {}),
        ...(payload.dimensions ? { dimensions: payload.dimensions } : {}), ...(payload.evidenceRefs ? { evidenceRefs: payload.evidenceRefs } : {})
      }));
    }
    return [...summaries.values()].map(clone);
  }
  get(feedbackId) { const record = this.#records.get(feedbackId); return record ? clone(record) : undefined; }
  summary() { return { store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY', eventCount: this.#events.length, feedbackCount: this.#records.size }; }
  async flush() { await this.#queue; }

  async #append(kind, input, { commandId, previousFeedbackId } = {}) {
    const operation = async () => {
      await this.load();
      const feedbackId = text(input?.feedbackId ?? `feedback-${this.#idFactory()}`, 'FEEDBACK_ID_INVALID', 240);
      const atMs = this.#now();
      const feedback = normalizeFeedback(input, { feedbackId, submittedAtMs: atMs, eventKind: kind, previousFeedbackId });
      const normalizedCommandId = commandId === undefined ? undefined : commandValue(commandId);
      const requestDigest = digest(input);
      if (normalizedCommandId) {
        const priorEvent = this.#events.find((event) => event.commandId === normalizedCommandId);
        if (priorEvent) {
          if (priorEvent.requestDigest !== requestDigest) throw new Error('FEEDBACK_COMMAND_IDEMPOTENCY_CONFLICT');
          return { feedback: clone(this.#records.get(priorEvent.feedback.feedbackId) ?? priorEvent.feedback), event: clone(priorEvent), idempotent: true };
        }
      }
      if (this.#records.has(feedbackId)) {
        const existing = this.#records.get(feedbackId);
        if (existing.recordDigest === feedback.recordDigest) return { feedback: clone(existing), idempotent: true };
        throw new Error('FEEDBACK_ID_CONFLICT');
      }
      const event = {
        schemaVersion: SCHEMA_VERSION,
        eventId: `feedback-event-${this.#idFactory()}`,
        kind,
        feedback,
        requestDigest,
        ...(normalizedCommandId ? { commandId: normalizedCommandId } : {}),
        atMs
      };
      return this.#commit(event);
    };
    this.#queue = this.#queue.then(operation, operation);
    return this.#queue;
  }

  async #commit(event) {
    validateEvent(event);
    if (this.#eventStore) {
      const payload = feedbackEventPayload(event);
      const result = await this.#eventStore.append({
        runId: event.feedback.runId, aggregateType: 'TaskRun', aggregateId: event.feedback.runId,
        kind: 'FeedbackFactRecorded',
        payload,
        sensitivity: 'FEEDBACK',
        commandId: 'feedback-fact:' + event.eventId
      });
      const receipt = result?.receipt ?? result;
      const durableEvent = result?.event ?? result?.events?.[0];
      if (receipt?.status !== 'COMMITTED' || !durableEvent?.eventId || !receipt.eventIds?.includes(durableEvent.eventId) || durableEvent.kind !== 'FeedbackFactRecorded' || durableEvent.aggregateId !== event.feedback.runId || digest(durableEvent.payload) !== digest(payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
    }
    const incomingEvents = [...this.#events, event];
    if (incomingEvents.length > MAX_EVENTS) throw new Error('FEEDBACK_STORE_LIMIT');
    let snapshot = { schemaVersion: SCHEMA_VERSION, events: incomingEvents };
    if (this.#storagePath) {
      await persistJsonFile(this.#storagePath, snapshot, {
        merge: (existing) => {
          if (existing !== undefined) validateStore(existing);
          const byId = new Map([...(existing?.events ?? []), ...snapshot.events].map((item) => [item.eventId, item]));
          snapshot = { schemaVersion: SCHEMA_VERSION, events: [...byId.values()].sort((left, right) => left.atMs - right.atMs || left.eventId.localeCompare(right.eventId)) };
          validateStore(snapshot);
          return snapshot;
        }
      });
    }
    this.#events = snapshot.events.map(clone);
    this.#records = new Map(project(this.#events).map((record) => [record.feedbackId, record]));
    return { feedback: clone(this.#records.get(event.feedback.feedbackId) ?? event.feedback), event: clone(event), idempotent: false };
  }
}

export const createFeedbackRegistry = (options) => new FeedbackRegistry(options);
export const feedbackDigest = digest;
export const validateFeedbackStore = validateStore;
