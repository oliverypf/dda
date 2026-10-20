import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileRegistry } from '../src/profile-registry.mjs';
import {
  CAPABILITY_PATH_MAX,
  INCIDENT_EVENTS_REQUIRED,
  applyIncidentToSafetyProfile,
  createIncident,
  createSafetyEvent,
  incidentEvidenceId,
  isSafetyIncidentEnabled,
  normalizeCapabilityPath
} from '../src/safety-incident.mjs';

const makeRegistry = () => new ProfileRegistry({
  now: () => 1_700_000_000_000,
  idFactory: (() => { let n = 0; return () => `id-${++n}`; })()
});

const sev2Event = (overrides = {}) => createSafetyEvent({
  eventId: 'ev-1',
  runId: 'run-1',
  phase: 'EXECUTE',
  severity: 'SEV2',
  reasonCode: 'ACTION_GATE_BLOCK',
  decisionId: 'dec-1',
  capabilityPath: ['shell.execute'],
  subject: { entityType: 'executor', entityId: 'exec-1' },
  ...overrides
});

test('T-s2-1 SEV2 SafetyEvent + Incident → apply demotes SAFETY (FAILURE_OBSERVED / safety drop)', async () => {
  const registry = makeRegistry();
  const event = sev2Event();
  const incident = createIncident({
    incidentId: 'inc-1',
    events: [event]
  });
  const result = await applyIncidentToSafetyProfile({
    incident,
    events: [event],
    profileRegistry: registry,
    now: 1_700_000_000_000
  });
  assert.equal(result.ok, true);
  assert.equal(result.demoted, true);
  assert.equal(result.incident.status, 'ATTRIBUTED');

  const profile = registry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-1'
  });
  assert.ok(profile, 'SAFETY profile must exist');
  assert.equal(profile.stats.failureCount, 1);
  assert.ok(profile.eligibility.reasonCodes.includes('FAILURE_OBSERVED'));
  assert.ok(profile.stats.safetyMean !== null && profile.stats.safetyMean <= 0.5);
  assert.ok(profile.stats.safetyMean <= 0.4 + 1e-9);

  const evidence = registry.listEvidence({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-1'
  });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].sourceType, 'system');
  assert.equal(evidence[0].sourceId, 'inc-1');
  assert.equal(evidence[0].outcome, 'FAILED');
  assert.equal(evidence[0].evidenceId, incidentEvidenceId('inc-1', 'executor', 'exec-1'));
});

test('T-s2-2 empty / missing events → no demote (INCIDENT_EVENTS_REQUIRED)', async () => {
  const registry = makeRegistry();
  // Seed a clean profile via unrelated success so we can detect absence of FAILED.
  await registry.recordEvidence({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-empty',
    runId: 'run-seed',
    sourceType: 'system',
    sourceId: 'seed',
    outcome: 'SUCCEEDED',
    safety: 0.95,
    observedAtMs: 1_700_000_000_000
  });
  const before = registry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-empty'
  });

  const incidentShell = {
    incidentId: 'inc-empty',
    severity: 'SEV2',
    eventIds: [],
    causalTrace: [],
    capabilityPath: [],
    status: 'OPEN',
    profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId: 'exec-empty' }]
  };
  const emptyIds = await applyIncidentToSafetyProfile({
    incident: incidentShell,
    events: [],
    profileRegistry: registry
  });
  assert.equal(emptyIds.ok, false);
  assert.equal(emptyIds.code, INCIDENT_EVENTS_REQUIRED);
  assert.equal(emptyIds.demoted, false);

  const missing = await applyIncidentToSafetyProfile({
    incident: {
      ...incidentShell,
      eventIds: ['ev-missing']
    },
    events: [sev2Event({ eventId: 'ev-other', subject: { entityType: 'executor', entityId: 'exec-empty' } })],
    profileRegistry: registry
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, INCIDENT_EVENTS_REQUIRED);
  assert.equal(missing.demoted, false);

  const after = registry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-empty'
  });
  assert.equal(after.stats.failureCount, before.stats.failureCount);
  assert.equal(after.evidenceCount, before.evidenceCount);
  assert.ok(!after.eligibility.reasonCodes.includes('FAILURE_OBSERVED'));
});

