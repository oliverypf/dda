// S5: Incident→Policy (Candidate→Active→Retired) with dual-gate activation.
// Active policies only raise stateFloor; never exempt hard BLOCK / lease.
// DDA_SAFETY_POLICY=0 disables. No UI; no auto Policy from shell fail.

import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import { SAFETY_STATE_RANK } from './safety-state.mjs';
import { normalizeCapabilityPath } from './safety-incident.mjs';

export const SAFETY_POLICY_VERSION = 'safety-policy-r1';
export const POLICY_STATUSES = Object.freeze([
  'CANDIDATE',
  'ACTIVE',
  'RESTRICTED',
  'RETIRED'
]);

/** Allowed effect floors — no ALLOW, no direct QUARANTINE. */
export const POLICY_STATE_FLOORS = Object.freeze([
  'MONITOR',
  'CONFIRM',
  'SANDBOX',
  'DENY'
]);

/** Rank among floors only (MONITOR < CONFIRM < SANDBOX < DENY). */
export const POLICY_FLOOR_RANK = Object.freeze({
  MONITOR: 1,
  CONFIRM: 2,
  SANDBOX: 3,
  DENY: 4
});

export const POLICY_ACTIVATION_BLOCKED = 'POLICY_ACTIVATION_BLOCKED';
export const POLICY_CONTROL_KILLED = 'POLICY_CONTROL_KILLED';
export const POLICY_PROPOSE_REJECTED = 'POLICY_PROPOSE_REJECTED';
export const POLICY_ILLEGAL_TRANSITION = 'POLICY_ILLEGAL_TRANSITION';

const SCHEMA_VERSION = '1.0';
const MAX_POLICIES = 4096;
const MAX_HISTORY = 256;
const SUMMARY_MAX = 240;

const SEV_FLOOR = Object.freeze({
  SEV2: 'CONFIRM',
  SEV1: 'SANDBOX',
  SEV0: 'DENY'
  // SEV3: no propose
});

const clone = (value) => structuredClone(value);

const nonEmptyString = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

const bounded = (value, max) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
  .trim()
  .slice(0, max);

const floorName = (value) => {
  const name = nonEmptyString(value, 'POLICY_FLOOR_INVALID');
  if (!POLICY_STATE_FLOORS.includes(name)) throw new Error('POLICY_FLOOR_INVALID');
  return name;
};

const statusName = (value) => {
  const name = nonEmptyString(value, 'POLICY_STATUS_INVALID');
  if (!POLICY_STATUSES.includes(name)) throw new Error('POLICY_STATUS_INVALID');
  return name;
};

/**
 * Legal transitions:
 *   CANDIDATE → ACTIVE | RETIRED
 *   ACTIVE    → RESTRICTED | RETIRED
 *   RESTRICTED → ACTIVE | RETIRED
 *   RETIRED   → (none)
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  CANDIDATE: Object.freeze(['ACTIVE', 'RETIRED']),
  ACTIVE: Object.freeze(['RESTRICTED', 'RETIRED']),
  RESTRICTED: Object.freeze(['ACTIVE', 'RETIRED']),
  RETIRED: Object.freeze([])
});

export function assertPolicyTransition(from, to) {
  const src = statusName(from);
  const dst = statusName(to);
  if (!ALLOWED_TRANSITIONS[src].includes(dst)) {
    throw new Error(`${POLICY_ILLEGAL_TRANSITION}:${src}->${dst}`);
  }
}

export function policyFloorRank(floor) {
  const rank = POLICY_FLOOR_RANK[floor];
  if (rank === undefined) throw new Error('POLICY_FLOOR_INVALID');
  return rank;
}

/**
 * Compare a SafetyState name vs a policy floor.
 * Uses SAFETY_STATE_RANK so QUARANTINE > DENY still ranks above any floor.
 */
