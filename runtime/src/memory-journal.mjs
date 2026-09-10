import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 4096;
const SENSITIVE_TEXT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer|private\s+key)\s*[:=]/i;
const baseRecord = (record) => ({
  memoryId: record.memoryId,
  runId: record.runId,
  statement: record.statement,
  sourceEventIds: record.sourceEventIds,
  scope: record.scope,
  confidence: record.confidence,
  createdAtMs: record.createdAtMs,
  ...(record.kind ? { kind: record.kind } : {}),
  ...(record.key ? { key: record.key } : {}),
  ...(record.validFromMs !== undefined ? { validFromMs: record.validFromMs } : {}),
  ...(record.expiresAtMs !== undefined ? { expiresAtMs: record.expiresAtMs } : {}),
  ...(record.untrainable === undefined ? {} : { untrainable: record.untrainable }),
  ...(record.untrainableAtMs === undefined ? {} : { untrainableAtMs: record.untrainableAtMs })
});
const lifecycleDigest = (record) => digest({
  status: record.status,
  updatedAtMs: record.updatedAtMs,
  ...(record.verification === undefined ? {} : { verification: record.verification }),
  ...(record.verifiedAtMs === undefined ? {} : { verifiedAtMs: record.verifiedAtMs }),
  ...(record.activatedAtMs === undefined ? {} : { activatedAtMs: record.activatedAtMs }),
  history: Array.isArray(record.history) ? record.history : [],
  ...(record.useCount === undefined ? {} : { useCount: record.useCount }),
  ...(record.lastUsedAtMs === undefined ? {} : { lastUsedAtMs: record.lastUsedAtMs }),
  ...(record.lastUsedRunDigest === undefined ? {} : { lastUsedRunDigest: record.lastUsedRunDigest }),
  ...(record.untrainable === undefined ? {} : { untrainable: record.untrainable }),
  ...(record.untrainableAtMs === undefined ? {} : { untrainableAtMs: record.untrainableAtMs })
});
const validRecord = (record) => record && typeof record.memoryId === 'string' &&
  ['PROPOSED', 'VERIFIED', 'REJECTED', 'ACTIVE', 'RETRACTED', 'EXPIRED', 'PRUNED'].includes(record.status) &&
  Array.isArray(record.sourceEventIds) && record.sourceEventIds.length <= 32 &&
  record.sourceEventIds.every((id) => typeof id === 'string' && id.length > 0) &&
  new Set(record.sourceEventIds).size === record.sourceEventIds.length &&
  (record.status !== 'ACTIVE' || record.sourceEventIds.length > 0) &&
  typeof record.recordDigest === 'string' && record.recordDigest === digest(baseRecord(record)) &&
  (record.lifecycleDigest === undefined || record.lifecycleDigest === lifecycleDigest(record));

export class MemoryJournal {
  #records = new Map();
  #storagePath;
  #queue = Promise.resolve();
  #loaded = false;
  #now;
  #eventStore;

