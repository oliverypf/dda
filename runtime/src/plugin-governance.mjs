import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';
import { PluginVersionLifecycle } from './plugin-version-lifecycle.mjs';

const STATES = Object.freeze(['DISCOVERED', 'VALIDATING', 'INSTALLED', 'DISABLED', 'ENABLED', 'ACTIVE', 'DEGRADED', 'QUARANTINED', 'REJECTED', 'REMOVED']);
const transitions = Object.freeze({ DISCOVERED: ['VALIDATING', 'REJECTED'], VALIDATING: ['INSTALLED', 'REJECTED'], INSTALLED: ['DISABLED', 'ENABLED'], DISABLED: ['ENABLED', 'REMOVED'], ENABLED: ['ACTIVE', 'DEGRADED', 'QUARANTINED'], DEGRADED: ['ACTIVE', 'QUARANTINED'], ACTIVE: ['QUARANTINED', 'DISABLED'], QUARANTINED: ['VALIDATING', 'REMOVED'] });
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 1024;
const MAX_HISTORY = 64;
const SENSITIVE_KEY = /^(?:api[_-]?key|secret|password|credential|authorization|private[_-]?key)$/i;
const assertSafeManifest = (value, depth = 0) => {
  if (depth > 8) throw new Error('PLUGIN_MANIFEST_INVALID');
  if (Array.isArray(value)) { for (const item of value) assertSafeManifest(item, depth + 1); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error('PLUGIN_MANIFEST_INVALID');
    assertSafeManifest(child, depth + 1);
  }
};


const immutableRecord = (record) => ({
  pluginId: record.pluginId,
  version: record.version,
  manifest: record.manifest,
  source: record.source,
  packageDigest: record.packageDigest,
  createdAtMs: record.createdAtMs
});

const recordDigest = (record) => digest(immutableRecord(record));
const lifecycleDigest = (record) => digest({
  state: record.state,
  updatedAtMs: record.updatedAtMs,
  ...(record.transition === undefined ? {} : { transition: record.transition }),
  history: Array.isArray(record.history) ? record.history : []
});

const validateStoredRecord = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (typeof record.pluginId !== 'string' || typeof record.version !== 'string' ||
    !record.manifest || typeof record.manifest !== 'object' || typeof record.packageDigest !== 'string' ||
    !STATES.includes(record.state) || typeof record.recordDigest !== 'string') return false;
  if (record.recordDigest !== recordDigest(record)) return false;
  // Older governance stores predate lifecycle sealing and remain readable;
  // records written by this version must reject state/history tampering.
  return record.lifecycleDigest === undefined || record.lifecycleDigest === lifecycleDigest(record);
};

export class PluginGovernance {
  #records = new Map();
  #storagePath;
  #now;
  #idFactory;
  #requireEvaluation;
  #evaluationVerifier;
  #queue = Promise.resolve();
  #loaded = false;
  #eventStore;
  #commands = Promise.resolve();
  #versionLifecycle;