test('T-s2-3 SEV3 only → ATTRIBUTED but no demote', async () => {
  const registry = makeRegistry();
  const event = sev2Event({ eventId: 'ev-sev3', severity: 'SEV3', reasonCode: 'LOW_RISK_NOTE' });
  const incident = createIncident({ incidentId: 'inc-sev3', events: [event] });
  const result = await applyIncidentToSafetyProfile({
    incident,
    events: [event],
    profileRegistry: registry
  });
  assert.equal(result.ok, true);
  assert.equal(result.demoted, false);
  assert.equal(result.incident.status, 'ATTRIBUTED');
  assert.deepEqual(result.evidenceIds, []);

  const profile = registry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-1'
  });
  assert.equal(profile, undefined);
});

test('T-s2-4 same incidentId second apply is idempotent (failureCount not doubled)', async () => {
  const registry = makeRegistry();
  const event = sev2Event({ eventId: 'ev-idem' });
  const incident = createIncident({ incidentId: 'inc-idem', events: [event] });

  const first = await applyIncidentToSafetyProfile({
    incident,
    events: [event],
    profileRegistry: registry,
    now: 1_700_000_000_000
  });
  assert.equal(first.demoted, true);

  const second = await applyIncidentToSafetyProfile({
    incident,
    events: [event],
    profileRegistry: registry,
    now: 1_700_000_000_100
  });
  assert.equal(second.ok, true);
  assert.equal(second.demoted, true);

  const profile = registry.getProfile({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-1'
  });
  assert.equal(profile.stats.failureCount, 1);
  assert.equal(profile.evidenceCount, 1);
  const evidence = registry.listEvidence({
    kind: 'SAFETY',
    entityType: 'executor',
    entityId: 'exec-1'
  });
  assert.equal(evidence.length, 1);
});

test('T-s2-5 capabilityPath longer than 8 is truncated (not rejected)', () => {
  const long = Array.from({ length: 12 }, (_, i) => `step.${i}`);
  const normalized = normalizeCapabilityPath(long);
  assert.equal(normalized.length, CAPABILITY_PATH_MAX);
  assert.deepEqual(normalized, long.slice(0, CAPABILITY_PATH_MAX));

  const event = createSafetyEvent({
    eventId: 'ev-path',
    runId: 'run-path',
    phase: 'PLAN',
    severity: 'SEV2',
    reasonCode: 'ACTION_GATE_BLOCK',
    capabilityPath: long,
    subject: { entityType: 'executor', entityId: 'exec-path' }
  });
  assert.equal(event.capabilityPath.length, CAPABILITY_PATH_MAX);

  const incident = createIncident({
    incidentId: 'inc-path',
    events: [event],
    capabilityPath: ['extra.a', 'extra.b', ...long]
  });
  assert.ok(incident.capabilityPath.length <= CAPABILITY_PATH_MAX);
  assert.equal(incident.causalTrace.length, 1);
  assert.equal(incident.causalTrace[0].eventId, 'ev-path');
});

test('T-s2-env DDA_SAFETY_INCIDENT=0 disables', () => {
  assert.equal(isSafetyIncidentEnabled({}), true);
  assert.equal(isSafetyIncidentEnabled({ DDA_SAFETY_INCIDENT: '1' }), true);
  assert.equal(isSafetyIncidentEnabled({ DDA_SAFETY_INCIDENT: '0' }), false);
});

test('T-s2-create rejects incident severity milder than members', () => {
  const event = sev2Event({ severity: 'SEV1' });
  assert.throws(
    () => createIncident({ incidentId: 'inc-mild', events: [event], severity: 'SEV3' }),
    /INCIDENT_SEVERITY_BELOW_MEMBERS/
  );
});
