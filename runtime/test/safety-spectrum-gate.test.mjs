import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAFETY_STATE_LIMIT,
  SAFETY_STATE_QUARANTINE,
  SAFETY_STATE_SANDBOX_UNAVAILABLE,
  applySafetySpectrumGate,
  isKernelSandboxAvailable,
  isSafetySpectrumEnabled,
  spectrumSoftOutcome
} from '../src/safety-spectrum-gate.mjs';
import {
  SAFETY_STATE_DENY,
  SAFETY_STATE_REQUIRE_APPROVAL
} from '../src/safety-state.mjs';
import { ACTION_GATE_DECISIONS } from '../src/decision/types.mjs';

test('T-s4-1 MONITOR + ALLOW → still ALLOW, softOutcome=LIMIT, controls contain LIMIT', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'MONITOR' }
  });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.softOutcome, 'LIMIT');
  assert.ok(result.requiredControls.includes('LIMIT'));
  assert.equal(result.reasonCode, SAFETY_STATE_LIMIT);
  assert.equal(result.elevated, true);
  assert.equal(spectrumSoftOutcome('MONITOR'), 'LIMIT');
  // LIMIT must not appear in Jev enum.
  assert.equal(ACTION_GATE_DECISIONS.includes('LIMIT'), false);
});

test('T-s4-2 SANDBOX + sandboxAvailable=true → REQUIRE_APPROVAL + SANDBOX control', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'SANDBOX' },
    sandboxAvailable: true
  });
  assert.equal(result.decision, 'REQUIRE_APPROVAL');
  assert.equal(result.softOutcome, 'SANDBOX');
  assert.ok(result.requiredControls.includes('SANDBOX'));
  assert.equal(result.reasonCode, SAFETY_STATE_REQUIRE_APPROVAL);
  assert.equal(result.elevated, true);
});

test('T-s4-3 SANDBOX + sandboxAvailable=false → REQUIRE_APPROVAL, SANDBOX_UNAVAILABLE, no fake SANDBOX control', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'SANDBOX' },
    sandboxAvailable: false
  });
  assert.equal(result.decision, 'REQUIRE_APPROVAL');
  assert.equal(result.softOutcome, 'SANDBOX');
  assert.equal(result.reasonCode, SAFETY_STATE_SANDBOX_UNAVAILABLE);
  assert.equal(result.requiredControls.includes('SANDBOX'), false);
  assert.deepEqual(result.requiredControls, []);
  assert.equal(result.elevated, true);
});

test('T-s4-4 QUARANTINE → BLOCK + SAFETY_STATE_QUARANTINE (≠ DENY)', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'QUARANTINE' }
  });
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.softOutcome, 'QUARANTINE');
  assert.equal(result.reasonCode, SAFETY_STATE_QUARANTINE);
  assert.notEqual(result.reasonCode, SAFETY_STATE_DENY);
  assert.equal(result.elevated, true);
});

test('T-s4-5 DENY → BLOCK + SAFETY_STATE_DENY', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'DENY' }
  });
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.softOutcome, 'DENY');
  assert.equal(result.reasonCode, SAFETY_STATE_DENY);
  assert.notEqual(result.reasonCode, SAFETY_STATE_QUARANTINE);
  assert.equal(result.elevated, true);
});

test('T-s4-6 existing BLOCK → decision unchanged', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'BLOCK', reasonCode: 'HARD_DENY' },
    stateRecord: { state: 'QUARANTINE' }
  });
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'HARD_DENY');
  assert.equal(result.elevated, false);
  assert.equal(result.preservedBlock, true);
  // Soft outcome may still reflect state for telemetry.
  assert.equal(result.softOutcome, 'QUARANTINE');
});

test('T-s4-7 REQUIRE_APPROVAL is not demoted to ALLOW by LIMIT/MONITOR', () => {
  const result = applySafetySpectrumGate({
    gateDecision: { decision: 'REQUIRE_APPROVAL', reasonCode: 'SAFETY_PROFILE_REQUIRE_APPROVAL' },
    stateRecord: { state: 'MONITOR' }
  });
  assert.equal(result.decision, 'REQUIRE_APPROVAL');
  assert.notEqual(result.decision, 'ALLOW');
  assert.equal(result.elevated, false);
  // Soft outcome may report LIMIT intent, but decision stays REQUIRE_APPROVAL.
  assert.equal(result.softOutcome, 'LIMIT');
  assert.equal(result.requiredControls.includes('LIMIT'), false);
});

test('T-s4-extra spectrum off falls back to S3; helpers; CONFIRM path', () => {
  assert.equal(isSafetySpectrumEnabled({}), true);
  assert.equal(isSafetySpectrumEnabled({ DDA_SAFETY_SPECTRUM: '0' }), false);
  assert.equal(isSafetySpectrumEnabled({ DDA_SAFETY_SPECTRUM: '1' }), true);

  assert.equal(isKernelSandboxAvailable({}), false);
  assert.equal(isKernelSandboxAvailable({ DDA_KERNEL_SANDBOX: '1' }), true);
  assert.equal(isKernelSandboxAvailable({ DDA_KERNEL_SANDBOX: '0' }), false);

  const disabled = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'QUARANTINE' },
    enabled: false
  });
  // S3 fallback: QUARANTINE → BLOCK with SAFETY_STATE_DENY (not QUARANTINE split).
  assert.equal(disabled.decision, 'BLOCK');
  assert.equal(disabled.reasonCode, SAFETY_STATE_DENY);
  assert.equal(disabled.softOutcome, 'NONE');
  assert.deepEqual(disabled.requiredControls, []);
  assert.equal(disabled.spectrumDisabled, true);

  const confirm = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW' },
    stateRecord: { state: 'CONFIRM' }
  });
  assert.equal(confirm.decision, 'REQUIRE_APPROVAL');
  assert.equal(confirm.reasonCode, SAFETY_STATE_REQUIRE_APPROVAL);
  assert.equal(confirm.softOutcome, 'CONFIRM');

  const allow = applySafetySpectrumGate({
    gateDecision: { decision: 'ALLOW', reasonCode: 'OK' },
    stateRecord: { state: 'ALLOW' }
  });
  assert.equal(allow.decision, 'ALLOW');
  assert.equal(allow.softOutcome, 'NONE');
  assert.equal(allow.elevated, false);

  // Enum unchanged.
  assert.deepEqual([...ACTION_GATE_DECISIONS], [
    'ALLOW',
    'BLOCK',
    'REQUIRE_APPROVAL',
    'REQUEST_EVIDENCE'
  ]);
});
