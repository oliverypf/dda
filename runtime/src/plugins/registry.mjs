import { createHash } from 'node:crypto';

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

/**
 * Cordis owns lifecycle; this registry owns the immutable, user-visible
 * identity of each contribution. Candidate versions are kept separate from
 * active versions so a model cannot silently replace a live plugin.
 */
export class PluginRegistry {
  #plugins = new Map();

  register(manifest) {
    if (!manifest || typeof manifest.id !== 'string' || !manifest.id) {
      throw new Error('PLUGIN_INVALID_MANIFEST');
    }
    if (this.#plugins.has(manifest.id)) {
      throw new Error(`PLUGIN_DUPLICATE:${manifest.id}`);
    }
    const snapshot = structuredClone(manifest);
    const digest = `sha256:${createHash('sha256').update(canonicalJson(snapshot)).digest('hex')}`;
    this.#plugins.set(snapshot.id, {
      manifest: deepFreeze(snapshot),
      digest,
      lifecycle: 'ACTIVE',
      source: 'BUNDLED_SIGNED'
    });
  }

  list() {
    return [...this.#plugins.values()].map(({ manifest, digest, lifecycle, source }) => ({
      ...manifest,
      digest,
      lifecycle,
      source
    }));
  }
}

export const pluginManifest = (id, name, type, capabilities, permissions = []) => ({
  schemaVersion: '1.0',
  id,
  name,
  version: '0.1.0',
  publisher: { id: 'com.hmcodex', displayName: 'hmCodex' },
  pluginApi: '>=1.0 <2.0',
  harnessProtocol: '>=1.0 <2.0',
  platform: { kind: 'node-cordis', os: ['windows'] },
  contributions: [{
    id: `${id}.contribution`,
    type,
    entrypoint: id,
    capabilities,
    permissions,
    permissionCeiling: 'READ_ONLY'
  }]
});
