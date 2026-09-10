import { createHash, randomUUID } from 'node:crypto';

const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
const clone = (value) => structuredClone(value);

/**
 * Coordinates side-by-side plugin versions. All callbacks are supplied by the
 * host and must be deterministic/sandboxed; a failed migration or self-test
 * leaves the previous active version untouched.
 */
export class PluginVersionLifecycle {
  #versions = new Map();
  #active = new Map();
  #now;
  #onChange;
  #operations = Promise.resolve();
  constructor({ now = () => Date.now(), onChange = () => {} } = {}) { this.#now = now; this.#onChange = typeof onChange === 'function' ? onChange : () => {}; }

  install({ pluginId, version, packageDigest, config = {} } = {}) {
    if (typeof pluginId !== 'string' || !pluginId || typeof version !== 'string' || !version || typeof packageDigest !== 'string' || !packageDigest) throw new Error('PLUGIN_VERSION_INSTALL_INVALID');
    const key = `${pluginId}@${version}`;
    if (this.#versions.has(key)) throw new Error('PLUGIN_VERSION_ALREADY_INSTALLED');
    const record = { pluginId, version, packageDigest, config: clone(config), state: 'INSTALLED', installedAtMs: this.#now(), lifecycleId: randomUUID() };
    this.#versions.set(key, record);
    this.#onChange();
    return clone(record);
  }

  list(pluginId) { return [...this.#versions.values()].filter((item) => !pluginId || item.pluginId === pluginId).map(clone); }
  active(pluginId) { const key = this.#active.get(pluginId); return key ? clone(this.#versions.get(key)) : undefined; }
  snapshot() { return { schemaVersion: '1.0', versions: this.list(), active: Object.fromEntries(this.#active.entries()) }; }
  restore(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== '1.0' || !Array.isArray(snapshot.versions) || !snapshot.active || typeof snapshot.active !== 'object') throw new Error('PLUGIN_VERSION_SNAPSHOT_INVALID');
    const versions = new Map();
    for (const record of snapshot.versions) {
      if (!record || typeof record.pluginId !== 'string' || typeof record.version !== 'string' || typeof record.packageDigest !== 'string' || !['INSTALLED', 'ACTIVE', 'ROLLED_BACK_AVAILABLE', 'ROLLED_BACK', 'DEGRADED'].includes(record.state)) throw new Error('PLUGIN_VERSION_SNAPSHOT_INVALID');
      const key = `${record.pluginId}@${record.version}`;
      if (versions.has(key)) throw new Error('PLUGIN_VERSION_SNAPSHOT_INVALID');
      versions.set(key, clone(record));
    }
    const active = new Map();
    for (const [pluginId, key] of Object.entries(snapshot.active)) {
      if (typeof pluginId !== 'string' || typeof key !== 'string' || !versions.has(key) || versions.get(key).pluginId !== pluginId || versions.get(key).state !== 'ACTIVE') throw new Error('PLUGIN_VERSION_SNAPSHOT_INVALID');
      active.set(pluginId, key);
    }
    this.#versions = versions;
    this.#active = active;
    return this.snapshot();
  }

  activate(pluginId, version, options = {}) {
    const run = () => this.#activate(pluginId, version, options);
    const result = this.#operations.then(run, run);
    this.#operations = result.catch(() => {});
    return result;
  }

  async #activate(pluginId, version, { migrate = async ({ to }) => ({ ok: true, config: to }), selfTest = async () => ({ ok: true }), shadow = async () => ({ ok: true }) } = {}) {
    const key = `${pluginId}@${version}`;
    const candidate = this.#versions.get(key);
    if (!candidate) throw new Error('PLUGIN_VERSION_NOT_INSTALLED');
    const previousKey = this.#active.get(pluginId);
    const previous = previousKey ? this.#versions.get(previousKey) : undefined;
    if (previousKey === key) return { activated: true, rolledBack: false, active: clone(candidate), idempotent: true };
    let migrated;
    try {
      migrated = await migrate({ from: previous ? clone(previous.config) : {}, to: clone(candidate.config), dryRun: true });
      if (!migrated || migrated.ok === false || !migrated.config) throw new Error('PLUGIN_CONFIG_MIGRATION_FAILED');
      const self = await selfTest({ pluginId, version, config: clone(migrated.config), shadow: false });
      if (!self?.ok) throw new Error('PLUGIN_SELF_TEST_FAILED');
      const shadowResult = await shadow({ pluginId, version, config: clone(migrated.config), shadow: true });
      if (!shadowResult?.ok) throw new Error('PLUGIN_SHADOW_FAILED');
    } catch (error) {
      candidate.state = 'DEGRADED';
      candidate.failureCode = String(error?.message ?? error).slice(0, 120);
      this.#onChange();
      return { activated: false, rolledBack: Boolean(previous), failureCode: candidate.failureCode, active: previous ? clone(previous) : undefined };
    }
    candidate.config = clone(migrated.config);
    candidate.state = 'ACTIVE';
    delete candidate.failureCode;
    candidate.activatedAtMs = this.#now();
    if (previous) previous.state = 'ROLLED_BACK_AVAILABLE';
    this.#active.set(pluginId, key);
    this.#onChange();
    return { activated: true, rolledBack: false, active: clone(candidate), previous: previous ? clone(previous) : undefined };
  }

  rollback(pluginId) {
    const run = () => this.#rollback(pluginId);
    const result = this.#operations.then(run, run);
    this.#operations = result.catch(() => {});
    return result;
  }

  async #rollback(pluginId) {
    const currentKey = this.#active.get(pluginId);
    const candidates = this.list(pluginId).filter((item) => item.state === 'ROLLED_BACK_AVAILABLE').sort((a, b) => b.activatedAtMs - a.activatedAtMs);
    if (!currentKey || !candidates.length) throw new Error('PLUGIN_PREVIOUS_VERSION_UNAVAILABLE');
    const previous = candidates[0];
    this.#versions.get(currentKey).state = 'ROLLED_BACK';
    this.#versions.get(`${pluginId}@${previous.version}`).state = 'ACTIVE';
    this.#active.set(pluginId, `${pluginId}@${previous.version}`);
    this.#onChange();
    return clone(previous);
  }
}

export { digest as pluginVersionDigest };