export function stateRankAtLeastFloor(state, floor) {
  const stateRank = SAFETY_STATE_RANK[state];
  const floorRank = POLICY_FLOOR_RANK[floor];
  if (stateRank === undefined || floorRank === undefined) return false;
  return stateRank >= floorRank;
}

function normalizeMatch(match = {}) {
  return {
    entityType: 'executor',
    entityId: typeof match.entityId === 'string' && match.entityId.trim()
      ? match.entityId.trim()
      : '*',
    capabilityId: typeof match.capabilityId === 'string' && match.capabilityId.trim()
      ? match.capabilityId.trim()
      : '*',
    taskClass: typeof match.taskClass === 'string' && match.taskClass.trim()
      ? match.taskClass.trim()
      : '*'
  };
}

/**
 * Wildcard match: policy dimension `*` matches any query value.
 */
export function policyMatches(policyMatch, query = {}) {
  const m = normalizeMatch(policyMatch);
  const entityId = typeof query.entityId === 'string' && query.entityId.trim()
    ? query.entityId.trim()
    : '*';
  const capabilityId = typeof query.capabilityId === 'string' && query.capabilityId.trim()
    ? query.capabilityId.trim()
    : '*';
  const taskClass = typeof query.taskClass === 'string' && query.taskClass.trim()
    ? query.taskClass.trim()
    : '*';
  const dimOk = (policyDim, queryDim) => policyDim === '*' || queryDim === '*' || policyDim === queryDim;
  return dimOk(m.entityId, entityId)
    && dimOk(m.capabilityId, capabilityId)
    && dimOk(m.taskClass, taskClass);
}

function appendHistory(policy, { from, to, reason, atMs, actor }) {
  const entry = {
    from,
    to,
    reason: bounded(reason ?? 'TRANSITION', 160) || 'TRANSITION',
    atMs,
    actor: bounded(actor ?? 'system', 80) || 'system'
  };
  const next = clone(policy);
  next.history = [...(next.history ?? []), entry].slice(-MAX_HISTORY);
  next.status = to;
  next.updatedAtMs = atMs;
  return next;
}

/**
 * Build a Policy record (does not persist).
 */
export function createPolicyRecord(input = {}) {
  const policyId = nonEmptyString(input.policyId, 'POLICY_ID_REQUIRED');
  const status = input.status !== undefined ? statusName(input.status) : 'CANDIDATE';
  const incidentIds = Array.isArray(input.incidentIds)
    ? input.incidentIds.map((id) => nonEmptyString(id, 'POLICY_INCIDENT_ID_REQUIRED'))
    : [];
  if (incidentIds.length < 1) throw new Error('POLICY_INCIDENT_REQUIRED');

  const abstractionIn = input.abstraction && typeof input.abstraction === 'object'
    ? input.abstraction
    : {};
  const abstraction = {
    reasonCode: nonEmptyString(abstractionIn.reasonCode ?? 'INCIDENT', 'POLICY_REASON_REQUIRED'),
    capabilityPath: normalizeCapabilityPath(abstractionIn.capabilityPath),
    summary: bounded(abstractionIn.summary ?? '', SUMMARY_MAX)
  };

  const effectFloor = floorName(input.effect?.stateFloor ?? 'CONFIRM');
  const evaluation = {
    cohortId: typeof input.evaluation?.cohortId === 'string' && input.evaluation.cohortId.trim()
      ? input.evaluation.cohortId.trim()
      : undefined,
    verified: input.evaluation?.verified === true,
    reportDigest: typeof input.evaluation?.reportDigest === 'string' && input.evaluation.reportDigest.trim()
      ? input.evaluation.reportDigest.trim()
      : undefined
  };
  const control = {
    enabled: input.control?.enabled === true
  };
  const atMs = typeof input.atMs === 'number' && Number.isInteger(input.atMs) && input.atMs >= 0
    ? input.atMs
    : Date.now();

  return {
    policyId,
    status,
    incidentIds,
    abstraction,
    match: normalizeMatch(input.match),
    effect: { stateFloor: effectFloor },
    evaluation,
    control,
    history: Array.isArray(input.history) ? clone(input.history) : [],
    createdAtMs: typeof input.createdAtMs === 'number' ? input.createdAtMs : atMs,
    updatedAtMs: atMs,
    policyVersion: SAFETY_POLICY_VERSION
  };
}

