// The runtime event `kind` set is intentionally open (see
// contracts/v1/runtime-event.schema.json): unrecognized kinds must be
// preserved and shown, never dropped. But the contract (LINUX_CLI_CONTRACT §10)
// also requires that an event the CLI cannot interpret yet which affects run
// state must surface PROTOCOL_ERROR or PAUSED_UNSUPPORTED instead of being
// treated as benign. We stay conservative to avoid false positives on the
// existing kinds: only a never-seen run-lifecycle kind, or an explicit
// pause/suspend signal the headless CLI cannot service, is flagged.

export const RUN_LIFECYCLE_KINDS = new Set([
  'run.started',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.state_changed'
]);

const PAUSE_SIGNAL = /paus|suspend|awaiting_input|needs_input/iu;

const stateText = (payload = {}) => String(payload.state ?? payload.status ?? payload.runState ?? '');

// Returns { unsupported: false } for events the CLI understands or that do not
// affect run state, otherwise { unsupported: true, code } naming the error the
// caller should report (the event itself is still preserved/displayed).
export function classifyStatefulEvent(event) {
  if (!event || event.type !== 'runtime_event' || typeof event.kind !== 'string') return { unsupported: false };
  const kind = event.kind;
  const payload = event.payload ?? {};
  // A headless run that pauses waiting for interaction the CLI cannot provide
  // must not hang or be reported as success.
  if (PAUSE_SIGNAL.test(kind) || PAUSE_SIGNAL.test(stateText(payload))) {
    return { unsupported: true, code: 'PAUSED_UNSUPPORTED' };
  }
  // A new run.* lifecycle kind we have never seen changes run state in a way we
  // cannot map; fail closed rather than guess the terminal outcome.
  if (kind.startsWith('run.') && !RUN_LIFECYCLE_KINDS.has(kind)) {
    return { unsupported: true, code: 'PROTOCOL_ERROR' };
  }
  return { unsupported: false };
}
