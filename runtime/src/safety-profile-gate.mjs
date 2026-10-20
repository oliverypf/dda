// S1: SAFETY profile → ACTION_GATE soft tighten.
// Pure: no I/O. Elevate ALLOW → REQUIRE_APPROVAL only; never demote; never touch BLOCK / readOnly.

export const SAFETY_PROFILE_REQUIRE_APPROVAL = 'SAFETY_PROFILE_REQUIRE_APPROVAL';

/** Eligibility reasonCodes that justify elevating a non-readOnly ALLOW. */
export const SAFETY_PROFILE_ELEVATE_CODES = Object.freeze([
  'SAFETY_BELOW_THRESHOLD',
  'FAILURE_OBSERVED'
]);

const elevateSet = new Set(SAFETY_PROFILE_ELEVATE_CODES);

/**
 * @param {{
 *   gateDecision?: { decision?: string, reasonCode?: string },
 *   safetyProfile?: { profileId?: string, eligibility?: { reasonCodes?: string[] } } | null,
 *   toolReadOnly?: boolean
 * }} input
 * @returns {{
 *   decision: string | undefined,
 *   reasonCode: string | undefined,
 *   profileId: string | undefined,
 *   reasonCodes: string[],
 *   elevated: boolean
 * }}
 */
export function applySafetyProfileGate({ gateDecision = {}, safetyProfile, toolReadOnly } = {}) {
  const decision = gateDecision?.decision;
  const reasonCode = gateDecision?.reasonCode;
  const profileId = typeof safetyProfile?.profileId === 'string' ? safetyProfile.profileId : undefined;
  const reasonCodes = Array.isArray(safetyProfile?.eligibility?.reasonCodes)
    ? safetyProfile.eligibility.reasonCodes.filter((code) => typeof code === 'string')
    : [];

  const unchanged = () => ({
    decision,
    reasonCode,
    profileId,
    reasonCodes,
    elevated: false
  });

  // Missing / unloaded profile → keep Jev/hard judgment as-is.
  if (!safetyProfile || typeof safetyProfile !== 'object') {
    return { decision, reasonCode, profileId: undefined, reasonCodes: [], elevated: false };
  }

  // Hard BLOCK short-circuit: profile must not rewrite.
  if (decision === 'BLOCK') return unchanged();

  // Read-only / readonly fast-path ALLOW: never elevate.
  if (toolReadOnly === true) return unchanged();

  // Never demote REQUIRE_APPROVAL / BLOCK / REQUEST_EVIDENCE / etc. to ALLOW.
  // Only soft-tighten a plain ALLOW when SAFETY codes warrant it.
  if (decision !== 'ALLOW') return unchanged();

  const shouldElevate = reasonCodes.some((code) => elevateSet.has(code));
  if (!shouldElevate) return unchanged();

  return {
    decision: 'REQUIRE_APPROVAL',
    reasonCode: SAFETY_PROFILE_REQUIRE_APPROVAL,
    profileId,
    reasonCodes,
    elevated: true
  };
}
