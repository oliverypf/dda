import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRUST_X_REQUIRE_APPROVAL,
  TRUST_X_DENY,
  TRUST_X_LIMIT,
  applyTrustXGate,
  combineRiskR,
  isTrustXEnabled,
  mapEvidenceToE,
  mapStateToR,
  meetsEvidenceMin,
  resolveTrustX,
  resolveTrustXEMin
} from '../src/trust-x.mjs';
import {
  createSafetyStateRecord,
  createSafetyStateStore
} from '../src/safety-state.mjs';

const allowGate = { decision: 'ALLOW', reasonCode: 'JEV_ACTION_GATE_ALLOW' };
const blockGate = { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' };
const requireGate = { decision: 'REQUIRE_APPROVAL', reasonCode: 'JEV_ACTION_GATE_REQUIRE_APPROVAL' };

const ACTOR = 'exec-trust-1';
const CAP = 'shell.execute';
const TC = 'coding';

function makeProfileRegistry(profiles = []) {
  const map = new Map();
  for (const p of profiles) {
    const key = ['SAFETY', 'executor', p.entityId, p.capabilityId ?? '-'].join(':');
    map.set(key, p);
  }
  return {
    getProfile({ kind, entityType, entityId, capabilityId } = {}) {
      const key = [kind, entityType, entityId, capabilityId ?? '-'].join(':');
      return map.get(key);
    }
  };
}

async function seedState(store, { entityId, capabilityId, taskClass, state, successCount = 0, lastIncidentSeverity = null }) {
  const record = createSafetyStateRecord({
    entityId,
    capabilityId,
    taskClass,
    state,
    successCount,
    lastIncidentSeverity,
    atMs: 1_700_000_000_000
  });
  await store.putRecord(record);
  return record;
}

test('helpers: mapStateToR / mapEvidenceToE / meetsEvidenceMin / E_min env', () => {
  assert.equal(mapStateToR('CONFIRM'), 0.4);
  assert.equal(mapStateToR('QUARANTINE'), 1.0);
  assert.equal(mapStateToR(undefined), 0.0);
  assert.equal(mapEvidenceToE({ evidenceCount: 3 }), 0.3);
  assert.equal(mapEvidenceToE({ evidenceCount: 10 }), 1.0);
  assert.equal(meetsEvidenceMin({ evidenceCount: 3, E: 0.3 }), true);
  assert.equal(meetsEvidenceMin({ evidenceCount: 2, E: 0.2 }), false);
  assert.equal(meetsEvidenceMin({ evidenceCount: 0, E: 0.5, eMin: 0.3 }), true);
  assert.equal(resolveTrustXEMin({ env: { DDA_TRUST_X_E_MIN: '0.5' } }), 0.5);
  assert.equal(combineRiskR({ state: 'MONITOR', lastIncidentSeverity: 'SEV1' }), 0.6);
  assert.equal(isTrustXEnabled({}), true);
  assert.equal(isTrustXEnabled({ DDA_TRUST_X: '0' }), false);
});

test('T-trust-1 fine key no evidence, coarse CONFIRM → fallback ≥1, ALLOW→REQUIRE_APPROVAL', async () => {
  const store = createSafetyStateStore();
  // Actor-level State CONFIRM (cap:* tc:*) — coarse hit.
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'CONFIRM',
    successCount: 0
  });
  // Subject SAFETY profile with enough evidence (actor-level, no capabilityId).
  const registry = makeProfileRegistry([
    {
      profileId: 'profile-safety-actor',
      kind: 'SAFETY',
      entityType: 'executor',
      entityId: ACTOR,
      evidenceCount: 5,
      eligibility: { status: 'CONSERVATIVE', eligible: false, reasonCodes: [] }
    }
  ]);

  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    taskClass: TC,
    stateStore: store,
    profileRegistry: registry
  });
  assert.ok(trust.fallbackLevel >= 1, `expected fallback≥1, got ${trust.fallbackLevel}`);
  assert.equal(trust.empty, false);
  assert.equal(trust.R, 0.4);
  assert.ok(trust.E >= 0.3);

  const out = applyTrustXGate({
    gateDecision: allowGate,
    trust,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, TRUST_X_REQUIRE_APPROVAL);
  assert.equal(out.elevated, true);
  assert.equal(out.trust.fallbackLevel, trust.fallbackLevel);
});

