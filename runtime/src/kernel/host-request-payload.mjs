/**
 * Prime Phase-2a: single shared normalization of a kernel.host_request
 * payload.
 *
 * Real models frequently send `payload` as a JSON *string* (for example
 * `"{\"path\":\"a.txt\",...}"`) instead of a nested object. The action gate
 * (Jev/rules claim), the arguments digest bound into approvals, and the host
 * dispatcher must all see the SAME unwrapped object, otherwise the gate sees an
 * opaque string (Jev REQUEST_EVIDENCE) while the dispatcher cannot map it to a
 * discrete tool input. Every consumer therefore goes through this module and
 * the string is parsed exactly once, before the arguments digest is taken.
 *
 * Only a string whose JSON value is a plain object is unwrapped; anything else
 * is returned unchanged so the schema / dispatcher reject it with their normal
 * bounded error (never a silent coercion).
 */

export const HOST_REQUEST_TOOL_NAME = 'kernel.host_request';
// Bound the work done on a stringified payload (batch limit is 256KB of
// content; allow JSON escaping overhead).
export const MAX_HOST_REQUEST_PAYLOAD_STRING_CHARS = 1024 * 1024;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Unwrap a JSON-string payload into its object; otherwise return it as-is. */
export const parseHostRequestPayload = (payload) => {
  if (typeof payload !== 'string' || payload.length > MAX_HOST_REQUEST_PAYLOAD_STRING_CHARS) return payload;
  const trimmed = payload.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return payload;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : payload;
  } catch {
    return payload;
  }
};

/** Normalize kernel.host_request arguments ({kind, payload}). Pure; never throws. */
export const normalizeHostRequestArguments = (args) => {
  if (!isPlainObject(args) || typeof args.payload !== 'string') return args;
  const payload = parseHostRequestPayload(args.payload);
  return payload === args.payload ? args : { ...args, payload };
};
