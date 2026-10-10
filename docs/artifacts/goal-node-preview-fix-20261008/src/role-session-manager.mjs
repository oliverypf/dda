import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const STATES = Object.freeze(['ALLOCATING', 'READY', 'BUSY', 'INTERRUPTING', 'CLOSING', 'CLOSED', 'FAILED']);
const TRANSITIONS = Object.freeze({
  ALLOCATING: ['READY', 'FAILED', 'CLOSING'],
  READY: ['BUSY', 'CLOSING', 'CLOSED', 'FAILED'],
  BUSY: ['READY', 'INTERRUPTING', 'CLOSING', 'CLOSED', 'FAILED'],
  INTERRUPTING: ['READY', 'CLOSING', 'CLOSED', 'FAILED'],
  CLOSING: ['CLOSED', 'FAILED'],
  CLOSED: [],
  FAILED: ['READY', 'CLOSING', 'CLOSED']
});
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_SNAPSHOT_CHARS = 256 * 1024;

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const clone = (value) => structuredClone(value);
const safeText = (value, field, max = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`ROLE_CONTEXT_INVALID_${field.toUpperCase()}`);
  }
  return value.trim();
};

// Adapter identities and binding snapshots are persisted as detached values
// and signed with a deterministic digest. This prevents a caller from
// mutating a binding after allocation and makes cross-process recovery checks
// independent of object key order.
const normalizeIdentity = (value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return safeText(value, 'ADAPTER_IDENTITY');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ROLE_CONTEXT_INVALID_ADAPTER_IDENTITY');
  let detached;
  try { detached = clone(value); } catch { throw new Error('ROLE_CONTEXT_INVALID_ADAPTER_IDENTITY'); }
  const serialized = canonical(detached);
  if (serialized.length > 16 * 1024) throw new Error('ROLE_CONTEXT_ADAPTER_IDENTITY_TOO_LARGE');
  if (!Object.keys(detached).length) throw new Error('ROLE_CONTEXT_INVALID_ADAPTER_IDENTITY');
  return detached;
};

const normalizeSnapshot = (value) => {
  if (value === undefined) return undefined;
  if (value === null || (typeof value !== 'object' && typeof value !== 'string')) throw new Error('ROLE_CONTEXT_INVALID_BINDING_SNAPSHOT');
  let detached;
  try { detached = clone(value); } catch { throw new Error('ROLE_CONTEXT_INVALID_BINDING_SNAPSHOT'); }
  if (canonical(detached).length > MAX_SNAPSHOT_CHARS) throw new Error('ROLE_CONTEXT_BINDING_SNAPSHOT_TOO_LARGE');
  return detached;
};

const identityDigest = (value) => value === undefined ? undefined : digest(value);
const snapshotDigest = (value) => value === undefined ? undefined : digest(value);

export class RoleSessionManager {
  #contexts = new Map();
  #factory;
  #sequence = 0;
  #storagePath;
  #queue = Promise.resolve();
  #loaded = false;
  #ownerPid;
  #runtimeInstanceId;
  #eventStore;

