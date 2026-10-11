// Runtime event vocabulary shared across clients.
//
// The monolith (runtime/src/index.mjs) emits these `runtime_event` kinds on the
// `--events stdout` JSONL channel. Clients must render unknown kinds generically
// rather than dropping them (docs/LINUX_CLI_CONTRACT.md §2 rule 6, §10). Listing
// the known vocabulary here lets every shell share the same human mapping and
// terminal-state detection without hard-coding strings in each platform.

export const RUNTIME_EVENT_TYPE = 'runtime_event';
export const RUNTIME_EVENT_SCHEMA_VERSION = '1.0';

// Known event kinds with their canonical human label (docs/LINUX_CLI_CONTRACT §4.3).
export const RUNTIME_EVENT_KINDS = Object.freeze({
  'run.started': 'task started',
  'runtime.phase': 'current phase',
  'runtime.heartbeat': 'activity',
  'runtime.error': 'runtime error',
  'approval.requested': 'approval requested',
  'approval.resolved': 'approval resolved',
  'action_intent.created': 'controlled action created',
  'tool.started': 'tool started',
  'tool.completed': 'tool completed',
  'task.classified': 'task classified',
  'task.prechecked': 'task safety prechecked',
  'route.selected': 'route selected'
});

// Terminal run states a client uses to stop reading the event stream.
export const TERMINAL_RUN_STATES = Object.freeze([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'PAUSED',
  'PAUSED_UNSUPPORTED'
]);

export const isKnownEventKind = (kind) =>
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(RUNTIME_EVENT_KINDS, kind);

export const isTerminalRunState = (state) =>
  typeof state === 'string' && TERMINAL_RUN_STATES.includes(state);

export const humanLabelForEventKind = (kind) =>
  isKnownEventKind(kind) ? RUNTIME_EVENT_KINDS[kind] : kind;

/**
 * Validate the minimal shape of a runtime event envelope (contracts/v1/
 * runtime-event.schema.json) without pulling a JSON-schema dependency into the
 * shared model. Unknown `kind` values are allowed on purpose.
 */
export const isRuntimeEventEnvelope = (value) =>
  value !== null &&
  typeof value === 'object' &&
  value.type === RUNTIME_EVENT_TYPE &&
  value.schemaVersion === RUNTIME_EVENT_SCHEMA_VERSION &&
  typeof value.runId === 'string' &&
  Number.isInteger(value.sequence) &&
  typeof value.kind === 'string' &&
  value.payload !== null &&
  typeof value.payload === 'object';
