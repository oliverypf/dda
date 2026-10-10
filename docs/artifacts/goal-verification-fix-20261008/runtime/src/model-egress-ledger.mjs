import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

// S2-12: per-candidate outbound (egress) and cost accounting.
//
// A candidate fanout can send N prompts to N different providers, so the
// "what left this machine" and "what did it cost" records must be per
// candidate rather than per run. Records carry digests and bounded metadata
// only: no prompt text, no model output, no credentials, no headers. That keeps
// the ledger inside the same privacy boundary as the Support Bundle, which
// scans these records with the shared privacy scanner.
const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 16_384;
const MAX_LIST = 2_048;
const PHASES = Object.freeze([
  'CANDIDATE_DRAFT',
  'CANDIDATE_JUDGE',
  'EXECUTOR_TURN',
  'SEMANTIC_VERIFIER',
  'PLANNER_TURN',
  'COUNCIL_TURN'
]);
const STATUSES = Object.freeze(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const bounded = (value, max = 240) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);
const numberOf = (value) => (Number.isFinite(value) && value >= 0 ? Number(value) : undefined);

/** Reduce an outbound URL to a bounded egress target. Credentials and query
 * strings are rejected outright: an egress record must never become a place
 * where a secret is stored.
 */
export const normalizeEgressTarget = (urlText) => {
  const text = bounded(urlText, 500);
  if (!text) throw new Error('MODEL_EGRESS_TARGET_REQUIRED');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('MODEL_EGRESS_TARGET_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('MODEL_EGRESS_TARGET_INVALID');
  if (parsed.search) throw new Error('MODEL_EGRESS_TARGET_INVALID');
  const scheme = parsed.protocol.replace(':', '');
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : (scheme === 'https' ? 443 : 80);
  return {
    scheme,
    host: host.slice(0, 240),
    port,
    targetDigest: digest({ scheme, host, port })
  };
};

const normalizeRecord = (input, { recordId, occurredAtMs }) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MODEL_EGRESS_INVALID');
  const phase = bounded(input.phase, 40);
  if (!PHASES.includes(phase)) throw new Error('MODEL_EGRESS_PHASE_INVALID');
  const status = bounded(input.status, 40);
  if (!STATUSES.includes(status)) throw new Error('MODEL_EGRESS_STATUS_INVALID');
  const modelId = bounded(input.modelId);
  if (!modelId) throw new Error('MODEL_EGRESS_MODEL_INVALID');
  const promptDigest = bounded(input.promptDigest, 120);
  if (promptDigest && !DIGEST.test(promptDigest)) throw new Error('MODEL_EGRESS_PROMPT_DIGEST_INVALID');
  const outputDigest = bounded(input.outputDigest, 120);
  if (outputDigest && !DIGEST.test(outputDigest)) throw new Error('MODEL_EGRESS_OUTPUT_DIGEST_INVALID');
  const record = {
    recordId,
    schemaVersion: SCHEMA_VERSION,
    phase,
    status,
    modelId,
    ...(bounded(input.runId) ? { runId: bounded(input.runId) } : {}),
    ...(bounded(input.stepId) ? { stepId: bounded(input.stepId) } : {}),
    ...(bounded(input.candidateId) ? { candidateId: bounded(input.candidateId) } : {}),
    ...(bounded(input.bindingId) ? { bindingId: bounded(input.bindingId) } : {}),
    ...(bounded(input.provider, 80) ? { provider: bounded(input.provider, 80) } : {}),
    ...(bounded(input.protocol, 40) ? { protocol: bounded(input.protocol, 40) } : {}),
    egress: {
      scheme: bounded(input.egress?.scheme, 10),
      host: bounded(input.egress?.host, 240),
      port: numberOf(input.egress?.port),
      targetDigest: bounded(input.egress?.targetDigest, 120)
    },
    ...(promptDigest ? { promptDigest } : {}),
    ...(outputDigest ? { outputDigest } : {}),
    ...(numberOf(input.latencyMs) !== undefined ? { latencyMs: numberOf(input.latencyMs) } : {}),
    ...(numberOf(input.expectedCost) !== undefined ? { expectedCost: numberOf(input.expectedCost) } : {}),
    ...(numberOf(input.expectedTokens) !== undefined ? { expectedTokens: numberOf(input.expectedTokens) } : {}),
    ...(numberOf(input.actualTokens) !== undefined ? { actualTokens: numberOf(input.actualTokens) } : {}),
    ...(numberOf(input.actualCost) !== undefined ? { actualCost: numberOf(input.actualCost) } : {}),
    redaction: { promptIncluded: false, outputIncluded: false, credentialsIncluded: false },
    occurredAtMs
  };
  if (!record.egress.host || !DIGEST.test(record.egress.targetDigest ?? '')) throw new Error('MODEL_EGRESS_TARGET_INVALID');
  record.recordDigest = digest({ ...record, recordDigest: undefined });
  return record;
};

