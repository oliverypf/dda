import { createHash, randomUUID } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import {
  openHarnessDatabase,
  readHarnessDatabase,
  commitHarnessEvent,
  commitHarnessBatch,
  purgeHarnessRun,
  countHarnessEvents,
  readHarnessEventPage,
  readHarnessEventsByIds,
  readHarnessReceipt,
  readHarnessReceiptPage,
  readHarnessTombstones,
  nextHarnessIdentity,
  readHarnessSummary
} from './harness-store-schema.mjs';

export const HARNESS_STORE_SCHEMA_VERSION = '1.0';
export const HARNESS_PROTOCOL_VERSION = '1.0';
export const HARNESS_STORAGE_SCHEMA_VERSION = 1;
export const HARNESS_APP_VERSION = process.env.HMCODEX_APP_VERSION?.trim() || '0.1.0';
export const HARNESS_PRODUCER_VERSION = 'hmcodex-runtime@0.1.0';
export const HARNESS_POLICY_VERSION = 'runtime-safety-1';

const MAX_EVENTS = 100_000;
const MAX_RECEIPTS = 100_000;
const MAX_TOMBSTONES = 4_096;
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_TEXT = 240;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const text = (value, fallback, max = MAX_TEXT) => {
  const normalized = typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max)
    : '';
  return normalized || fallback;
};
const normalizePayload = (value) => {
  if (!isObject(value)) throw new Error('HARNESS_EVENT_PAYLOAD_INVALID');
  const normalize = (item) => {
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return null;
    if (typeof item === 'number' && !Number.isFinite(item)) return null;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, normalize(child)]));
    return item;
  };
  return normalize(value);
};
const safeDigest = (value, code) => {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) throw new Error(code);
  return value;
};
const normalizeSourceRef = (value) => {
  if (value === undefined) return undefined;
  if (!isObject(value) || typeof value.store !== 'string' || !value.store.trim()
    || typeof value.eventId !== 'string' || !value.eventId.trim()) {
    throw new Error('HARNESS_EVENT_SOURCE_REF_INVALID');
  }
  return {
    store: text(value.store, 'legacy', 80),
    eventId: value.eventId.trim().slice(0, MAX_TEXT),
    ...(value.recordDigest === undefined ? {} : { recordDigest: safeDigest(value.recordDigest, 'HARNESS_EVENT_SOURCE_REF_INVALID') })
  };
};

const validateEvent = (event, index) => {
  if (!isObject(event) || event.schemaVersion !== HARNESS_STORE_SCHEMA_VERSION
    || typeof event.eventId !== 'string' || !event.eventId
    || typeof event.runId !== 'string' || !event.runId
    || !Number.isInteger(event.sequence) || event.sequence < 1
    || typeof event.aggregateType !== 'string' || !event.aggregateType
    || typeof event.aggregateId !== 'string' || !event.aggregateId
    || !Number.isInteger(event.aggregateVersion) || event.aggregateVersion < 1
    || typeof event.kind !== 'string' || !event.kind
    || !isObject(event.payload)
    || !Number.isInteger(event.emittedAtMs) || event.emittedAtMs < 0
    || !Number.isInteger(event.observedAtMs) || event.observedAtMs < 0) {
    throw new Error(`HARNESS_STORE_INVALID_EVENT:${index + 1}`);
  }
  safeDigest(event.payloadDigest, 'HARNESS_STORE_INVALID_DIGEST');
  safeDigest(event.recordDigest, 'HARNESS_STORE_INVALID_DIGEST');
  if (event.sourceRef !== undefined) normalizeSourceRef(event.sourceRef);
  const { recordDigest, ...unsigned } = event;
  if (event.payloadDigest !== digest(event.payload) || recordDigest !== digest(unsigned)) {
    throw new Error(`HARNESS_STORE_INVALID_EVENT:${index + 1}`);
  }
  if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) {
    throw new Error(`HARNESS_STORE_EVENT_TOO_LARGE:${index + 1}`);
  }
};

const validateTombstone = (tombstone, index) => {
  if (!isObject(tombstone) || typeof tombstone.tombstoneId !== 'string' || !tombstone.tombstoneId
    || typeof tombstone.runId !== 'string' || !tombstone.runId
    || !Number.isInteger(tombstone.purgedAtMs) || tombstone.purgedAtMs < 0
    || !DIGEST_PATTERN.test(tombstone.reasonDigest) || !DIGEST_PATTERN.test(tombstone.recordDigest)) {
    throw new Error('HARNESS_STORE_INVALID_TOMBSTONE:' + (index + 1));
  }
  const { recordDigest, ...unsigned } = tombstone;
  if (recordDigest !== digest(unsigned)) throw new Error('HARNESS_STORE_INVALID_TOMBSTONE:' + (index + 1));
};

