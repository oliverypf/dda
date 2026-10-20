// S4: Realtime spectrum LIMIT / SANDBOX·QUARANTINE soft layer on top of S3 State.
// Does NOT expand ACTION_GATE_DECISIONS. Never auto-spawns bwrap.
// DDA_SAFETY_SPECTRUM=0 → fall back to S3 applySafetyStateGate.

import { isKernelSandboxEnabled } from './kernel/sandbox.mjs';
import {
  applySafetyStateGate,
  SAFETY_STATE_DENY,
  SAFETY_STATE_REQUIRE_APPROVAL
} from './safety-state.mjs';

export const SAFETY_STATE_LIMIT = 'SAFETY_STATE_LIMIT';
export const SAFETY_STATE_SANDBOX_UNAVAILABLE = 'SAFETY_STATE_SANDBOX_UNAVAILABLE';
export const SAFETY_STATE_QUARANTINE = 'SAFETY_STATE_QUARANTINE';

export const SPECTRUM_SOFT_OUTCOMES = Object.freeze([
  'NONE',
  'LIMIT',
  'CONFIRM',
  'SANDBOX',
  'DENY',
  'QUARANTINE'
]);

/**
 * Thin helper: env flag alone. Index must AND with an existing sandbox probe
 * (e.g. cellsAvailability.sandbox) before claiming SANDBOX control is real.
 */
export function isKernelSandboxAvailable(env = process.env) {
  return isKernelSandboxEnabled(env);
}

export function isSafetySpectrumEnabled(env = process.env) {
  return env?.DDA_SAFETY_SPECTRUM !== '0';
}

/**
 * Map State → softOutcome (spectrum layer). Independent of gate decision.
 */
export function spectrumSoftOutcome(stateOrRecord) {
  const state = typeof stateOrRecord === 'string'
    ? stateOrRecord
    : stateOrRecord?.state;
  switch (state) {
    case 'MONITOR': return 'LIMIT';
    case 'CONFIRM': return 'CONFIRM';
    case 'SANDBOX': return 'SANDBOX';
    case 'DENY': return 'DENY';
    case 'QUARANTINE': return 'QUARANTINE';
    case 'ALLOW':
    default:
      return 'NONE';
  }
}

/**
 * Apply spectrum soft layer onto an already-S1 (and optionally S3-ready) gate decision.
 * Elevate only; never softens BLOCK / REQUIRE_APPROVAL → ALLOW/LIMIT.
 * Never invents new ACTION_GATE_DECISIONS values (LIMIT is softOutcome only).
 *
 * @returns {{
 *   decision: string | undefined,
 *   reasonCode: string | undefined,
 *   softOutcome: string,
 *   requiredControls: string[],
 *   elevated: boolean,
 *   state: string | undefined,
 *   hint?: string,
 *   preservedBlock?: boolean,
 *   spectrumDisabled?: boolean
 * }}
 */
export function applySafetySpectrumGate({
  gateDecision = {},
  stateRecord,
  sandboxAvailable = false,
  enabled = true
} = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const state = stateRecord?.state;
  const softOutcome = spectrumSoftOutcome(stateRecord ?? state);

  // Spectrum off → S3 gate behavior (no LIMIT / QUARANTINE-split / SANDBOX control).
  if (enabled === false) {
    const s3 = applySafetyStateGate({
      gateDecision,
      stateRecord,
      enabled: true
    });
    return {
      decision: s3.decision,
      reasonCode: s3.reasonCode,
      softOutcome: 'NONE',
      requiredControls: [],
      elevated: s3.elevated === true,
      state: s3.state,
      hint: s3.hint,
      spectrumDisabled: true,
      ...(s3.preservedBlock ? { preservedBlock: true } : {})
    };
  }

  const base = {
    decision,
    reasonCode,
    softOutcome,
    requiredControls: [],
    elevated: false,
    state
  };

  // Hard BLOCK: never rewrite decision; attach spectrumOutcome telemetry only.
  if (decision === 'BLOCK') {
    return {
      ...base,
      softOutcome,
      elevated: false,
      preservedBlock: true
    };
  }

  // ALLOW / MONITOR → soft LIMIT. Keep ALLOW; never demote a stricter decision.
  if (softOutcome === 'LIMIT') {
    if (decision === 'ALLOW') {
      return {
        decision: 'ALLOW',
        reasonCode: SAFETY_STATE_LIMIT,
        softOutcome: 'LIMIT',
        requiredControls: ['LIMIT'],
        elevated: true,
        state
      };
    }
    // REQUIRE_APPROVAL / REQUEST_EVIDENCE / etc.: do not demote to ALLOW/LIMIT.
    return {
      ...base,
      softOutcome: 'LIMIT',
      requiredControls: [],
      elevated: false
    };
  }

  if (softOutcome === 'CONFIRM') {
    if (decision === 'ALLOW') {
      return {
        decision: 'REQUIRE_APPROVAL',
        reasonCode: SAFETY_STATE_REQUIRE_APPROVAL,
        softOutcome: 'CONFIRM',
        requiredControls: [],
        elevated: true,
        state
      };
    }
    return { ...base, softOutcome: 'CONFIRM', elevated: false };
  }

  if (softOutcome === 'SANDBOX') {
    const available = sandboxAvailable === true;
    if (decision === 'ALLOW') {
      return {
        decision: 'REQUIRE_APPROVAL',
        reasonCode: available
          ? SAFETY_STATE_REQUIRE_APPROVAL
          : SAFETY_STATE_SANDBOX_UNAVAILABLE,
        softOutcome: 'SANDBOX',
        // Only claim SANDBOX control when a real kernel sandbox probe says so.
        requiredControls: available ? ['SANDBOX'] : [],
        elevated: true,
        state
      };
    }
    // Already REQUIRE_APPROVAL (or stricter non-BLOCK): keep decision; attach controls if real.
    if (decision === 'REQUIRE_APPROVAL') {
      return {
        decision: 'REQUIRE_APPROVAL',
        reasonCode: available
          ? (reasonCode ?? SAFETY_STATE_REQUIRE_APPROVAL)
          : SAFETY_STATE_SANDBOX_UNAVAILABLE,
        softOutcome: 'SANDBOX',
        requiredControls: available ? ['SANDBOX'] : [],
        elevated: !available, // reason may change when unavailable
        state
      };
    }
    return {
      ...base,
      softOutcome: 'SANDBOX',
      requiredControls: available ? ['SANDBOX'] : [],
      elevated: false
    };
  }

  if (softOutcome === 'DENY') {
    return {
      decision: 'BLOCK',
      reasonCode: SAFETY_STATE_DENY,
      softOutcome: 'DENY',
      requiredControls: [],
      elevated: true,
      state
    };
  }

  if (softOutcome === 'QUARANTINE') {
    return {
      decision: 'BLOCK',
      reasonCode: SAFETY_STATE_QUARANTINE,
      softOutcome: 'QUARANTINE',
      requiredControls: [],
      elevated: true,
      state
    };
  }

  // ALLOW / unknown → no-op
  return base;
}
