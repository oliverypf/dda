import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY_ACTIVATION_BLOCKED,
  POLICY_CONTROL_KILLED,
  POLICY_ILLEGAL_TRANSITION,
  POLICY_PROPOSE_REJECTED,
  activatePolicy,
  assertPolicyTransition,
  createSafetyPolicyControlStore,
  createSafetyPolicyStore,
  effectiveStateFloor,
  isSafetyPolicyEnabled,
  proposePolicyFromIncident,
  raiseStateRecordToPolicyFloor,
  restrictPolicy,
  retirePolicy,
  storeProposedPolicy
} from '../src/safety-policy.mjs';
import {
  applySafetySpectrumGate
} from '../src/safety-spectrum-gate.mjs';
import {
  createIncident,
  createSafetyEvent
} from '../src/safety-incident.mjs';

const makeAttributed = ({ severity = 'SEV2', incidentId = 'inc-1', entityId = 'executor-a' } = {}) => {
  const event = createSafetyEvent({
    eventId: `ev-${incidentId}`,
    runId: 'run-1',
    phase: 'EXECUTE',
    severity,
    reasonCode: 'ACTION_GATE_BLOCK',
    capabilityPath: ['shell.exec'],
    subject: { entityType: 'executor', entityId }
  });
  const incident = {
    ...createIncident({
      incidentId,
      events: [event],
      profileTargets: [{ kind: 'SAFETY', entityType: 'executor', entityId }]
    }),
    status: 'ATTRIBUTED'
  };
  return { incident, events: [event] };
};

test('T-s5-1 SEV2 Incident → Candidate floor=CONFIRM; not enabled → no gate effect', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV2' });
  const proposed = proposePolicyFromIncident({ incident, events });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.policy.status, 'CANDIDATE');
  assert.equal(proposed.policy.effect.stateFloor, 'CONFIRM');
  assert.equal(proposed.policy.control.enabled, false);
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });

  // Candidate must not raise floor.
  const floor = effectiveStateFloor({
    match: { entityId: 'executor-a', capabilityId: 'shell.exec' },
    policyStore: store
  });
  assert.equal(floor, null);

  const raised = raiseStateRecordToPolicyFloor({ state: 'ALLOW', rank: 0 }, floor);
  assert.equal(raised.state, 'ALLOW');

  const spectrum = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: raised
  });
  assert.equal(spectrum.decision, 'ALLOW');
  assert.equal(spectrum.softOutcome, 'NONE');
});

test('T-s5-2 no verified evaluation → cannot Active', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV2', incidentId: 'inc-nv' });
  const proposed = proposePolicyFromIncident({ incident, events });
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });

  const result = await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: false },
    enable: true
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, POLICY_ACTIVATION_BLOCKED);
  assert.equal(result.detail, 'NOT_VERIFIED');
  assert.equal(store.getPolicy(proposed.policy.policyId).status, 'CANDIDATE');
});

test('T-s5-3 control killed / enabled=false → cannot Active', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const control = createSafetyPolicyControlStore();
  await control.load();
  const { incident, events } = makeAttributed({ severity: 'SEV1', incidentId: 'inc-kill' });
  const proposed = proposePolicyFromIncident({ incident, events });
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });

  // enabled=false (default) blocks even when verified.
  const blocked = await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: false,
    controlStore: control
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, POLICY_ACTIVATION_BLOCKED);
  assert.equal(blocked.detail, 'NOT_ENABLED');

  await control.kill({ reason: 'drill' });
  await assert.rejects(
    () => activatePolicy({
      policyId: proposed.policy.policyId,
      policyStore: store,
      evaluation: { verified: true },
      enable: true,
      controlStore: control
    }),
    (err) => {
      assert.ok(String(err.message).startsWith(POLICY_CONTROL_KILLED));
      return true;
    }
  );
  assert.equal(store.getPolicy(proposed.policy.policyId).status, 'CANDIDATE');
});

test('T-s5-4 verified + enable → Active; match raises spectrum/state to floor', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV2', incidentId: 'inc-act' });
  const proposed = proposePolicyFromIncident({
    incident,
    events,
    match: { entityId: 'executor-a', capabilityId: 'shell.exec', taskClass: '*' }
  });
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });

  const activated = await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true, cohortId: 'cohort-1' },
    enable: true,
    actor: 'test'
  });
  assert.equal(activated.ok, true);
  assert.equal(activated.policy.status, 'ACTIVE');
  assert.equal(activated.policy.control.enabled, true);
  assert.equal(activated.policy.evaluation.verified, true);

  const floor = effectiveStateFloor({
    match: { entityId: 'executor-a', capabilityId: 'shell.exec' },
    policyStore: store
  });
  assert.equal(floor, 'CONFIRM');

  const raised = raiseStateRecordToPolicyFloor({ state: 'ALLOW', rank: 0 }, floor);
  assert.equal(raised.state, 'CONFIRM');
  assert.equal(raised.policyFloorApplied, 'CONFIRM');

  const spectrum = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: raised
  });
  assert.equal(spectrum.decision, 'REQUIRE_APPROVAL');
  assert.equal(spectrum.softOutcome, 'CONFIRM');
  assert.equal(spectrum.elevated, true);

  // Already at/above floor: no further raise.
  const already = raiseStateRecordToPolicyFloor({ state: 'SANDBOX', rank: 3 }, floor);
  assert.equal(already.state, 'SANDBOX');
  assert.equal(already.policyFloorApplied, null);
});

