import { createHash, randomUUID } from 'node:crypto';
import { cordisPlugin } from './cordis-plugin.mjs';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from '../persistent-json-store.mjs';

/**
 * The registry is deliberately a proposal registry, not a plugin loader.
 * A candidate can move through validation/shadow/canary states, but loading
 * or granting a candidate is owned by a later evaluator/controller.
 */
export const EVOLUTION_STATUSES = Object.freeze([
  'PROPOSED',
  'VALIDATING',
  'SHADOW',
  'CANARY',
  'ACTIVE',
  'REJECTED',
  'QUARANTINED',
  'ROLLED_BACK'
]);

const transitions = Object.freeze({
  PROPOSED: ['VALIDATING', 'REJECTED', 'QUARANTINED'],
  VALIDATING: ['SHADOW', 'REJECTED', 'QUARANTINED'],
  SHADOW: ['CANARY', 'REJECTED', 'QUARANTINED'],
  CANARY: ['ACTIVE', 'REJECTED', 'QUARANTINED', 'ROLLED_BACK'],
  ACTIVE: ['ROLLED_BACK', 'QUARANTINED'],
  REJECTED: [],
  QUARANTINED: ['VALIDATING', 'REJECTED'],
  ROLLED_BACK: ['VALIDATING', 'QUARANTINED']
});

const MAX_RECORDS = 1000;
const MAX_JSON_CHARS = 128 * 1024;
const MAX_VALUE_DEPTH = 8;
const SENSITIVE_KEY = /^(?:api[_-]?key|secret|password|credential|authorization|private[_-]?key)$/i;

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const clone = (value) => structuredClone(value);
const lifecycleDigest = (record) => digest({
  status: record.status,
  createdAtMs: record.createdAtMs,
  updatedAtMs: record.updatedAtMs,
  ...(record.lastTransition === undefined ? {} : { lastTransition: record.lastTransition })
});

const freeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
};

const boundedJson = (value) => {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error('EVOLUTION_INVALID_PROPOSAL');
  }
  if (!encoded || encoded.length > MAX_JSON_CHARS) throw new Error('EVOLUTION_PROPOSAL_TOO_LARGE');
  return value;
};

const sanitizeValue = (value, { redactSensitive = false } = {}, depth = 0) => {
  if (depth > MAX_VALUE_DEPTH) throw new Error('EVOLUTION_VALUE_TOO_DEEP');
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, { redactSensitive }, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      if (redactSensitive) result[key] = '[REDACTED]';
      else throw new Error(`EVOLUTION_SENSITIVE_FIELD:${key}`);
    } else {
      result[key] = sanitizeValue(child, { redactSensitive }, depth + 1);
    }
  }
  return result;
};

const normalizeProposal = (proposal, idFactory) => {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('EVOLUTION_INVALID_PROPOSAL');
  }
  const candidate = sanitizeValue(proposal);
  // These fields are registry-owned and can never be supplied by a candidate.
  delete candidate.proposalId;
  delete candidate.status;
  delete candidate.createdAtMs;
  delete candidate.updatedAtMs;
  delete candidate.proposalDigest;
  delete candidate.lastTransition;
  delete candidate.lifecycleDigest;
  candidate.candidateId = String(candidate.candidateId ?? candidate.id ?? `candidate-${idFactory()}`);
  try {
    structuredClone(candidate);
  } catch {
    throw new Error('EVOLUTION_INVALID_PROPOSAL');
  }
  boundedJson(candidate);
  return candidate;
};

const validateStoredRecord = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.proposalId !== 'string' || typeof record.candidateId !== 'string') return false;
  if (!EVOLUTION_STATUSES.includes(record.status)) return false;
  if (typeof record.proposalDigest !== 'string' || !record.proposalDigest.startsWith('sha256:')) return false;
  const { proposalId, status, createdAtMs, updatedAtMs, lastTransition, proposalDigest, lifecycleDigest: _lifecycleDigest, ...candidate } = record;
  if (digest(candidate) !== proposalDigest) return false;
  // Older proposal stores predate lifecycle sealing and remain readable;
  // records written by this version reject status/timestamp/transition edits.
  return record.lifecycleDigest === undefined || record.lifecycleDigest === lifecycleDigest(record);
};

export class EvolutionRegistry {
  #records = new Map();
  #storagePath;
  #now;
  #idFactory;
  #writeQueue = Promise.resolve();
  #loaded = false;
  #eventStore;

