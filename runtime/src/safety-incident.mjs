// S2: SafetyEvent + Incident — asymmetric SAFETY demotion (slow build / fast drop).
// Pure constructors + applyIncidentToSafetyProfile. No lease/hardDecision changes.
// Profile writes use existing recordEvidence only (no schema rewrite).
//
// Note: freeze suggests sourceType:'incident'; ProfileRegistry EVIDENCE_SOURCES
// only allows coordinator|verifier|system|user. We map to sourceType:'system'
// with sourceId=incidentId so attribution stays auditable without schema change.

export const SAFETY_EVENT_PHASES = Object.freeze(['PLAN', 'EXECUTE', 'OUTCOME']);
export const SAFETY_SEVERITIES = Object.freeze(['SEV0', 'SEV1', 'SEV2', 'SEV3']);
export const INCIDENT_STATUSES = Object.freeze(['OPEN', 'ATTRIBUTED']);

export const INCIDENT_EVENTS_REQUIRED = 'INCIDENT_EVENTS_REQUIRED';
export const CAPABILITY_PATH_MAX = 8;

/** Higher rank = worse. SEV0 worst, SEV3 mildest. */
const SEV_RANK = Object.freeze({ SEV0: 3, SEV1: 2, SEV2: 1, SEV3: 0 });

const SEV_SAFETY = Object.freeze({
  SEV0: 0.1,
  SEV1: 0.1,
  SEV2: 0.4
  // SEV3: no demote
});

const nonEmptyString = (value, code) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
};

/**
 * capabilityPath policy (T-s2-5): truncate to CAPABILITY_PATH_MAX, keep order, drop empties.
 * Chosen over reject so production callers never throw solely for path length.
 */
export function normalizeCapabilityPath(path) {
  if (path === undefined || path === null) return [];
  if (!Array.isArray(path)) throw new Error('CAPABILITY_PATH_INVALID');
  const out = [];
  for (const part of path) {
    if (typeof part !== 'string' || !part.trim()) continue;
    out.push(part.trim());
    if (out.length >= CAPABILITY_PATH_MAX) break;
  }
  return out;
}

export function severityRank(severity) {
  const rank = SEV_RANK[severity];
  if (rank === undefined) throw new Error('SEVERITY_INVALID');
  return rank;
}

export function maxSeverity(severities) {
  if (!Array.isArray(severities) || severities.length === 0) throw new Error('SEVERITY_INVALID');
  let best = severities[0];
  for (const sev of severities) {
    if (severityRank(sev) > severityRank(best)) best = sev;
  }
  return best;
}

/**
 * @returns {object} SafetyEvent
 */
export function createSafetyEvent(input = {}) {
  const eventId = nonEmptyString(input.eventId, 'SAFETY_EVENT_ID_REQUIRED');
  const runId = nonEmptyString(input.runId, 'SAFETY_EVENT_RUN_REQUIRED');
  const phase = nonEmptyString(input.phase, 'SAFETY_EVENT_PHASE_INVALID');
  if (!SAFETY_EVENT_PHASES.includes(phase)) throw new Error('SAFETY_EVENT_PHASE_INVALID');
  const severity = nonEmptyString(input.severity, 'SEVERITY_INVALID');
  if (!SAFETY_SEVERITIES.includes(severity)) throw new Error('SEVERITY_INVALID');
  const reasonCode = nonEmptyString(input.reasonCode ?? 'UNKNOWN', 'SAFETY_EVENT_REASON_REQUIRED');
  const subject = input.subject && typeof input.subject === 'object'
    ? {
      entityType: nonEmptyString(input.subject.entityType ?? 'executor', 'SAFETY_EVENT_SUBJECT_INVALID'),
      entityId: nonEmptyString(input.subject.entityId ?? 'executor', 'SAFETY_EVENT_SUBJECT_INVALID')
    }
    : { entityType: 'executor', entityId: 'executor' };

  return {
    eventId,
    runId,
    phase,
    severity,
    ...(input.decisionId !== undefined ? { decisionId: nonEmptyString(String(input.decisionId), 'SAFETY_EVENT_DECISION_INVALID') } : {}),
    ...(input.causationId !== undefined ? { causationId: nonEmptyString(String(input.causationId), 'SAFETY_EVENT_CAUSATION_INVALID') } : {}),
    capabilityPath: normalizeCapabilityPath(input.capabilityPath),
    reasonCode,
    subject
  };
}

/**
 * Build Incident from member events. severity may be explicit but must not be milder than max member.
 */
