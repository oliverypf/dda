import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySafetyProfileGate,
  SAFETY_PROFILE_REQUIRE_APPROVAL
} from '../src/safety-profile-gate.mjs';

const allowGate = { decision: 'ALLOW', reasonCode: 'JEV_ACTION_GATE_ALLOW' };
const blockGate = { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' };
const requireGate = { decision: 'REQUIRE_APPROVAL', reasonCode: 'JEV_ACTION_GATE_REQUIRE_APPROVAL' };

const profileWith = (reasonCodes, profileId = 'profile-safety-exec-1') => ({
  profileId,
  eligibility: {
    status: 'CONSERVATIVE',
    eligible: false,
    reasonCodes
  },
  safetyMean: 0.4,
  failureCount: reasonCodes.includes('FAILURE_OBSERVED') ? 1 : 0
});

test('T-s1-1 ALLOW + FAILURE_OBSERVED elevates to REQUIRE_APPROVAL', () => {
  const out = applySafetyProfileGate({
    gateDecision: allowGate,
    safetyProfile: profileWith(['FAILURE_OBSERVED']),
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, SAFETY_PROFILE_REQUIRE_APPROVAL);
  assert.equal(out.elevated, true);
  assert.equal(out.profileId, 'profile-safety-exec-1');
  assert.ok(out.reasonCodes.includes('FAILURE_OBSERVED'));
});

test('T-s1-1b ALLOW + SAFETY_BELOW_THRESHOLD elevates', () => {
  const out = applySafetyProfileGate({
    gateDecision: allowGate,
    safetyProfile: profileWith(['SAFETY_BELOW_THRESHOLD', 'INSUFFICIENT_SAMPLES']),
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, SAFETY_PROFILE_REQUIRE_APPROVAL);
  assert.equal(out.elevated, true);
});

test('T-s1-2 BLOCK stays BLOCK (profile does not rewrite)', () => {
  const out = applySafetyProfileGate({
    gateDecision: blockGate,
    safetyProfile: profileWith(['FAILURE_OBSERVED', 'SAFETY_BELOW_THRESHOLD']),
    toolReadOnly: false
  });
  assert.equal(out.decision, 'BLOCK');
  assert.equal(out.reasonCode, 'HARD_BLOCK');
  assert.equal(out.elevated, false);
});

test('T-s1-3 ALLOW + only INSUFFICIENT_SAMPLES stays ALLOW', () => {
  const out = applySafetyProfileGate({
    gateDecision: allowGate,
    safetyProfile: profileWith(['INSUFFICIENT_SAMPLES']),
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.reasonCode, 'JEV_ACTION_GATE_ALLOW');
  assert.equal(out.elevated, false);
});

test('T-s1-3b ALLOW + only QUALITY_BELOW_THRESHOLD / CONSERVATIVE codes stays ALLOW', () => {
  for (const codes of [['QUALITY_BELOW_THRESHOLD'], ['QUALITY_BELOW_THRESHOLD', 'INSUFFICIENT_SAMPLES']]) {
    const out = applySafetyProfileGate({
      gateDecision: allowGate,
      safetyProfile: profileWith(codes),
      toolReadOnly: false
    });
    assert.equal(out.decision, 'ALLOW');
    assert.equal(out.elevated, false);
  }
});

test('T-s1-4 readOnly ALLOW is not elevated', () => {
  const out = applySafetyProfileGate({
    gateDecision: allowGate,
    safetyProfile: profileWith(['FAILURE_OBSERVED']),
    toolReadOnly: true
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
});

test('T-s1-5 high eligibility cannot demote REQUIRE_APPROVAL to ALLOW', () => {
  const high = {
    profileId: 'profile-safety-high',
    eligibility: {
      status: 'ELIGIBLE_FOR_ROUTING',
      eligible: true,
      reasonCodes: []
    },
    safetyMean: 0.99,
    failureCount: 0
  };
  const out = applySafetyProfileGate({
    gateDecision: requireGate,
    safetyProfile: high,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'REQUIRE_APPROVAL');
  assert.equal(out.reasonCode, 'JEV_ACTION_GATE_REQUIRE_APPROVAL');
  assert.equal(out.elevated, false);
});

test('T-s1-5b missing profile leaves gate unchanged', () => {
  const out = applySafetyProfileGate({
    gateDecision: allowGate,
    safetyProfile: undefined,
    toolReadOnly: false
  });
  assert.equal(out.decision, 'ALLOW');
  assert.equal(out.elevated, false);
  assert.equal(out.profileId, undefined);
  assert.deepEqual(out.reasonCodes, []);
});
