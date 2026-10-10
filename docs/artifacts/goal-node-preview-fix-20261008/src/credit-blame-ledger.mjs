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
    const allocations = allocate({ decisions, outcome });
    if (!allocations.length) return [];
    const records = allocations.map((allocation) => {
      const record = { allocationId: 'allocation-' + this.#idFactory(), ...allocation, createdAtMs: Date.now() };
      record.allocationDigest = digest({ ...record, allocationDigest: undefined });
      return record;
    });
    const runId = String(outcome?.runId ?? records[0].runId ?? 'credit-blame').slice(0, 240);
    const sourceDigest = digest({ decisionIds: records.map((record) => record.decisionId), outcomeId: outcome?.outcomeId, status: outcome?.status });
    await this.#eventStore.append({
      runId,
      aggregateType: 'CreditBlame',
      aggregateId: String(outcome?.outcomeId ?? sourceDigest).slice(0, 240),
      commandId: 'credit-blame:' + sourceDigest,
      kind: 'CreditBlameRecorded',
      payload: { outcomeId: outcome?.outcomeId, status: String(outcome?.status ?? 'UNKNOWN').toUpperCase(), sourceDigest, allocations: records.map((record) => clone(record)) },
      sensitivity: 'INTERNAL'
    });
    for (const record of records) this.#records.set(record.allocationId, record);
    this.#schedulePersist();
    return records.map(clone);
  }

  record({ decisions, outcome } = {}) {
    const allocations = allocate({ decisions, outcome });
    const records = allocations.map((allocation) => {
      const record = { allocationId: `allocation-${this.#idFactory()}`, ...allocation, createdAtMs: Date.now() };
      record.allocationDigest = digest({ ...record, allocationDigest: undefined });
      this.#records.set(record.allocationId, record);
      return clone(record);
    });
    if (records.length) this.#schedulePersist();
    return records;
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
