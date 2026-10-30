// Decision reason/uncertainty code assembly helpers.
// freeze-harness-decision-reasoncodes-dedupe-r1:
// Path/Trust/RV elevate writes toolGate.reasonCode then telemetry used to
// append the same code → cleanCodes threw DECISION_INVALID_REASON_CODES.
// freeze-harness-trust-x-key-reasoncodes-r1:
// TRUST_X_KEY:${trustKey()} embeds @ | * rejected by cleanCodes charset —
// sanitize those three before propose/record; do NOT widen cleanCodes.
// freeze-harness-council-riskcodes-dedupe-r1:
// Council proposals carry model-authored `risks` free text. Mapping each entry
// onto the cleanCodes alphabet collapses non-Latin text to a bare `_` (and
// different English spellings onto one code), so normalizeOptions rejected the
// whole run with DECISION_INVALID_OPTIONS. Normalize + dedupe at the producer;
// do NOT widen cleanCodes.
import { createHash } from 'node:crypto';

const ILLEGAL_CODE_CHARS = /[^A-Za-z0-9_.:-]+/gu;
const EDGE_CODE_CHARS = /^[_.:-]+|[_.:-]+$/gu;
const CODE_MAX = 120;
/**
 * Map trustKey / control chars that cleanCodes rejects (`@` `|` `*`) to safe
 * stand-ins (`@`/`*` → `_`, `|` → `:`). Other illegal chars (space, `/`, …)
 * pass through so enforce still fails intentionally dirty inputs.
 * Does NOT widen cleanCodes; does NOT raise max 32.
 */
export const sanitizeReasonCodeCharset = (code) => {
  if (code == null || code === '') return code;
  return String(code)
    .replace(/\|/g, ':')
    .replace(/[@*]/g, '_');
};

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
 * Normalize a list of decision codes (risk / rejection / capability) so it
 * survives `cleanCodes` in decision-trace.mjs: ASCII code alphabet, no
 * duplicates, ≤ max entries.
 *
 * Model-authored free text (council `risks`) has no ASCII code characters once
 * sanitized — every entry collapses to `_` and the trace store fails closed
 * with DECISION_INVALID_OPTIONS. Those entries get a stable `PREFIX_<digest>`
 * stand-in derived from the original text instead of a duplicate `_`, so the
 * code stays unique without persisting the source wording.
 */
export const normalizeDecisionCodeList = (codes, { fallbackPrefix = 'CODE', uppercase = false, max = 32 } = {}) => {
  if (!Array.isArray(codes)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of codes) {
    if (entry == null) continue;
    const text = String(entry);
    if (text === '') continue;
    let code = (uppercase ? text.toUpperCase() : text)
      .replace(ILLEGAL_CODE_CHARS, '_')
      .replace(EDGE_CODE_CHARS, '')
      .slice(0, CODE_MAX);
    if (!/[A-Za-z0-9]/.test(code)) {
      code = `${fallbackPrefix}_${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}`;
    }
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length >= max) break;
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
 * self-injury dups. Charset-sanitize (@|* → safe) before dedupe so Trust KEY
 * telemetry matches cleanCodes. After order-preserving dedupe, if still > max,
 * keep the gate reason and slice the telemetry head so the final list is ≤ max.
 * Does not loosen cleanCodes — other illegal chars / true dirty dups still fail
 * when callers bypass this helper or pass residual illegal tokens.
 */
export const assembleToolActionReasonCodes = ({
  gateReasonCode,
  telemetryCodes = [],
  max = 32,
  fallbackGate = 'JEV_ACTION_GATE'
} = {}) => {
  const gateRaw = (gateReasonCode != null && gateReasonCode !== '')
    ? String(gateReasonCode)
    : fallbackGate;
  const gate = sanitizeReasonCodeCharset(gateRaw);
  const telem = dedupePreserveOrder(
    (Array.isArray(telemetryCodes) ? telemetryCodes : [])
      .filter((c) => c != null && c !== '')
      .map((c) => sanitizeReasonCodeCharset(String(c)))
      .filter((c) => c !== gate)
  );
  if (1 + telem.length <= max) {
    return dedupePreserveOrder([gate, ...telem]);
  }
  const room = Math.max(0, max - 1);
  return [gate, ...telem.slice(0, room)];
};