const validRecord = (record) => Boolean(record)
  && typeof record.recordId === 'string'
  && record.schemaVersion === SCHEMA_VERSION
  && PHASES.includes(record.phase)
  && STATUSES.includes(record.status)
  && typeof record.modelId === 'string'
  && record.recordDigest === digest({ ...record, recordDigest: undefined });

export class ModelEgressLedger {
  #records = new Map();
  #storagePath;
  #queue = Promise.resolve();
  #loaded = false;
  #idFactory;
  #eventStore;
  #now;

  constructor({ storagePath, idFactory = randomUUID, eventStore, now = Date.now } = {}) {
    this.#storagePath = storagePath;
    this.#idFactory = idFactory;
    this.#eventStore = eventStore;
    this.#now = now;
  }

  async load() {
    if (this.#loaded) return;
    if (this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'ModelEgress' }); }
      catch { throw new Error('MODEL_EGRESS_READ_FAILED'); }
      for (const event of events) {
        if (event.kind !== 'ModelEgressRecorded') continue;
        const records = Array.isArray(event.payload?.records) ? event.payload.records : [];
        for (const record of records) {
          if (!validRecord(record)) throw new Error('MODEL_EGRESS_STORE_INVALID');
          this.#records.set(record.recordId, clone(record));
        }
      }
      this.#loaded = true;
      return;
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); }
    catch (error) { if (error?.code === 'ENOENT') return; throw new Error('MODEL_EGRESS_READ_FAILED'); }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error('MODEL_EGRESS_STORE_INVALID');
    for (const record of parsed.records) {
      if (!validRecord(record)) throw new Error('MODEL_EGRESS_STORE_INVALID');
      this.#records.set(record.recordId, clone(record));
    }
    this.#loaded = true;
  }

  get hasDurableSink() { return Boolean(this.#eventStore && typeof this.#eventStore.append === 'function'); }

  /** Commit egress facts before they influence any cache or report. */
  async recordDurably(entries = []) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const list = Array.isArray(entries) ? entries : [entries];
    if (!list.length) return [];
    const occurredAtMs = this.#now();
    const records = list.map((entry) => normalizeRecord(entry, { recordId: `egress-${this.#idFactory()}`, occurredAtMs }));
    if (this.#records.size + records.length > MAX_RECORDS) throw new Error('MODEL_EGRESS_CAPACITY_EXCEEDED');
    this.#assertDistinctRecordIds(records);
    await this.#eventStore.append({
      runId: records[0].runId ?? 'model-egress',
      aggregateType: 'ModelEgress',
      aggregateId: records[0].runId ?? 'model-egress',
      commandId: `model-egress:${digest(records.map((record) => record.recordId))}`,
      kind: 'ModelEgressRecorded',
      payload: { records: records.map((record) => clone(record)) },
      sensitivity: 'INTERNAL'
    });
    for (const record of records) this.#records.set(record.recordId, record);
    this.#schedulePersist();
    return records.map(clone);
  }

  record(entries = []) {
    const list = Array.isArray(entries) ? entries : [entries];
    const occurredAtMs = this.#now();
    const records = list.map((entry) => normalizeRecord(entry, { recordId: `egress-${this.#idFactory()}`, occurredAtMs }));
    if (this.#records.size + records.length > MAX_RECORDS) throw new Error('MODEL_EGRESS_CAPACITY_EXCEEDED');
    this.#assertDistinctRecordIds(records);
    for (const record of records) this.#records.set(record.recordId, record);
    if (records.length) this.#schedulePersist();
    return records.map(clone);
  }

  list(filter = {}) {
    return [...this.#records.values()]
      .filter((record) => (filter.runId === undefined || record.runId === filter.runId)
        && (filter.phase === undefined || record.phase === filter.phase)
        && (filter.candidateId === undefined || record.candidateId === filter.candidateId))
      .sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.recordId.localeCompare(right.recordId))
      .slice(0, MAX_LIST)
      .map(clone);
  }

  /** Group by provider/model and by candidate so a fanout can be audited at the
   * granularity the calls really happened.
   */
  summarize({ runId } = {}) {
    const records = [...this.#records.values()].filter((record) => runId === undefined || record.runId === runId);
    const empty = () => ({ calls: 0, failures: 0, expectedCost: null, actualCost: null, expectedCostKnown: 0, actualCostKnown: 0, expectedTokens: 0, actualTokens: 0, latencyMs: 0 });
    const accumulate = (bucket, record) => {
      bucket.calls += 1;
      if (record.status !== 'SUCCEEDED') bucket.failures += 1;
      if (record.expectedCost !== undefined) { bucket.expectedCost = (bucket.expectedCost ?? 0) + record.expectedCost; bucket.expectedCostKnown += 1; }
      if (record.actualCost !== undefined) { bucket.actualCost = (bucket.actualCost ?? 0) + record.actualCost; bucket.actualCostKnown += 1; }
      bucket.expectedTokens += record.expectedTokens ?? 0;
      bucket.actualTokens += record.actualTokens ?? 0;
      bucket.latencyMs += record.latencyMs ?? 0;
    };
    const byProvider = {};
    const byPhase = {};
    const byCandidate = {};
    for (const record of records) {
      const providerKey = `${record.provider ?? 'unknown'}/${record.modelId}`;
      byProvider[providerKey] = byProvider[providerKey] ?? empty();
      accumulate(byProvider[providerKey], record);
      byPhase[record.phase] = byPhase[record.phase] ?? empty();
      accumulate(byPhase[record.phase], record);
      if (record.candidateId) {
        byCandidate[record.candidateId] = byCandidate[record.candidateId] ?? { ...empty(), provider: record.provider, modelId: record.modelId };
        accumulate(byCandidate[record.candidateId], record);
      }
    }
    const totals = records.reduce((bucket, record) => {
      accumulate(bucket, record);
      return bucket;
    }, empty());
    return {
      schemaVersion: SCHEMA_VERSION,
      recordCount: records.length,
      totals,
      byProvider,
      byPhase,
      byCandidate,
      redaction: { promptIncluded: false, outputIncluded: false, credentialsIncluded: false }
    };
  }

  async flush() { await this.#queue; }

  /** Two distinct outbound calls must never collapse into one record, neither
   * against the existing ledger nor inside a single batch.
   */
  #assertDistinctRecordIds(records) {
    const batchIds = new Set();
    for (const record of records) {
      if (this.#records.has(record.recordId) || batchIds.has(record.recordId)) throw new Error('MODEL_EGRESS_RECORD_ID_CONFLICT');
      batchIds.add(record.recordId);
    }
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: SCHEMA_VERSION, records: [...this.#records.values()].map(clone) }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'records', id: 'recordId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createModelEgressLedger = (options) => new ModelEgressLedger(options);
export const MODEL_EGRESS_PHASES = PHASES;