/**
 * Global kill/enable for Policy activation (EvolutionControlStore spirit).
 * Default enabled=true. In-memory; optional persistent-json via storagePath.
 */
export class SafetyPolicyControlStore {
  #enabled = true;
  #reason;
  #actor;
  #changedAtMs = 0;
  #storagePath;
  #loaded = false;

  constructor({ storagePath } = {}) {
    this.#storagePath = storagePath;
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
      throw new Error('POLICY_CONTROL_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (typeof parsed.enabled !== 'boolean') throw new Error('POLICY_CONTROL_STORE_INVALID');
    this.#enabled = parsed.enabled;
    this.#reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;
    this.#actor = typeof parsed.actor === 'string' ? parsed.actor : undefined;
    this.#changedAtMs = Number.isInteger(parsed.changedAtMs) ? parsed.changedAtMs : 0;
    this.#loaded = true;
  }

  async #persist() {
    if (!this.#storagePath) return;
    await persistJsonFile(this.#storagePath, {
      schemaVersion: SCHEMA_VERSION,
      enabled: this.#enabled,
      reason: this.#reason,
      actor: this.#actor,
      changedAtMs: this.#changedAtMs
    });
  }

  state() {
    return {
      enabled: this.#enabled,
      reason: this.#reason,
      actor: this.#actor,
      changedAtMs: this.#changedAtMs
    };
  }

  async assertEnabled(operation = 'POLICY') {
    await this.load();
    if (this.#enabled === false) {
      throw new Error(`${POLICY_CONTROL_KILLED}:${String(operation).slice(0, 40)}`);
    }
  }

  async kill({ reason = 'MANUAL_KILL_SWITCH', actor = 'OPERATOR' } = {}) {
    await this.load();
    if (this.#enabled === false) return { idempotent: true, state: this.state() };
    this.#enabled = false;
    this.#reason = bounded(reason, 160) || 'MANUAL_KILL_SWITCH';
    this.#actor = bounded(actor, 80) || 'OPERATOR';
    this.#changedAtMs = Date.now();
    await this.#persist();
    return { idempotent: false, state: this.state() };
  }

  async enable({ reason = 'MANUAL_RECOVERY', actor = 'OPERATOR' } = {}) {
    await this.load();
    if (this.#enabled === true) return { idempotent: true, state: this.state() };
    this.#enabled = true;
    this.#reason = bounded(reason, 160) || 'MANUAL_RECOVERY';
    this.#actor = bounded(actor, 80) || 'OPERATOR';
    this.#changedAtMs = Date.now();
    await this.#persist();
    return { idempotent: false, state: this.state() };
  }
}

export const createSafetyPolicyControlStore = (options) => new SafetyPolicyControlStore(options);

/**
 * Persistent-json Policy store (S3 SafetyStateStore style).
 */
export class SafetyPolicyStore {
  #policies = new Map();
  #storagePath;
  #loaded = false;
  #queue = Promise.resolve();

  constructor({ storagePath } = {}) {
    this.#storagePath = storagePath;
  }

  get size() {
    return this.#policies.size;
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
      throw new Error('POLICY_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.policies)) {
      throw new Error('POLICY_STORE_INVALID');
    }
    if (parsed.policies.length > MAX_POLICIES) throw new Error('POLICY_STORE_INVALID');
    for (const policy of parsed.policies) {
      if (!policy?.policyId || typeof policy.policyId !== 'string') {
        throw new Error('POLICY_STORE_INVALID');
      }
      if (!POLICY_STATUSES.includes(policy.status)) throw new Error('POLICY_STORE_INVALID');
      this.#policies.set(policy.policyId, clone(policy));
    }
    this.#loaded = true;
  }

  async #persist() {
    if (!this.#storagePath) return;
    await persistJsonFile(this.#storagePath, {
      schemaVersion: SCHEMA_VERSION,
      policyVersion: SAFETY_POLICY_VERSION,
      policies: [...this.#policies.values()].map(clone)
    });
  }

  #enqueue(work) {
    const run = this.#queue.then(work, work);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  getPolicy(policyId) {
    const id = nonEmptyString(policyId, 'POLICY_ID_REQUIRED');
    const existing = this.#policies.get(id);
    return existing ? clone(existing) : null;
  }

  listPolicies({ status } = {}) {
    const all = [...this.#policies.values()].map(clone);
    if (status === undefined) return all;
    const want = statusName(status);
    return all.filter((p) => p.status === want);
  }

  async putPolicy(policy) {
    await this.load();
    if (this.#policies.size >= MAX_POLICIES && !this.#policies.has(policy.policyId)) {
      throw new Error('POLICY_STORE_FULL');
    }
    this.#policies.set(policy.policyId, clone(policy));
    await this.#persist();
    return clone(policy);
  }

  async update(mutator) {
    return this.#enqueue(async () => {
      await this.load();
      const result = await mutator({
        get: (policyId) => this.getPolicy(policyId),
        put: async (policy) => {
          if (this.#policies.size >= MAX_POLICIES && !this.#policies.has(policy.policyId)) {
            throw new Error('POLICY_STORE_FULL');
          }
          this.#policies.set(policy.policyId, clone(policy));
          return clone(policy);
        },
        list: (opts) => this.listPolicies(opts)
      });
      await this.#persist();
      return result;
    });
  }
}

