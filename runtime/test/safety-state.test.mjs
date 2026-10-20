import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAN_WINDOW_MS,
  MIN_RECOVER_SAMPLES,
  RECOVER_CLEAN_WINDOW_VIOLATED,
  RECOVER_EVIDENCE_REQUIRED,
  RECOVER_QUARANTINE_NEEDS_REVIEWER,
  RECOVER_SAMPLES_INSUFFICIENT,
  SAFETY_STATE_DENY,
  SAFETY_STATE_REQUIRE_APPROVAL,
  applyIncidentToSafetyState,
  applySafetyStateGate,
  createSafetyStateRecord,
  createSafetyStateStore,
  getState,
  isSafetyStateEnabled,
  safetyStateGateHint,
  safetyStateKey,
  transitionRecover,
  transitionTighten
} from '../src/safety-state.mjs';
import {
  createIncident,
  createSafetyEvent
} from '../src/safety-incident.mjs';

const NOW = 1_700_000_000_000;

const makeStore = () => createSafetyStateStore();

const makeEvent = (overrides = {}) => createSafetyEvent({
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

test('T-s3-1 SEV2 Incident → state at least CONFIRM', async () => {
  const store = makeStore();
  const event = makeEvent({ severity: 'SEV2' });
  const incident = createIncident({ incidentId: 'inc-sev2', events: [event] });
  const result = await applyIncidentToSafetyState({
    incident,
    events: [event],
    stateStore: store,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.record.state, 'CONFIRM');
  assert.equal(result.record.rank, 2);
  assert.ok(result.transition);
  assert.equal(result.transition.from, 'ALLOW');
  assert.equal(result.transition.to, 'CONFIRM');
  assert.equal(result.transition.policyVersion, 'safety-state-r1');
  assert.equal(result.transition.evidenceRef, 'inc-sev2');
  assert.equal(result.transition.atMs, NOW);

  const again = await applyIncidentToSafetyState({
    incident,
    events: [event],
    stateStore: store,
    now: NOW + 1
  });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.code, 'IDEMPOTENT');
  assert.equal(again.record.state, 'CONFIRM');
});

test('T-s3-2 SEV0 → QUARANTINE', async () => {
  const store = makeStore();
  const event = makeEvent({ severity: 'SEV0', eventId: 'ev-0' });
  const incident = createIncident({ incidentId: 'inc-sev0', events: [event] });
  const result = await applyIncidentToSafetyState({
    incident,
    events: [event],
    stateStore: store,
    now: NOW
  });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.record.state, 'QUARANTINE');
  assert.equal(result.record.rank, 5);
});

test('T-s3-3 empty / missing events → state unchanged', async () => {
  const store = makeStore();
  const key = { entityId: 'exec-empty' };
  await store.putRecord(createSafetyStateRecord({ ...key, state: 'ALLOW', atMs: NOW }));

  const empty = await applyIncidentToSafetyState({
    incident: {
      incidentId: 'inc-empty',
      severity: 'SEV2',
      eventIds: [],
      profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId: 'exec-empty' }]
    },
    events: [],
    stateStore: store,
    entityId: 'exec-empty',
    now: NOW
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.changed, false);

  const missing = await applyIncidentToSafetyState({
    incident: {
      incidentId: 'inc-missing',
      severity: 'SEV1',
      eventIds: ['ev-missing'],
      profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId: 'exec-empty' }]
    },
    events: [],
    stateStore: store,
    entityId: 'exec-empty',
    now: NOW
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.changed, false);

  const sev3Event = makeEvent({ severity: 'SEV3', eventId: 'ev-3', subject: { entityType: 'executor', entityId: 'exec-empty' } });
  const sev3 = createIncident({ incidentId: 'inc-sev3', events: [sev3Event] });
  const sev3Result = await applyIncidentToSafetyState({
    incident: sev3,
    events: [sev3Event],
    stateStore: store,
    entityId: 'exec-empty',
    now: NOW
  });
  assert.equal(sev3Result.ok, true);
  assert.equal(sev3Result.changed, false);

  const record = getState(store, key);
  assert.equal(record.state, 'ALLOW');
});