const validateStore = (parsed, {
  maxEvents = MAX_EVENTS,
  maxReceipts = MAX_RECEIPTS,
  maxTombstones = MAX_TOMBSTONES
} = {}) => {
  if (!isObject(parsed) || parsed.schemaVersion !== HARNESS_STORE_SCHEMA_VERSION
    || !Array.isArray(parsed.events) || parsed.events.length > maxEvents
    || !Array.isArray(parsed.receipts) || parsed.receipts.length > maxReceipts
    || (parsed.tombstones !== undefined && (!Array.isArray(parsed.tombstones) || parsed.tombstones.length > maxTombstones))) {
    throw new Error('HARNESS_STORE_INVALID');
  }
  const tombstones = Array.isArray(parsed.tombstones) ? parsed.tombstones : [];
  const tombstoneRuns = new Set();
  for (const [index, tombstone] of tombstones.entries()) {
    validateTombstone(tombstone, index);
    if (tombstoneRuns.has(tombstone.runId)) throw new Error('HARNESS_STORE_DUPLICATE_TOMBSTONE');
    tombstoneRuns.add(tombstone.runId);
  }
  const runSequences = new Map();
  const aggregateVersions = new Map();
  const eventIds = new Set();
  for (const [index, event] of parsed.events.entries()) {
    validateEvent(event, index);
    if (tombstoneRuns.has(event.runId)) throw new Error('HARNESS_STORE_TOMBSTONE_CONFLICT');
    if (eventIds.has(event.eventId)) throw new Error('HARNESS_STORE_DUPLICATE_EVENT');
    eventIds.add(event.eventId);
    const runKey = event.runId;
    const priorSequence = runSequences.get(runKey) ?? 0;
    if (event.sequence !== priorSequence + 1) throw new Error('HARNESS_STORE_SEQUENCE_INVALID');
    runSequences.set(runKey, event.sequence);
    const aggregateKey = JSON.stringify([event.aggregateType, event.aggregateId]);
    const versions = aggregateVersions.get(aggregateKey) ?? [];
    versions.push(event.aggregateVersion);
    aggregateVersions.set(aggregateKey, versions);
  }
  for (const versions of aggregateVersions.values()) {
    versions.sort((a, b) => a - b);
    if (versions.some((version, index) => version !== index + 1)) throw new Error('HARNESS_STORE_AGGREGATE_VERSION_INVALID');
  }
  const commandIds = new Set();
  for (const receipt of parsed.receipts) {
    if (!isObject(receipt) || typeof receipt.commandId !== 'string' || !receipt.commandId
      || commandIds.has(receipt.commandId) || typeof receipt.requestDigest !== 'string'
      || !DIGEST_PATTERN.test(receipt.requestDigest) || !Array.isArray(receipt.eventIds)) {
      throw new Error('HARNESS_STORE_INVALID_RECEIPT');
    }
    commandIds.add(receipt.commandId);
    for (const eventId of receipt.eventIds) {
      if (!eventIds.has(eventId)) throw new Error('HARNESS_STORE_RECEIPT_EVENT_MISSING');
    }
  }
  return parsed;
};

const validateReceiptShape = (receipt) => {
  if (!isObject(receipt) || typeof receipt.commandId !== 'string' || !receipt.commandId
    || typeof receipt.requestDigest !== 'string' || !DIGEST_PATTERN.test(receipt.requestDigest)
    || !Array.isArray(receipt.eventIds)) {
    throw new Error('HARNESS_STORE_INVALID_RECEIPT');
  }
  return receipt;
};

