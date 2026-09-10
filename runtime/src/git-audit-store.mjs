import { createHmac, randomUUID } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import { gitDigest, stableGitStringify } from './git-observer.mjs';

export const GIT_AUDIT_SCHEMA_VERSION = '1.0';
const MAX_CHECKPOINTS = 100_000;
const AUDIT_STATUSES = new Set(['READY', 'AUDIT_DEGRADED', 'SCOPE_VIOLATION', 'QUARANTINED']);
const FORBIDDEN_KEYS = /(?:prompt|reasoning|credential|secret|authorization|apiKey|stdout|stderr|command$|path$|content$)/iu;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const signatureValue = (recordDigest, key) => `sha256:${createHmac('sha256', key).update(recordDigest, 'utf8').digest('hex')}`;
const validateSignature = (signature) => {
  if (signature === undefined) return;
  if (!signature || signature.algorithm !== 'HMAC-SHA256' || typeof signature.keyRef !== 'string' || !signature.keyRef.trim() || !DIGEST_PATTERN.test(signature.value)) fail('GIT_AUDIT_SIGNATURE_INVALID');
};

const clone = (value) => structuredClone(value);
const fail = (code) => { throw new Error(code); };

const inspectDigests = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) inspectDigests(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/digest$/iu.test(key) && child !== null && (typeof child !== 'string' || !DIGEST_PATTERN.test(child))) fail('GIT_AUDIT_INVALID_DIGEST');
    inspectDigests(child);
  }
};

const normalizeCorrelation = (value) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('GIT_AUDIT_CORRELATION_INVALID');
  const allowed = new Set(['runId', 'decisionId', 'operationId', 'intentId', 'approvalId', 'leaseId', 'threadId', 'actionId']);
  const correlation = {};
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (typeof child !== 'string' || !child.trim()) fail('GIT_AUDIT_CORRELATION_INVALID');
    correlation[key] = child.trim().slice(0, 240);
  }
  return Object.keys(correlation).length > 0 ? correlation : undefined;
};

const optionalDigest = (value, key) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail(`GIT_AUDIT_INVALID_DIGEST:${key}`);
  return value;
};

const inspectSafe = (value) => {
  if (Array.isArray(value)) {
    for (const item of value) inspectSafe(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) fail('GIT_AUDIT_FORBIDDEN_FIELD');
    inspectSafe(child);
  }
};

const unsignedCheckpoint = (input) => ({
  schemaVersion: GIT_AUDIT_SCHEMA_VERSION,
  checkpointId: typeof input.checkpointId === 'string' && input.checkpointId.trim()
    ? input.checkpointId.trim().slice(0, 200)
    : `audit-${randomUUID()}`,
  runId: typeof input.runId === 'string' && input.runId.trim() ? input.runId.trim().slice(0, 200) : 'audit-standalone',
  checkpointKind: typeof input.checkpointKind === 'string' && input.checkpointKind.trim()
    ? input.checkpointKind.trim().slice(0, 80)
    : 'OBSERVATION',
  status: AUDIT_STATUSES.has(input.status) ? input.status : 'READY',
  ...(typeof input.eventId === 'string' && input.eventId.trim() ? { eventId: input.eventId.trim().slice(0, 240) } : {}),
  ...(Number.isInteger(input.eventSequence) && input.eventSequence >= 1 ? { eventSequence: input.eventSequence } : {}),
  ...(optionalDigest(input.scopeSnapshotDigest, 'scopeSnapshotDigest') ? { scopeSnapshotDigest: input.scopeSnapshotDigest } : {}),
  ...(optionalDigest(input.observationDigest, 'observationDigest') ? { observationDigest: input.observationDigest } : {}),
  ...(optionalDigest(input.trajectoryRootDigest, 'trajectoryRootDigest') ? { trajectoryRootDigest: input.trajectoryRootDigest } : {}),
  ...(optionalDigest(input.projectionChecksum, 'projectionChecksum') ? { projectionChecksum: input.projectionChecksum } : {}),
  ...(normalizeCorrelation(input.correlation) ? { correlation: normalizeCorrelation(input.correlation) } : {}),
  ...(input.observation && typeof input.observation === 'object' && !Array.isArray(input.observation)
    ? { observation: clone(input.observation) }
    : {}),
  ...(typeof input.errorCode === 'string' && input.errorCode.trim() ? { errorCode: input.errorCode.trim().slice(0, 120) } : {}),
  createdAtMs: Number.isInteger(input.createdAtMs) && input.createdAtMs >= 0 ? input.createdAtMs : Date.now()
});

const normalizeCheckpoint = (input) => {
  const unsigned = unsignedCheckpoint(input);
  inspectSafe(unsigned);
  inspectDigests(unsigned);
  return {
    ...unsigned,
    recordDigest: gitDigest(stableGitStringify(unsigned))
  };
};

const validateCheckpoint = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.schemaVersion !== GIT_AUDIT_SCHEMA_VERSION ||
      typeof record.checkpointId !== 'string' || typeof record.runId !== 'string' ||
      typeof record.checkpointKind !== 'string' || typeof record.recordDigest !== 'string') {
    fail('GIT_AUDIT_INVALID_CHECKPOINT');
  }
  const { recordDigest, signature, ...unsigned } = record;
  inspectSafe(unsigned);
  inspectDigests(unsigned);
  validateSignature(signature);
  if (recordDigest !== gitDigest(stableGitStringify(unsigned))) fail('GIT_AUDIT_DIGEST_INVALID');
  return clone(record);
};