test('T-s3-4 CONFIRM→ALLOW one-shot recover rejected; two steps to ALLOW', async () => {
  const store = makeStore();
  const key = { entityId: 'exec-hyst', capabilityId: 'shell.execute' };
  await transitionTighten({
    stateStore: store,
    key,
    to: 'CONFIRM',
    reasonCode: 'TEST_SEED',
    evidenceRef: 'seed',
    now: NOW - CLEAN_WINDOW_MS - 1
  });
  // Mark last incident outside clean window so recover is allowed by time.
  const seeded = getState(store, key);
  seeded.lastIncidentAtMs = NOW - CLEAN_WINDOW_MS - 1;
  seeded.successCount = MIN_RECOVER_SAMPLES;
  await store.putRecord(seeded);

  const jump = await transitionRecover({
    stateStore: store,
    key,
    evidence: {
      outcome: 'SUCCEEDED',
      outcomeId: 'out-1',
      runId: 'run-hyst',
      successCount: MIN_RECOVER_SAMPLES
    },
    now: NOW
  });
  assert.equal(jump.ok, true);
  assert.equal(jump.record.state, 'MONITOR', 'one recover step only: CONFIRM→MONITOR');

  const jump2 = await transitionRecover({
    stateStore: store,
    key,
    evidence: {
      outcome: 'SUCCEEDED',
      outcomeId: 'out-2',
      runId: 'run-hyst',
      successCount: MIN_RECOVER_SAMPLES
    },
    now: NOW + 1
  });
  assert.equal(jump2.ok, true);
  assert.equal(jump2.record.state, 'ALLOW');
});

