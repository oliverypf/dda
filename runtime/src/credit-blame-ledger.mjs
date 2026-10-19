import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const SAFE_STATUSES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN']);

/** Deterministic ms from identity — excludes Date.now() / random. */
const stableCreatedAtMs = (identity) => {
  const hex = createHash('sha256').update(canonical(identity), 'utf8').digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16) % 1e13;
};

const allocate = ({ decisions = [], outcome = {} } = {}) => {
  if (!Array.isArray(decisions) || !decisions.length) return [];
  const usable = decisions.filter((decision) => decision?.status === 'COMMITTED' && typeof decision.decisionId === 'string');
  if (!usable.length) return [];
  const status = String(outcome.status ?? 'UNKNOWN').toUpperCase();
  if (!SAFE_STATUSES.has(status)) throw new Error('CREDIT_OUTCOME_INVALID');
  const success = status === 'SUCCEEDED';
  const weight = 1 / usable.length;
  return usable.map((decision) => ({
    decisionId: decision.decisionId,
    runId: decision.runId,
    role: decision.role,
    outcomeId: outcome.outcomeId,
    credit: success ? weight : 0,
    blame: success ? 0 : weight,
    evidenceRefs: Array.isArray(outcome.executionEventIds) ? outcome.executionEventIds.slice(0, 16) : [],
    allocationMethod: 'CAUSAL_EQUAL_SHARE'
  }));
};

const sourceDigestFor = ({ decisions, outcome }) => {
  const records = allocate({ decisions, outcome });
  return digest({
    decisionIds: records.map((record) => record.decisionId),
    outcomeId: outcome?.outcomeId,
    status: outcome?.status
  });
};

/** Build byte-stable allocation records for a given sourceDigest (freeze §1.2). */
const stableRecordsFor = ({ decisions, outcome, sourceDigest }) => {
  const allocations = allocate({ decisions, outcome });
  return allocations.map((allocation) => {
    const allocationId = `allocation-${digest({
      sourceDigest,
      decisionId: allocation.decisionId,
      outcomeId: allocation.outcomeId ?? null
    }).slice('sha256:'.length, 'sha256:'.length + 32)}`;
    const createdAtMs = stableCreatedAtMs({
      sourceDigest,
      decisionId: allocation.decisionId,
      outcomeId: allocation.outcomeId ?? null,
      evidenceRefs: allocation.evidenceRefs
    });
    const record = { allocationId, ...allocation, createdAtMs };
    record.allocationDigest = digest({ ...record, allocationDigest: undefined });
    return record;
  });
};

export class CreditBlameLedger {
  #records = new Map();
  #storagePath;
  #queue = Promise.resolve();
  #loaded = false;
  #idFactory;
  #eventStore;

