// Trust(X) knife: named Trust(A,S,C,O,R,E) + layered fallback into ACTION_GATE.
// Soft tighten only; never exempts hardDecision / lease; never demotes.
// Paper aliases (comments only): Actor / Skill / Context / Object / Risk / Evidence.
// Code keys: A / S / C / O / R / E (freeze-trust-x-r1 §1.1).
//
// T-trust-2 lock (freeze §2): **hit-layer exclusive** — stop at first layer with
// E≥E_min and use ONLY that layer's R. No cross-layer max(R_fine, R_coarse).

import { safetyStateKey } from './safety-state.mjs';

export const TRUST_X_REQUIRE_APPROVAL = 'TRUST_X_REQUIRE_APPROVAL';
export const TRUST_X_DENY = 'TRUST_X_DENY';
export const TRUST_X_LIMIT = 'TRUST_X_LIMIT';

/** Default E_min: evidenceCount≥3 OR E≥0.3 (freeze §1.2). Override via DDA_TRUST_X_E_MIN or opts.eMin. */
export const DEFAULT_TRUST_X_E_MIN = 0.3;
export const DEFAULT_TRUST_X_MIN_EVIDENCE_COUNT = 3;

/** R from Safety State rank (freeze §1.3). Not a ten-dim Risk Vector. */
export const STATE_TO_R = Object.freeze({
  ALLOW: 0.0,
  MONITOR: 0.1,
  CONFIRM: 0.4,
  SANDBOX: 0.6,
  DENY: 0.8,
  QUARANTINE: 1.0
});

/** Recent Incident SEV floor into R (freeze §1.3). */
export const SEV_TO_R = Object.freeze({
  SEV2: 0.4,
  SEV1: 0.6,
  SEV0: 1.0
  // SEV3: no floor
});

export function isTrustXEnabled(env = process.env) {
  return env?.DDA_TRUST_X !== '0';
}

/**
 * Parse E_min from env or explicit override. Falls back to DEFAULT_TRUST_X_E_MIN.
 */
export function resolveTrustXEMin({ eMin, env = process.env } = {}) {
  if (typeof eMin === 'number' && Number.isFinite(eMin) && eMin >= 0 && eMin <= 1) {
    return eMin;
  }
  const raw = env?.DDA_TRUST_X_E_MIN;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) return parsed;
  }
  return DEFAULT_TRUST_X_E_MIN;
}

/**
 * Map evidenceCount / success samples → E in [0,1].
 * evidenceCount=3 → 0.3; 10+ → 1.0.
 */
export function mapEvidenceToE({ evidenceCount, successCount } = {}) {
  const samples = Math.max(
    Number.isInteger(evidenceCount) && evidenceCount >= 0 ? evidenceCount : 0,
    Number.isInteger(successCount) && successCount >= 0 ? successCount : 0
  );
  return Math.min(1, samples / 10);
}

export function meetsEvidenceMin({ E = 0, evidenceCount = 0, successCount = 0, eMin = DEFAULT_TRUST_X_E_MIN } = {}) {
  const samples = Math.max(
    Number.isInteger(evidenceCount) && evidenceCount >= 0 ? evidenceCount : 0,
    Number.isInteger(successCount) && successCount >= 0 ? successCount : 0
  );
  return samples >= DEFAULT_TRUST_X_MIN_EVIDENCE_COUNT || E >= eMin;
}

export function mapStateToR(stateOrRecord) {
  const state = typeof stateOrRecord === 'string'
    ? stateOrRecord
    : stateOrRecord?.state;
  if (!state || !(state in STATE_TO_R)) return 0.0;
  return STATE_TO_R[state];
}

export function mapSevToR(severity) {
  if (typeof severity !== 'string') return 0;
  return SEV_TO_R[severity] ?? 0;
}

/**
 * Combine State R with optional recent SEV floor: R = max(R_state, sevMap).
 */
export function combineRiskR(stateOrRecord, severity) {
  const rState = mapStateToR(stateOrRecord);
  const rSev = mapSevToR(
    severity
      ?? (typeof stateOrRecord === 'object' ? stateOrRecord?.lastIncidentSeverity : undefined)
  );
  return Math.max(rState, rSev);
}

