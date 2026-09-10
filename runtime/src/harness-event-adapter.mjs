// Adapt the local redacted Trajectory shape to the stable cross-platform
// HarnessEvent envelope.  The local store intentionally remains smaller and
// can be replayed without requiring every transport field to be present.

export const HARNESS_EVENT_SCHEMA_VERSION = '1.0';
export const HARNESS_PROTOCOL_VERSION = '1.0';
export const HARNESS_STORAGE_SCHEMA_VERSION = 1;
export const HARNESS_APP_VERSION = process.env.HMCODEX_APP_VERSION?.trim() || '0.1.0';
export const HARNESS_PRODUCER_VERSION = 'hmcodex-runtime@0.1.0';

const ACTOR_TYPES = new Set(['USER', 'CORE', 'MODEL', 'ADAPTER', 'PLUGIN', 'SYSTEM']);
const SENSITIVITY_VALUES = new Set(['PUBLIC', 'INTERNAL', 'SOURCE', 'SENSITIVE', 'SECRET_REF', 'SECURITY_AUDIT']);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const boundedText = (value, fallback, maxLength) => {
  const text = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim()
    : '';
  return (text || fallback).slice(0, maxLength);
};

const actorType = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (ACTOR_TYPES.has(normalized)) return normalized;
  return {
    RUNTIME: 'SYSTEM',
    AGENT: 'CORE',
    PROVIDER: 'ADAPTER',
    EXECUTOR: 'PLUGIN'
  }[normalized] ?? 'SYSTEM';
};

const sensitivity = (value) => SENSITIVITY_VALUES.has(value) ? value : 'INTERNAL';

const clonePayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return structuredClone(payload);
};

/**
 * Convert one persisted trajectory record into the canonical event envelope.
 * Missing transport metadata is derived deterministically from the run so the
 * result is stable across retries and does not invent a new event identity.
 */
export const trajectoryToHarnessEvent = (record, options = {}) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('HARNESS_EVENT_RECORD_INVALID');
  }
  if (typeof record.runId !== 'string' || !record.runId.trim() ||
    typeof record.kind !== 'string' || !record.kind.trim() ||
    !Number.isInteger(record.sequence) || record.sequence < 1) {
    throw new Error('HARNESS_EVENT_RECORD_INVALID');
  }

  const payload = clonePayload(record.payload);
  const runId = boundedText(record.runId, 'unknown-run', 160);
  const aggregateType = boundedText(record.aggregateType, 'TaskRun', 80);
  const aggregateId = boundedText(record.aggregateId, runId, 240);
  const emittedAtMs = Number.isInteger(record.emittedAtMs) && record.emittedAtMs >= 0
    ? record.emittedAtMs
    : Date.now();
  const observedAtMs = Number.isInteger(record.observedAtMs) && record.observedAtMs >= 0
    ? record.observedAtMs
    : (Number.isInteger(options.now) && options.now >= 0 ? options.now : emittedAtMs);
  const protocolVersion = boundedText(options.protocolVersion ?? record.protocolVersion, HARNESS_PROTOCOL_VERSION, 40);
  const appVersion = boundedText(options.appVersion ?? record.appVersion, HARNESS_APP_VERSION, 80);
  const producerVersion = boundedText(options.producerVersion ?? record.producerVersion, HARNESS_PRODUCER_VERSION, 120);
  const policyVersion = boundedText(options.policyVersion ?? record.policyVersion, 'runtime-safety-1', 120);
  const correlationId = boundedText(record.correlationId, `run:${runId}`, 240);
  const event = {
    eventId: boundedText(record.eventId, `trajectory:${runId}:${record.sequence}`, 240),
    schemaVersion: HARNESS_EVENT_SCHEMA_VERSION,
    kind: boundedText(record.kind, 'UnknownEvent', 120),
    runId,
    aggregateType,
    aggregateId,
    sequence: record.sequence,
    aggregateVersion: Number.isInteger(record.aggregateVersion) && record.aggregateVersion >= 0
      ? record.aggregateVersion
      : record.sequence,
    ...(typeof record.operationId === 'string' && record.operationId.trim()
      ? { operationId: boundedText(record.operationId, undefined, 240) }
      : {}),
    correlationId,
    ...(typeof record.causationId === 'string' && record.causationId.trim()
      ? { causationId: boundedText(record.causationId, undefined, 240) }
      : {}),
    actorType: actorType(record.actorType),
    actorId: boundedText(record.actorId, 'hmcodex-runtime', 240),
    emittedAtMs,
    observedAtMs,
    payload,
    payloadDigest: boundedText(record.payloadDigest, '', 71),
    sensitivity: sensitivity(record.sensitivity),
    protocolVersion,
    appVersion,
    storageSchemaVersion: Number.isInteger(options.storageSchemaVersion ?? record.storageSchemaVersion)
      && (options.storageSchemaVersion ?? record.storageSchemaVersion) >= 0
      ? (options.storageSchemaVersion ?? record.storageSchemaVersion)
      : HARNESS_STORAGE_SCHEMA_VERSION,
    policyVersion,
    producerVersion
  };
  if (!DIGEST_PATTERN.test(event.payloadDigest)) throw new Error('HARNESS_EVENT_PAYLOAD_DIGEST_INVALID');
  return structuredClone(event);
};