test('T-s3-5 QUARANTINE without reviewer.approved fails; with approved → DENY only', async () => {
  const store = makeStore();
  const key = { entityId: 'exec-q' };
  await transitionTighten({
    stateStore: store,
    key,
    to: 'QUARANTINE',
    reasonCode: 'TEST_SEED',
    evidenceRef: 'seed-q',
    now: NOW - CLEAN_WINDOW_MS - 1
  });
  const seeded = getState(store, key);
  seeded.lastIncidentAtMs = NOW - CLEAN_WINDOW_MS - 1;
  seeded.successCount = 99;
  await store.putRecord(seeded);

  const denied = await transitionRecover({
    stateStore: store,
    key,
    evidence: { outcome: 'SUCCEEDED', outcomeId: 'out-q', runId: 'run-q', successCount: 99 },
    now: NOW
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, RECOVER_QUARANTINE_NEEDS_REVIEWER);
  assert.equal(getState(store, key).state, 'QUARANTINE');

  const approved = await transitionRecover({
    stateStore: store,
    key,
    evidence: { outcome: 'SUCCEEDED', outcomeId: 'out-q2', runId: 'run-q', successCount: 99 },
    reviewer: { approved: true, reviewId: 'rev-1' },
    now: NOW + 1
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.record.state, 'DENY');
  assert.equal(approved.transition.from, 'QUARANTINE');
  assert.equal(approved.transition.to, 'DENY');
});

test('T-s3-6 cleanWindow / minSamples insufficient → no recover', async () => {
  const store = makeStore();
  const key = { entityId: 'exec-win' };
  await transitionTighten({
    stateStore: store,
    key,
    to: 'CONFIRM',
    reasonCode: 'TEST_SEED',
    evidenceRef: 'seed-w',
    now: NOW - 1000
  });
  const seeded = getState(store, key);
  seeded.lastIncidentAtMs = NOW - 1000; // inside 24h window
  seeded.successCount = 1;
  await store.putRecord(seeded);

  const samples = await transitionRecover({
    stateStore: store,
    key,
    evidence: {
      outcome: 'SUCCEEDED',
      outcomeId: 'out-w1',
      runId: 'run-w',
      successCount: 1
    },
    now: NOW
  });
  assert.equal(samples.ok, false);
  assert.equal(samples.code, RECOVER_SAMPLES_INSUFFICIENT);

  seeded.successCount = MIN_RECOVER_SAMPLES;
  await store.putRecord(seeded);
  const window = await transitionRecover({
    stateStore: store,
    key,
    evidence: {
      outcome: 'SUCCEEDED',
      outcomeId: 'out-w2',
      runId: 'run-w',
      successCount: MIN_RECOVER_SAMPLES
    },
    now: NOW
  });
  assert.equal(window.ok, false);
  assert.equal(window.code, RECOVER_CLEAN_WINDOW_VIOLATED);

  const noEvidence = await transitionRecover({
    stateStore: store,
    key,
    evidence: { outcome: 'FAILED', outcomeId: 'out-bad' },
    now: NOW + CLEAN_WINDOW_MS
  });
  assert.equal(noEvidence.ok, false);
  assert.equal(noEvidence.code, RECOVER_EVIDENCE_REQUIRED);

  assert.equal(getState(store, key).state, 'CONFIRM');
});

test('T-s3-7 gate hint: CONFIRM→REQUIRE_APPROVAL; QUARANTINE→BLOCK; never soften BLOCK', () => {
  assert.equal(safetyStateGateHint('ALLOW'), 'NONE');
  assert.equal(safetyStateGateHint('MONITOR'), 'NONE');
  assert.equal(safetyStateGateHint('CONFIRM'), 'REQUIRE_APPROVAL');
  assert.equal(safetyStateGateHint('SANDBOX'), 'REQUIRE_APPROVAL');
  assert.equal(safetyStateGateHint('DENY'), 'DENY');
  assert.equal(safetyStateGateHint('QUARANTINE'), 'DENY');

  const confirm = applySafetyStateGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'CONFIRM' }
  });
  assert.equal(confirm.elevated, true);
  assert.equal(confirm.decision, 'REQUIRE_APPROVAL');
  assert.equal(confirm.reasonCode, SAFETY_STATE_REQUIRE_APPROVAL);

  const quarantine = applySafetyStateGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'QUARANTINE' }
  });
  assert.equal(quarantine.elevated, true);
  assert.equal(quarantine.decision, 'BLOCK');
  assert.equal(quarantine.reasonCode, SAFETY_STATE_DENY);

  const hardBlock = applySafetyStateGate({
    gateDecision: { decision: 'BLOCK', reasonCode: 'HARD_DENY' },
    stateRecord: { state: 'ALLOW' }
  });
  assert.equal(hardBlock.elevated, false);
  assert.equal(hardBlock.decision, 'BLOCK');
  assert.equal(hardBlock.reasonCode, 'HARD_DENY');

  const alreadyReq = applySafetyStateGate({
    gateDecision: { decision: 'REQUIRE_APPROVAL', reasonCode: 'SAFETY_PROFILE_REQUIRE_APPROVAL' },
    stateRecord: { state: 'CONFIRM' }
  });
  assert.equal(alreadyReq.elevated, false);
  assert.equal(alreadyReq.decision, 'REQUIRE_APPROVAL');

  assert.equal(isSafetyStateEnabled({}), true);
  assert.equal(isSafetyStateEnabled({ DDA_SAFETY_STATE: '0' }), false);
  assert.equal(isSafetyStateEnabled({ DDA_SAFETY_STATE: '1' }), true);

  const disabled = applySafetyStateGate({
    gateDecision: { decision: 'ALLOW' },
    stateRecord: { state: 'QUARANTINE' },
    enabled: false
  });
  assert.equal(disabled.elevated, false);
  assert.equal(disabled.decision, 'ALLOW');

  assert.equal(
    safetyStateKey({ entityId: 'e1', capabilityId: 'shell.execute', taskClass: 'code' }),
    'executor:e1|cap:shell.execute|tc:code'
  );
  assert.equal(
    safetyStateKey({ entityId: 'e1' }),
    'executor:e1|cap:*|tc:*'
  );
});

test('T-s3-extra SEV1 → SANDBOX and raise-only semantics', async () => {
  const store = makeStore();
  const event = makeEvent({ severity: 'SEV1', eventId: 'ev-sev1' });
  const incident = createIncident({ incidentId: 'inc-sev1', events: [event] });
  const result = await applyIncidentToSafetyState({
    incident,
    events: [event],
    stateStore: store,
    now: NOW
  });
  assert.equal(result.record.state, 'SANDBOX');

  // Milder SEV2 must not lower SANDBOX.
  const milder = makeEvent({ severity: 'SEV2', eventId: 'ev-mild' });
  const mildInc = createIncident({ incidentId: 'inc-mild', events: [milder] });
  const mildResult = await applyIncidentToSafetyState({
    incident: mildInc,
    events: [milder],
    stateStore: store,
    now: NOW + 1
  });
  assert.equal(mildResult.changed, false);
  assert.equal(mildResult.record.state, 'SANDBOX');
});
