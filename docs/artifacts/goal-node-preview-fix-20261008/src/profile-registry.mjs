import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_PROFILES = 4096;
const MAX_EVIDENCE = 16384;
const MAX_TEXT = 240;
const PROFILE_KINDS = new Set(['CAPABILITY', 'SAFETY']);
const EVIDENCE_SOURCES = new Set(['coordinator', 'verifier', 'system', 'user']);
const OUTCOMES = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'NOT_EXECUTED', 'UNKNOWN']);
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
const FORBIDDEN_KEY = /(?:prompt|message|reasoning|credential|password|secret|token|authorization|api[_-]?key|private[_-]?key)/i;

const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const boundedText = (value, max = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('PROFILE_TEXT_INVALID');
  return value.trim();
};
const optionalText = (value, max = MAX_TEXT) => value === undefined ? undefined : boundedText(value, max);
const boundedNumber = (value, code, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(code);
  return value;
};
const safeKeys = (value, seen = new Set()) => {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('PROFILE_CYCLIC_INPUT');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_KEY.test(key) || FORBIDDEN_KEY.test(key)) throw new Error(`PROFILE_FORBIDDEN_FIELD:${key}`);
    safeKeys(child, seen);
  }
  seen.delete(value);
};

const profileKey = ({ kind, entityType, entityId, capabilityId }) => [
  kind, entityType, entityId, capabilityId ?? '-'
].join(':');

const profileBase = (record) => ({
  profileId: record.profileId,
  kind: record.kind,
  entityType: record.entityType,
  entityId: record.entityId,
  ...(record.capabilityId ? { capabilityId: record.capabilityId } : {}),
  version: record.version,
  stats: record.stats,
  eligibility: record.eligibility,
  evidenceCount: record.evidenceCount,
  updatedAtMs: record.updatedAtMs
});

const evidenceBase = (record) => ({
  evidenceId: record.evidenceId,
  kind: record.kind,
  entityType: record.entityType,
  entityId: record.entityId,
  ...(record.capabilityId ? { capabilityId: record.capabilityId } : {}),
  runId: record.runId,
  ...(record.decisionId ? { decisionId: record.decisionId } : {}),
  ...(record.outcomeId ? { outcomeId: record.outcomeId } : {}),
  sourceType: record.sourceType,
  sourceId: record.sourceId,
  outcome: record.outcome,
  ...(record.quality === undefined ? {} : { quality: record.quality }),
  ...(record.safety === undefined ? {} : { safety: record.safety }),
  ...(record.latencyMs === undefined ? {} : { latencyMs: record.latencyMs }),
  ...(record.cost === undefined ? {} : { cost: record.cost }),
  observedAtMs: record.observedAtMs
});

const validDigest = (value, source) => typeof value === 'string' && value === digest(source);

const validateEvidence = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    typeof record.evidenceId !== 'string' || !PROFILE_KINDS.has(record.kind) ||
    typeof record.entityType !== 'string' || typeof record.entityId !== 'string' ||
    typeof record.runId !== 'string' || !EVIDENCE_SOURCES.has(record.sourceType) ||
    typeof record.sourceId !== 'string' || !OUTCOMES.has(record.outcome) ||
    !Number.isInteger(record.observedAtMs) || record.observedAtMs < 0 ||
    !validDigest(record.evidenceDigest, evidenceBase(record))) return false;
  if (record.kind === 'CAPABILITY' && typeof record.capabilityId !== 'string') return false;
  return true;
};

const validateProfile = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
    typeof record.profileId !== 'string' || !PROFILE_KINDS.has(record.kind) ||
    typeof record.entityType !== 'string' || typeof record.entityId !== 'string' ||
    !Number.isInteger(record.version) || record.version < 0 ||
    !record.stats || typeof record.stats !== 'object' ||
    !record.eligibility || typeof record.eligibility !== 'object' ||
    !Number.isInteger(record.evidenceCount) || record.evidenceCount < 0 ||
    !Number.isInteger(record.updatedAtMs) || record.updatedAtMs < 0 ||
    typeof record.profileDigest !== 'string' || !validDigest(record.profileDigest, profileBase(record))) return false;
  if (record.kind === 'CAPABILITY' && typeof record.capabilityId !== 'string') return false;
  return true;
};

const initialStats = () => ({
  sampleCount: 0,
  successCount: 0,
  partialCount: 0,
  failureCount: 0,
  cancelledCount: 0,
  unknownCount: 0,
  qualityMean: null,
  safetyMean: null,
  safetyMin: null,
  latencyMeanMs: null,
  costMean: null
});

// Persist null for an unavailable aggregate. JSON.stringify drops undefined
// fields, which would otherwise make a valid in-memory digest fail on reload.
const mean = (sum, count) => count > 0 ? sum / count : null;

