// DDA_JEV_READONLY_FAST_PATH (default OFF).
//
// A STRICT allowlist of in-workspace read-only inspection tools may skip the
// ACTION_GATE Jev round-trip and its evidence collection. Everything else
// (kernel.session_*, kernel.host_request, side-effect tools, unregistered
// tools, absolute/opaque/out-of-workspace paths) still goes through the gate,
// so #15 REQUIRE_APPROVAL and every hard policy remain intact.

export const READONLY_FAST_PATH_REASON = 'READONLY_FAST_PATH';

export const READONLY_FAST_PATH_TOOLS = Object.freeze(new Set([
  'workspace.list',
  'workspace.read',
  'workspace.focus',
  'kernel.workspace_list',
  'kernel.workspace_read',
  'kernel.workspace_focus'
]));

const MAX_PATH_CHARS = 512;

/** Relative, in-workspace path: no absolute, drive, UNC, home or parent
 * segments. The empty string means the workspace root. */
export const isRelativeWorkspacePath = (value) => {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > MAX_PATH_CHARS) return false;
  if (/[\u0000-\u001f]/u.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.startsWith('~')) return false;
  if (/^[A-Za-z]:/u.test(normalized)) return false;
  if (normalized.split('/').some((segment) => segment === '..')) return false;
  return true;
};

const proposedInput = (claim) => {
  if (claim && typeof claim === 'object') return claim.untrustedProposedInput;
  if (typeof claim === 'string') {
    try { return JSON.parse(claim)?.untrustedProposedInput; } catch { return undefined; }
  }
  return undefined;
};

/**
 * Return a deterministic ACTION_GATE ALLOW for an eligible call, or undefined
 * when the call must keep its normal gate. The caller must apply the hard
 * READ_ONLY BLOCK first; this function never overrides a block.
 */
export const readonlyFastPathDecision = ({ enabled, name, registered, toolReadOnly, request, proposedInputClaim } = {}) => {
  if (enabled !== true) return undefined;
  if (!READONLY_FAST_PATH_TOOLS.has(name)) return undefined;
  if (registered !== true || toolReadOnly !== true) return undefined;
  const input = proposedInput(proposedInputClaim);
  if (!input || typeof input !== 'object') return undefined;
  if (input.pathClass === 'OUTSIDE_OR_OPAQUE' || input.cwdClass === 'OUTSIDE_OR_OPAQUE') return undefined;
  if (input.pathClass !== undefined || input.cwdClass !== undefined) return undefined;
  const raw = request && typeof request === 'object' ? request : {};
  if (raw.cwd !== undefined) return undefined;
  if (!isRelativeWorkspacePath(raw.path)) return undefined;
  if (input.path !== undefined && !isRelativeWorkspacePath(input.path)) return undefined;
  return {
    decision: 'ALLOW',
    confidence: 1,
    source: 'rule',
    fallbackUsed: false,
    reasonCode: READONLY_FAST_PATH_REASON,
    decisionType: 'ACTION_GATE'
  };
};
