// S3: State(A,S,C,O) + hysteresis slow recover (SECURITY_MODEL §15).
// Pure transitions + optional memory/persistent-json-store. No lease/hardDecision changes.
// Incident tighten maps SEV2→CONFIRM / SEV1→SANDBOX / SEV0→QUARANTINE; SEV3 no-op.
// Recover: one rank down only; QUARANTINE needs reviewer.approved → DENY only.

import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

export const SAFETY_STATE_POLICY_VERSION = 'safety-state-r1';
export const SAFETY_STATES = Object.freeze([
  'ALLOW',
  'MONITOR',
  'CONFIRM',
  'SANDBOX',
  'DENY',
  'QUARANTINE'
]);

/** Rank: ALLOW=0 … QUARANTINE=5 */
export const SAFETY_STATE_RANK = Object.freeze({
  ALLOW: 0,
  MONITOR: 1,
  CONFIRM: 2,
  SANDBOX: 3,
  DENY: 4,
  QUARANTINE: 5
});

export const CLEAN_WINDOW_MS = 86_400_000;
export const MIN_RECOVER_SAMPLES = 3;

export const SAFETY_STATE_REQUIRE_APPROVAL = 'SAFETY_STATE_REQUIRE_APPROVAL';
export const SAFETY_STATE_DENY = 'SAFETY_STATE_DENY';

export const RECOVER_REJECTED = 'RECOVER_REJECTED';
export const RECOVER_QUARANTINE_NEEDS_REVIEWER = 'RECOVER_QUARANTINE_NEEDS_REVIEWER';
export const RECOVER_SAMPLES_INSUFFICIENT = 'RECOVER_SAMPLES_INSUFFICIENT';
export const RECOVER_CLEAN_WINDOW_VIOLATED = 'RECOVER_CLEAN_WINDOW_VIOLATED';
export const RECOVER_EVIDENCE_REQUIRED = 'RECOVER_EVIDENCE_REQUIRED';
export const INCIDENT_EVENTS_REQUIRED = 'INCIDENT_EVENTS_REQUIRED';

const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 4096;
const MAX_TRANSITIONS = 256;

const SEV_TARGET_STATE = Object.freeze({
  SEV2: 'CONFIRM',
  SEV1: 'SANDBOX',
  SEV0: 'QUARANTINE'
  // SEV3: no-op
});

const clone = (value) => structuredClone(value);

const nonEmptyString = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const stateName = (value) => {
  const name = nonEmptyString(value, 'SAFETY_STATE_INVALID');
  if (!SAFETY_STATES.includes(name)) throw new Error('SAFETY_STATE_INVALID');
  return name;
};

const rankOf = (state) => {
  const rank = SAFETY_STATE_RANK[state];
  if (rank === undefined) throw new Error('SAFETY_STATE_INVALID');
  return rank;
};

/**
 * Key serialization: executor:{entityId}|cap:{capabilityId|*}|tc:{taskClass|*}
 */
export function safetyStateKey({ entityId, capabilityId, taskClass } = {}) {
  const id = nonEmptyString(entityId ?? 'executor', 'SAFETY_STATE_ENTITY_REQUIRED');
  const cap = typeof capabilityId === 'string' && capabilityId.trim() ? capabilityId.trim() : '*';
  const tc = typeof taskClass === 'string' && taskClass.trim() ? taskClass.trim() : '*';
  return `executor:${id}|cap:${cap}|tc:${tc}`;
}

export function parseSafetyStateKey(key) {
  const text = nonEmptyString(key, 'SAFETY_STATE_KEY_INVALID');
  const match = /^executor:([^|]+)\|cap:([^|]+)\|tc:([^|]+)$/.exec(text);
  if (!match) throw new Error('SAFETY_STATE_KEY_INVALID');
  return {
    entityType: 'executor',
    entityId: match[1],
    capabilityId: match[2],
    taskClass: match[3]
  };
}

/**
 * @returns {object} SafetyState record
 */