export const createSafetyPolicyStore = (options) => new SafetyPolicyStore(options);

/**
 * Incident → Candidate. Rejects empty/unattributed/SEV3.
 * @returns {{ ok: boolean, code?: string, policy?: object }}
 */
export function proposePolicyFromIncident({
  incident,
  events,
  policyId,
  match,
  now,
  actor = 'system'
} = {}) {
  if (!incident || typeof incident !== 'object') {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'INCIDENT_REQUIRED' };
  }
  if (incident.status !== 'ATTRIBUTED') {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'NOT_ATTRIBUTED' };
  }
  if (!Array.isArray(incident.eventIds) || incident.eventIds.length < 1) {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'NO_EVENT_IDS' };
  }
  if (!Array.isArray(events) || events.length < 1) {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'NO_EVENTS' };
  }
  const byId = new Set(events.map((ev) => ev?.eventId).filter(Boolean));
  for (const eventId of incident.eventIds) {
    if (!byId.has(eventId)) {
      return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'EVENTS_INCOMPLETE' };
    }
  }

  if (incident.severity === 'SEV3') {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'SEV3_NO_POLICY' };
  }
  const stateFloor = SEV_FLOOR[incident.severity];
  if (!stateFloor) {
    return { ok: false, code: POLICY_PROPOSE_REJECTED, detail: 'SEVERITY_INVALID' };
  }

  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  const firstEvent = events.find((ev) => ev.eventId === incident.eventIds[0]);
  const reasonCode = firstEvent?.reasonCode
    ?? (incident.severity === 'SEV0' ? 'CRITICAL_INCIDENT'
      : incident.severity === 'SEV1' ? 'HIGH_INCIDENT'
        : 'MEDIUM_INCIDENT');

  const resolvedMatch = normalizeMatch(match ?? {
    entityId: incident.profileTargets?.[0]?.entityId
      ?? firstEvent?.subject?.entityId
      ?? 'executor',
    capabilityId: Array.isArray(incident.capabilityPath) && incident.capabilityPath[0]
      ? incident.capabilityPath[0]
      : '*',
    taskClass: '*'
  });

  const id = typeof policyId === 'string' && policyId.trim()
    ? policyId.trim()
    : `pol-${incident.incidentId}`;

  const policy = createPolicyRecord({
    policyId: id,
    status: 'CANDIDATE',
    incidentIds: [incident.incidentId],
    abstraction: {
      reasonCode,
      capabilityPath: incident.capabilityPath ?? [],
      summary: bounded(
        `Candidate from ${incident.severity} incident ${incident.incidentId}`,
        SUMMARY_MAX
      )
    },
    match: resolvedMatch,
    effect: { stateFloor },
    evaluation: { verified: false },
    control: { enabled: false },
    atMs,
    history: [{
      from: 'CANDIDATE',
      to: 'CANDIDATE',
      reason: 'PROPOSED',
      atMs,
      actor: bounded(actor, 80) || 'system'
    }]
  });

  return { ok: true, policy };
}

