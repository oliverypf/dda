// Decision reason/uncertainty code assembly helpers.
// freeze-harness-decision-reasoncodes-dedupe-r1:
// Path/Trust/RV elevate writes toolGate.reasonCode then telemetry used to
// append the same code → cleanCodes threw DECISION_INVALID_REASON_CODES.

/** Order-preserving unique: first occurrence kept; null/empty skipped. */
export const dedupePreserveOrder = (codes) => {
  const seen = new Set();
  const out = [];
  for (const entry of codes ?? []) {
    if (entry == null || entry === '') continue;
    const code = String(entry);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
};

/**
 * Elevate already wrote toolGate.reasonCode — do not re-append the same
 * *Applied.reasonCode into telemetry (Path / Trust / RV / SAFETY_STATE).
 */
export const telemetryElevateReason = (applied, toolGateReasonCode) => {
  if (!applied?.elevated || !applied.reasonCode) return [];
  if (toolGateReasonCode != null && String(applied.reasonCode) === String(toolGateReasonCode)) {
    return [];
  }
  return [String(applied.reasonCode)];
};

/**
 * SELECT_TOOL_ACTION reasonCodes: gate reason first, then telemetry without
 * self-injury dups. After order-preserving dedupe, if still > max, keep the
 * gate reason and slice the telemetry head so the final list is ≤ max.
 * Does not loosen cleanCodes — illegal chars / true dirty dups still fail
 * upstream when callers bypass this helper.
 */
export const assembleToolActionReasonCodes = ({
  gateReasonCode,
  telemetryCodes = [],
  max = 32,
  fallbackGate = 'JEV_ACTION_GATE'
} = {}) => {
  const gate = (gateReasonCode != null && gateReasonCode !== '')
    ? String(gateReasonCode)
    : fallbackGate;
  const telem = dedupePreserveOrder(
    (Array.isArray(telemetryCodes) ? telemetryCodes : [])
      .filter((c) => c != null && c !== '' && String(c) !== gate)
  );
  if (1 + telem.length <= max) {
    return dedupePreserveOrder([gate, ...telem]);
  }
  const room = Math.max(0, max - 1);
  return [gate, ...telem.slice(0, room)];
};