export function createSafetyStateRecord(input = {}) {
  const entityId = nonEmptyString(input.entityId ?? 'executor', 'SAFETY_STATE_ENTITY_REQUIRED');
  const capabilityId = typeof input.capabilityId === 'string' && input.capabilityId.trim()
    ? input.capabilityId.trim()
    : '*';
  const taskClass = typeof input.taskClass === 'string' && input.taskClass.trim()
    ? input.taskClass.trim()
    : '*';
  const state = input.state !== undefined ? stateName(input.state) : 'ALLOW';
  const atMs = typeof input.atMs === 'number' && Number.isInteger(input.atMs) && input.atMs >= 0
    ? input.atMs
    : 0;
  const key = safetyStateKey({ entityId, capabilityId, taskClass });
  return {
    key,
    entityType: 'executor',
    entityId,
    capabilityId,
    taskClass,
    workspace: input.workspace === undefined ? 'default' : String(input.workspace),
    state,
    rank: rankOf(state),
    successCount: Number.isInteger(input.successCount) && input.successCount >= 0 ? input.successCount : 0,
    lastIncidentAtMs: Number.isInteger(input.lastIncidentAtMs) ? input.lastIncidentAtMs : null,
    lastIncidentSeverity: typeof input.lastIncidentSeverity === 'string' ? input.lastIncidentSeverity : null,
    appliedIncidentIds: Array.isArray(input.appliedIncidentIds) ? [...input.appliedIncidentIds] : [],
    transitions: Array.isArray(input.transitions) ? clone(input.transitions) : [],
    updatedAtMs: atMs,
    policyVersion: SAFETY_STATE_POLICY_VERSION
  };
}

function appendTransition(record, { from, to, reasonCode, evidenceRef, atMs }) {
  const transition = {
    from,
    to,
    reasonCode: nonEmptyString(reasonCode, 'SAFETY_STATE_REASON_REQUIRED'),
    evidenceRef: evidenceRef === undefined || evidenceRef === null
      ? null
      : nonEmptyString(String(evidenceRef), 'SAFETY_STATE_EVIDENCE_REQUIRED'),
    policyVersion: SAFETY_STATE_POLICY_VERSION,
    atMs
  };
  const next = clone(record);
  next.transitions = [...(next.transitions ?? []), transition].slice(-MAX_TRANSITIONS);
  next.state = to;
  next.rank = rankOf(to);
  next.updatedAtMs = atMs;
  return { record: next, transition };
}

/**
 * In-memory (+ optional persistent-json-store) SafetyState store.
 */
export class SafetyStateStore {
  #records = new Map();
  #storagePath;
  #loaded = false;
  #queue = Promise.resolve();

  constructor({ storagePath } = {}) {
    this.#storagePath = storagePath;
  }

  get size() {
    return this.#records.size;
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
      if (error?.code === 'ENOENT') {
        this.#loaded = true;
        return;
      }
      throw new Error('SAFETY_STATE_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      throw new Error('SAFETY_STATE_STORE_INVALID');
    }
    if (parsed.records.length > MAX_RECORDS) throw new Error('SAFETY_STATE_STORE_INVALID');
    for (const record of parsed.records) {
      if (!record?.key || typeof record.key !== 'string') throw new Error('SAFETY_STATE_STORE_INVALID');
      if (!SAFETY_STATES.includes(record.state)) throw new Error('SAFETY_STATE_STORE_INVALID');
      this.#records.set(record.key, clone(record));
    }
    this.#loaded = true;
  }

  async #persist() {
    if (!this.#storagePath) return;
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      policyVersion: SAFETY_STATE_POLICY_VERSION,
      records: [...this.#records.values()].map(clone)
    };
    await persistJsonFile(this.#storagePath, payload);
  }

  #enqueue(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  getState(keyOrParts) {
    const key = typeof keyOrParts === 'string'
      ? keyOrParts
      : safetyStateKey(keyOrParts ?? {});
    const existing = this.#records.get(key);
    if (existing) return clone(existing);
    const parts = typeof keyOrParts === 'string'
      ? parseSafetyStateKey(keyOrParts)
      : {
        entityId: keyOrParts?.entityId ?? 'executor',
        capabilityId: keyOrParts?.capabilityId,
        taskClass: keyOrParts?.taskClass
      };
    return createSafetyStateRecord(parts);
  }