test('T-trust-2 hit-layer exclusive: fine low R + enough E is NOT polluted by coarse high R', async () => {
  const store = createSafetyStateStore();
  // Fine key: ALLOW + enough samples via successCount.
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: CAP,
    taskClass: TC,
    state: 'ALLOW',
    successCount: 5
  });
  // Coarse A-level: QUARANTINE (would BLOCK if we wrongly max'd across layers).
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'QUARANTINE',
    successCount: 10
  });

  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    taskClass: TC,
    stateStore: store,
    profileRegistry: makeProfileRegistry([])
  });
  // Must stop at fine layer (level 0) with R from ALLOW only.
  assert.equal(trust.fallbackLevel, 0);
  assert.equal(trust.R, 0.0);
  assert.ok(trust.E >= 0.3);

  const out = applyTrustXGate({
    gateDecision: allowGate,
    trust,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.notEqual(out.reasonCode, TRUST_X_DENY);
});

test('T-trust-3 QUARANTINE/DENY residual → BLOCK + TRUST_X_DENY', async () => {
  for (const state of ['QUARANTINE', 'DENY']) {
    const store = createSafetyStateStore();
    await seedState(store, {
      entityId: ACTOR,
      capabilityId: '*',
      taskClass: '*',
      state,
      successCount: 4
    });
    const trust = resolveTrustX({
      actor: ACTOR,
      capabilityId: CAP,
      stateStore: store,
      profileRegistry: makeProfileRegistry([])
    });
    assert.ok(trust.R >= 0.8, `${state} R=${trust.R}`);
    const out = applyTrustXGate({ gateDecision: allowGate, trust, toolReadOnly: false });
    assert.equal(out.decision, 'BLOCK');
    assert.equal(out.reasonCode, TRUST_X_DENY);
    assert.equal(out.elevated, true);
  }
});

test('T-trust-4 hard BLOCK unchanged', async () => {
  const store = createSafetyStateStore();
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'QUARANTINE',
    successCount: 5
  });
  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    stateStore: store
  });
  const out = applyTrustXGate({
    gateDecision: blockGate,
    trust,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.reasonCode, 'HARD_BLOCK');
  assert.equal(out.elevated, false);
  assert.equal(out.preservedBlock, true);
});

test('T-trust-5 high E + low R cannot demote REQUIRE_APPROVAL', async () => {
  const store = createSafetyStateStore();
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: CAP,
    taskClass: '*',
    state: 'ALLOW',
    successCount: 20
  });
  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    stateStore: store
  });
  assert.ok(trust.E >= 0.3);
  assert.ok(trust.R < 0.1);
  const out = applyTrustXGate({
    gateDecision: requireGate,
    trust,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, 'JEV_ACTION_GATE_REQUIRE_APPROVAL');
  assert.equal(out.elevated, false);
});

test('T-trust-6 DDA_TRUST_X=0 disables (enabled:false leaves baseline)', async () => {
  const store = createSafetyStateStore();
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'CONFIRM',
    successCount: 5
  });
  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    stateStore: store
  });
  assert.equal(trust.R, 0.4);
  const out = applyTrustXGate({
    gateDecision: allowGate,
    trust,
    enabled: false,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.reasonCode, 'JEV_ACTION_GATE_ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.disabled, true);
  assert.equal(isTrustXEnabled({ DDA_TRUST_X: '0' }), false);
});

test('T-trust-extra MONITOR band → ALLOW + LIMIT control + TRUST_X_LIMIT', async () => {
  const store = createSafetyStateStore();
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'MONITOR',
    successCount: 4
  });
  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    stateStore: store
  });
  assert.equal(trust.R, 0.1);
  const out = applyTrustXGate({ gateDecision: allowGate, trust, toolReadOnly: false });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.reasonCode, TRUST_X_LIMIT);
  assert.deepEqual(out.requiredControls, ['LIMIT']);
  assert.equal(out.elevated, false);
});

test('T-trust-extra readOnly ALLOW not elevated', async () => {
  const store = createSafetyStateStore();
  await seedState(store, {
    entityId: ACTOR,
    capabilityId: '*',
    taskClass: '*',
    state: 'CONFIRM',
    successCount: 5
  });
  const trust = resolveTrustX({ actor: ACTOR, capabilityId: CAP, stateStore: store });
  const out = applyTrustXGate({
    gateDecision: allowGate,
    trust,
    toolReadOnly: true
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
});

test('T-trust-extra empty reputation leaves ALLOW', () => {
  const trust = resolveTrustX({
    actor: ACTOR,
    capabilityId: CAP,
    stateStore: createSafetyStateStore(),
    profileRegistry: makeProfileRegistry([])
  });
  assert.equal(trust.empty, true);
  assert.equal(trust.fallbackLevel, 4);
  const out = applyTrustXGate({ gateDecision: allowGate, trust, toolReadOnly: false });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
});