  constructor({ idFactory = randomUUID, storagePath, ownerPid = process.pid, runtimeInstanceId = `runtime-${randomUUID()}`, eventStore } = {}) {
    this.#factory = idFactory;
    this.#storagePath = storagePath;
    this.#ownerPid = ownerPid;
    this.#runtimeInstanceId = runtimeInstanceId;
    this.#eventStore = eventStore;
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
      throw new Error('ROLE_CONTEXT_STORE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== '1.0' || !Array.isArray(parsed.contexts) || parsed.contexts.length > 4096) throw new Error('ROLE_CONTEXT_STORE_INVALID');
    const restored = [];
    for (const context of parsed.contexts) {
      if (!context || typeof context.contextId !== 'string' || typeof context.runId !== 'string' || typeof context.role !== 'string' || !STATES.includes(context.state)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
      if (context.ownerPid !== undefined && (!Number.isInteger(context.ownerPid) || context.ownerPid < 1)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
      if (context.runtimeInstanceId !== undefined && (typeof context.runtimeInstanceId !== 'string' || !context.runtimeInstanceId.trim())) throw new Error('ROLE_CONTEXT_STORE_INVALID');
      if (context.threadId !== undefined) {
        try { safeText(context.threadId, 'THREAD_ID'); } catch { throw new Error('ROLE_CONTEXT_STORE_INVALID'); }
      }
      if (context.adapterIdentity !== undefined) {
        try {
          const identity = normalizeIdentity(context.adapterIdentity);
          if (context.adapterIdentityDigest !== identityDigest(identity)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
        } catch { throw new Error('ROLE_CONTEXT_STORE_INVALID'); }
      } else if (context.adapterIdentityDigest !== undefined) {
        throw new Error('ROLE_CONTEXT_STORE_INVALID');
      }
      if (context.bindingSnapshot !== undefined) {
        try {
          const snapshot = normalizeSnapshot(context.bindingSnapshot);
          if (context.bindingSnapshotDigest !== snapshotDigest(snapshot)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
        } catch { throw new Error('ROLE_CONTEXT_STORE_INVALID'); }
      } else if (context.bindingSnapshotDigest !== undefined) {
        throw new Error('ROLE_CONTEXT_STORE_INVALID');
      }
      if (context.adapterIdentityDigest !== undefined && !DIGEST.test(context.adapterIdentityDigest)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
      if (context.bindingSnapshotDigest !== undefined && !DIGEST.test(context.bindingSnapshotDigest)) throw new Error('ROLE_CONTEXT_STORE_INVALID');
      restored.push(Object.freeze(clone(context)));
    }
    if (new Set(restored.map((context) => context.contextId)).size !== restored.length) throw new Error('ROLE_CONTEXT_STORE_INVALID');
    for (const context of restored) this.#contexts.set(context.contextId, context);
    this.#loaded = true;
  }

  async reload() {
    try { await this.#queue; } catch { /* a prior persistence attempt may have failed */ }
    this.#queue = Promise.resolve();
    this.#contexts.clear();
    this.#loaded = false;
    await this.load();
    return this.list();
  }

  async allocateDurably(input = {}) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const context = this.allocate(input, { deferPersist: true, deferStore: true });
    await this.#eventStore.append({
      runId: context.runId,
      aggregateType: 'RoleContext',
      aggregateId: context.contextId,
      kind: 'RoleContextAllocated',
      payload: { contextId: context.contextId, runId: context.runId, role: context.role, model: context.model, isolation: context.isolation, adapterIdentityDigest: context.adapterIdentityDigest, bindingSnapshotDigest: context.bindingSnapshotDigest, threadId: context.threadId },
      sensitivity: 'INTERNAL'
    });
    this.#contexts.set(context.contextId, context);
    this.#schedulePersist();
    return structuredClone(context);
  }

  allocate({ runId, role, model, isolation = 'DEDICATED', metadata = {}, adapterIdentity, adapterId, threadId, externalThreadId, bindingSnapshot } = {}, { deferPersist = false, deferStore = false } = {}) {
    if (typeof runId !== 'string' || typeof role !== 'string' || !role.trim()) throw new Error('ROLE_CONTEXT_INVALID');
    if (!['DEDICATED', 'EXPLICIT_SHARED'].includes(isolation)) throw new Error('ROLE_ISOLATION_INVALID');
    const normalizedAdapterIdentity = normalizeIdentity(adapterIdentity ?? adapterId);
    const normalizedThreadId = threadId === undefined ? externalThreadId : threadId;
    const normalizedBindingSnapshot = normalizeSnapshot(bindingSnapshot);
    const context = Object.freeze({
      contextId: `role-context-${this.#factory()}-${++this.#sequence}`,
      runId,
      role,
      model: typeof model === 'string' ? model : undefined,
      isolation,
      state: 'READY',
      ownerPid: this.#ownerPid,
      runtimeInstanceId: this.#runtimeInstanceId,
      metadata: structuredClone(metadata),
      ...(normalizedAdapterIdentity === undefined ? {} : {
        adapterIdentity: normalizedAdapterIdentity,
        adapterIdentityDigest: identityDigest(normalizedAdapterIdentity)
      }),
      ...(normalizedThreadId === undefined ? {} : { threadId: safeText(normalizedThreadId, 'THREAD_ID') }),
      ...(normalizedBindingSnapshot === undefined ? {} : {
        bindingSnapshot: normalizedBindingSnapshot,
        bindingSnapshotDigest: snapshotDigest(normalizedBindingSnapshot)
      }),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    });
    if (!deferStore) this.#contexts.set(context.contextId, context);
    if (!deferPersist) this.#schedulePersist();
    return structuredClone(context);
  }

  async transitionDurably(contextId, state, reason) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const current = this.#require(contextId);
    if (!STATES.includes(state)) throw new Error('ROLE_CONTEXT_STATE_INVALID');
    if (!(TRANSITIONS[current.state] ?? []).includes(state)) throw new Error(current.state === 'CLOSED' ? 'ROLE_CONTEXT_CLOSED' : 'ROLE_CONTEXT_INVALID_TRANSITION:' + current.state + '->' + state);
    await this.#eventStore.append({
      runId: current.runId,
      aggregateType: 'RoleContext',
      aggregateId: current.contextId,
      kind: 'RoleContextStateChanged',
      payload: { contextId: current.contextId, runId: current.runId, role: current.role, from: current.state, to: state, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) },
      sensitivity: 'INTERNAL'
    });
    return this.#replace(current, { state, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) });
  }