  listStates() {
    return [...this.#records.values()].map(clone);
  }

  async putRecord(record) {
    await this.load();
    if (this.#records.size >= MAX_RECORDS && !this.#records.has(record.key)) {
      throw new Error('SAFETY_STATE_STORE_FULL');
    }
    this.#records.set(record.key, clone(record));
    await this.#persist();
    return clone(record);
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      await this.load();
      const result = await mutator({
        get: (keyOrParts) => this.getState(keyOrParts),
        put: async (record) => {
          if (this.#records.size >= MAX_RECORDS && !this.#records.has(record.key)) {
            throw new Error('SAFETY_STATE_STORE_FULL');
          }
          this.#records.set(record.key, clone(record));
          return clone(record);
        }
      });
      await this.#persist();
      return result;
    });
  }
}

export const createSafetyStateStore = (options) => new SafetyStateStore(options);

/**
 * Raise state rank (may skip levels). No-op if already at/above target.
 */
export async function transitionTighten({
  stateStore,
  key,
  to,
  reasonCode,
  evidenceRef,
  now
} = {}) {
  if (!stateStore || typeof stateStore.update !== 'function') {
    throw new Error('SAFETY_STATE_STORE_REQUIRED');
  }
  const target = stateName(to);
  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  const keyParts = typeof key === 'string' ? key : key;

  return stateStore.update(async ({ get, put }) => {
    const current = get(keyParts);
    if (rankOf(current.state) >= rankOf(target)) {
      return {
        ok: true,
        changed: false,
        record: current,
        transition: null,
        code: 'ALREADY_AT_OR_ABOVE'
      };
    }
    const { record, transition } = appendTransition(current, {
      from: current.state,
      to: target,
      reasonCode: reasonCode ?? 'TIGHTEN',
      evidenceRef,
      atMs
    });
    await put(record);
    return { ok: true, changed: true, record, transition };
  });
}

/**
 * Drop exactly one rank when evidence + clean window + samples allow.
 * QUARANTINE requires reviewer.approved === true and only recovers to DENY.
 */
export async function transitionRecover({
  stateStore,
  key,
  evidence,
  reviewer,
  now,
  minSamples = MIN_RECOVER_SAMPLES,
  cleanWindowMs = CLEAN_WINDOW_MS
} = {}) {
  if (!stateStore || typeof stateStore.update !== 'function') {
    throw new Error('SAFETY_STATE_STORE_REQUIRED');
  }
  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  const keyParts = typeof key === 'string' ? key : key;

  return stateStore.update(async ({ get, put }) => {
    const current = get(keyParts);

    if (current.state === 'ALLOW') {
      return {
        ok: false,
        changed: false,
        record: current,
        transition: null,
        code: RECOVER_REJECTED,
        detail: 'ALREADY_ALLOW'
      };
    }

    if (current.state === 'QUARANTINE') {
      if (reviewer?.approved !== true) {
        return {
          ok: false,
          changed: false,
          record: current,
          transition: null,
          code: RECOVER_QUARANTINE_NEEDS_REVIEWER
        };
      }
      // Explicit human review: only one step → DENY (still not automatic full recovery).
      const evidenceRef = evidence?.outcomeId ?? evidence?.runId ?? reviewer?.reviewId ?? 'reviewer-approved';
      const { record, transition } = appendTransition(current, {
        from: 'QUARANTINE',
        to: 'DENY',
        reasonCode: 'REVIEWER_APPROVED_RECOVER',
        evidenceRef,
        atMs
      });
      await put(record);
      return { ok: true, changed: true, record, transition };
    }

    if (!evidence || evidence.outcome !== 'SUCCEEDED') {
      return {
        ok: false,
        changed: false,
        record: current,
        transition: null,
        code: RECOVER_EVIDENCE_REQUIRED
      };
    }
    const evidenceRef = evidence.outcomeId ?? evidence.runId;
    if (!evidenceRef || (typeof evidenceRef === 'string' && !evidenceRef.trim())) {
      return {
        ok: false,
        changed: false,
        record: current,
        transition: null,
        code: RECOVER_EVIDENCE_REQUIRED
      };
    }

    const successCount = Number.isInteger(evidence.successCount)
      ? evidence.successCount
      : current.successCount;
    const requiredSamples = Number.isInteger(minSamples) && minSamples > 0
      ? minSamples
      : MIN_RECOVER_SAMPLES;
    if (successCount < requiredSamples) {
      return {
        ok: false,
        changed: false,
        record: current,
        transition: null,
        code: RECOVER_SAMPLES_INSUFFICIENT
      };
    }

    const windowMs = Number.isInteger(cleanWindowMs) && cleanWindowMs > 0
      ? cleanWindowMs
      : CLEAN_WINDOW_MS;
    if (current.lastIncidentAtMs !== null && current.lastIncidentAtMs !== undefined) {
      if (atMs - current.lastIncidentAtMs < windowMs) {
        return {
          ok: false,
          changed: false,
          record: current,
          transition: null,
          code: RECOVER_CLEAN_WINDOW_VIOLATED
        };
      }
    }

    const fromRank = rankOf(current.state);
    const toRank = fromRank - 1;
    const to = SAFETY_STATES[toRank];
    const nextBase = clone(current);
    // Count this successful sample toward the key's running total when provided.
    if (Number.isInteger(evidence.successCount)) {
      nextBase.successCount = evidence.successCount;
    } else {
      nextBase.successCount = current.successCount + 1;
    }
    const { record, transition } = appendTransition(nextBase, {
      from: current.state,
      to,
      reasonCode: 'HYSTERESIS_RECOVER',
      evidenceRef: String(evidenceRef),
      atMs
    });
    await put(record);
    return { ok: true, changed: true, record, transition };
  });
}