/**
 * Dual-gate activate: verified evaluation AND explicit enable; control store not killed.
 */
export async function activatePolicy({
  policyId,
  policyStore,
  evaluation,
  actor = 'OPERATOR',
  controlStore,
  enable = false,
  now
} = {}) {
  if (!policyStore || typeof policyStore.update !== 'function') {
    throw new Error('POLICY_STORE_REQUIRED');
  }
  if (controlStore && typeof controlStore.assertEnabled === 'function') {
    await controlStore.assertEnabled('ACTIVATE');
  }

  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  const verified = evaluation?.verified === true;

  return policyStore.update(async ({ get, put }) => {
    const current = get(policyId);
    if (!current) {
      return { ok: false, code: 'POLICY_NOT_FOUND', policy: null };
    }
    if (current.status === 'ACTIVE') {
      return { ok: true, changed: false, code: 'ALREADY_ACTIVE', policy: current };
    }
    if (current.status !== 'CANDIDATE' && current.status !== 'RESTRICTED') {
      throw new Error(`${POLICY_ILLEGAL_TRANSITION}:${current.status}->ACTIVE`);
    }

    const nextEval = {
      cohortId: typeof evaluation?.cohortId === 'string' ? evaluation.cohortId : current.evaluation?.cohortId,
      verified,
      reportDigest: typeof evaluation?.reportDigest === 'string'
        ? evaluation.reportDigest
        : current.evaluation?.reportDigest
    };

    let next = clone(current);
    next.evaluation = nextEval;
    if (enable === true) {
      next.control = { ...next.control, enabled: true };
    }

    if (nextEval.verified !== true || next.control?.enabled !== true) {
      await put(next);
      return {
        ok: false,
        changed: nextEval.verified !== current.evaluation?.verified
          || next.control.enabled !== current.control?.enabled,
        code: POLICY_ACTIVATION_BLOCKED,
        policy: next,
        detail: nextEval.verified !== true ? 'NOT_VERIFIED' : 'NOT_ENABLED'
      };
    }

    assertPolicyTransition(current.status, 'ACTIVE');
    next = appendHistory(next, {
      from: current.status,
      to: 'ACTIVE',
      reason: 'ACTIVATED',
      atMs,
      actor
    });
    await put(next);
    return { ok: true, changed: true, code: 'ACTIVATED', policy: next };
  });
}

export async function retirePolicy({
  policyId,
  policyStore,
  actor = 'OPERATOR',
  reason = 'RETIRED',
  now
} = {}) {
  if (!policyStore || typeof policyStore.update !== 'function') {
    throw new Error('POLICY_STORE_REQUIRED');
  }
  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  return policyStore.update(async ({ get, put }) => {
    const current = get(policyId);
    if (!current) return { ok: false, code: 'POLICY_NOT_FOUND', policy: null };
    if (current.status === 'RETIRED') {
      return { ok: true, changed: false, code: 'ALREADY_RETIRED', policy: current };
    }
    assertPolicyTransition(current.status, 'RETIRED');
    const next = appendHistory(current, {
      from: current.status,
      to: 'RETIRED',
      reason,
      atMs,
      actor
    });
    next.control = { ...next.control, enabled: false };
    await put(next);
    return { ok: true, changed: true, code: 'RETIRED', policy: next };
  });
}