function trustKey({ entityId, capabilityId, taskClass, workspace }) {
  const id = typeof entityId === 'string' && entityId.trim() ? entityId.trim() : 'executor';
  const cap = typeof capabilityId === 'string' && capabilityId.trim() ? capabilityId.trim() : '*';
  const tc = typeof taskClass === 'string' && taskClass.trim() ? taskClass.trim() : '*';
  const ws = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : 'default';
  return `executor:${id}|cap:${cap}|tc:${tc}|ws:${ws}`;
}

function lookupStateRecord(stateStore, parts) {
  if (!stateStore) return null;
  const key = safetyStateKey(parts);
  if (typeof stateStore.listStates === 'function') {
    const found = stateStore.listStates().find((r) => r?.key === key);
    if (found) return found;
    // Fabricated ALLOW only when nothing stored — still usable for R=0.0.
  }
  if (typeof stateStore.getState === 'function') {
    return stateStore.getState(parts);
  }
  if (typeof stateStore.get === 'function') {
    return stateStore.get(parts);
  }
  return null;
}

function lookupProfile(profileRegistry, { entityId, capabilityId, actorLevelOnly = false }) {
  if (!profileRegistry || typeof profileRegistry.getProfile !== 'function') return null;
  // Actor-only layer (fallbackLevel≥3 / S dropped): subject SAFETY without capabilityId.
  // Finer layers: ONLY capability-scoped SAFETY counts for E — do not inherit actor E
  // (hit-layer exclusive / avoid coarse evidence making fine layers "hit" early with wrong R).
  if (actorLevelOnly || !capabilityId || capabilityId === '*') {
    return profileRegistry.getProfile({
      kind: 'SAFETY',
      entityType: 'executor',
      entityId
    }) ?? null;
  }
  return profileRegistry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId,
    capabilityId
  }) ?? null;
}

/**
 * Layer ladder fine→coarse (freeze §1.2).
 * Level 0: A+S+C+O … Level 3: A … Level 4: empty (caller).
 */
function buildLayers({ actor, capabilityId, taskClass, workspace }) {
  const A = typeof actor === 'string' && actor.trim() ? actor.trim() : 'executor';
  const S = typeof capabilityId === 'string' && capabilityId.trim() ? capabilityId.trim() : '*';
  const C = typeof taskClass === 'string' && taskClass.trim() ? taskClass.trim() : '*';
  const O = typeof workspace === 'string' && workspace.trim() ? workspace.trim() : 'default';
  return [
    { fallbackLevel: 0, A, S, C, O, drop: 'none' },
    { fallbackLevel: 1, A, S, C, O: 'default', drop: 'O' },
    { fallbackLevel: 2, A, S, C: '*', O: 'default', drop: 'C' },
    { fallbackLevel: 3, A, S: '*', C: '*', O: 'default', drop: 'S' }
  ];
}

function evaluateLayer(layer, { stateStore, profileRegistry, nowMs }) {
  const parts = {
    entityId: layer.A,
    capabilityId: layer.S,
    taskClass: layer.C
  };
  const stateRecord = lookupStateRecord(stateStore, parts);
  // Profile: A-only layer uses subject SAFETY; finer layers use capability-scoped only.
  const profile = lookupProfile(profileRegistry, {
    entityId: layer.A,
    capabilityId: layer.S,
    actorLevelOnly: layer.fallbackLevel >= 3 || layer.S === '*'
  });

  const evidenceCount = Number.isInteger(profile?.evidenceCount) ? profile.evidenceCount : 0;
  const successCount = Number.isInteger(stateRecord?.successCount) ? stateRecord.successCount : 0;
  const E = mapEvidenceToE({ evidenceCount, successCount });
  const R = combineRiskR(stateRecord, stateRecord?.lastIncidentSeverity);

  const key = trustKey({
    entityId: layer.A,
    capabilityId: layer.S,
    taskClass: layer.C,
    workspace: layer.O
  });

  return {
    A: layer.A,
    S: layer.S,
    C: layer.C,
    O: layer.O,
    R,
    E,
    key,
    sourceKey: key,
    fallbackLevel: layer.fallbackLevel,
    evidenceCount,
    successCount,
    state: stateRecord?.state,
    profileId: typeof profile?.profileId === 'string' ? profile.profileId : undefined,
    nowMs: typeof nowMs === 'number' ? nowMs : undefined
  };
}

/**
 * Resolve Trust(A,S,C,O,R,E) with layered fallback.
 * Hit-layer exclusive: first layer meeting E_min wins; its R is used alone.
 *
 * @returns {TrustX}
 */