export class GitAuditStore {
  #storagePath;
  #records = new Map();
  #loaded = false;
  #queue = Promise.resolve();
  #signingKey;
  #signingKeyRef;

  constructor({ storagePath, signingKey, signingKeyRef = 'env' } = {}) {
    this.#storagePath = storagePath;
    this.#signingKey = typeof signingKey === 'string' && signingKey ? signingKey : undefined;
    this.#signingKeyRef = typeof signingKeyRef === 'string' && signingKeyRef.trim() ? signingKeyRef.trim().slice(0, 120) : 'env';
  }

  async load() {
    if (this.#loaded) return this.summary();
    const parsed = this.#storagePath ? await readPersistentJsonFile(this.#storagePath) : undefined;
    if (parsed !== undefined) {
      if (!parsed || parsed.schemaVersion !== GIT_AUDIT_SCHEMA_VERSION || !Array.isArray(parsed.checkpoints) || parsed.checkpoints.length > MAX_CHECKPOINTS) {
        fail('GIT_AUDIT_STORE_INVALID');
      }
      for (const raw of parsed.checkpoints) {
        const checkpoint = validateCheckpoint(raw);
        if (this.#records.has(checkpoint.checkpointId)) fail('GIT_AUDIT_DUPLICATE_CHECKPOINT');
        this.#records.set(checkpoint.checkpointId, checkpoint);
      }
    }
    this.#loaded = true;
    return this.summary();
  }

  async append(input) {
    await this.load();
    let checkpoint = normalizeCheckpoint(input);
    if (this.#signingKey) checkpoint = { ...checkpoint, signature: { algorithm: 'HMAC-SHA256', keyRef: this.#signingKeyRef, value: signatureValue(checkpoint.recordDigest, this.#signingKey) } };
    const persist = async () => {
      const previous = this.#records.get(checkpoint.checkpointId);
      if (previous) {
        if (previous.recordDigest !== checkpoint.recordDigest) fail('GIT_AUDIT_CHECKPOINT_CONFLICT');
        return clone(previous);
      }
      if (this.#records.size >= MAX_CHECKPOINTS) fail('GIT_AUDIT_STORE_LIMIT');
      const nextRecords = new Map(this.#records);
      nextRecords.set(checkpoint.checkpointId, checkpoint);
      if (this.#storagePath) {
        const incoming = {
          schemaVersion: GIT_AUDIT_SCHEMA_VERSION,
          checkpoints: [...nextRecords.values()].map(clone)
        };
        await persistJsonFile(this.#storagePath, incoming, {
          merge: (existing) => {
            const merged = new Map();
            for (const raw of Array.isArray(existing?.checkpoints) ? existing.checkpoints : []) {
              const item = validateCheckpoint(raw);
              merged.set(item.checkpointId, item);
            }
            for (const item of nextRecords.values()) merged.set(item.checkpointId, item);
            return {
              schemaVersion: GIT_AUDIT_SCHEMA_VERSION,
              checkpoints: [...merged.values()].slice(-MAX_CHECKPOINTS)
            };
          }
        });
      }
      this.#records = nextRecords;
      return clone(checkpoint);
    };
    this.#queue = this.#queue.then(persist, persist);
    return this.#queue;
  }

  async get(checkpointId) {
    await this.load();
    if (typeof checkpointId !== 'string' || !checkpointId.trim()) return undefined;
    const checkpoint = this.#records.get(checkpointId.trim());
    return checkpoint ? clone(checkpoint) : undefined;
  }

  async list({ runId } = {}) {
    await this.load();
    return [...this.#records.values()]
      .filter((record) => !runId || record.runId === runId)
      .map(clone);
  }

  async verify({ events = [], signingKey = this.#signingKey } = {}) {
    await this.load();
    const eventMap = new Map(events.filter((event) => event && typeof event.eventId === 'string').map((event) => [event.eventId, event]));
    const records = [...this.#records.values()];
    const missingEvents = [];
    const mismatchedEvents = [];
    const invalidSignatures = [];
    for (const record of records) {
      if (record.signature && signingKey && signatureValue(record.recordDigest, signingKey) !== record.signature.value) invalidSignatures.push(record.checkpointId);
      if (!record.eventId) continue;
      const event = eventMap.get(record.eventId);
      if (!event) {
        missingEvents.push(record.eventId);
        continue;
      }
      const mismatch = record.runId !== event.runId
        || (record.eventSequence !== undefined && record.eventSequence !== event.sequence)
        || (record.trajectoryRootDigest !== undefined && record.trajectoryRootDigest !== event.recordDigest);
      if (mismatch) mismatchedEvents.push(record.eventId);
    }
    return {
      ok: missingEvents.length === 0 && mismatchedEvents.length === 0 && invalidSignatures.length === 0,
      integrityStatus: records.some((record) => !record.signature) ? (signingKey ? 'PARTIALLY_SIGNED' : 'INTEGRITY_UNKNOWN') : (signingKey ? 'SIGNED' : 'INTEGRITY_UNKNOWN'),
      invalidSignatures,
      store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY',
      checkpointCount: records.length,
      missingEventIds: missingEvents,
      mismatchedEventIds: mismatchedEvents
    };
  }

  summary() {
    return {
      store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY',
      checkpointCount: this.#records.size
    };
  }
}

export const createGitAuditStore = (options) => new GitAuditStore(options);
export { normalizeCheckpoint as normalizeGitAuditCheckpoint, validateCheckpoint as validateGitAuditCheckpoint };