  fork(parent, { mode = 'EPHEMERAL', role = parent?.role } = {}) {
    const current = this.#require(parent?.contextId);
    if (current.state === 'CLOSED' || current.state === 'FAILED') throw new Error('ROLE_CONTEXT_NOT_FORKABLE');
    return this.allocate({ runId: current.runId, role, model: current.model, isolation: 'DEDICATED', metadata: { parentContextId: current.contextId, mode } });
  }

  setBusy(contextId) { return this.#transition(contextId, 'BUSY'); }
  interrupt(contextId, reason = '') { return this.#transition(contextId, 'INTERRUPTING', reason); }
  close(contextId) { return this.#transition(contextId, 'CLOSED'); }
  recover(contextId, expected = {}) {
    const current = this.#require(contextId);
    const mismatch = this.#resumeIdentityMismatch(current, expected);
    if (mismatch.length && current.state !== 'CLOSED') {
      const replacement = this.allocate({
        runId: current.runId,
        role: current.role,
        model: current.model,
        isolation: current.isolation,
        adapterIdentity: Object.hasOwn(expected, 'adapterIdentity')
          ? expected.adapterIdentity
          : Object.hasOwn(expected, 'adapterId') ? expected.adapterId : current.adapterIdentity,
        threadId: Object.hasOwn(expected, 'threadId')
          ? expected.threadId
          : Object.hasOwn(expected, 'externalThreadId') ? expected.externalThreadId : current.threadId,
        bindingSnapshot: Object.hasOwn(expected, 'bindingSnapshot') ? expected.bindingSnapshot : current.bindingSnapshot,
        metadata: {
          ...(current.metadata && typeof current.metadata === 'object' ? clone(current.metadata) : {}),
          parentContextId: current.contextId,
          replacementReason: 'RESUME_IDENTITY_MISMATCH',
          replacementFields: mismatch
        }
      });
      this.#replace(current, {
        state: 'CLOSED',
        reason: 'RESUME_IDENTITY_MISMATCH',
        replacedByContextId: replacement.contextId
      });
      return replacement;
    }
    // A closed context has released its adapter/thread and must not be
    // resurrected. Only interrupted or failed contexts can be made ready.
    if (!['INTERRUPTING', 'FAILED'].includes(current.state)) return structuredClone(current);
    return this.#replace(current, { state: 'READY' });
  }
  /** Return the fields that would prevent a context from being resumed. */
  validateResume(contextId, expected = {}) {
    const current = this.#require(contextId);
    const mismatches = this.#resumeIdentityMismatch(current, expected);
    return { contextId, valid: mismatches.length === 0, mismatches };
  }
  get hasDurableSink() { return Boolean(this.#eventStore && typeof this.#eventStore.append === 'function'); }
  get(contextId) { const context = this.#contexts.get(contextId); return context ? structuredClone(context) : undefined; }
  list(runId) { return [...this.#contexts.values()].filter((context) => !runId || context.runId === runId).map((context) => structuredClone(context)); }
  async flush() { await this.#queue; }

  async reconcile({ isOwnerAlive = defaultOwnerAlive } = {}) {
    if (typeof isOwnerAlive !== 'function') throw new Error('ROLE_CONTEXT_RECONCILE_INVALID');
    await this.load();
    const reconciled = [];
    for (const context of this.#contexts.values()) {
      if (!['ALLOCATING', 'BUSY', 'INTERRUPTING', 'CLOSING'].includes(context.state)) continue;
      const ownerAlive = Number.isInteger(context.ownerPid) && context.ownerPid > 0 && isOwnerAlive(context.ownerPid);
      if (ownerAlive) continue;
      reconciled.push(this.#replace(context, { state: 'FAILED', reason: 'OWNER_PROCESS_LOST' }));
    }
    await this.flush();
    return {
      reconciled: reconciled.length,
      contexts: reconciled.map((context) => ({
        contextId: context.contextId,
        runId: context.runId,
        role: context.role,
        state: context.state,
        reason: context.reason
      }))
    };
  }

  #resumeIdentityMismatch(current, expected) {
    if (expected === undefined) return [];
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('ROLE_CONTEXT_RESUME_IDENTITY_INVALID');
    const mismatch = [];
    const hasExpectedAdapterIdentity = Object.hasOwn(expected, 'adapterIdentity') || Object.hasOwn(expected, 'adapterId');
    const expectedAdapterIdentity = Object.hasOwn(expected, 'adapterIdentity')
      ? expected.adapterIdentity
      : Object.hasOwn(expected, 'adapterId') ? expected.adapterId : undefined;
    if (hasExpectedAdapterIdentity) {
      const value = normalizeIdentity(expectedAdapterIdentity);
      if (identityDigest(value) !== current.adapterIdentityDigest) mismatch.push('adapterIdentity');
    }
    const hasExpectedThreadId = Object.hasOwn(expected, 'threadId') || Object.hasOwn(expected, 'externalThreadId');
    const expectedThreadId = Object.hasOwn(expected, 'threadId')
      ? expected.threadId
      : Object.hasOwn(expected, 'externalThreadId') ? expected.externalThreadId : undefined;
    if (hasExpectedThreadId) {
      const value = expectedThreadId === undefined ? undefined : safeText(expectedThreadId, 'THREAD_ID');
      if (value !== current.threadId) mismatch.push('threadId');
    }
    if (Object.hasOwn(expected, 'bindingSnapshot')) {
      if (expected.bindingSnapshot === undefined) {
        if (current.bindingSnapshotDigest !== undefined) mismatch.push('bindingSnapshot');
      } else {
        const value = normalizeSnapshot(expected.bindingSnapshot);
        if (snapshotDigest(value) !== current.bindingSnapshotDigest) mismatch.push('bindingSnapshot');
      }
    } else if (Object.hasOwn(expected, 'bindingSnapshotDigest')) {
      if (expected.bindingSnapshotDigest === undefined) {
        if (current.bindingSnapshotDigest !== undefined) mismatch.push('bindingSnapshot');
      } else {
        if (typeof expected.bindingSnapshotDigest !== 'string' || !DIGEST.test(expected.bindingSnapshotDigest)) throw new Error('ROLE_CONTEXT_INVALID_BINDING_SNAPSHOT_DIGEST');
        if (expected.bindingSnapshotDigest !== current.bindingSnapshotDigest) mismatch.push('bindingSnapshot');
      }
    }
    return mismatch;
  }

  #require(contextId) {
    const context = this.#contexts.get(contextId);
    if (!context) throw new Error('ROLE_CONTEXT_NOT_FOUND');
    return context;
  }
  #transition(contextId, state, reason) {
    const current = this.#require(contextId);
    if (!STATES.includes(state)) throw new Error('ROLE_CONTEXT_STATE_INVALID');
    if (!(TRANSITIONS[current.state] ?? []).includes(state)) {
      throw new Error(current.state === 'CLOSED' ? 'ROLE_CONTEXT_CLOSED' : `ROLE_CONTEXT_INVALID_TRANSITION:${current.state}->${state}`);
    }
    return this.#replace(current, { state, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) });
  }
  #replace(current, patch) {
    const next = Object.freeze({ ...current, ...patch, updatedAtMs: Date.now() });
    this.#contexts.set(current.contextId, next);
    this.#schedulePersist();
    return structuredClone(next);
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: '1.0', contexts: this.list() }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'contexts', id: 'contextId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createRoleSessionManager = (options) => new RoleSessionManager(options);
export { STATES as ROLE_CONTEXT_STATES, TRANSITIONS as ROLE_CONTEXT_TRANSITIONS };

const defaultOwnerAlive = (pid) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};
