import { createHash } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import { assessBayesian, rankSafeCandidates } from './bayesian-assessment.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_PROFILES = 4096;
const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const profileBase = (profile) => {
  const { profileDigest: _profileDigest, ...unsigned } = profile;
  return unsigned;
};
const validateProfile = (profile) => {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)
    || typeof profile.profileId !== 'string' || typeof profile.groupKey !== 'string'
    || typeof profile.scenarioKey !== 'string' || typeof profile.candidateKey !== 'string'
    || typeof profile.modelRegistryDigest !== 'string' || typeof profile.policyVersion !== 'string'
    || !profile.metrics || typeof profile.metrics !== 'object'
    || typeof profile.profileDigest !== 'string' || profile.profileDigest !== digest(profileBase(profile))) {
    throw new Error('MODEL_SCENARIO_PROFILE_INVALID');
  }
};
const statusFor = (assessment) => {
  if (assessment.safetyIncidentCount > 0) return 'BLOCKED_BY_SAFETY';
  if (assessment.metrics.objectiveSuccess.priorOnly) return 'PRIOR_ONLY';
  return 'SHADOW_ONLY';
};

export class ModelScenarioProfileRegistry {
  #storagePath;
  #profiles = new Map();
  #loaded = false;
  #queue = Promise.resolve();
  #now;
  #eventStore;

  constructor({ storagePath, now = () => Date.now(), eventStore } = {}) {
    this.#storagePath = storagePath;
    this.#now = now;
    if (eventStore !== undefined && (!eventStore || typeof eventStore.append !== 'function')) throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return this.summary();
    if (!this.#storagePath && this.#eventStore?.list) {
      const events = await this.#eventStore.list({ aggregateType: 'ModelScenarioProfile' });
      const event = events.filter((item) => item.kind === 'ModelScenarioScoreProjected').at(-1);
      if (event) {
        const profiles = event.payload?.profiles;
        if (!Array.isArray(profiles) || profiles.length > MAX_PROFILES) throw new Error('MODEL_SCENARIO_PROFILE_STORE_INVALID');
        for (const profile of profiles) { validateProfile(profile); this.#profiles.set(profile.profileId, clone(profile)); }
        this.#loaded = true;
        return this.summary();
      }
    }
    if (this.#storagePath) {
      let parsed;
      try { parsed = await readPersistentJsonFile(this.#storagePath); } catch { throw new Error('MODEL_SCENARIO_PROFILE_READ_FAILED'); }
      if (parsed !== undefined) {
        if (parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.profiles) || parsed.profiles.length > MAX_PROFILES) throw new Error('MODEL_SCENARIO_PROFILE_STORE_INVALID');
        for (const profile of parsed.profiles) { validateProfile(profile); if (this.#profiles.has(profile.profileId)) throw new Error('MODEL_SCENARIO_PROFILE_DUPLICATE'); this.#profiles.set(profile.profileId, clone(profile)); }
      }
    }
    this.#loaded = true;
    return this.summary();
  }

  async rebuild({ samples = [], prior, sourceDigest } = {}) {
    await this.load();
    const assessment = assessBayesian({ samples, prior, now: this.#now });
    const profiles = assessment.assessments.map((item) => {
      const profile = {
        schemaVersion: SCHEMA_VERSION,
        profileId: item.groupKey,
        groupKey: item.groupKey,
        scenarioKey: item.scenarioKey,
        candidateKey: item.candidateKey,
        policyVersion: item.policyVersion,
        modelRegistryDigest: item.modelRegistryDigest,
        status: statusFor(item),
        metrics: item.metrics,
        sampleCount: item.sampleCount,
        independentSampleCount: item.independentSampleCount,
        safetyIncidentCount: item.safetyIncidentCount,
        sourceDigest: sourceDigest ?? assessment.datasetDigest,
        updatedAtMs: this.#now()
      };
      return { ...profile, profileDigest: digest(profile) };
    });
    if (profiles.length > MAX_PROFILES) throw new Error('MODEL_SCENARIO_PROFILE_LIMIT');
    const next = new Map(profiles.map((profile) => [profile.profileId, profile]));
    const projectionPayload = { profiles: profiles.map(clone).sort((left, right) => left.profileId.localeCompare(right.profileId)), sourceDigest: assessment.datasetDigest, updatedAtMs: this.#now() };
    if (this.#eventStore) {
      const result = await this.#eventStore.append({ runId: 'model-scenario-profile', aggregateType: 'ModelScenarioProfile', aggregateId: 'model-scenario-profile', commandId: 'model-scenario-profile:' + assessment.datasetDigest, kind: 'ModelScenarioScoreProjected', payload: projectionPayload, sensitivity: 'INTERNAL' });
      const receipt = result?.receipt ?? result; const event = result?.event ?? result?.events?.[0];
      if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId) || event.kind !== 'ModelScenarioScoreProjected' || event.aggregateId !== 'model-scenario-profile' || digest(event.payload) !== digest(projectionPayload)) throw new Error('DURABLE_COMMIT_REQUIRED');
    }
    const snapshot = { schemaVersion: SCHEMA_VERSION, profiles: profiles.map(clone).sort((left, right) => left.profileId.localeCompare(right.profileId)), sourceDigest: assessment.datasetDigest, updatedAtMs: this.#now() };
    if (this.#storagePath) {
      const write = async () => persistJsonFile(this.#storagePath, snapshot, { merge: () => snapshot });
      this.#queue = this.#queue.then(write, write);
      await this.#queue;
    }
    this.#profiles = next;
    return { assessment, profiles: profiles.map(clone) };
  }

  list({ scenarioKey, candidateKey, status } = {}) {
    return [...this.#profiles.values()].filter((profile) => (!scenarioKey || profile.scenarioKey === scenarioKey) && (!candidateKey || profile.candidateKey === candidateKey) && (!status || profile.status === status)).map(clone);
  }

  rank({ candidates = [] } = {}) {
    return rankSafeCandidates({ candidates, assessments: this.list().map((profile) => ({ ...profile, metrics: profile.metrics })) });
  }

  summary() { return { store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY', profileCount: this.#profiles.size }; }
  async flush() { await this.#queue; }
}

export const createModelScenarioProfileRegistry = (options) => new ModelScenarioProfileRegistry(options);
export { digest as modelScenarioProfileDigest, validateProfile as validateModelScenarioProfile };