  constructor({ storagePath, now = () => Date.now(), idFactory = randomUUID, eventStore } = {}) {
    this.#storagePath = storagePath;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath && this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'EvolutionProposal' }); }
      catch { throw new Error('EVOLUTION_STORE_READ_FAILED'); }
      let projected = false;
      for (const event of events) {
        if (!['EvolutionProposalCommitted', 'EvolutionStateChanged'].includes(event.kind)) continue;
        const payload = event.payload;
        const candidate = payload?.candidate;
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const record = { ...clone(candidate), proposalId: payload.proposalId, status: event.kind === 'EvolutionProposalCommitted' ? payload.status : payload.to, createdAtMs: payload.createdAtMs, updatedAtMs: payload.updatedAtMs, ...(payload.lastTransition ? { lastTransition: clone(payload.lastTransition) } : {}), proposalDigest: payload.proposalDigest, lifecycleDigest: payload.lifecycleDigest };
        if (!validateStoredRecord(record)) throw new Error('EVOLUTION_STORE_INVALID');
        const prior = this.#records.get(record.proposalId);
        if (!prior || record.updatedAtMs >= prior.updatedAtMs) this.#records.set(record.proposalId, freeze(record));
        projected = true;
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
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (error instanceof SyntaxError) throw new Error('EVOLUTION_STORE_INVALID');
      throw new Error(`EVOLUTION_STORE_READ:${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.proposals) || parsed.proposals.length > MAX_RECORDS) {
      throw new Error('EVOLUTION_STORE_INVALID');
    }
    for (const record of parsed.proposals) {
      if (!validateStoredRecord(record)) throw new Error('EVOLUTION_STORE_INVALID');
      if (this.#records.has(record.proposalId)) throw new Error('EVOLUTION_STORE_INVALID');
      this.#records.set(record.proposalId, freeze(clone(record)));
    }
    this.#loaded = true;
  }

  async propose(proposal) {
    if (this.#records.size >= MAX_RECORDS) throw new Error('EVOLUTION_REGISTRY_FULL');
    const candidate = normalizeProposal(proposal, this.#idFactory);
    const now = this.#now();
    const record = {
      ...candidate,
      proposalId: `proposal-${this.#idFactory()}`,
      status: 'PROPOSED',
      createdAtMs: now,
      updatedAtMs: now,
      proposalDigest: digest(candidate),
      lifecycleDigest: undefined
    };
    record.lifecycleDigest = lifecycleDigest(record);
    const frozen = freeze(clone(record));
    if (this.#eventStore?.append) await this.#eventStore.append({
      runId: 'evolution:' + record.proposalId,
      aggregateType: 'EvolutionProposal',
      aggregateId: record.proposalId,
      kind: 'EvolutionProposalCommitted',
      payload: { proposalId: record.proposalId, candidate: clone(candidate), status: record.status, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, proposalDigest: record.proposalDigest, lifecycleDigest: record.lifecycleDigest },
      sensitivity: 'INTERNAL'
    });
    this.#records.set(record.proposalId, frozen);
    await this.#persist();
    return clone(frozen);
  }

  async transition(proposalId, nextStatus, metadata = {}) {
    if (!EVOLUTION_STATUSES.includes(nextStatus)) throw new Error(`EVOLUTION_UNKNOWN_STATUS:${nextStatus}`);
    const current = this.#records.get(proposalId);
    if (!current) throw new Error(`EVOLUTION_NOT_FOUND:${proposalId}`);
    if (!transitions[current.status].includes(nextStatus)) {
      throw new Error(`EVOLUTION_INVALID_TRANSITION:${current.status}->${nextStatus}`);
    }
    const safeMetadata = boundedJson(sanitizeValue({ ...metadata }, { redactSensitive: true }));
    const transitionAt = this.#now();
    const record = {
      ...clone(current),
      status: nextStatus,
      updatedAtMs: transitionAt,
      lastTransition: {
        from: current.status,
        to: nextStatus,
        atMs: transitionAt,
        metadata: safeMetadata
      },
      lifecycleDigest: undefined
    };
    record.lifecycleDigest = lifecycleDigest(record);
    const frozen = freeze(clone(record));
    if (this.#eventStore?.append) await this.#eventStore.append({
      runId: 'evolution:' + record.proposalId,
      aggregateType: 'EvolutionProposal',
      aggregateId: record.proposalId,
      kind: 'EvolutionStateChanged',
      payload: { proposalId: record.proposalId, candidate: Object.fromEntries(Object.entries(current).filter(([key]) => !['proposalId', 'status', 'createdAtMs', 'updatedAtMs', 'lastTransition', 'proposalDigest', 'lifecycleDigest'].includes(key))), candidateId: record.candidateId, from: current.status, to: record.status, createdAtMs: record.createdAtMs, updatedAtMs: record.updatedAtMs, lastTransition: record.lastTransition, proposalDigest: record.proposalDigest, lifecycleDigest: record.lifecycleDigest, metadataDigest: digest(safeMetadata) },
      sensitivity: 'SECURITY_AUDIT'
    });
    this.#records.set(proposalId, frozen);
    await this.#persist();
    return clone(frozen);
  }

  list() {
    return [...this.#records.values()].map((record) => clone(record));
  }

  get(proposalId) {
    const record = this.#records.get(proposalId);
    return record ? clone(record) : undefined;
  }

  async #persist() {
    if (!this.#storagePath) return;
    const write = async () => {
      const payload = {
        schemaVersion: '1.0',
        proposals: this.list()
      };
      await persistJsonFile(this.#storagePath, payload, {
        merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'proposals', id: 'proposalId' })
      });
    };
    this.#writeQueue = this.#writeQueue.then(write, write);
    await this.#writeQueue;
  }
}

export const createEvolutionRegistryPlugin = (options = {}) => cordisPlugin(async (ctx) => {
  const registry = new EvolutionRegistry(options);
  await registry.load();
  ctx.provide('evolutionRegistry', registry);
}, 'evolution-registry');

// Kept for callers that only need an isolated in-memory registry.
export const evolutionRegistryPlugin = createEvolutionRegistryPlugin();

export { lifecycleDigest as evolutionLifecycleDigest };