export function resolveTrustX({
  actor,
  capabilityId,
  taskClass,
  workspace = 'default',
  stateStore,
  profileRegistry,
  nowMs,
  eMin,
  env = process.env
} = {}) {
  const threshold = resolveTrustXEMin({ eMin, env });
  const layers = buildLayers({ actor, capabilityId, taskClass, workspace });

  for (const layer of layers) {
    const trust = evaluateLayer(layer, { stateStore, profileRegistry, nowMs });
    if (meetsEvidenceMin({
      E: trust.E,
      evidenceCount: trust.evidenceCount,
      successCount: trust.successCount,
      eMin: threshold
    })) {
      return {
        A: trust.A,
        S: trust.S,
        C: trust.C,
        O: trust.O,
        R: trust.R,
        E: trust.E,
        key: trust.key,
        sourceKey: trust.sourceKey,
        fallbackLevel: trust.fallbackLevel,
        evidenceCount: trust.evidenceCount,
        successCount: trust.successCount,
        state: trust.state,
        profileId: trust.profileId,
        empty: false
      };
    }
  }

  // Empty / no reputation — do not raise or lower (freeze §1.2 step 5).
  const A = typeof actor === 'string' && actor.trim() ? actor.trim() : 'executor';
  return {
    A,
    S: typeof capabilityId === 'string' && capabilityId.trim() ? capabilityId.trim() : '*',
    C: typeof taskClass === 'string' && taskClass.trim() ? taskClass.trim() : '*',
    O: typeof workspace === 'string' && workspace.trim() ? workspace.trim() : 'default',
    R: 0,
    E: 0,
    key: trustKey({ entityId: A, capabilityId, taskClass, workspace }),
    sourceKey: null,
    fallbackLevel: 4,
    evidenceCount: 0,
    successCount: 0,
    state: undefined,
    profileId: undefined,
    empty: true
  };
}

/**
 * Soft-tighten gate from Trust(X). Elevate only; never demote; never rewrite hard BLOCK.
 *
 * @returns {{ decision, reasonCode, elevated, trust, requiredControls: string[] }}
 */
export function applyTrustXGate({
  gateDecision = {},
  trust,
  enabled = true,
  toolReadOnly
} = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const requiredControls = [];

  const unchanged = (extra = {}) => ({
    decision,
    reasonCode,
    elevated: false,
    trust,
    requiredControls,
    ...extra
  });

  if (enabled === false) return unchanged({ disabled: true });
  if (!trust || typeof trust !== 'object') return unchanged();

  // Hard BLOCK short-circuit (including hardDecision path already BLOCK).
  if (decision === 'BLOCK') return unchanged({ preservedBlock: true });

  // Read-only fast-path: never elevate.
  if (toolReadOnly === true) return unchanged({ readOnly: true });

  // Empty / insufficient evidence after full fallback → keep upstream judgment.
  if (trust.empty === true || trust.fallbackLevel === 4) return unchanged({ empty: true });

  const R = typeof trust.R === 'number' && Number.isFinite(trust.R) ? trust.R : 0;

  // High trust (low R) must NEVER demote REQUIRE_APPROVAL / BLOCK / etc.
  if (decision !== 'ALLOW') return unchanged();

  // R ≥ 0.8 → BLOCK TRUST_X_DENY (QUARANTINE/DENY residual).
  if (R >= 0.8) {
    return {
      decision: 'BLOCK',
      reasonCode: TRUST_X_DENY,
      elevated: true,
      trust,
      requiredControls
    };
  }

  // R ≥ 0.4 → REQUIRE_APPROVAL.
  if (R >= 0.4) {
    return {
      decision: 'REQUIRE_APPROVAL',
      reasonCode: TRUST_X_REQUIRE_APPROVAL,
      elevated: true,
      trust,
      requiredControls
    };
  }

  // MONITOR band ≈ 0.1 ≤ R < 0.4: keep ALLOW, attach LIMIT soft control (not a new Jev enum).
  if (R >= 0.1 && R < 0.4) {
    return {
      decision: 'ALLOW',
      reasonCode: TRUST_X_LIMIT,
      elevated: false,
      trust,
      requiredControls: ['LIMIT']
    };
  }

  // R < 0.1: no change.
  return unchanged();
}