export function createIncident(input = {}) {
  const incidentId = nonEmptyString(input.incidentId, 'INCIDENT_ID_REQUIRED');
  const events = Array.isArray(input.events) ? input.events : [];
  if (events.length === 0 && (!Array.isArray(input.eventIds) || input.eventIds.length === 0)) {
    throw new Error(INCIDENT_EVENTS_REQUIRED);
  }

  const eventIds = Array.isArray(input.eventIds) && input.eventIds.length
    ? input.eventIds.map((id) => nonEmptyString(id, 'INCIDENT_EVENT_ID_REQUIRED'))
    : events.map((ev) => nonEmptyString(ev.eventId, 'INCIDENT_EVENT_ID_REQUIRED'));

  if (eventIds.length < 1) throw new Error(INCIDENT_EVENTS_REQUIRED);

  const memberSevs = events
    .filter((ev) => eventIds.includes(ev.eventId))
    .map((ev) => ev.severity);
  const fromMembers = memberSevs.length ? maxSeverity(memberSevs) : undefined;

  let severity;
  if (input.severity !== undefined) {
    severity = nonEmptyString(input.severity, 'SEVERITY_INVALID');
    if (!SAFETY_SEVERITIES.includes(severity)) throw new Error('SEVERITY_INVALID');
    if (fromMembers && severityRank(severity) < severityRank(fromMembers)) {
      throw new Error('INCIDENT_SEVERITY_BELOW_MEMBERS');
    }
  } else if (fromMembers) {
    severity = fromMembers;
  } else {
    throw new Error('SEVERITY_INVALID');
  }

  const causalTrace = Array.isArray(input.causalTrace) && input.causalTrace.length
    ? input.causalTrace.map((row) => {
      const eventId = nonEmptyString(row?.eventId, 'CAUSAL_TRACE_INVALID');
      return {
        eventId,
        ...(row.decisionId !== undefined
          ? { decisionId: nonEmptyString(String(row.decisionId), 'CAUSAL_TRACE_INVALID') }
          : {})
      };
    })
    : eventIds.map((eventId) => {
      const ev = events.find((item) => item.eventId === eventId);
      return {
        eventId,
        ...(ev?.decisionId ? { decisionId: ev.decisionId } : {})
      };
    });

  const mergedPath = normalizeCapabilityPath([
    ...(Array.isArray(input.capabilityPath) ? input.capabilityPath : []),
    ...events.flatMap((ev) => (Array.isArray(ev.capabilityPath) ? ev.capabilityPath : []))
  ]);

  // Dedupe while preserving order (after truncate already applied per segment merge).
  const seen = new Set();
  const capabilityPath = [];
  for (const part of mergedPath) {
    if (seen.has(part)) continue;
    seen.add(part);
    capabilityPath.push(part);
    if (capabilityPath.length >= CAPABILITY_PATH_MAX) break;
  }

  const profileTargets = Array.isArray(input.profileTargets) && input.profileTargets.length
    ? input.profileTargets.map((t) => ({
      kind: 'SAFETY',
      entityType: nonEmptyString(t.entityType ?? 'executor', 'PROFILE_TARGET_INVALID'),
      entityId: nonEmptyString(t.entityId, 'PROFILE_TARGET_INVALID')
    }))
    : [{
      kind: 'SAFETY',
      entityType: events[0]?.subject?.entityType ?? 'executor',
      entityId: events[0]?.subject?.entityId ?? 'executor'
    }];

  const status = input.status ?? 'OPEN';
  if (!INCIDENT_STATUSES.includes(status)) throw new Error('INCIDENT_STATUS_INVALID');

  return {
    incidentId,
    severity,
    eventIds,
    causalTrace,
    capabilityPath,
    status,
    profileTargets
  };
}

const eventMap = (events) => {
  const map = new Map();
  if (!Array.isArray(events)) return map;
  for (const ev of events) {
    if (ev?.eventId) map.set(ev.eventId, ev);
  }
  return map;
};

/** Stable evidence id → recordEvidence idempotent on same incidentId+target. */
export function incidentEvidenceId(incidentId, entityType, entityId) {
  return `incident-safety:${incidentId}:${entityType}:${entityId}`;
}

/**
 * Asymmetric SAFETY update from Incident.
 * @returns {Promise<{ ok: boolean, code?: string, demoted: boolean, incident: object, evidenceIds: string[] }>}
 */