/**
 * Apply Incident severity → minimum state. Empty/missing events → no-op.
 * Idempotent on same incidentId for a key.
 */
export async function applyIncidentToSafetyState({
  incident,
  events,
  stateStore,
  entityId,
  capabilityId,
  taskClass,
  now
} = {}) {
  if (!incident || typeof incident !== 'object') {
    return {
      ok: false,
      changed: false,
      code: INCIDENT_EVENTS_REQUIRED,
      record: null
    };
  }
  if (!Array.isArray(incident.eventIds) || incident.eventIds.length < 1) {
    return {
      ok: false,
      changed: false,
      code: INCIDENT_EVENTS_REQUIRED,
      record: null,
      incident
    };
  }
  if (Array.isArray(events)) {
    const byId = new Set(events.map((ev) => ev?.eventId).filter(Boolean));
    for (const eventId of incident.eventIds) {
      if (!byId.has(eventId)) {
        return {
          ok: false,
          changed: false,
          code: INCIDENT_EVENTS_REQUIRED,
          record: null,
          incident
        };
      }
    }
  }

  // SEV3: attribute only — no state change (align S2).
  if (incident.severity === 'SEV3') {
    return { ok: true, changed: false, code: 'SEV3_NOOP', record: null, incident };
  }

  const targetState = SEV_TARGET_STATE[incident.severity];
  if (!targetState) {
    return {
      ok: false,
      changed: false,
      code: 'SEVERITY_INVALID',
      record: null,
      incident
    };
  }

  if (!stateStore || typeof stateStore.update !== 'function') {
    throw new Error('SAFETY_STATE_STORE_REQUIRED');
  }

  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();

  // Resolve subject: explicit args → profileTargets → first event subject → executor.
  let resolvedEntityId = entityId;
  let resolvedCapabilityId = capabilityId;
  let resolvedTaskClass = taskClass;

  if (!resolvedEntityId && Array.isArray(incident.profileTargets) && incident.profileTargets[0]?.entityId) {
    resolvedEntityId = incident.profileTargets[0].entityId;
  }
  if (!resolvedEntityId && Array.isArray(events) && events[0]?.subject?.entityId) {
    resolvedEntityId = events[0].subject.entityId;
  }
  resolvedEntityId = resolvedEntityId ?? 'executor';

  if (resolvedCapabilityId === undefined) {
    const path = Array.isArray(incident.capabilityPath) ? incident.capabilityPath : [];
    resolvedCapabilityId = path[0] ?? '*';
  }

  const key = safetyStateKey({
    entityId: resolvedEntityId,
    capabilityId: resolvedCapabilityId,
    taskClass: resolvedTaskClass
  });

  return stateStore.update(async ({ get, put }) => {
    const current = get(key);
    if (current.appliedIncidentIds?.includes(incident.incidentId)) {
      return {
        ok: true,
        changed: false,
        code: 'IDEMPOTENT',
        record: current,
        incident
      };
    }

    let next = clone(current);
    next.lastIncidentAtMs = atMs;
    next.lastIncidentSeverity = incident.severity;
    next.appliedIncidentIds = [...(next.appliedIncidentIds ?? []), incident.incidentId];

    let transition = null;
    let changed = false;
    if (rankOf(next.state) < rankOf(targetState)) {
      const tightened = appendTransition(next, {
        from: next.state,
        to: targetState,
        reasonCode: `INCIDENT_${incident.severity}`,
        evidenceRef: incident.incidentId,
        atMs
      });
      next = tightened.record;
      transition = tightened.transition;
      changed = true;
    } else {
      next.updatedAtMs = atMs;
    }

    await put(next);
    return {
      ok: true,
      changed,
      code: changed ? 'TIGHTENED' : 'ALREADY_AT_OR_ABOVE',
      record: next,
      transition,
      incident
    };
  });
}