  constructor({ storagePath, now = () => Date.now(), idFactory = randomUUID, requireEvaluation = false, evaluationVerifier, evolutionEvaluator, eventStore } = {}) {
    this.#storagePath = storagePath;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#requireEvaluation = requireEvaluation === true || evolutionEvaluator !== undefined;
    if (evaluationVerifier !== undefined && typeof evaluationVerifier !== 'function') throw new Error('PLUGIN_EVALUATION_VERIFIER_INVALID');
    if (evolutionEvaluator !== undefined && (evolutionEvaluator === null || typeof evolutionEvaluator.verifyPluginPromotion !== 'function')) {
      throw new Error('PLUGIN_EVALUATOR_INVALID');
    }
    this.#evaluationVerifier = evaluationVerifier ?? (evolutionEvaluator
      ? ({ plugin, evidence }) => evolutionEvaluator.verifyPluginPromotion({
          ...evidence,
          pluginId: plugin.pluginId,
          packageDigest: plugin.packageDigest
        }) === true
      : undefined);
    if (eventStore !== undefined && (!eventStore || typeof eventStore.append !== 'function')) throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    this.#eventStore = eventStore;
    this.#versionLifecycle = new PluginVersionLifecycle({ now, onChange: () => this.#schedulePersist() });
  }

  get versionLifecycle() { return this.#versionLifecycle; }

  installVersion(input) { return this.#versionLifecycle.install(input); }
  activateVersion(pluginId, version, options) { return this.#versionLifecycle.activate(pluginId, version, options); }
  rollbackVersion(pluginId) { return this.#versionLifecycle.rollback(pluginId); }
  listVersions(pluginId) { return this.#versionLifecycle.list(pluginId); }
  versionLifecycleSnapshot() { return this.#versionLifecycle.snapshot(); }
  restoreVersionLifecycle(snapshot) { return this.#versionLifecycle.restore(snapshot); }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath && this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'PluginGovernance' }); }
      catch { throw new Error('PLUGIN_GOVERNANCE_READ_FAILED'); }
      let projected = false;
      for (const event of events) {
        if (!['PluginDiscovered', 'PluginStateChangeCommitted'].includes(event.kind)) continue;
        if (!Object.hasOwn(event.payload ?? {}, 'record')) continue;
        const record = event.payload.record;
        if (!validateStoredRecord(record) || typeof record.lifecycleDigest !== 'string' ||
            record.pluginId !== event.aggregateId || record.pluginId !== event.payload.pluginId ||
            record.recordDigest !== event.payload.recordDigest) throw new Error('PLUGIN_GOVERNANCE_INVALID');
        const prior = this.#records.get(record.pluginId);
        if (event.kind === 'PluginDiscovered') {
          if (prior || record.state !== 'DISCOVERED' || record.history.length !== 0) throw new Error('PLUGIN_GOVERNANCE_INVALID');
        } else {
          if (!prior || event.payload.from !== prior.state || event.payload.to !== record.state ||
              !(transitions[prior.state] ?? []).includes(record.state) ||
              record.history.length !== prior.history.length + 1) throw new Error('PLUGIN_GOVERNANCE_INVALID');
        }
        this.#records.set(record.pluginId, structuredClone(record));
        projected = true;
      }
      if (projected) { this.#loaded = true; return; }
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try {
      parsed = await readPersistentJsonFile(this.#storagePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('PLUGIN_GOVERNANCE_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.plugins) || parsed.plugins.length > MAX_RECORDS || parsed.plugins.some((record) => !validateStoredRecord(record))) {
      throw new Error('PLUGIN_GOVERNANCE_INVALID');
    }
    const ids = new Set();
    for (const record of parsed.plugins) {
      if (ids.has(record.pluginId)) throw new Error('PLUGIN_GOVERNANCE_INVALID');
      ids.add(record.pluginId);
      this.#records.set(record.pluginId, structuredClone(record));
    }
    if (parsed.versionLifecycle !== undefined) this.#versionLifecycle.restore(parsed.versionLifecycle);
    this.#loaded = true;
  }

  discover(manifest, { source = 'LOCAL_DEVELOPMENT' } = {}) {
    this.#assertLegacyWrite();
    if (!manifest || typeof manifest.id !== 'string' || !manifest.version || !Array.isArray(manifest.contributions)) throw new Error('PLUGIN_MANIFEST_INVALID');
    assertSafeManifest(manifest);
    if (this.#records.has(manifest.id)) throw new Error('PLUGIN_ALREADY_EXISTS');
    if (this.#records.size >= MAX_RECORDS) throw new Error('PLUGIN_GOVERNANCE_FULL');
    const now = this.#now();
    const record = { pluginId: manifest.id, version: manifest.version, manifest: structuredClone(manifest), source: String(source).slice(0, 80), packageDigest: digest(manifest), state: 'DISCOVERED', createdAtMs: now, updatedAtMs: now, history: [], recordDigest: undefined, lifecycleDigest: undefined };
    record.recordDigest = recordDigest(record);
    record.lifecycleDigest = lifecycleDigest(record);
    this.#records.set(record.pluginId, record);
    this.#schedulePersist();
    return structuredClone(record);
  }
  get hasDurableSink() { return Boolean(this.#eventStore); }

  async transitionDurably(pluginId, state, metadata = {}) {
    const detached = structuredClone(metadata);
    return this.#enqueueCommand(() => this.#durableTransitionLoaded(pluginId, state, detached));
  }

  async #durableTransitionLoaded(pluginId, state, detached) {
      const current = this.#records.get(pluginId); if (!current) throw new Error('PLUGIN_NOT_FOUND');
      if (!STATES.includes(state) || !(transitions[current.state] ?? []).includes(state)) throw new Error('PLUGIN_INVALID_TRANSITION:' + current.state + '->' + state);
      if (state === 'ACTIVE' && this.#requireEvaluation) this.#assertEvaluation(current, detached);
      const transition = { from: current.state, to: state, metadata: detached, atMs: this.#now() };
      const next = { ...current, state, updatedAtMs: transition.atMs, transition, history: [...(Array.isArray(current.history) ? current.history : []), transition].slice(-MAX_HISTORY) };
      next.recordDigest = recordDigest(next);
      next.lifecycleDigest = lifecycleDigest(next);
      assertSafeManifest(next.manifest);
      assertSafeManifest(next.history);
      const payload = { pluginId: current.pluginId, version: current.version, packageDigest: current.packageDigest, from: current.state, to: state, recordDigest: next.recordDigest, lifecycleDigest: next.lifecycleDigest, metadataDigest: digest(detached), record: structuredClone(next) };
      const result = await this.#eventStore.append({ runId: 'plugin:' + current.pluginId, aggregateType: 'PluginGovernance', aggregateId: current.pluginId, commandId: 'plugin-transition:' + current.pluginId + ':' + next.lifecycleDigest, kind: 'PluginStateChangeCommitted', payload, sensitivity: 'SECURITY_AUDIT' });
      this.#assertCommitted(result, 'PluginStateChangeCommitted', current.pluginId, payload);
      const previous = this.#records.get(pluginId);
      this.#records.set(pluginId, next);
      this.#schedulePersist();
      try {
        await this.#queue;
      } catch (error) {
        if (previous) this.#records.set(pluginId, previous); else this.#records.delete(pluginId);
        throw error;
      }
      return structuredClone(next);
  }

  async discoverDurably(manifest, { source = 'LOCAL_DEVELOPMENT' } = {}) {
    const detached = structuredClone(manifest);
    return this.#enqueueCommand(async () => {
      manifest = detached;
      if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    if (!manifest || typeof manifest.id !== 'string' || !manifest.version || !Array.isArray(manifest.contributions)) throw new Error('PLUGIN_MANIFEST_INVALID');
    assertSafeManifest(manifest);
    if (this.#records.has(manifest.id)) throw new Error('PLUGIN_ALREADY_EXISTS');
    if (this.#records.size >= MAX_RECORDS) throw new Error('PLUGIN_GOVERNANCE_FULL');
    const now = this.#now();
    const record = { pluginId: manifest.id, version: manifest.version, manifest: structuredClone(manifest), source: String(source).slice(0, 80), packageDigest: digest(manifest), state: 'DISCOVERED', createdAtMs: now, updatedAtMs: now, history: [], recordDigest: undefined, lifecycleDigest: undefined };
    record.recordDigest = recordDigest(record);
    record.lifecycleDigest = lifecycleDigest(record);
    const payload = { pluginId: record.pluginId, version: record.version, source: record.source, packageDigest: record.packageDigest, recordDigest: record.recordDigest, record: structuredClone(record) };
    const result = await this.#eventStore.append({ runId: 'plugin:' + record.pluginId, aggregateType: 'PluginGovernance', aggregateId: record.pluginId, commandId: 'plugin-discover:' + record.pluginId + ':' + record.recordDigest, kind: 'PluginDiscovered', payload, sensitivity: 'SECURITY_AUDIT' });
    this.#assertCommitted(result, 'PluginDiscovered', record.pluginId, payload);
    const frozen = Object.freeze(structuredClone(record));
    this.#records.set(record.pluginId, frozen);
    this.#schedulePersist();
    try {
      await this.#queue;
    } catch (error) {
      this.#records.delete(record.pluginId);
      throw error;
    }
    return structuredClone(frozen);
    });
  }

  transition(pluginId, state, metadata = {}) {
    this.#assertLegacyWrite();
    return this.#transitionUnsafe(pluginId, state, metadata);
  }

  #transitionUnsafe(pluginId, state, metadata = {}) {
    const current = this.#records.get(pluginId); if (!current) throw new Error('PLUGIN_NOT_FOUND');
    if (!STATES.includes(state) || !(transitions[current.state] ?? []).includes(state)) throw new Error(`PLUGIN_INVALID_TRANSITION:${current.state}->${state}`);
    if (state === 'ACTIVE' && this.#requireEvaluation) this.#assertEvaluation(current, metadata);
    const transition = { from: current.state, to: state, metadata: structuredClone(metadata), atMs: this.#now() };
    const next = { ...current, state, updatedAtMs: transition.atMs, transition, history: [...(Array.isArray(current.history) ? current.history : []), transition].slice(-MAX_HISTORY) };
    next.recordDigest = recordDigest(next);
    next.lifecycleDigest = lifecycleDigest(next);
    this.#records.set(pluginId, next);
    this.#schedulePersist();
    return structuredClone(next);
  }
  async validateDurably(pluginId, { expectedDigest } = {}) {
    return this.#enqueueCommand(async () => {
      const current = this.#records.get(pluginId); if (!current) throw new Error('PLUGIN_NOT_FOUND');
      const state = expectedDigest && expectedDigest !== current.packageDigest ? 'REJECTED' : 'VALIDATING';
      const metadata = state === 'REJECTED' ? { reason: 'PACKAGE_DIGEST_MISMATCH' } : {};
      return this.#durableTransitionLoaded(pluginId, state, metadata);
    });
  }
  validate(pluginId, { expectedDigest } = {}) {
    const current = this.#records.get(pluginId); if (!current) throw new Error('PLUGIN_NOT_FOUND');
    if (expectedDigest && expectedDigest !== current.packageDigest) return this.transition(pluginId, 'REJECTED', { reason: 'PACKAGE_DIGEST_MISMATCH' });
    return this.transition(pluginId, 'VALIDATING');
  }
  list() { return [...this.#records.values()].map((record) => structuredClone(record)); }
  get(pluginId) { const record = this.#records.get(pluginId); return record ? structuredClone(record) : undefined; }

  assertLoadable(pluginId) {
    const record = this.#records.get(pluginId);
    if (!record) throw new Error('PLUGIN_NOT_FOUND');
    if (record.state !== 'ACTIVE') throw new Error(`PLUGIN_NOT_ACTIVE:${record.state}`);
    if (this.#requireEvaluation) this.#assertEvaluation(record, record.transition?.metadata);
    return structuredClone(record);
  }

  async revoke(pluginId, reason = 'REVOKED') {
    const current = this.#records.get(pluginId);
    if (!current) throw new Error('PLUGIN_NOT_FOUND');
    const state = ['ACTIVE', 'ENABLED', 'DEGRADED'].includes(current.state) ? 'QUARANTINED' : 'REJECTED';
    const plugin = this.hasDurableSink
      ? await this.transitionDurably(pluginId, state, { reason, revocation: true })
      : this.transition(pluginId, state, { reason, revocation: true });
    return plugin;
  }

  #enqueueCommand(operation) {
    if (!this.hasDurableSink) throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const execute = async () => { await this.load(); return operation(); };
    this.#commands = this.#commands.then(execute, execute);
    void this.#commands.catch(() => {});
    return this.#commands;
  }

  #assertCommitted(result, kind, aggregateId, payload) {
    const receipt = result?.receipt ?? result;
    const event = result?.event ?? result?.events?.[0];
    if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId) || event.kind !== kind || event.aggregateId !== aggregateId || digest(event.payload) !== digest(payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
  }

  #assertLegacyWrite() {
    if (this.hasDurableSink) throw new Error('PLUGIN_DURABLE_API_REQUIRED');
  }

  async flush() { await this.#commands; await this.#queue; }

  #assertEvaluation(plugin, metadata) {
    const evidence = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata.evaluation ?? metadata.evaluationCredential)
      : undefined;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) ||
        typeof evidence.reportId !== 'string' || typeof evidence.reportDigest !== 'string') {
      throw new Error('PLUGIN_EVALUATION_REQUIRED');
    }
    if (evidence.pluginId !== plugin.pluginId || evidence.packageDigest !== plugin.packageDigest) {
      throw new Error('PLUGIN_EVALUATION_BINDING_MISMATCH');
    }
    let verified = false;
    try {
      verified = this.#evaluationVerifier?.({ plugin: structuredClone(plugin), evidence: structuredClone(evidence) }) === true;
    } catch {
      verified = false;
    }
    if (!verified) throw new Error('PLUGIN_EVALUATION_INVALID');
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: SCHEMA_VERSION, plugins: this.list(), versionLifecycle: this.#versionLifecycle.snapshot() }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'plugins', id: 'pluginId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createPluginGovernance = (options) => new PluginGovernance(options);
export { STATES as PLUGIN_GOVERNANCE_STATES, digest as pluginGovernanceDigest, lifecycleDigest as pluginGovernanceLifecycleDigest };