export async function applyIncidentToSafetyProfile({
  incident,
  events,
  profileRegistry,
  now
} = {}) {
  if (!incident || typeof incident !== 'object') {
    return { ok: false, code: INCIDENT_EVENTS_REQUIRED, demoted: false, incident: incident ?? null, evidenceIds: [] };
  }
  if (!Array.isArray(incident.eventIds) || incident.eventIds.length < 1) {
    return { ok: false, code: INCIDENT_EVENTS_REQUIRED, demoted: false, incident, evidenceIds: [] };
  }

  const byId = eventMap(events);
  for (const eventId of incident.eventIds) {
    if (!byId.has(eventId)) {
      return { ok: false, code: INCIDENT_EVENTS_REQUIRED, demoted: false, incident, evidenceIds: [] };
    }
  }

  // SEV3 only: attribute, do not demote via recordEvidence.
  if (incident.severity === 'SEV3') {
    const attributed = { ...incident, status: 'ATTRIBUTED' };
    return { ok: true, demoted: false, incident: attributed, evidenceIds: [] };
  }

  if (!['SEV0', 'SEV1', 'SEV2'].includes(incident.severity)) {
    return { ok: false, code: 'SEVERITY_INVALID', demoted: false, incident, evidenceIds: [] };
  }

  if (!profileRegistry || typeof profileRegistry.recordEvidence !== 'function') {
    throw new Error('PROFILE_REGISTRY_REQUIRED');
  }

  const safety = SEV_SAFETY[incident.severity];
  const observedAtMs = typeof now === 'number' && Number.isInteger(now) && now >= 0
    ? now
    : Date.now();

  // Prefer runId/decisionId from first member event.
  const firstEvent = byId.get(incident.eventIds[0]);
  const runId = firstEvent?.runId ?? `incident-run-${incident.incidentId}`;
  const decisionId = firstEvent?.decisionId;

  const targets = Array.isArray(incident.profileTargets) && incident.profileTargets.length
    ? incident.profileTargets
    : [{ kind: 'SAFETY', entityType: 'executor', entityId: 'executor' }];

  const evidenceIds = [];
  for (const target of targets) {
    const evidenceId = incidentEvidenceId(incident.incidentId, target.entityType, target.entityId);
    // Idempotent on same incidentId: skip if stable evidenceId already recorded
    // (avoids PROFILE_EVIDENCE_ID_CONFLICT when observedAtMs / payload drifts).
    const prior = typeof profileRegistry.listEvidence === 'function'
      ? profileRegistry.listEvidence({
        kind: 'SAFETY',
        entityType: target.entityType,
        entityId: target.entityId
      }).find((item) => item.evidenceId === evidenceId)
      : undefined;
    if (prior) {
      evidenceIds.push(evidenceId);
      continue;
    }
    try {
      await profileRegistry.recordEvidence({
        evidenceId,
        kind: 'SAFETY',
        entityType: target.entityType,
        entityId: target.entityId,
        runId,
        ...(decisionId ? { decisionId } : {}),
        sourceType: 'system',
        sourceId: incident.incidentId,
        outcome: 'FAILED',
        safety,
        observedAtMs
      });
    } catch (error) {
      // Concurrent / replay race: treat identical id as already attributed.
      if (error instanceof Error && error.message === 'PROFILE_EVIDENCE_ID_CONFLICT') {
        evidenceIds.push(evidenceId);
        continue;
      }
      throw error;
    }
    evidenceIds.push(evidenceId);
  }

  const attributed = { ...incident, status: 'ATTRIBUTED' };
  return { ok: true, demoted: true, incident: attributed, evidenceIds };
}

export function isSafetyIncidentEnabled(env = process.env) {
  return env?.DDA_SAFETY_INCIDENT !== '0';
}

/**
 * Production helper: ACTION_GATE BLOCK → SEV2 Incident + apply (caller soft-fails).
 */
export async function recordActionGateBlockIncident({
  profileRegistry,
  runId,
  entityId,
  decisionId,
  capabilityPath,
  phase = 'EXECUTE',
  now
} = {}) {
  const event = createSafetyEvent({
    eventId: `sev-gate-block-${runId}-${decisionId ?? 'nodec'}`,
    runId,
    phase: phase === 'PLAN' ? 'PLAN' : 'EXECUTE',
    severity: 'SEV2',
    reasonCode: 'ACTION_GATE_BLOCK',
    ...(decisionId ? { decisionId } : {}),
    capabilityPath,
    subject: { entityType: 'executor', entityId: entityId ?? 'executor' }
  });
  const incident = createIncident({
    incidentId: `inc-gate-block-${runId}-${decisionId ?? event.eventId}`,
    events: [event],
    profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId: entityId ?? 'executor' }]
  });
  return applyIncidentToSafetyProfile({ incident, events: [event], profileRegistry, now });
}

/**
 * Production helper: SCOPE_VIOLATION.
 * executed=true (post-observation failure) → SEV1; block-only → SEV2.
 */
export async function recordScopeViolationIncident({
  profileRegistry,
  runId,
  entityId,
  decisionId,
  capabilityPath,
  executed = true,
  now
} = {}) {
  const severity = executed ? 'SEV1' : 'SEV2';
  const event = createSafetyEvent({
    eventId: `sev-scope-${runId}-${decisionId ?? 'nodec'}`,
    runId,
    phase: 'EXECUTE',
    severity,
    reasonCode: 'SCOPE_VIOLATION',
    ...(decisionId ? { decisionId } : {}),
    capabilityPath,
    subject: { entityType: 'executor', entityId: entityId ?? 'executor' }
  });
  const incident = createIncident({
    incidentId: `inc-scope-${runId}-${decisionId ?? event.eventId}`,
    events: [event],
    profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId: entityId ?? 'executor' }]
  });
  return applyIncidentToSafetyProfile({ incident, events: [event], profileRegistry, now });
}