/**
 * Gate hint for ACTION_GATE soft elevate after S1.
 * @returns {'NONE'|'REQUIRE_APPROVAL'|'DENY'}
 */
export function safetyStateGateHint(stateOrRecord) {
  const state = typeof stateOrRecord === 'string'
    ? stateOrRecord
    : stateOrRecord?.state;
  if (!state || !SAFETY_STATES.includes(state)) return 'NONE';
  if (state === 'ALLOW' || state === 'MONITOR') return 'NONE';
  if (state === 'CONFIRM' || state === 'SANDBOX') return 'REQUIRE_APPROVAL';
  // DENY / QUARANTINE
  return 'DENY';
}

/**
 * Apply gate hint onto an already-S1-processed gate decision.
 * Elevate only; never softens hard BLOCK.
 */
export function applySafetyStateGate({
  gateDecision = {},
  stateRecord,
  enabled = true
} = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const state = stateRecord?.state;
  const hint = enabled === false ? 'NONE' : safetyStateGateHint(stateRecord ?? state);

  const unchanged = (extra = {}) => ({
    decision,
    reasonCode,
    hint,
    state,
    elevated: false,
    ...extra
  });

  if (enabled === false || hint === 'NONE') return unchanged();

  // Never rewrite an existing hard BLOCK (or soften it).
  if (decision === 'BLOCK') return unchanged({ preservedBlock: true });

  if (hint === 'DENY') {
    return {
      decision: 'BLOCK',
      reasonCode: SAFETY_STATE_DENY,
      hint,
      state,
      elevated: true
    };
  }

  // REQUIRE_APPROVAL: elevate ALLOW → REQUIRE_APPROVAL; leave existing REQUIRE_APPROVAL.
  if (hint === 'REQUIRE_APPROVAL') {
    if (decision === 'ALLOW') {
      return {
        decision: 'REQUIRE_APPROVAL',
        reasonCode: SAFETY_STATE_REQUIRE_APPROVAL,
        hint,
        state,
        elevated: true
      };
    }
    return unchanged();
  }

  return unchanged();
}

export function isSafetyStateEnabled(env = process.env) {
  return env?.DDA_SAFETY_STATE !== '0';
}

/** Convenience: getState without requiring store method naming. */
export function getState(stateStore, keyOrParts) {
  if (!stateStore || typeof stateStore.getState !== 'function') {
    throw new Error('SAFETY_STATE_STORE_REQUIRED');
  }
  return stateStore.getState(keyOrParts);
}
