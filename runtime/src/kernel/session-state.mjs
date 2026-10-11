import { createHash } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from '../persistent-json-store.mjs';

/**
 * Durable per-session state for the resident kernel.
 *
 * This is the authoritative record the host rebuilds a crashed kernel from. It
 * is a bounded, host-owned key/value map of JSON values plus a monotonically
 * increasing revision. It deliberately holds no workspace mutations, no leases
 * and no side-effect outcomes: a Phase-1 kernel is read-only, and the recovery
 * contract is "rebuild in-memory kernel state from this record, never replay a
 * side effect". Writes are persisted here before they ever reach the kernel
 * subprocess, so re-applying the record after a crash is idempotent.
 */

const SCHEMA_VERSION = '1.0';
const MAX_ENTRIES = 256;
const MAX_KEY_LENGTH = 240;
const MAX_VALUE_CHARS = 64 * 1024;
const MAX_TOTAL_CHARS = 2 * 1024 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isJsonValue = (value, seen = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const ok = Array.isArray(value)
    ? value.every((child) => isJsonValue(child, seen))
    : isPlainObject(value) && Object.keys(value).every((key) => key !== '__proto__' && isJsonValue(value[key], seen));
  seen.delete(value);
  return ok;
};

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const clone = (value) => structuredClone(value);

const normalizeKey = (key) => {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.length > MAX_KEY_LENGTH) {
    throw new Error('KERNEL_SESSION_KEY_INVALID');
  }
  return key;
};

const normalizeValue = (value) => {
  if (!isJsonValue(value)) throw new Error('KERNEL_SESSION_VALUE_INVALID');
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > MAX_VALUE_CHARS) throw new Error('KERNEL_SESSION_VALUE_TOO_LARGE');
  return clone(value);
};

export class SessionStateStore {
  #storagePath;
  #sessionId;
  #entries = new Map();
  #revision = 0;
  #loaded = false;
  #queue = Promise.resolve();

  constructor({ storagePath, sessionId } = {}) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('KERNEL_SESSION_ID_REQUIRED');
    this.#storagePath = storagePath;
    this.#sessionId = sessionId.trim();
  }

  get sessionId() {
    return this.#sessionId;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch {
      throw new Error('KERNEL_SESSION_READ_FAILED');
    }
    if (parsed !== undefined) {
      if (parsed?.schemaVersion !== SCHEMA_VERSION || parsed.sessionId !== this.#sessionId
        || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES
        || !Number.isInteger(parsed.revision) || parsed.revision < 0) {
        throw new Error('KERNEL_SESSION_STATE_INVALID');
      }
      for (const entry of parsed.entries) {
        if (!isPlainObject(entry)) throw new Error('KERNEL_SESSION_STATE_INVALID');
        const key = normalizeKey(entry.key);
        const value = normalizeValue(entry.value);
        if (entry.valueDigest !== digest(value)) throw new Error('KERNEL_SESSION_STATE_INVALID');
        this.#entries.set(key, { key, value, valueDigest: entry.valueDigest, updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : Date.now() });
      }
      this.#revision = parsed.revision;
    }
    this.#loaded = true;
  }

  async reload() {
    try { await this.#queue; } catch { /* a prior optimistic write may have failed */ }
    this.#queue = Promise.resolve();
    this.#entries.clear();
    this.#revision = 0;
    this.#loaded = false;
    await this.load();
    return this.snapshot();
  }

  async get(key) {
    await this.load();
    const entry = this.#entries.get(normalizeKey(key));
    return entry ? clone(entry.value) : undefined;
  }

  async has(key) {
    await this.load();
    return this.#entries.has(normalizeKey(key));
  }

  async list() {
    await this.load();
    return [...this.#entries.keys()].sort();
  }

  async entries() {
    await this.load();
    return [...this.#entries.values()]
      .map((entry) => ({ key: entry.key, value: clone(entry.value), valueDigest: entry.valueDigest, updatedAtMs: entry.updatedAtMs }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async set(key, value) {
    await this.load();
    const normalizedKey = normalizeKey(key);
    const normalizedValue = normalizeValue(value);
    const next = new Map(this.#entries);
    next.set(normalizedKey, {
      key: normalizedKey,
      value: normalizedValue,
      valueDigest: digest(normalizedValue),
      updatedAtMs: Date.now()
    });
    if (next.size > MAX_ENTRIES) throw new Error('KERNEL_SESSION_STATE_FULL');
    return this.#commit(next);
  }

  async delete(key) {
    await this.load();
    const normalizedKey = normalizeKey(key);
    if (!this.#entries.has(normalizedKey)) {
      return { deleted: false, key: normalizedKey, revision: this.#revision };
    }
    const next = new Map(this.#entries);
    next.delete(normalizedKey);
    const result = await this.#commit(next);
    return { deleted: true, key: normalizedKey, revision: result.revision };
  }

  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessionId: this.#sessionId,
      revision: this.#revision,
      entries: [...this.#entries.values()]
        .map((entry) => ({ key: entry.key, value: clone(entry.value), valueDigest: entry.valueDigest, updatedAtMs: entry.updatedAtMs }))
        .sort((a, b) => a.key.localeCompare(b.key))
    };
  }

  async #commit(nextEntries) {
    const previousEntries = this.#entries;
    const previousRevision = this.#revision;
    this.#entries = nextEntries;
    this.#revision = previousRevision + 1;
    const payload = this.snapshot();
    if (JSON.stringify(payload).length > MAX_TOTAL_CHARS) {
      this.#entries = previousEntries;
      this.#revision = previousRevision;
      throw new Error('KERNEL_SESSION_STATE_TOO_LARGE');
    }
    if (!this.#storagePath) {
      return { revision: this.#revision, snapshot: payload };
    }
    const write = () => persistJsonFile(this.#storagePath, payload, {
      merge: (_existing, incoming) => incoming
    });
    this.#queue = this.#queue.then(write, write);
    try {
      await this.#queue;
    } catch (error) {
      this.#entries = previousEntries;
      this.#revision = previousRevision;
      throw error;
    }
    return { revision: this.#revision, snapshot: payload };
  }
}

export const createSessionStateStore = (options) => new SessionStateStore(options);
export { SCHEMA_VERSION as SESSION_STATE_SCHEMA_VERSION, digest as sessionStateDigest };