// Streaming equivalent of validateStore for the SQLite backend. It preserves
// the same invariants while keeping memory bounded to one page.
const validateSqliteDatabase = (db) => {
  const runGap = db.prepare(`SELECT run_id FROM trajectory_events GROUP BY run_id
    HAVING MIN(sequence) <> 1 OR MAX(sequence) <> COUNT(*) LIMIT 1`).get();
  if (runGap) throw new Error('HARNESS_STORE_SEQUENCE_INVALID');
  const aggregateGap = db.prepare(`SELECT aggregate_type FROM trajectory_events GROUP BY aggregate_type, aggregate_id
    HAVING MIN(aggregate_version) <> 1 OR MAX(aggregate_version) <> COUNT(*) LIMIT 1`).get();
  if (aggregateGap) throw new Error('HARNESS_STORE_AGGREGATE_VERSION_INVALID');
  const orphanReceipt = db.prepare(`SELECT c.command_id FROM command_dedup c, json_each(c.receipt, '$.eventIds') ids
    LEFT JOIN trajectory_events e ON e.event_id = ids.value WHERE e.event_id IS NULL LIMIT 1`).get();
  if (orphanReceipt) throw new Error('HARNESS_STORE_RECEIPT_EVENT_MISSING');
  const tombstoneConflict = db.prepare(`SELECT e.event_id FROM trajectory_events e
    JOIN run_tombstones t ON t.run_id = e.run_id LIMIT 1`).get();
  if (tombstoneConflict) throw new Error('HARNESS_STORE_TOMBSTONE_CONFLICT');
  let cursor;
  let index = 0;
  for (;;) {
    const page = readHarnessEventPage(db, { ...(cursor ?? {}), limit: 1000 });
    for (const event of page.events) validateEvent(event, index++);
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  let receiptCursor;
  for (;;) {
    const page = readHarnessReceiptPage(db, {
      ...(receiptCursor ? { afterCommandId: receiptCursor } : {}),
      limit: 1000
    });
    for (const receipt of page.receipts) validateReceiptShape(receipt);
    if (!page.hasMore) break;
    receiptCursor = page.nextCursor.afterCommandId;
  }
  for (const tombstone of readHarnessTombstones(db)) validateTombstone(tombstone, 0);
};

export class HarnessEventStore {
  #storagePath;
  #now;
  #idFactory;
  #backupPath;
  #events = [];
  #receipts = new Map();
  #tombstones = new Map();
  #loaded = false;
  #queue = Promise.resolve();
  #sqlite;
  #sqliteSummary = { eventCount: 0, receiptCount: 0, tombstoneCount: 0, lastSequenceByRun: {} };

  constructor({ storagePath, backupPath, now = () => Date.now(), idFactory = randomUUID } = {}) {
    this.#storagePath = storagePath;
    this.#sqlite = typeof storagePath === 'string' && /\.db$/iu.test(storagePath);
    this.#backupPath = backupPath ?? (storagePath ? `${storagePath}.backup` : undefined);
    this.#now = typeof now === 'function' ? now : () => Date.now();
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
  }

  async load() {
    if (this.#loaded) return this.summary();
    if (!this.#storagePath) {
      this.#loaded = true;
      return this.summary();
    }
    if (this.#sqlite) {
      try {
        const db = openHarnessDatabase(this.#storagePath);
        try {
          validateSqliteDatabase(db);
          this.#tombstones = new Map(readHarnessTombstones(db).map((tombstone) => [tombstone.runId, clone(tombstone)]));
          this.#sqliteSummary = readHarnessSummary(db);
        } finally {
          db.close();
        }
      } catch (error) {
        if (error?.message?.startsWith('HARNESS_STORE_')) throw error;
        throw new Error('HARNESS_STORE_READ_FAILED');
      }
      this.#loaded = true;
      return this.summary();
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.message?.startsWith('HARNESS_STORE_')) throw error;
      throw new Error('HARNESS_STORE_READ_FAILED');
    }
    if (parsed !== undefined) {
      try { validateStore(parsed); } catch (error) {
        if (error?.message?.startsWith('HARNESS_STORE_')) throw error;
        throw new Error('HARNESS_STORE_INVALID');
      }
      this.#events = parsed.events.map(clone);
      this.#receipts = new Map(parsed.receipts.map((receipt) => [receipt.commandId, clone(receipt)]));
      this.#tombstones = new Map((Array.isArray(parsed.tombstones) ? parsed.tombstones : []).map((tombstone) => [tombstone.runId, clone(tombstone)]));
    }
    this.#loaded = true;
    return this.summary();
  }

  async reload() {
    try { await this.#queue; } catch { /* failed writes are discarded before reload */ }
    this.#queue = Promise.resolve();
    this.#events = [];
    this.#receipts = new Map();
    this.#tombstones = new Map();
    this.#loaded = false;
    return this.load();
  }

  // SQLite append paths never materialize the full event log. The database
  // connection sees committed facts from other processes, and the unique
  // (run_id, sequence) / aggregate constraints remain the concurrency guard.
  #sqliteAppendOne(db, input, { identity, validate = true } = {}) {
    if (!isObject(input) || typeof input.runId !== 'string' || !input.runId.trim()
      || typeof input.kind !== 'string' || !input.kind.trim()) {
      throw new Error('HARNESS_EVENT_INPUT_INVALID');
    }
    const commandId = typeof input.commandId === 'string' && input.commandId.trim()
      ? input.commandId.trim().slice(0, MAX_TEXT)
      : undefined;
    const requestedEventId = typeof input.eventId === 'string' && input.eventId.trim()
      ? input.eventId.trim().slice(0, MAX_TEXT)
      : undefined;
    const requestDigest = digest({
      runId: input.runId,
      aggregateType: input.aggregateType ?? 'TaskRun',
      aggregateId: input.aggregateId ?? input.runId,
      kind: input.kind,
      payload: input.payload ?? {},
      ...(input.sourceRef === undefined ? {} : { sourceRef: normalizeSourceRef(input.sourceRef) }),
      ...(requestedEventId === undefined ? {} : { eventId: requestedEventId }),
      commandId
    });
    if (commandId) {
      const previous = readHarnessReceipt(db, commandId);
      if (previous) {
        if (previous.requestDigest !== requestDigest) throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT');
        return {
          result: {
            ...clone(previous),
            idempotent: true,
            events: readHarnessEventsByIds(db, previous.eventIds).map(clone)
          }
        };
      }
    }
    const payload = normalizePayload(input.payload ?? {});
    const runId = input.runId.trim().slice(0, MAX_TEXT);
    const aggregateType = text(input.aggregateType, 'TaskRun', 80);
    const aggregateId = text(input.aggregateId, runId, MAX_TEXT);
    if (db.prepare('SELECT 1 FROM run_tombstones WHERE run_id=?').get(runId)) throw new Error('HARNESS_RUN_TOMBSTONED');
    const resolvedIdentity = identity ?? nextHarnessIdentity(db, { runId, aggregateType, aggregateId });
    const now = this.#now();
    const unsigned = {
      schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
      protocolVersion: text(input.protocolVersion, HARNESS_PROTOCOL_VERSION, 40),
      storageSchemaVersion: Number.isInteger(input.storageSchemaVersion) && input.storageSchemaVersion >= 1 ? input.storageSchemaVersion : HARNESS_STORAGE_SCHEMA_VERSION,
      appVersion: text(input.appVersion, HARNESS_APP_VERSION, 80),
      producerVersion: text(input.producerVersion, HARNESS_PRODUCER_VERSION, 120),
      policyVersion: text(input.policyVersion, HARNESS_POLICY_VERSION, 120),
      eventId: requestedEventId ?? `event-${this.#idFactory()}`,
      runId,
      sequence: resolvedIdentity.sequence,
      aggregateType,
      aggregateId,
      aggregateVersion: resolvedIdentity.aggregateVersion,
      kind: input.kind.trim().slice(0, 120),
      actorType: text(input.actorType, 'SYSTEM', 40),
      actorId: text(input.actorId, 'hmcodex-runtime', MAX_TEXT),
      ...(typeof input.correlationId === 'string' && input.correlationId.trim() ? { correlationId: input.correlationId.trim().slice(0, MAX_TEXT) } : {}),
      ...(typeof input.causationId === 'string' && input.causationId.trim() ? { causationId: input.causationId.trim().slice(0, MAX_TEXT) } : {}),
      emittedAtMs: now,
      observedAtMs: Number.isInteger(input.observedAtMs) && input.observedAtMs >= 0 ? input.observedAtMs : now,
      payload,
      payloadDigest: digest(payload),
      sensitivity: text(input.sensitivity, 'INTERNAL', 40),
      ...(input.sourceRef === undefined ? {} : { sourceRef: normalizeSourceRef(input.sourceRef) })
    };
    const event = { ...unsigned, recordDigest: digest(unsigned) };
    if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) throw new Error('HARNESS_EVENT_TOO_LARGE');
    const receipt = {
      receiptId: `receipt-${this.#idFactory()}`,
      commandId: commandId ?? `append:${event.eventId}`,
      requestDigest,
      eventIds: [event.eventId],
      status: 'COMMITTED',
      committedAtMs: now
    };
    const committed = commitHarnessEvent(db, event, receipt, undefined, { skipIdentityCheck: true });
    if (committed.idempotent) {
      const saved = readHarnessReceipt(db, committed.commandId);
      return { result: { ...clone(saved), idempotent: true, events: readHarnessEventsByIds(db, saved.eventIds).map(clone) } };
    }
    if (validate) {
      const saved = readHarnessReceipt(db, committed.commandId);
      const savedEvent = readHarnessEventsByIds(db, saved.eventIds)[0];
      validateEvent(savedEvent, 0);
      this.#sqliteSummary = {
        ...this.#sqliteSummary,
        eventCount: this.#sqliteSummary.eventCount + 1,
        receiptCount: this.#sqliteSummary.receiptCount + 1,
        lastSequenceByRun: { ...this.#sqliteSummary.lastSequenceByRun, [runId]: savedEvent.sequence }
      };
      return { result: { event: clone(savedEvent), receipt: clone(saved), idempotent: false } };
    }
    if (!committed.idempotent) {
      this.#sqliteSummary = {
        ...this.#sqliteSummary,
        eventCount: this.#sqliteSummary.eventCount + 1,
        receiptCount: this.#sqliteSummary.receiptCount + 1,
        lastSequenceByRun: { ...this.#sqliteSummary.lastSequenceByRun, [runId]: event.sequence }
      };
    }
    return { result: { event: clone(event), receipt: clone(committed), idempotent: false } };
  }

  #appendSqlite(input) {
    const db = openHarnessDatabase(this.#storagePath);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const { result } = this.#sqliteAppendOne(db, input);
        db.exec('COMMIT');
        return clone(result);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  #appendSqliteBatch(inputs) {
    const db = openHarnessDatabase(this.#storagePath);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = inputs.map((input) => this.#sqliteAppendOne(db, input).result);
        db.exec('COMMIT');
        return results.map(clone);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
        throw error;
      }
    } finally {
      db.close();
    }
  }

  async appendBatch(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 128 || inputs.some((input) => !isObject(input))) throw new Error('HARNESS_EVENT_BATCH_INVALID');
    const operation = async () => {
      await this.load();
      if (this.#sqlite) return this.#appendSqliteBatch(inputs);
      const staged = new HarnessEventStore({ now: this.#now, idFactory: this.#idFactory });
      staged.#events = this.#events.map(clone);
      staged.#receipts = new Map([...this.#receipts].map(([key, value]) => [key, clone(value)]));
      staged.#tombstones = new Map([...this.#tombstones].map(([key, value]) => [key, clone(value)]));
      staged.#loaded = true;
      const results = [];
      for (const input of inputs) results.push(await staged.append(clone(input)));
      const entries = results.filter((result) => !result.idempotent).map((result) => ({ event: result.event, receipt: result.receipt }));
      if (this.#sqlite) {
        const db = openHarnessDatabase(this.#storagePath);
        try {
          validateStore(readHarnessDatabase(db));
          commitHarnessBatch(db, entries, [], validateStore);
          const snapshot = readHarnessDatabase(db);
          validateStore(snapshot);
          this.#events = snapshot.events.map(clone);
          this.#receipts = new Map(snapshot.receipts.map((item) => [item.commandId, clone(item)]));
          this.#tombstones = new Map(snapshot.tombstones.map((item) => [item.runId, clone(item)]));
        } finally { db.close(); }
      } else {
        const snapshot = {
          schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
          events: staged.#events.map(clone),
          receipts: [...staged.#receipts.values()].map(clone),
          tombstones: [...staged.#tombstones.values()].map(clone)
        };
        if (this.#storagePath) {
          await persistJsonFile(this.#storagePath, snapshot, {
            merge: (existing) => {
              const current = existing ?? { schemaVersion: HARNESS_STORE_SCHEMA_VERSION, events: [], receipts: [], tombstones: [] };
              validateStore(current);
              const eventsById = new Map(current.events.map((item) => [item.eventId, item]));
              const eventsByPosition = new Map(current.events.map((item) => [item.runId + '\0' + item.sequence, item]));
              for (const item of snapshot.events) {
                const priorById = eventsById.get(item.eventId);
                if (priorById && priorById.recordDigest !== item.recordDigest) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
                const priorByPosition = eventsByPosition.get(item.runId + '\0' + item.sequence);
                if (priorByPosition && priorByPosition.eventId !== item.eventId) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
                eventsById.set(item.eventId, item);
                eventsByPosition.set(item.runId + '\0' + item.sequence, item);
              }
              const receiptsByCommand = new Map(current.receipts.map((item) => [item.commandId, item]));
              for (const item of snapshot.receipts) {
                const prior = receiptsByCommand.get(item.commandId);
                if (prior && prior.requestDigest !== item.requestDigest) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
                receiptsByCommand.set(item.commandId, item);
              }
              const tombstonesByRun = new Map((current.tombstones ?? []).map((item) => [item.runId, item]));
              for (const item of snapshot.tombstones ?? []) tombstonesByRun.set(item.runId, item);
              const merged = {
                schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
                events: [...eventsById.values()].sort((left, right) => left.runId.localeCompare(right.runId) || left.sequence - right.sequence),
                receipts: [...receiptsByCommand.values()],
                tombstones: [...tombstonesByRun.values()]
              };
              if (merged.events.length > MAX_EVENTS || merged.receipts.length > MAX_RECEIPTS || merged.tombstones.length > MAX_TOMBSTONES) throw new Error('HARNESS_STORE_LIMIT');
              return merged;
            },
            ...(this.#backupPath ? { backupPath: this.#backupPath } : {})
          });
        }
        this.#events = snapshot.events;
        this.#receipts = new Map(snapshot.receipts.map((item) => [item.commandId, item]));
        this.#tombstones = new Map(snapshot.tombstones.map((item) => [item.runId, item]));
      }
      return results.map(clone);
    };
    this.#queue = this.#queue.then(operation, operation);
    return this.#queue;
  }

  async append(input = {}) {
    const operation = async () => {
      await this.load();
      if (this.#sqlite) return this.#appendSqlite(input);
      if (!isObject(input) || typeof input.runId !== 'string' || !input.runId.trim()
        || typeof input.kind !== 'string' || !input.kind.trim()) {
        throw new Error('HARNESS_EVENT_INPUT_INVALID');
      }
      const commandId = typeof input.commandId === 'string' && input.commandId.trim() ? input.commandId.trim().slice(0, MAX_TEXT) : undefined;
      const requestedEventId = typeof input.eventId === 'string' && input.eventId.trim()
        ? input.eventId.trim().slice(0, MAX_TEXT)
        : undefined;
      const requestDigest = digest({
        runId: input.runId,
        aggregateType: input.aggregateType ?? 'TaskRun',
        aggregateId: input.aggregateId ?? input.runId,
        kind: input.kind,
        payload: input.payload ?? {},
        ...(input.sourceRef === undefined ? {} : { sourceRef: normalizeSourceRef(input.sourceRef) }),
        ...(requestedEventId === undefined ? {} : { eventId: requestedEventId }),
        commandId
      });
      if (commandId) {
        const previous = this.#receipts.get(commandId);
        if (previous) {
          if (previous.requestDigest !== requestDigest) throw new Error('HARNESS_COMMAND_IDEMPOTENCY_CONFLICT');
          return { ...clone(previous), idempotent: true, events: previous.eventIds.map((id) => clone(this.#events.find((event) => event.eventId === id))).filter(Boolean) };
        }
      }
      if (this.#events.length >= MAX_EVENTS) throw new Error('HARNESS_STORE_LIMIT');
      const payload = normalizePayload(input.payload ?? {});
      const runId = input.runId.trim().slice(0, MAX_TEXT);
      const aggregateType = text(input.aggregateType, 'TaskRun', 80);
      const aggregateId = text(input.aggregateId, runId, MAX_TEXT);
      if (this.#tombstones.has(runId)) throw new Error('HARNESS_RUN_TOMBSTONED');
      const priorRun = [...this.#events].reverse().find((event) => event.runId === runId);
      const priorAggregateVersion = this.#events.reduce((version, event) => event.aggregateType === aggregateType && event.aggregateId === aggregateId
        ? Math.max(version, event.aggregateVersion) : version, 0);
      const now = this.#now();
      const unsigned = {
        schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
        protocolVersion: text(input.protocolVersion, HARNESS_PROTOCOL_VERSION, 40),
        storageSchemaVersion: Number.isInteger(input.storageSchemaVersion) && input.storageSchemaVersion >= 1 ? input.storageSchemaVersion : HARNESS_STORAGE_SCHEMA_VERSION,
        appVersion: text(input.appVersion, HARNESS_APP_VERSION, 80),
        producerVersion: text(input.producerVersion, HARNESS_PRODUCER_VERSION, 120),
        policyVersion: text(input.policyVersion, HARNESS_POLICY_VERSION, 120),
        eventId: requestedEventId ?? `event-${this.#idFactory()}`,
        runId,
        sequence: (priorRun?.sequence ?? 0) + 1,
        aggregateType,
        aggregateId,
        aggregateVersion: priorAggregateVersion + 1,
        kind: input.kind.trim().slice(0, 120),
        actorType: text(input.actorType, 'SYSTEM', 40),
        actorId: text(input.actorId, 'hmcodex-runtime', MAX_TEXT),
        ...(typeof input.correlationId === 'string' && input.correlationId.trim() ? { correlationId: input.correlationId.trim().slice(0, MAX_TEXT) } : {}),
        ...(typeof input.causationId === 'string' && input.causationId.trim() ? { causationId: input.causationId.trim().slice(0, MAX_TEXT) } : {}),
        emittedAtMs: now,
        observedAtMs: Number.isInteger(input.observedAtMs) && input.observedAtMs >= 0 ? input.observedAtMs : now,
        payload,
        payloadDigest: digest(payload),
        sensitivity: text(input.sensitivity, 'INTERNAL', 40),
        ...(input.sourceRef === undefined ? {} : { sourceRef: normalizeSourceRef(input.sourceRef) })
      };
      const event = { ...unsigned, recordDigest: digest(unsigned) };
      if (Buffer.byteLength(JSON.stringify(event), 'utf8') > MAX_EVENT_BYTES) throw new Error('HARNESS_EVENT_TOO_LARGE');
      const receiptCommandId = commandId ?? `append:${event.eventId}`;
      const receipt = {
        receiptId: `receipt-${this.#idFactory()}`,
        commandId: receiptCommandId,
        requestDigest,
        eventIds: [event.eventId],
        status: 'COMMITTED',
        committedAtMs: now
      };
      if (this.#sqlite) {
        const db = openHarnessDatabase(this.#storagePath);
        try {
          // Validate the durable state before making another change, including
          // changes made by another process since this facade was loaded.
          validateStore(readHarnessDatabase(db));
          const committed = commitHarnessEvent(db, event, receipt, validateStore);
          const snapshot = readHarnessDatabase(db);
          validateStore(snapshot);
          this.#events = snapshot.events.map(clone);
          this.#receipts = new Map(snapshot.receipts.map((item) => [item.commandId, clone(item)]));
          this.#tombstones = new Map(snapshot.tombstones.map((item) => [item.runId, clone(item)]));
          const saved = this.#receipts.get(committed.commandId);
          const savedEvent = this.#events.find((item) => item.eventId === saved.eventIds[0]);
          return { event: clone(savedEvent), receipt: clone(saved), idempotent: committed.idempotent };
        } finally { db.close(); }
      }
      const nextEvents = [...this.#events, event];
      const nextReceipts = new Map(this.#receipts);
      nextReceipts.set(receiptCommandId, receipt);
      let committedSnapshot = {
        schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
        events: nextEvents,
        receipts: [...nextReceipts.values()],
        tombstones: [...this.#tombstones.values()]
      };
      if (this.#storagePath) {
        await persistJsonFile(this.#storagePath, committedSnapshot, {
          merge: (existing) => {
            const current = existing ?? { schemaVersion: HARNESS_STORE_SCHEMA_VERSION, events: [], receipts: [], tombstones: [] };
            validateStore(current);
            const currentTombstones = Array.isArray(current.tombstones) ? current.tombstones : [];
            if (currentTombstones.some((tombstone) => tombstone.runId === runId)) throw new Error('HARNESS_RUN_TOMBSTONED');
            const eventsById = new Map(current.events.map((item) => [item.eventId, item]));
            const eventsByPosition = new Map(current.events.map((item) => [item.runId + '\0' + item.sequence, item]));
            for (const item of nextEvents) {
              const priorById = eventsById.get(item.eventId);
              if (priorById && priorById.recordDigest !== item.recordDigest) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
              const priorByPosition = eventsByPosition.get(item.runId + '\0' + item.sequence);
              if (priorByPosition && priorByPosition.eventId !== item.eventId) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
              eventsById.set(item.eventId, item);
              eventsByPosition.set(item.runId + '\0' + item.sequence, item);
            }
            const receiptsByCommand = new Map(current.receipts.map((item) => [item.commandId, item]));
            for (const item of nextReceipts.values()) {
              const prior = receiptsByCommand.get(item.commandId);
              if (prior && prior.requestDigest !== item.requestDigest) throw new Error('HARNESS_STORE_CONCURRENT_CONFLICT');
              receiptsByCommand.set(item.commandId, item);
            }
            committedSnapshot = {
              schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
              events: [...eventsById.values()].sort((left, right) => left.runId.localeCompare(right.runId) || left.sequence - right.sequence),
              receipts: [...receiptsByCommand.values()],
              tombstones: currentTombstones
            };
            if (committedSnapshot.events.length > MAX_EVENTS || committedSnapshot.receipts.length > MAX_RECEIPTS) throw new Error('HARNESS_STORE_LIMIT');
            return committedSnapshot;
          },
          ...(this.#backupPath ? { backupPath: this.#backupPath } : {})
        });
      }
      this.#events = committedSnapshot.events.map(clone);
      this.#receipts = new Map(committedSnapshot.receipts.map((receipt) => [receipt.commandId, clone(receipt)]));
      this.#tombstones = new Map((committedSnapshot.tombstones ?? []).map((tombstone) => [tombstone.runId, clone(tombstone)]));
      return { event: clone(event), receipt: clone(receipt), idempotent: false };
    };
    this.#queue = this.#queue.then(operation, operation);
    return this.#queue;
  }

  async purgeRun(runId, { reason = 'USER_REQUESTED' } = {}) {
    const operation = async () => {
      if (this.#sqlite) this.#loaded = false;
      await this.load();
      if (typeof runId !== 'string' || !runId.trim()) throw new Error('HARNESS_PURGE_RUN_REQUIRED');
      const normalizedRunId = runId.trim().slice(0, MAX_TEXT);
      const existingTombstone = this.#tombstones.get(normalizedRunId);
      if (existingTombstone) return { status: 'COMMITTED', tombstone: clone(existingTombstone), idempotent: true };
      const unsigned = {
        schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
        tombstoneId: 'tombstone-' + this.#idFactory(),
        runId: normalizedRunId,
        purgedAtMs: this.#now(),
        reasonDigest: digest(String(reason ?? 'USER_REQUESTED'))
      };
      const tombstone = { ...unsigned, recordDigest: digest(unsigned) };
      if (this.#sqlite) {
        const db = openHarnessDatabase(this.#storagePath);
        try {
          const result = purgeHarnessRun(db, tombstone, validateSqliteDatabase);
          this.#sqliteSummary = readHarnessSummary(db);
          this.#tombstones = new Map(readHarnessTombstones(db).map((item) => [item.runId, clone(item)]));
          return clone(result);
        } finally { db.close(); }
      }
      const removedIds = new Set(this.#events.filter((event) => event.runId === normalizedRunId).map((event) => event.eventId));
      const remainingEvents = this.#events.filter((event) => event.runId !== normalizedRunId);
      const remainingReceipts = [...this.#receipts.values()].filter((receipt) => !receipt.eventIds.some((eventId) => removedIds.has(eventId)));
      const nextTombstones = [...this.#tombstones.values(), tombstone];
      let committedSnapshot = { schemaVersion: HARNESS_STORE_SCHEMA_VERSION, events: remainingEvents, receipts: remainingReceipts, tombstones: nextTombstones };
      if (this.#storagePath) {
        await persistJsonFile(this.#storagePath, committedSnapshot, {
          merge: (existing) => {
            const current = existing ?? { schemaVersion: HARNESS_STORE_SCHEMA_VERSION, events: [], receipts: [], tombstones: [] };
            validateStore(current);
            const currentTombstones = Array.isArray(current.tombstones) ? current.tombstones : [];
            const currentExisting = currentTombstones.find((item) => item.runId === normalizedRunId);
            if (currentExisting) return current;
            const deletedEventIds = new Set(current.events.filter((event) => event.runId === normalizedRunId).map((event) => event.eventId));
            const eventsById = new Map(current.events.filter((event) => event.runId !== normalizedRunId).map((event) => [event.eventId, event]));
            for (const event of remainingEvents) eventsById.set(event.eventId, event);
            const receipts = current.receipts.filter((receipt) => !receipt.eventIds.some((eventId) => deletedEventIds.has(eventId)));
            const receiptById = new Map(receipts.map((receipt) => [receipt.commandId, receipt]));
            for (const receipt of remainingReceipts) receiptById.set(receipt.commandId, receipt);
            committedSnapshot = {
              schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
              events: [...eventsById.values()].sort((left, right) => left.runId.localeCompare(right.runId) || left.sequence - right.sequence),
              receipts: [...receiptById.values()],
              tombstones: [...currentTombstones, tombstone]
            };
            return committedSnapshot;
          },
          ...(this.#backupPath ? { backupPath: this.#backupPath } : {})
        });
      }
      this.#events = committedSnapshot.events.map(clone);
      this.#receipts = new Map(committedSnapshot.receipts.map((receipt) => [receipt.commandId, clone(receipt)]));
      this.#tombstones = new Map((committedSnapshot.tombstones ?? []).map((item) => [item.runId, clone(item)]));
      return { status: 'COMMITTED', tombstone: clone(tombstone), purgedEventCount: removedIds.size, idempotent: false };
    };
    this.#queue = this.#queue.then(operation, operation);
    return this.#queue;
  }
  async importLegacySnapshot(snapshot) {
    validateStore(snapshot);
    if (!this.#sqlite) throw new Error('HARNESS_IMPORT_SQLITE_REQUIRED');
    return this.importLegacyEvents(snapshot.events, { sourceStore: 'harness-json', tombstones: snapshot.tombstones ?? [] });
  }

  async importLegacyEvents(events, { sourceStore = 'trajectory-jsonl', tombstones = [] } = {}) {
    if (!Array.isArray(events) || (!this.#sqlite && events.length > MAX_EVENTS)) throw new Error('HARNESS_IMPORT_INVALID');
    if (!Array.isArray(tombstones) || tombstones.length > MAX_TOMBSTONES) throw new Error('HARNESS_IMPORT_INVALID');
    for (const tombstone of tombstones) validateTombstone(tombstone);
    if (tombstones.length && !this.#sqlite) throw new Error('HARNESS_IMPORT_SQLITE_REQUIRED');
    if (this.#sqlite) {
      const operation = async () => {
        await this.load();
        const db = openHarnessDatabase(this.#storagePath);
        try {
          db.exec('BEGIN IMMEDIATE');
          try {
            const runSequences = new Map(db.prepare(
              'SELECT run_id, MAX(sequence) AS sequence FROM trajectory_events GROUP BY run_id'
            ).all().map((row) => [row.run_id, Number(row.sequence)]));
            const aggregateVersions = new Map(db.prepare(
              'SELECT aggregate_type, aggregate_id, MAX(aggregate_version) AS version FROM trajectory_events GROUP BY aggregate_type, aggregate_id'
            ).all().map((row) => [JSON.stringify([row.aggregate_type, row.aggregate_id]), Number(row.version)]));
            const results = [];
            for (const legacy of events) {
              if (!isObject(legacy) || typeof legacy.runId !== 'string' || typeof legacy.kind !== 'string') {
                throw new Error('HARNESS_IMPORT_INVALID');
              }
              if (typeof legacy.eventId !== 'string' || !legacy.eventId.trim()) throw new Error('HARNESS_IMPORT_SOURCE_ID_REQUIRED');
              const runId = legacy.runId.trim().slice(0, MAX_TEXT);
              const aggregateType = legacy.aggregateType ?? 'TaskRun';
              const aggregateId = legacy.aggregateId ?? legacy.runId;
              const sequence = (runSequences.get(runId) ?? 0) + 1;
              const aggregateKey = JSON.stringify([aggregateType, aggregateId]);
              const aggregateVersion = (aggregateVersions.get(aggregateKey) ?? 0) + 1;
              const { result } = this.#sqliteAppendOne(db, {
                runId,
                aggregateType,
                aggregateId,
                kind: legacy.kind,
                payload: legacy.payload ?? {},
                protocolVersion: legacy.protocolVersion,
                storageSchemaVersion: legacy.storageSchemaVersion,
                appVersion: legacy.appVersion,
                policyVersion: legacy.policyVersion,
                producerVersion: legacy.producerVersion,
                actorType: legacy.actorType,
                actorId: legacy.actorId,
                sensitivity: legacy.sensitivity,
                sourceRef: { store: sourceStore, eventId: legacy.eventId, recordDigest: legacy.recordDigest },
                commandId: 'legacy:' + digest({ sourceStore, eventId: legacy.eventId })
              }, { identity: { sequence, aggregateVersion }, validate: false });
              if (!result.idempotent) {
                runSequences.set(runId, sequence);
                aggregateVersions.set(aggregateKey, aggregateVersion);
              }
              results.push(result);
            }
            validateSqliteDatabase(db);
            for (const tombstone of tombstones) purgeHarnessRun(db, tombstone, validateSqliteDatabase);
            db.exec('COMMIT');
            this.#sqliteSummary = readHarnessSummary(db);
            this.#tombstones = new Map(readHarnessTombstones(db).map((item) => [item.runId, clone(item)]));
            return results.map(clone);
          } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
            throw error;
          }
        } finally { db.close(); }
      };
      this.#queue = this.#queue.then(operation, operation);
      return this.#queue;
    }
    const imported = [];
    for (const legacy of events) {
      if (!isObject(legacy) || typeof legacy.runId !== 'string' || typeof legacy.kind !== 'string') {
        throw new Error('HARNESS_IMPORT_INVALID');
      }
      if (typeof legacy.eventId !== 'string' || !legacy.eventId.trim()) throw new Error('HARNESS_IMPORT_SOURCE_ID_REQUIRED');
      const result = await this.append({
        runId: legacy.runId,
        aggregateType: legacy.aggregateType ?? 'TaskRun',
        aggregateId: legacy.aggregateId ?? legacy.runId,
        kind: legacy.kind,
        payload: legacy.payload ?? {},
        protocolVersion: legacy.protocolVersion,
        storageSchemaVersion: legacy.storageSchemaVersion,
        appVersion: legacy.appVersion,
        policyVersion: legacy.policyVersion,
        producerVersion: legacy.producerVersion,
        actorType: legacy.actorType,
        actorId: legacy.actorId,
        sensitivity: legacy.sensitivity,
        sourceRef: { store: sourceStore, eventId: legacy.eventId, recordDigest: legacy.recordDigest },
        commandId: 'legacy:' + digest({ sourceStore, eventId: legacy.eventId })
      });
      imported.push(result);
    }
    return imported;
  }

  async list({ runId, aggregateType, aggregateId } = {}) {
    try { await this.#queue; } catch { /* a failed write must not poison reads */ }
    await this.load();
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try {
        const events = [];
        let cursor;
        for (;;) {
          const page = readHarnessEventPage(db, { runId, aggregateType, aggregateId, ...(cursor ?? {}), limit: 1000 });
          events.push(...page.events);
          if (!page.hasMore) break;
          cursor = page.nextCursor;
        }
        return events.map(clone);
      } finally {
        db.close();
      }
    }
    return this.#events.filter((event) => (!runId || event.runId === runId)
      && (!aggregateType || event.aggregateType === aggregateType)
      && (!aggregateId || event.aggregateId === aggregateId)).map(clone);
  }

  // Paged reads let callers rebuild or export a store larger than memory.
  async listPage({ runId, aggregateType, aggregateId, afterRunId, afterSequence, limit = 500 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('HARNESS_STORE_PAGE_LIMIT_INVALID');
    try { await this.#queue; } catch { /* a failed write must not poison reads */ }
    await this.load();
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try {
        const page = readHarnessEventPage(db, { runId, aggregateType, aggregateId, afterRunId, afterSequence, limit });
        return {
          ...page,
          events: page.events.map(clone),
          total: countHarnessEvents(db, { runId, aggregateType, aggregateId })
        };
      } finally {
        db.close();
      }
    }
    const filtered = this.#events.filter((event) => (!runId || event.runId === runId)
      && (!aggregateType || event.aggregateType === aggregateType)
      && (!aggregateId || event.aggregateId === aggregateId));
    const start = typeof afterRunId === 'string' && afterRunId
      ? filtered.findIndex((event) => event.runId > afterRunId
        || (event.runId === afterRunId && event.sequence > (Number.isInteger(afterSequence) ? afterSequence : 0)))
      : 0;
    const from = start < 0 ? filtered.length : start;
    const items = filtered.slice(from, from + limit);
    const hasMore = from + items.length < filtered.length;
    const last = items.at(-1);
    return {
      events: items.map(clone),
      limit,
      total: filtered.length,
      hasMore,
      ...(hasMore && last ? { nextCursor: { afterRunId: last.runId, afterSequence: last.sequence } } : {})
    };
  }

  async *iterate({ runId, aggregateType, aggregateId, limit = 500 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('HARNESS_STORE_PAGE_LIMIT_INVALID');
    try { await this.#queue; } catch { /* a failed write must not poison reads */ }
    await this.load();
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try {
        let cursor;
        for (;;) {
          const page = readHarnessEventPage(db, { runId, aggregateType, aggregateId, ...(cursor ?? {}), limit });
          for (const event of page.events) yield clone(event);
          if (!page.hasMore) return;
          cursor = page.nextCursor;
        }
      } finally {
        db.close();
      }
    }
    let cursor;
    for (;;) {
      const page = await this.listPage({ runId, aggregateType, aggregateId, ...(cursor ?? {}), limit });
      for (const event of page.events) yield event;
      if (!page.hasMore) return;
      cursor = page.nextCursor;
    }
  }

  async listDeletedRunIds() {
    try { await this.#queue; } catch { /* a failed write must not poison reads */ }
    await this.load();
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try { return readHarnessTombstones(db).map((tombstone) => tombstone.runId).sort(); } finally { db.close(); }
    }
    return [...this.#tombstones.keys()].sort();
  }

  getReceipt(commandId) {
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try {
        const receipt = readHarnessReceipt(db, commandId);
        return receipt ? clone(receipt) : undefined;
      } finally {
        db.close();
      }
    }
    const receipt = this.#receipts.get(commandId);
    return receipt ? clone(receipt) : undefined;
  }

  async verify() {
    try { await this.#queue; } catch { /* a failed write must not poison reads */ }
    await this.load();
    if (this.#sqlite) {
      const db = openHarnessDatabase(this.#storagePath);
      try {
        validateSqliteDatabase(db);
        const summary = readHarnessSummary(db);
        return {
          ok: true,
          eventCount: summary.eventCount,
          receiptCount: summary.receiptCount,
          tombstoneCount: summary.tombstoneCount
        };
      } finally {
        db.close();
      }
    }
    try {
      validateStore({ schemaVersion: HARNESS_STORE_SCHEMA_VERSION, events: this.#events, receipts: [...this.#receipts.values()], tombstones: [...this.#tombstones.values()] });
      return { ok: true, eventCount: this.#events.length, receiptCount: this.#receipts.size, tombstoneCount: this.#tombstones.size };
    } catch (error) {
      return { ok: false, errorCode: error?.message ?? 'HARNESS_STORE_INVALID' };
    }
  }

  summary() {
    if (this.#sqlite) {
      return {
        store: 'PERSISTED',
        schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
        eventCount: this.#sqliteSummary.eventCount,
        receiptCount: this.#sqliteSummary.receiptCount,
        tombstoneCount: this.#sqliteSummary.tombstoneCount,
        lastSequenceByRun: clone(this.#sqliteSummary.lastSequenceByRun)
      };
    }
    return {
      store: this.#storagePath ? 'PERSISTED' : 'MEMORY_ONLY',
      schemaVersion: HARNESS_STORE_SCHEMA_VERSION,
      eventCount: this.#events.length,
      receiptCount: this.#receipts.size,
      tombstoneCount: this.#tombstones.size,
      lastSequenceByRun: Object.fromEntries([...new Set(this.#events.map((event) => event.runId))].map((runId) => [runId, this.#events.filter((event) => event.runId === runId).at(-1)?.sequence ?? 0]))
    };
  }
}

export const createHarnessEventStore = (options) => new HarnessEventStore(options);
export { canonical as stableHarnessStringify, digest as harnessDigest, validateEvent as validateHarnessEvent, validateStore as validateHarnessStore };