test('T-s5-5 Active→Retired stops raising floor', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV1', incidentId: 'inc-ret' });
  const proposed = proposePolicyFromIncident({ incident, events });
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });
  await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: true
  });
  assert.equal(
    effectiveStateFloor({ match: { entityId: 'executor-a' }, policyStore: store }),
    'SANDBOX'
  );

  const retired = await retirePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store
  });
  assert.equal(retired.ok, true);
  assert.equal(retired.policy.status, 'RETIRED');
  assert.equal(
    effectiveStateFloor({ match: { entityId: 'executor-a' }, policyStore: store }),
    null
  );

  // RETIRED → ACTIVE illegal
  assert.throws(
    () => assertPolicyTransition('RETIRED', 'ACTIVE'),
    (err) => String(err.message).includes(POLICY_ILLEGAL_TRANSITION)
  );
});

test('T-s5-6 SEV3 / empty Incident → no Candidate', () => {
  const sev3 = makeAttributed({ severity: 'SEV3', incidentId: 'inc-sev3' });
  const rejected = proposePolicyFromIncident(sev3);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, POLICY_PROPOSE_REJECTED);
  assert.equal(rejected.detail, 'SEV3_NO_POLICY');

  const empty = proposePolicyFromIncident({
    incident: { incidentId: 'x', status: 'ATTRIBUTED', eventIds: [], severity: 'SEV2' },
    events: []
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, POLICY_PROPOSE_REJECTED);

  const unattributed = proposePolicyFromIncident({
    incident: { ...sev3.incident, status: 'OPEN', severity: 'SEV2' },
    events: sev3.events
  });
  // Force SEV2 on OPEN copy
  const openSev2 = makeAttributed({ severity: 'SEV2', incidentId: 'inc-open' });
  const openReject = proposePolicyFromIncident({
    incident: { ...openSev2.incident, status: 'OPEN' },
    events: openSev2.events
  });
  assert.equal(openReject.ok, false);
  assert.equal(openReject.detail, 'NOT_ATTRIBUTED');

  // No events
  const noEvents = proposePolicyFromIncident({
    incident: openSev2.incident,
    events: undefined
  });
  assert.equal(noEvents.ok, false);
});

test('T-s5-7 hard BLOCK is not demoted to ALLOW by Policy floor', async () => {
  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV0', incidentId: 'inc-block' });
  const proposed = proposePolicyFromIncident({ incident, events });
  assert.equal(proposed.policy.effect.stateFloor, 'DENY');
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });
  await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: true
  });

  const floor = effectiveStateFloor({
    match: { entityId: 'executor-a' },
    policyStore: store
  });
  assert.equal(floor, 'DENY');
  const raised = raiseStateRecordToPolicyFloor({ state: 'ALLOW', rank: 0 }, floor);
  assert.equal(raised.state, 'DENY');

  const preserved = applySafetySpectrumGate({
    gateDecision: { decision: 'BLOCK', reasonCode: 'HARD_DENY' },
    stateRecord: raised
  });
  assert.equal(preserved.decision, 'BLOCK');
  assert.equal(preserved.reasonCode, 'HARD_DENY');
  assert.equal(preserved.preservedBlock, true);
  assert.notEqual(preserved.decision, 'ALLOW');
});

test('T-s5-extra restrict dual-gate; helpers; SEV0/1 floors; kill enable', async () => {
  assert.equal(isSafetyPolicyEnabled({}), true);
  assert.equal(isSafetyPolicyEnabled({ DDA_SAFETY_POLICY: '0' }), false);

  const store = createSafetyPolicyStore();
  await store.load();
  const { incident, events } = makeAttributed({ severity: 'SEV0', incidentId: 'inc-extra' });
  const proposed = proposePolicyFromIncident({ incident, events });
  assert.equal(proposed.policy.effect.stateFloor, 'DENY');
  await storeProposedPolicy({ policyStore: store, proposeResult: proposed });
  await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: true
  });

  const restricted = await restrictPolicy({
    policyId: proposed.policy.policyId,
    policyStore: store
  });
  assert.equal(restricted.ok, true);
  assert.equal(restricted.policy.status, 'RESTRICTED');
  assert.equal(
    effectiveStateFloor({ match: { entityId: 'executor-a' }, policyStore: store }),
    null
  );

  // RESTRICTED → ACTIVE still needs dual gate
  const blocked = await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: false
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, POLICY_ACTIVATION_BLOCKED);

  const reactivated = await activatePolicy({
    policyId: proposed.policy.policyId,
    policyStore: store,
    evaluation: { verified: true },
    enable: true
  });
  assert.equal(reactivated.ok, true);
  assert.equal(reactivated.policy.status, 'ACTIVE');

  // CANDIDATE → RETIRED allowed (discard draft)
  const draft = makeAttributed({ severity: 'SEV2', incidentId: 'inc-draft' });
  const draftProp = proposePolicyFromIncident(draft);
  await storeProposedPolicy({ policyStore: store, proposeResult: draftProp });
  const discarded = await retirePolicy({
    policyId: draftProp.policy.policyId,
    policyStore: store,
    reason: 'DISCARD_DRAFT'
  });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.policy.status, 'RETIRED');

  // Highest of multiple ACTIVE floors
  const sev1 = makeAttributed({ severity: 'SEV1', incidentId: 'inc-hi' });
  const p2 = proposePolicyFromIncident({
    ...sev1,
    policyId: 'pol-hi'
  });
  await storeProposedPolicy({ policyStore: store, proposeResult: p2 });
  await activatePolicy({
    policyId: 'pol-hi',
    policyStore: store,
    evaluation: { verified: true },
    enable: true
  });
  // existing SEV0 DENY still active + SANDBOX → DENY wins
  assert.equal(
    effectiveStateFloor({ match: { entityId: 'executor-a' }, policyStore: store }),
    'DENY'
  );
});
