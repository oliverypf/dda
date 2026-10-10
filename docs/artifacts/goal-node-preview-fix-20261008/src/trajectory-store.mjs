import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { trajectoryToHarnessEvent } from './harness-event-adapter.mjs';
import { createHarnessEventStore } from './harness-event-store.mjs';

export const TRAJECTORY_SCHEMA_VERSION = '1.0';
export const TRAJECTORY_PROTOCOL_VERSION = '1.0';
export const TRAJECTORY_STORAGE_SCHEMA_VERSION = 1;
export const TRAJECTORY_APP_VERSION = process.env.HMCODEX_APP_VERSION?.trim() || '0.1.0';
export const TRAJECTORY_PRODUCER_VERSION = 'hmcodex-runtime@0.1.0';

const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;

const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const normalizeForDigest = (value) => {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(normalizeForDigest);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeForDigest(child)]));
  }
  return value;
};

export const sha256Digest = (value) =>
  `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;

const safeSequence = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
const safeMetadataText = (value, fallback, maxLength = 120) => {
  const normalized = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, maxLength)
    : '';
  return normalized || fallback;
};

const parsePersistedEvents = (raw) => {
  const sequences = new Map();
  const ids = new Set();
  return raw
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        throw new Error('invalid event');
      }
      if (event.schemaVersion !== TRAJECTORY_SCHEMA_VERSION || typeof event.runId !== 'string' ||
        !Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.kind !== 'string' ||
        !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload) ||
        typeof event.recordDigest !== 'string') {
        throw new Error('invalid event');
      }
      const { recordDigest: _recordDigest, ...unsigned } = event;
      if (event.payloadDigest !== sha256Digest(stableStringify(event.payload)) ||
        event.recordDigest !== sha256Digest(stableStringify(unsigned))) {
        throw new Error('invalid event digest');
      }
      if (typeof event.eventId !== 'string' || !event.eventId.trim() || ids.has(event.eventId)
        || event.sequence !== (sequences.get(event.runId) ?? 0) + 1) {
        throw new Error('invalid event identity or sequence');
      }
      ids.add(event.eventId);
      sequences.set(event.runId, event.sequence);
      return event;
    } catch {
      throw new Error(`TRAJECTORY_INVALID_EVENT:${index + 1}`);
    }
  });
};

export const parseLegacyTrajectoryEvents = parsePersistedEvents;

export const createTrajectoryStore = (storagePath, options = {}) => {
  const harnessEventStore = options.harnessEventStore
    ?? (options.harnessStoragePath ? createHarnessEventStore({ storagePath: options.harnessStoragePath }) : undefined);
  if (harnessEventStore) {
    return {
      append: async (input) => {
        const result = await harnessEventStore.append(input);
        const receipt = result?.receipt ?? (result?.idempotent ? result : undefined);
        const event = result?.event ?? (result?.idempotent ? result.events?.[0] : undefined);
        if (receipt?.status !== 'COMMITTED' || !event?.eventId
          || !Array.isArray(receipt.eventIds) || !receipt.eventIds.includes(event.eventId)
          || (input.commandId !== undefined && receipt.commandId !== input.commandId)
          || event.runId !== input.runId || event.kind !== input.kind
          || stableStringify(event.payload) !== stableStringify(normalizeForDigest(input.payload ?? {}))
          || (input.aggregateType !== undefined && event.aggregateType !== input.aggregateType)
          || (input.aggregateId !== undefined && event.aggregateId !== input.aggregateId)) {
          throw new Error('DURABLE_COMMIT_REQUIRED');
        }
        return event;
      },
      list: async (runId) => harnessEventStore.list({ runId }),
      summary: () => {
        const summary = harnessEventStore.summary();
        return { store: summary.store, eventCount: summary.eventCount };
      },
      toHarnessEvent: trajectoryToHarnessEvent,
      importLegacyEvents: (...args) => harnessEventStore.importLegacyEvents(...args),
      harnessEventStore
    };
  }
  let initialized = false;
  let tail = Promise.resolve();
  let events = [];
  const sequences = new Map();

  const initialize = async () => {
    if (initialized) return;
    if (!storagePath) { initialized = true; return; }
    try {
      const metadata = await stat(storagePath);
      if (metadata.size > MAX_STORE_BYTES) throw new Error('TRAJECTORY_TOO_LARGE');
      const raw = await readFile(storagePath, 'utf8');
      events = parsePersistedEvents(raw);
      for (const event of events) {
        if (typeof event.runId !== 'string') continue;
        sequences.set(event.runId, Math.max(sequences.get(event.runId) ?? 0, safeSequence(event.sequence)));
      }
    } catch (error) {
      if (error?.code === 'ENOENT') { initialized = true; return; }
      throw error;
    }
    initialized = true;
  };

  const append = (input) => {
    tail = tail.catch(() => undefined).then(async () => {
      await initialize();
      if (!input || typeof input !== 'object' || typeof input.runId !== 'string' || !input.runId.trim()) {
        throw new Error('TRAJECTORY_INVALID_INPUT');
      }
      if (typeof input.kind !== 'string' || !input.kind.trim()) {
        throw new Error('TRAJECTORY_INVALID_KIND');
      }
      const sequence = (sequences.get(input.runId) ?? 0) + 1;
      const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
        ? normalizeForDigest(input.payload)
        : {};
      const payloadDigest = sha256Digest(stableStringify(payload));
      const unsigned = {
        schemaVersion: TRAJECTORY_SCHEMA_VERSION,
        protocolVersion: safeMetadataText(input.protocolVersion, TRAJECTORY_PROTOCOL_VERSION, 32),
        storageSchemaVersion: Number.isInteger(input.storageSchemaVersion) && input.storageSchemaVersion >= 1
          ? input.storageSchemaVersion
          : TRAJECTORY_STORAGE_SCHEMA_VERSION,
        appVersion: safeMetadataText(input.appVersion, TRAJECTORY_APP_VERSION, 64),
        eventId: `event-${randomUUID()}`,
        runId: input.runId,
        sequence,
        aggregateType: 'TaskRun',
        aggregateId: input.runId,
        kind: input.kind,
        actorType: input.actorType ?? 'runtime',
        actorId: input.actorId ?? 'hmcodex-runtime',
        ...(typeof input.operationId === 'string' && input.operationId.trim()
          ? { operationId: safeMetadataText(input.operationId, undefined, 240) }
          : {}),
        ...(typeof input.correlationId === 'string' && input.correlationId.trim()
          ? { correlationId: safeMetadataText(input.correlationId, undefined, 240) }
          : {}),
        ...(typeof input.causationId === 'string' && input.causationId.trim()
          ? { causationId: safeMetadataText(input.causationId, undefined, 240) }
          : {}),
        payload,
        policyVersion: safeMetadataText(input.policyVersion, 'runtime-safety-1', 120),
        producerVersion: safeMetadataText(input.producerVersion, TRAJECTORY_PRODUCER_VERSION, 120),
        payloadDigest,
        sensitivity: input.sensitivity ?? 'INTERNAL',
        redactionState: 'REDACTED',
        emittedAtMs: Date.now(),
        observedAtMs: Date.now()
      };
      const event = {
        ...unsigned,
        recordDigest: sha256Digest(stableStringify(unsigned))
      };
      const encoded = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(encoded, 'utf8') > MAX_EVENT_BYTES) {
        throw new Error('TRAJECTORY_EVENT_TOO_LARGE');
      }
      if (storagePath) {
        await mkdir(dirname(storagePath), { recursive: true });
        await appendFile(storagePath, encoded, 'utf8');
      }
      events.push(event);
      sequences.set(input.runId, sequence);
      return structuredClone(event);
    });
    return tail;
  };

  const list = async (runId) => {
    await tail;
    await initialize();
    return structuredClone(runId ? events.filter((event) => event.runId === runId) : events);
  };

  const summary = () => ({
    store: storagePath ? 'PERSISTED' : 'MEMORY_ONLY',
    eventCount: events.filter((event) => !['RunStateChanged', 'VerificationCompleted', 'RoleContextsAllocated', 'PlanStepStateChanged'].includes(event.kind)).length
  });

  return { append, list, summary, toHarnessEvent: trajectoryToHarnessEvent };
};