  constructor({ storagePath, idFactory = randomUUID, eventStore } = {}) { this.#storagePath = storagePath; this.#idFactory = idFactory; this.#eventStore = eventStore; }
  async load() {
    if (this.#loaded) return;
    if (this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'CreditBlame' }); }
      catch { throw new Error('CREDIT_STORE_READ_FAILED'); }
      let projected = false;
      try {
        for (const event of events) {
          if (event.kind !== 'CreditBlameRecorded' || !Array.isArray(event.payload?.allocations)) continue;
          for (const allocation of event.payload.allocations) {
            if (!allocation || typeof allocation.allocationId !== 'string') throw new Error('CREDIT_STORE_INVALID');
            const record = { ...clone(allocation), runId: allocation.runId ?? event.runId, outcomeId: allocation.outcomeId ?? event.payload.outcomeId, createdAtMs: allocation.createdAtMs ?? event.createdAtMs };
            if (record.allocationDigest !== digest({ ...record, allocationDigest: undefined })) throw new Error('CREDIT_STORE_INVALID');
            this.#records.set(record.allocationId, record);
            projected = true;
          }
        }
      } catch (error) {
        // 历史版本写入的事件可能因字段缺失导致 digest 校验失败；回退到文件存储，
        // 避免单条旧事件永久阻塞任务启动。
        if (error?.message !== 'CREDIT_STORE_INVALID' || !this.#storagePath) throw error;
        this.#records.clear();
        projected = false;
      }
      if (projected) {
        this.#loaded = true;
        return;
      }
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); }
    catch (error) { if (error?.code === 'ENOENT') return; throw new Error('CREDIT_STORE_READ_FAILED'); }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.records) || parsed.records.length > 16384) throw new Error('CREDIT_STORE_INVALID');
    const ids = new Set();
    for (const record of parsed.records) {
      if (!record?.allocationId || record.allocationDigest !== digest({ ...record, allocationDigest: undefined })) throw new Error('CREDIT_STORE_INVALID');
      if (ids.has(record.allocationId)) throw new Error('CREDIT_STORE_INVALID');
      ids.add(record.allocationId);
      this.#records.set(record.allocationId, clone(record));
    }
    this.#loaded = true;
  }
  get hasDurableSink() { return Boolean(this.#eventStore && typeof this.#eventStore.append === 'function'); }

  async recordDurably({ decisions, outcome } = {}) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    await this.load();
    const allocations = allocate({ decisions, outcome });
    if (!allocations.length) return [];
    const sourceDigest = digest({
      decisionIds: allocations.map((record) => record.decisionId),
      outcomeId: outcome?.outcomeId,
      status: outcome?.status
    });
    const records = stableRecordsFor({ decisions, outcome, sourceDigest });

    // Idempotent hit in memory: same allocation ids already present — do not insert again.
    const existingInMemory = records.map((record) => this.#records.get(record.allocationId)).filter(Boolean);
    if (existingInMemory.length === records.length
      && existingInMemory.every((record, index) => record.allocationDigest === records[index].allocationDigest)) {
      return existingInMemory.map(clone);
    }

    const runId = String(outcome?.runId ?? records[0].runId ?? 'credit-blame').slice(0, 240);
    const appendResult = await this.#eventStore.append({
      runId,
      aggregateType: 'CreditBlame',
      aggregateId: String(outcome?.outcomeId ?? sourceDigest).slice(0, 240),
      commandId: 'credit-blame:' + sourceDigest,
      kind: 'CreditBlameRecorded',
      payload: { outcomeId: outcome?.outcomeId, status: String(outcome?.status ?? 'UNKNOWN').toUpperCase(), sourceDigest, allocations: records.map((record) => clone(record)) },
      sensitivity: 'INTERNAL'
    });

    // Store-level idempotent replay: adopt committed allocations; never insert a second set.
    if (appendResult?.idempotent) {
      const committed = appendResult.events?.[0]?.payload?.allocations;
      if (Array.isArray(committed) && committed.length) {
        for (const allocation of committed) {
          if (allocation?.allocationId && !this.#records.has(allocation.allocationId)) {
            this.#records.set(allocation.allocationId, clone(allocation));
          }
        }
        this.#schedulePersist();
        return committed.map(clone);
      }
      // Receipt without events — return stable records already computed (do not double-insert).
      for (const record of records) {
        if (!this.#records.has(record.allocationId)) this.#records.set(record.allocationId, record);
      }
      this.#schedulePersist();
      return records.map(clone);
    }

    for (const record of records) this.#records.set(record.allocationId, record);
    this.#schedulePersist();
    return records.map(clone);
  }

  record({ decisions, outcome } = {}) {
    const allocations = allocate({ decisions, outcome });
    if (!allocations.length) return [];
    const sourceDigest = digest({
      decisionIds: allocations.map((record) => record.decisionId),
      outcomeId: outcome?.outcomeId,
      status: outcome?.status
    });
    const records = stableRecordsFor({ decisions, outcome, sourceDigest });
    const out = [];
    for (const record of records) {
      const existing = this.#records.get(record.allocationId);
      if (existing) {
        out.push(clone(existing));
        continue;
      }
      this.#records.set(record.allocationId, record);
      out.push(clone(record));
    }
    if (out.length) this.#schedulePersist();
    return out;
  }
  list(runId) { return [...this.#records.values()].filter((record) => !runId || record.runId === runId).map(clone); }
  summarize(runId) {
    const records = this.list(runId);
    return { recordCount: records.length, credit: records.reduce((sum, record) => sum + record.credit, 0), blame: records.reduce((sum, record) => sum + record.blame, 0) };
  }
  async flush() { await this.#queue; }
  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: '1.0', records: this.list() }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'records', id: 'allocationId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createCreditBlameLedger = (options) => new CreditBlameLedger(options);
export const allocateDecisionCreditBlame = allocate;
export const creditBlameSourceDigest = sourceDigestFor;