const aggregate = (evidence) => {
  const stats = initialStats();
  let qualitySum = 0;
  let qualityCount = 0;
  let safetySum = 0;
  let safetyCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let costSum = 0;
  let costCount = 0;
  for (const item of evidence) {
    stats.sampleCount += 1;
    if (item.outcome === 'SUCCEEDED') stats.successCount += 1;
    else if (item.outcome === 'PARTIAL') stats.partialCount += 1;
    else if (item.outcome === 'FAILED') stats.failureCount += 1;
    else if (item.outcome === 'CANCELLED') stats.cancelledCount += 1;
    else stats.unknownCount += 1;
    if (item.quality !== undefined) { qualitySum += item.quality; qualityCount += 1; }
    if (item.safety !== undefined) {
      safetySum += item.safety;
      safetyCount += 1;
      stats.safetyMin = stats.safetyMin === null ? item.safety : Math.min(stats.safetyMin, item.safety);
    }
    if (item.latencyMs !== undefined) { latencySum += item.latencyMs; latencyCount += 1; }
    if (item.cost !== undefined) { costSum += item.cost; costCount += 1; }
  }
  stats.qualityMean = mean(qualitySum, qualityCount);
  stats.safetyMean = mean(safetySum, safetyCount);
  stats.latencyMeanMs = mean(latencySum, latencyCount);
  stats.costMean = mean(costSum, costCount);
  return stats;
};

const eligibility = (stats, { minSamples = 3, minQuality = 0.6, minSafety = 0.9 } = {}) => {
  const sampleReady = stats.sampleCount >= minSamples;
  const qualityReady = stats.qualityMean === null || stats.qualityMean >= minQuality;
  const safetyReady = stats.safetyMean === null || (stats.safetyMean >= minSafety && stats.safetyMin >= minSafety);
  const eligible = sampleReady && qualityReady && safetyReady && stats.failureCount === 0;
  return {
    status: eligible ? 'ELIGIBLE_FOR_ROUTING' : 'CONSERVATIVE',
    eligible,
    minSamples,
    minQuality,
    minSafety,
    reasonCodes: [
      ...(!sampleReady ? ['INSUFFICIENT_SAMPLES'] : []),
      ...(!qualityReady ? ['QUALITY_BELOW_THRESHOLD'] : []),
      ...(!safetyReady ? ['SAFETY_BELOW_THRESHOLD'] : []),
      ...(stats.failureCount > 0 ? ['FAILURE_OBSERVED'] : [])
    ]
  };
};