  constructor({ storagePath, now = Date.now, eventStore } = {}) {
    this.#storagePath = storagePath;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('MEMORY_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.memories) || parsed.memories.length > MAX_RECORDS || parsed.memories.some((record) => !validRecord(record))) {
      throw new Error('MEMORY_STORE_INVALID');
    }
    const ids = new Set();
    for (const record of parsed.memories) {
      if (ids.has(record.memoryId)) throw new Error('MEMORY_STORE_INVALID');
      ids.add(record.memoryId);
      this.#records.set(record.memoryId, structuredClone(record));
    }
    this.#loaded = true;
  }

  async proposeDurably(input = {}) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const record = this.propose(input, { deferPersist: true });
    try {
      await this.#commitMemoryEvent('MemoryProposalCommitted', record, { sourceEventIds: record.sourceEventIds });
    } catch (error) {
      this.#records.delete(record.memoryId);
      throw error;
    }
    this.#records.set(record.memoryId, record);
    this.#schedulePersist();
    return structuredClone(record);
  }

  propose({ runId, statement, sourceEventIds = [], scope = 'workspace', confidence = 0.5, kind = 'PROJECT', key, validFromMs, expiresAtMs } = {}, { deferPersist = false } = {}) {
    if (typeof statement !== 'string' || !statement.trim()) throw new Error('MEMORY_STATEMENT_INVALID');
    if (SENSITIVE_TEXT.test(statement)) throw new Error('MEMORY_SENSITIVE_CONTENT');
    if (this.#records.size >= MAX_RECORDS) throw new Error('MEMORY_STORE_FULL');
    if (!Array.isArray(sourceEventIds) || sourceEventIds.length > 32 ||
      sourceEventIds.some((id) => typeof id !== 'string' || !id.trim()) ||
      new Set(sourceEventIds.map((id) => id.trim())).size !== sourceEventIds.length) {
      throw new Error('MEMORY_SOURCES_INVALID');
    }
    const normalizedSourceEventIds = sourceEventIds.map((id) => id.trim().slice(0, 240));
    if (new Set(normalizedSourceEventIds).size !== normalizedSourceEventIds.length) throw new Error('MEMORY_SOURCES_INVALID');
    const now = this.#now();
    const normalizedKind = String(kind || 'PROJECT').trim().slice(0, 64);
    const normalizedKey = key === undefined ? undefined : String(key).trim().slice(0, 256);
    const normalizedValidFrom = validFromMs === undefined ? now : Number(validFromMs);
    const normalizedExpires = expiresAtMs === undefined ? undefined : Number(expiresAtMs);
    if (!Number.isInteger(normalizedValidFrom) || normalizedValidFrom < 0 || (normalizedExpires !== undefined && (!Number.isInteger(normalizedExpires) || normalizedExpires <= normalizedValidFrom))) {
      throw new Error('MEMORY_VALIDITY_INVALID');
    }
    const candidate = {
      memoryId: `memory-${randomUUID()}`,
      runId: typeof runId === 'string' ? runId.slice(0, 240) : 'unknown',
      statement: statement.trim().slice(0, 2000),
      sourceEventIds: normalizedSourceEventIds,
      scope: String(scope).slice(0, 256),
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      kind: normalizedKind,
      ...(normalizedKey ? { key: normalizedKey } : {}),
      validFromMs: normalizedValidFrom,
      ...(normalizedExpires === undefined ? {} : { expiresAtMs: normalizedExpires }),
      createdAtMs: now,
      updatedAtMs: now
    };
    const record = { ...candidate, status: 'PROPOSED', history: [], recordDigest: digest(baseRecord(candidate)), lifecycleDigest: undefined };
    record.lifecycleDigest = lifecycleDigest(record);
    this.#records.set(record.memoryId, record); if (!deferPersist) this.#schedulePersist(); return structuredClone(record);
  }

  async verifyDurably(memoryId, options = {}) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (current.status !== 'PROPOSED') throw new Error('MEMORY_NOT_REVIEWABLE');
    if (options.accepted && current.sourceEventIds.length === 0) throw new Error('MEMORY_SOURCE_REQUIRED');
    const next = this.#previewTransition(current, options.accepted ? 'VERIFIED' : 'REJECTED', options.reason ?? 'REVIEW_REQUIRED');
    await this.#commitMemoryEvent('MemoryStateChanged', next, { previousStatus: current.status });
    return this.verify(memoryId, options);
  }

  async activateDurably(memoryId) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (current.status !== 'VERIFIED') throw new Error('MEMORY_NOT_VERIFIED');
    if (current.sourceEventIds.length === 0) throw new Error('MEMORY_SOURCE_REQUIRED');
    const next = this.#previewTransition(current, 'ACTIVE');
    await this.#commitMemoryEvent('MemoryStateChanged', next, { previousStatus: current.status });
    return this.activate(memoryId);
  }

  async retractDurably(memoryId, reason = 'USER_REVOKED') {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (!['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(current.status)) throw new Error('MEMORY_INVALID_TRANSITION');
    const next = this.#previewTransition(current, 'RETRACTED', reason);
    await this.#commitMemoryEvent('MemoryStateChanged', next, { previousStatus: current.status });
    return this.retract(memoryId, reason);
  }

  async deleteDurably(memoryId) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (current.untrainable === true && current.status === 'PRUNED') return structuredClone(current);
    const now = this.#now();
    const next = {
      ...current,
      statement: '[DELETED]',
      sourceEventIds: [],
      confidence: 0,
      status: 'PRUNED',
      untrainable: true,
      untrainableAtMs: now,
      updatedAtMs: now,
      history: [...(Array.isArray(current.history) ? current.history : []), {
        from: current.status,
        to: 'PRUNED',
        atMs: now,
        reason: 'USER_DELETED_UNTRAINABLE'
      }]
    };
    next.recordDigest = digest(baseRecord(next));
    next.lifecycleDigest = lifecycleDigest(next);
    await this.#commitMemoryEvent('MemoryStateChanged', next, { previousStatus: current.status });
    this.#records.set(memoryId, next);
    this.#schedulePersist();
    return structuredClone(next);
  }

  #previewTransition(current, status, reason) {
    const now = this.#now();
    const next = { ...current, status, updatedAtMs: now, history: [...(Array.isArray(current.history) ? current.history : []), { from: current.status, to: status, atMs: now, ...(reason === undefined ? {} : { reason: String(reason).slice(0, 500) }) }] };
    next.recordDigest = digest(baseRecord(next));
    next.lifecycleDigest = lifecycleDigest(next);
    return next;
  }

  async #commitMemoryEvent(kind, record, details = {}) {
    const payload = { memoryId: record.memoryId, runId: record.runId, statement: record.statement, status: record.status, recordDigest: record.recordDigest, lifecycleDigest: record.lifecycleDigest, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, sourceEventIds: record.sourceEventIds, scope: record.scope, confidence: record.confidence, kind: record.kind, ...(record.key === undefined ? {} : { key: record.key }), ...(record.validFromMs === undefined ? {} : { validFromMs: record.validFromMs }), ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }), ...(record.untrainable === undefined ? {} : { untrainable: record.untrainable }), ...(record.untrainableAtMs === undefined ? {} : { untrainableAtMs: record.untrainableAtMs }), ...details };
    const result = await this.#eventStore.append({ runId: String(record.runId || 'memory-system').slice(0, 240), aggregateType: 'Memory', aggregateId: record.memoryId, kind, payload, sensitivity: 'INTERNAL' });
    const receipt = result?.receipt ?? result;
    const event = result?.event ?? result?.events?.[0];
    if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId)
      || event.kind !== kind || event.aggregateId !== record.memoryId
      || digest(event.payload) !== digest(payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
  }

  verify(memoryId, { accepted = false, reason = 'REVIEW_REQUIRED' } = {}) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (current.status !== 'PROPOSED') throw new Error('MEMORY_NOT_REVIEWABLE');
    if (accepted && (!Array.isArray(current.sourceEventIds) || current.sourceEventIds.length === 0)) {
      throw new Error('MEMORY_SOURCE_REQUIRED');
    }
    const status = accepted ? 'VERIFIED' : 'REJECTED';
    const now = this.#now();
    const next = { ...current, status, verification: String(reason).slice(0, 500), verifiedAtMs: now, updatedAtMs: now, history: [...(Array.isArray(current.history) ? current.history : []), { from: current.status, to: status, atMs: now, reason: String(reason).slice(0, 500) }] };
    next.recordDigest = digest(baseRecord(next));
    next.lifecycleDigest = lifecycleDigest(next);
    this.#records.set(memoryId, next); this.#schedulePersist(); return structuredClone(next);
  }
  activate(memoryId) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (current.status !== 'VERIFIED') throw new Error('MEMORY_NOT_VERIFIED');
    if (!Array.isArray(current.sourceEventIds) || current.sourceEventIds.length === 0) throw new Error('MEMORY_SOURCE_REQUIRED');
    const now = this.#now();
    const next = { ...current, status: 'ACTIVE', activatedAtMs: now, updatedAtMs: now, history: [...(Array.isArray(current.history) ? current.history : []), { from: current.status, to: 'ACTIVE', atMs: now }] };
    next.recordDigest = digest(baseRecord(next));
    next.lifecycleDigest = lifecycleDigest(next);
    this.#records.set(memoryId, next); this.#schedulePersist(); return structuredClone(next);
  }

  retract(memoryId, reason = 'USER_REVOKED') {
    return this.#transition(memoryId, 'RETRACTED', reason, ['PROPOSED', 'VERIFIED', 'ACTIVE']);
  }

  expire({ now = this.#now() } = {}) {
    const expired = [];
    for (const current of this.#records.values()) {
      if (!['ACTIVE', 'VERIFIED'].includes(current.status) || current.expiresAtMs === undefined || current.expiresAtMs > now) continue;
      expired.push(this.#transition(current.memoryId, 'EXPIRED', 'VALIDITY_WINDOW_ENDED', ['ACTIVE', 'VERIFIED']));
    }
    return expired;
  }

  decay({ now = this.#now(), halfLifeMs = 30 * 24 * 60 * 60 * 1000, minConfidence = 0.05 } = {}) {
    if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0 || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new Error('MEMORY_DECAY_OPTIONS_INVALID');
    const changed = [];
    for (const current of this.#records.values()) {
      if (current.status !== 'ACTIVE') continue;
      const age = Math.max(0, now - (current.updatedAtMs ?? current.createdAtMs ?? now));
      const confidence = Math.max(minConfidence, current.confidence * (0.5 ** (age / halfLifeMs)));
      if (Math.abs(confidence - current.confidence) < 1e-9) continue;
      const next = { ...current, confidence, updatedAtMs: now, history: [...(Array.isArray(current.history) ? current.history : []), { from: current.status, to: current.status, atMs: now, reason: 'CONFIDENCE_DECAY' }] };
      next.recordDigest = digest(baseRecord(next));
      next.lifecycleDigest = lifecycleDigest(next);
      this.#records.set(current.memoryId, next);
      changed.push(structuredClone(next));
    }
    if (changed.length) this.#schedulePersist();
    return changed;
  }

  prune({ beforeMs = this.#now(), statuses = ['REJECTED', 'RETRACTED', 'EXPIRED'], limit = 256 } = {}) {
    if (!Array.isArray(statuses) || !Number.isInteger(limit) || limit < 1) throw new Error('MEMORY_PRUNE_OPTIONS_INVALID');
    const allowed = new Set(statuses);
    const pruned = [];
    for (const current of this.#records.values()) {
      if (pruned.length >= limit || !allowed.has(current.status) || (current.updatedAtMs ?? current.createdAtMs) > beforeMs) continue;
      pruned.push(this.#transition(current.memoryId, 'PRUNED', 'RETENTION_PRUNE', [current.status]));
    }
    return pruned;
  }

  findSimilar({ statement, scope = 'workspace', includeInactive = false } = {}) {
    const needle = String(statement ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    return [...this.#records.values()]
      .filter((record) => (includeInactive || ['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(record.status)))
      .filter((record) => String(record.scope).toLowerCase() === String(scope).toLowerCase())
      .filter((record) => String(record.statement).replace(/\s+/g, ' ').trim().toLowerCase() === needle)
      .map((record) => structuredClone(record));
  }
  markUsed({ runId = 'unknown', memoryIds = [] } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length > 64) throw new Error('MEMORY_USAGE_IDS_INVALID');
    const run = String(runId ?? 'unknown').slice(0, 240) || 'unknown';
    const now = this.#now();
    const used = [];
    for (const memoryId of [...new Set(memoryIds)]) {
      const current = this.#records.get(memoryId);
      if (!current || current.status !== 'ACTIVE') continue;
      const next = {
        ...current,
        useCount: Math.min(1000000, Number(current.useCount ?? 0) + 1),
        lastUsedAtMs: now,
        lastUsedRunDigest: digest({ memoryId, runId: run }),
        updatedAtMs: now
      };
      next.recordDigest = digest(baseRecord(next));
      next.lifecycleDigest = lifecycleDigest(next);
      this.#records.set(memoryId, next);
      used.push({ memoryId, useCount: next.useCount, usedAtMs: now });
    }
    if (used.length) this.#schedulePersist();
    return used;
  }
  get hasDurableSink() { return Boolean(this.#eventStore && typeof this.#eventStore.append === 'function'); }
  get(memoryId) {
    const record = this.#records.get(memoryId);
    return record ? structuredClone(record) : undefined;
  }
  async listDurableSummaries(status) {
    if (!this.#eventStore?.list) return [];
    const events = await this.#eventStore.list({ aggregateType: 'Memory' });
    const latest = new Map();
    for (const event of events) {
      if (!['MemoryProposalCommitted', 'MemoryStateChanged'].includes(event.kind)) continue;
      const payload = event.payload ?? {};
      if (typeof payload.memoryId !== 'string' || typeof payload.recordDigest !== 'string' || typeof payload.lifecycleDigest !== 'string' || payload.memoryId !== event.aggregateId || !['PROPOSED', 'VERIFIED', 'REJECTED', 'ACTIVE', 'RETRACTED', 'EXPIRED', 'PRUNED'].includes(payload.status) || !Array.isArray(payload.sourceEventIds)) throw new Error('MEMORY_STORE_INVALID');
      latest.set(payload.memoryId, payload);
    }
    return [...latest.values()]
      .filter((record) => !status || record.status === status)
      .map((record) => ({ memoryId: record.memoryId, runId: record.runId, status: record.status, recordDigest: record.recordDigest, lifecycleDigest: record.lifecycleDigest, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, sourceEventIds: structuredClone(record.sourceEventIds ?? []), scope: record.scope, confidence: record.confidence, kind: record.kind, ...(record.key === undefined ? {} : { key: record.key }), ...(record.validFromMs === undefined ? {} : { validFromMs: record.validFromMs }), ...(record.expiresAtMs === undefined ? {} : { expiresAtMs: record.expiresAtMs }) }));
  }

  list(status) { return [...this.#records.values()].filter((record) => !status || record.status === status).map((record) => structuredClone(record)); }
  async flush() { await this.#queue; }

  #transition(memoryId, status, reason, allowedStates) {
    const current = this.#records.get(memoryId); if (!current) throw new Error('MEMORY_NOT_FOUND');
    if (!allowedStates.includes(current.status)) throw new Error(`MEMORY_INVALID_TRANSITION:${current.status}->${status}`);
    const now = this.#now();
    const next = { ...current, status, updatedAtMs: now, history: [...(Array.isArray(current.history) ? current.history : []), { from: current.status, to: status, atMs: now, reason: String(reason).slice(0, 500) }] };
    next.recordDigest = digest(baseRecord(next));
    next.lifecycleDigest = lifecycleDigest(next);
    this.#records.set(memoryId, next);
    this.#schedulePersist();
    return structuredClone(next);
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: SCHEMA_VERSION, memories: this.list() }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'memories', id: 'memoryId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createMemoryJournal = (options) => new MemoryJournal(options);
export { lifecycleDigest as memoryLifecycleDigest };