export async function restrictPolicy({
  policyId,
  policyStore,
  actor = 'OPERATOR',
  reason = 'RESTRICTED',
  now
} = {}) {
  if (!policyStore || typeof policyStore.update !== 'function') {
    throw new Error('POLICY_STORE_REQUIRED');
  }
  const atMs = typeof now === 'number' && Number.isInteger(now) && now >= 0 ? now : Date.now();
  return policyStore.update(async ({ get, put }) => {
    const current = get(policyId);
    if (!current) return { ok: false, code: 'POLICY_NOT_FOUND', policy: null };
    if (current.status === 'RESTRICTED') {
      return { ok: true, changed: false, code: 'ALREADY_RESTRICTED', policy: current };
    }
    assertPolicyTransition(current.status, 'RESTRICTED');
    const next = appendHistory(current, {
      from: current.status,
      to: 'RESTRICTED',
      reason,
      atMs,
      actor
    });
    // Drop enable so RESTRICTED→ACTIVE still requires dual gate (verified + enable).
    next.control = { ...next.control, enabled: false };
    await put(next);
    return { ok: true, changed: true, code: 'RESTRICTED', policy: next };
  });
}

/**
 * Highest ACTIVE matching stateFloor, or null if none.
 */
export function effectiveStateFloor({ match, policyStore } = {}) {
  if (!policyStore || typeof policyStore.listPolicies !== 'function') {
    return null;
  }
  const active = policyStore.listPolicies({ status: 'ACTIVE' });
  let best = null;
  let bestRank = -1;
  for (const policy of active) {
    if (!policyMatches(policy.match, match ?? {})) continue;
    const floor = policy.effect?.stateFloor;
    if (!POLICY_STATE_FLOORS.includes(floor)) continue;
    const rank = POLICY_FLOOR_RANK[floor];
    if (rank > bestRank) {
      bestRank = rank;
      best = floor;
    }
  }
  return best;
}

/**
 * Raise a SafetyState record's state to at least the policy floor (read-path only).
 * Does not mutate the store. Returns original if no floor or already at/above.
 */
export function raiseStateRecordToPolicyFloor(stateRecord, floor) {
  if (!floor || !POLICY_STATE_FLOORS.includes(floor)) return stateRecord;
  if (!stateRecord || typeof stateRecord !== 'object') {
    return { state: floor, rank: SAFETY_STATE_RANK[floor], policyFloorApplied: floor };
  }
  const currentState = stateRecord.state ?? 'ALLOW';
  const currentRank = SAFETY_STATE_RANK[currentState] ?? 0;
  const floorRank = POLICY_FLOOR_RANK[floor];
  if (currentRank >= floorRank) {
    return { ...stateRecord, policyFloorApplied: null };
  }
  return {
    ...stateRecord,
    state: floor,
    rank: SAFETY_STATE_RANK[floor],
    policyFloorApplied: floor
  };
}

export function isSafetyPolicyEnabled(env = process.env) {
  return env?.DDA_SAFETY_POLICY !== '0';
}

/**
 * Persist a proposed Candidate (idempotent on same policyId if already present).
 */
export async function storeProposedPolicy({ policyStore, proposeResult } = {}) {
  if (!proposeResult?.ok || !proposeResult.policy) {
    return proposeResult ?? { ok: false, code: POLICY_PROPOSE_REJECTED };
  }
  if (!policyStore || typeof policyStore.putPolicy !== 'function') {
    throw new Error('POLICY_STORE_REQUIRED');
  }
  await policyStore.load?.();
  const existing = policyStore.getPolicy(proposeResult.policy.policyId);
  if (existing) {
    return { ok: true, policy: existing, code: 'IDEMPOTENT' };
  }
  const stored = await policyStore.putPolicy(proposeResult.policy);
  return { ok: true, policy: stored, code: 'STORED' };
}