export class ProfileRegistry {
  #profiles = new Map();
  #evidence = new Map();
  #storagePath;
  #now;
  #idFactory;
  #queue = Promise.resolve();
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
    if (this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'Profile' }); }
      catch { throw new Error('PROFILE_STORE_READ_FAILED'); }
      let projected = false;
      try {
        for (const event of events) {
          if (event.kind !== 'ProfileProjectionUpdated') continue;
          projected = true;
          const payload = event.payload;
          const record = {
            profileId: payload?.profileId,
            kind: payload?.kind,
            entityType: payload?.entityType,
            entityId: payload?.entityId,
            ...(payload?.capabilityId ? { capabilityId: payload.capabilityId } : {}),
            version: payload?.version,
            stats: payload?.stats,
            eligibility: payload?.eligibility,
            evidenceCount: payload?.evidenceCount,
            updatedAtMs: payload?.updatedAtMs,
            profileDigest: payload?.profileDigest
          };
          if (!validateProfile(record)) throw new Error('PROFILE_STORE_INVALID');
          const key = profileKey(record);
          const prior = this.#profiles.get(key);
          if (!prior || record.version >= prior.version) this.#profiles.set(key, clone(record));
        }
      } catch (error) {
        // 历史版本写入的投影事件可能缺少 updatedAtMs 等字段，无法通过完整性校验。
        // 此时回退到文件存储（profiles.json 由同一注册表落盘，记录更完整），避免
        // 单条旧事件永久阻塞所有任务启动。
        if (error?.message !== 'PROFILE_STORE_INVALID' || !this.#storagePath) throw error;
        this.#profiles.clear();
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
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('PROFILE_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles) ||
      !Array.isArray(parsed.evidence) || parsed.profiles.length > MAX_PROFILES ||
      parsed.evidence.length > MAX_EVIDENCE || parsed.profiles.some((item) => !validateProfile(item)) ||
      parsed.evidence.some((item) => !validateEvidence(item))) throw new Error('PROFILE_STORE_INVALID');
    const profileIds = new Set();
    for (const item of parsed.profiles) {
      const key = profileKey(item);
      if (profileIds.has(item.profileId)) throw new Error('PROFILE_STORE_INVALID');
      profileIds.add(item.profileId);
      this.#profiles.set(key, clone(item));
    }
    const evidenceIds = new Set();
    for (const item of parsed.evidence) {
      if (evidenceIds.has(item.evidenceId)) throw new Error('PROFILE_STORE_INVALID');
      evidenceIds.add(item.evidenceId);
      this.#evidence.set(item.evidenceId, clone(item));
    }
    this.#loaded = true;
  }

  async recordEvidence(input = {}) {
    await this.load();
    safeKeys(input);
    if (!PROFILE_KINDS.has(input.kind)) throw new Error('PROFILE_KIND_INVALID');
    const kind = input.kind;
    const entityType = boundedText(input.entityType, 80);
    const entityId = boundedText(input.entityId, 240);
    const capabilityId = input.kind === 'CAPABILITY' ? boundedText(input.capabilityId, 120) : undefined;
    const runId = boundedText(input.runId, 240);
    const sourceType = boundedText(input.sourceType, 32);
    const sourceId = boundedText(input.sourceId, 240);
    if (!EVIDENCE_SOURCES.has(sourceType)) throw new Error('PROFILE_SOURCE_INVALID');
    const outcome = boundedText(input.outcome, 32).toUpperCase();
    if (!OUTCOMES.has(outcome)) throw new Error('PROFILE_OUTCOME_INVALID');
    const evidenceId = typeof input.evidenceId === 'string' && input.evidenceId.trim()
      ? boundedText(input.evidenceId, 240) : `profile-evidence-${this.#idFactory()}`;
    const existingEvidence = this.#evidence.get(evidenceId);
    const observedAtMs = input.observedAtMs ?? existingEvidence?.observedAtMs ?? this.#now();
    if (!Number.isInteger(observedAtMs) || observedAtMs < 0) throw new Error('PROFILE_TIME_INVALID');
    const evidence = {
      evidenceId,
      kind,
      entityType,
      entityId,
      ...(capabilityId ? { capabilityId } : {}),
      runId,
      ...(input.decisionId === undefined ? {} : { decisionId: boundedText(input.decisionId) }),
      ...(input.outcomeId === undefined ? {} : { outcomeId: boundedText(input.outcomeId) }),
      sourceType,
      sourceId,
      outcome,
      ...(input.quality === undefined ? {} : { quality: boundedNumber(input.quality, 'PROFILE_QUALITY_INVALID', 0, 1) }),
      ...(input.safety === undefined ? {} : { safety: boundedNumber(input.safety, 'PROFILE_SAFETY_INVALID', 0, 1) }),
      ...(input.latencyMs === undefined ? {} : { latencyMs: boundedNumber(input.latencyMs, 'PROFILE_LATENCY_INVALID') }),
      ...(input.cost === undefined ? {} : { cost: boundedNumber(input.cost, 'PROFILE_COST_INVALID') }),
      observedAtMs
    };
    evidence.evidenceDigest = digest(evidenceBase(evidence));
    if (existingEvidence) {
      if (existingEvidence.evidenceDigest !== evidence.evidenceDigest) throw new Error('PROFILE_EVIDENCE_ID_CONFLICT');
      return clone(existingEvidence);
    }
    if (this.#evidence.size >= MAX_EVIDENCE) throw new Error('PROFILE_EVIDENCE_FULL');
    const nextProfile = this.#buildProfile(evidence);
    if (this.#eventStore?.appendBatch) {
      const evidencePayload = { evidenceId: evidence.evidenceId, profileId: nextProfile.profileId, kind, entityType, entityId, ...(capabilityId ? { capabilityId } : {}), runId, sourceType, sourceId, outcome, evidenceDigest: evidence.evidenceDigest };
      const profilePayload = { profileId: nextProfile.profileId, kind: nextProfile.kind, entityType: nextProfile.entityType, entityId: nextProfile.entityId, ...(nextProfile.capabilityId ? { capabilityId: nextProfile.capabilityId } : {}), version: nextProfile.version, evidenceCount: nextProfile.evidenceCount, updatedAtMs: nextProfile.updatedAtMs, stats: nextProfile.stats, eligibility: nextProfile.eligibility, profileDigest: nextProfile.profileDigest };
      await this.#eventStore.appendBatch([
        { runId, aggregateType: 'ProfileEvidence', aggregateId: evidence.evidenceId, commandId: 'profile-evidence:' + evidence.evidenceId, kind: 'ProfileEvidenceRecorded', payload: evidencePayload, sensitivity: 'INTERNAL' },
        { runId, aggregateType: 'Profile', aggregateId: nextProfile.profileId, commandId: 'profile-projection:' + nextProfile.profileId + ':' + nextProfile.version, kind: 'ProfileProjectionUpdated', payload: profilePayload, sensitivity: 'INTERNAL' }
      ]);
    } else if (this.#eventStore?.append) {
      const evidencePayload = { evidenceId: evidence.evidenceId, profileId: nextProfile.profileId, kind, entityType, entityId, ...(capabilityId ? { capabilityId } : {}), runId, sourceType, sourceId, outcome, evidenceDigest: evidence.evidenceDigest };
      await this.#appendCommitted({ runId, aggregateType: 'ProfileEvidence', aggregateId: evidence.evidenceId, commandId: 'profile-evidence:' + evidence.evidenceId, kind: 'ProfileEvidenceRecorded', payload: evidencePayload, sensitivity: 'INTERNAL' });
      const profilePayload = { profileId: nextProfile.profileId, kind: nextProfile.kind, entityType: nextProfile.entityType, entityId: nextProfile.entityId, ...(nextProfile.capabilityId ? { capabilityId: nextProfile.capabilityId } : {}), version: nextProfile.version, evidenceCount: nextProfile.evidenceCount, updatedAtMs: nextProfile.updatedAtMs, stats: nextProfile.stats, eligibility: nextProfile.eligibility, profileDigest: nextProfile.profileDigest };
      await this.#appendCommitted({ runId, aggregateType: 'Profile', aggregateId: nextProfile.profileId, commandId: 'profile-projection:' + nextProfile.profileId + ':' + nextProfile.version, kind: 'ProfileProjectionUpdated', payload: profilePayload, sensitivity: 'INTERNAL' });
    }
    this.#evidence.set(evidence.evidenceId, evidence);
    this.#profiles.set(profileKey(nextProfile), nextProfile);
    this.#schedulePersist();
    return clone(evidence);
  }

  getProfile({ kind, entityType, entityId, capabilityId } = {}) {
    const record = this.#profiles.get(profileKey({ kind, entityType, entityId, capabilityId }));
    return record ? clone(record) : undefined;
  }

  listProfiles(kind) {
    return [...this.#profiles.values()]
      .filter((item) => !kind || item.kind === kind)
      .map(clone);
  }

  listEvidence({ profileId, kind, entityType, entityId, capabilityId } = {}) {
    let profile = profileId ? [...this.#profiles.values()].find((item) => item.profileId === profileId) : undefined;
    return [...this.#evidence.values()]
      .filter((item) => !profile || profileKey(item) === profileKey(profile))
      .filter((item) => !kind || item.kind === kind)
      .filter((item) => !entityType || item.entityType === entityType)
      .filter((item) => !entityId || item.entityId === entityId)
      .filter((item) => capabilityId === undefined || item.capabilityId === capabilityId)
      .map(clone);
  }

  async #appendCommitted(input) {
    const result = await this.#eventStore.append(input);
    const receipt = result?.receipt ?? result;
    const event = result?.event ?? result?.events?.[0];
    if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId)
      || event.kind !== input.kind || event.aggregateId !== input.aggregateId
      || digest(event.payload) !== digest(input.payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
    return result;
  }

  async flush() { await this.#queue; }

  #buildProfile(evidence) {
    const key = profileKey(evidence);
    const prior = this.#profiles.get(key);
    const items = [...this.#evidence.values(), evidence].filter((item) => profileKey(item) === key);
    const stats = aggregate(items);
    const next = {
      profileId: prior?.profileId ?? `profile-${this.#idFactory()}`,
      kind: evidence.kind,
      entityType: evidence.entityType,
      entityId: evidence.entityId,
      ...(evidence.capabilityId ? { capabilityId: evidence.capabilityId } : {}),
      version: (prior?.version ?? 0) + 1,
      stats,
      eligibility: eligibility(stats),
      evidenceCount: items.length,
      updatedAtMs: this.#now()
    };
    next.profileDigest = digest(profileBase(next));
    return next;
  }

  #rebuildProfile(evidence) {
    const next = this.#buildProfile(evidence);
    this.#profiles.set(profileKey(evidence), next);
    return next;
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, {
      schemaVersion: SCHEMA_VERSION,
      profiles: this.listProfiles(),
      evidence: [...this.#evidence.values()].map(clone)
    }, {
      merge: (existing, incoming) => ({
        schemaVersion: SCHEMA_VERSION,
        profiles: mergeRecordsById(existing, incoming, { collection: 'profiles', id: 'profileId' }).profiles ?? incoming.profiles,
        evidence: mergeRecordsById(existing, incoming, { collection: 'evidence', id: 'evidenceId' }).evidence ?? incoming.evidence
      })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createProfileRegistry = (options) => new ProfileRegistry(options);
export const profileDigest = digest;
