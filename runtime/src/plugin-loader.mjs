import { createHash, randomUUID, verify } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginGovernanceDigest } from './plugin-governance.mjs';
import { preferMappedPath } from './windows-path.mjs';
import { resolveReleaseChannel } from './release-channel.mjs';

const MAX_PLUGIN_BYTES = 2 * 1024 * 1024;
const MODULE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);
const CONTRIBUTION_TYPES = new Set([
  'agent', 'skill', 'verifier', 'model-provider', 'executor', 'workspace',
  'approval', 'ui-contribution', 'tooling'
]);
const PERMISSION_CEILINGS = new Set(['READ_ONLY', 'CONTROLLED']);
const SIGNATURE_ALGORITHMS = new Set(['ed25519']);
// This is the host permission vocabulary. Unknown permissions are rejected so
// a typo cannot silently turn into a future capability grant.
const KNOWN_PERMISSIONS = new Set([
  'workspace.read.metadata', 'workspace.read.content', 'workspace.read.snapshot',
  'workspace.write.patch', 'filesystem.write.workspace',
  'process.execute.argv', 'process.execute.shell', 'process.spawn.restricted',
  'network.connect.host', 'trajectory.read.redacted', 'trajectory.write',
  'profile.read', 'profile.propose-update', 'ui.render.timeline-item',
  'executor.invoke.controlled', 'thread.read', 'thread.write',
  'plugin.manifest.read', 'plugin.registry.write'
]);

const digestBytes = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const clone = (value) => structuredClone(value);
const mappedRealpath = async (value) => preferMappedPath(await realpath(value));
const inside = (root, candidate) => {
  const suffix = relative(root, candidate);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${candidate.includes('\\') ? '\\' : '/'}`) && !isAbsolute(suffix));
};

const manifestValid = (manifest) => manifest && typeof manifest === 'object' && !Array.isArray(manifest)
  && typeof manifest.id === 'string' && /^[a-z][a-z0-9._-]{1,127}$/i.test(manifest.id)
  && typeof manifest.version === 'string' && manifest.version.length <= 64
  && Array.isArray(manifest.contributions) && manifest.contributions.length <= 64;

const versionPattern = /^\d+\.\d+(?:\.\d+)?$/u;
const rangePattern = /^\s*>=\s*(\d+)\.(\d+)(?:\.\d+)?\s+<\s*(\d+)\.(\d+)(?:\.\d+)?\s*$/u;

const validApiRange = (value) => {
  if (typeof value !== 'string') return false;
  const match = rangePattern.exec(value);
  if (!match) return false;
  const lowerMajor = Number(match[1]);
  const upperMajor = Number(match[3]);
  return lowerMajor <= 1 && upperMajor > 1;
};

const validPermission = (value) => typeof value === 'string'
  && KNOWN_PERMISSIONS.has(value);

const validCapability = (value) => typeof value === 'string'
  && /^[a-z][a-z0-9._-]{1,127}$/iu.test(value);

/**
 * Validate the host-facing part of a dynamic manifest without importing it.
 * Fields introduced after the initial local MVP remain optional for backward
 * compatibility, but malformed values are always rejected fail-closed.
 */
export const validatePluginManifest = (manifest) => {
  if (!manifestValid(manifest)) throw new Error('PLUGIN_MANIFEST_INVALID');
  if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== '1.0') {
    throw new Error('PLUGIN_SCHEMA_VERSION_UNSUPPORTED');
  }
  for (const field of ['pluginApi', 'harnessProtocol']) {
    if (manifest[field] !== undefined && !validApiRange(manifest[field])) {
      throw new Error(`PLUGIN_${field === 'pluginApi' ? 'API' : 'HARNESS_PROTOCOL'}_RANGE_INVALID`);
    }
  }
  if (manifest.version !== undefined && !versionPattern.test(manifest.version)) {
    throw new Error('PLUGIN_VERSION_INVALID');
  }
  const seenContributions = new Set();
  for (const contribution of manifest.contributions) {
    if (!contribution || typeof contribution !== 'object' || Array.isArray(contribution)) {
      throw new Error('PLUGIN_CONTRIBUTION_INVALID');
    }
    if (typeof contribution.id !== 'string' || !/^[a-z][a-z0-9._-]{1,127}$/iu.test(contribution.id) || seenContributions.has(contribution.id)) {
      throw new Error('PLUGIN_CONTRIBUTION_ID_INVALID');
    }
    seenContributions.add(contribution.id);
    if (typeof contribution.type !== 'string' || !CONTRIBUTION_TYPES.has(contribution.type)) {
      throw new Error('PLUGIN_CONTRIBUTION_TYPE_INVALID');
    }
    if (contribution.entrypoint !== undefined && (typeof contribution.entrypoint !== 'string' || !contribution.entrypoint.trim() || /^([a-z]+:|[\\/])/iu.test(contribution.entrypoint) || /[\\/]/u.test(contribution.entrypoint))) {
      throw new Error('PLUGIN_CONTRIBUTION_ENTRYPOINT_INVALID');
    }
    for (const field of ['capabilities', 'permissions']) {
      if (contribution[field] === undefined) continue;
      if (!Array.isArray(contribution[field]) || contribution[field].length > 64 || contribution[field].some((value) => typeof value !== 'string' || !value.trim())) {
        throw new Error(`PLUGIN_${field.toUpperCase()}_INVALID`);
      }
    }
    if (contribution.capabilities?.some((value) => !validCapability(value))) {
      throw new Error('PLUGIN_CAPABILITIES_INVALID');
    }
    if (contribution.permissions?.some((value) => !validPermission(value))) {
      throw new Error('PLUGIN_PERMISSIONS_UNDECLARED');
    }
    if (contribution.permissionCeiling !== undefined && !PERMISSION_CEILINGS.has(contribution.permissionCeiling)) {
      throw new Error('PLUGIN_PERMISSION_CEILING_INVALID');
    }
  }
  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length > 64) throw new Error('PLUGIN_DEPENDENCIES_INVALID');
    const seenDependencies = new Set();
    for (const dependency of manifest.dependencies) {
      if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency) || typeof dependency.id !== 'string' || !/^[a-z][a-z0-9._-]{1,127}$/iu.test(dependency.id) || seenDependencies.has(dependency.id)) {
        throw new Error('PLUGIN_DEPENDENCY_INVALID');
      }
      if (dependency.id === manifest.id) throw new Error('PLUGIN_DEPENDENCY_SELF');
      seenDependencies.add(dependency.id);
      if (typeof dependency.range !== 'string' || !dependency.range.trim()) throw new Error('PLUGIN_DEPENDENCY_RANGE_INVALID');
      if (!versionPattern.test(dependency.range) && !validApiRange(dependency.range)) throw new Error('PLUGIN_DEPENDENCY_RANGE_INVALID');
      if (dependency.optional !== undefined && typeof dependency.optional !== 'boolean') throw new Error('PLUGIN_DEPENDENCY_OPTIONAL_INVALID');
    }
  }
  return structuredClone(manifest);
};

const parsedVersion = (value) => {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
};

const dependencyRangeMatches = (version, range) => {
  const actual = parsedVersion(version);
  if (!actual) return false;
  if (versionPattern.test(range)) {
    const expected = parsedVersion(range);
    return expected && actual[0] === expected[0] && actual[1] === expected[1]
      && (range.split('.').length < 3 || actual[2] === expected[2]);
  }
  const match = rangePattern.exec(range);
  if (!match) return false;
  const lower = [Number(match[1]), Number(match[2]), 0];
  const upper = [Number(match[3]), Number(match[4]), 0];
  return (actual[0] > lower[0] || (actual[0] === lower[0] && (actual[1] > lower[1] || (actual[1] === lower[1] && actual[2] >= lower[2]))))
    && (actual[0] < upper[0] || (actual[0] === upper[0] && actual[1] < upper[1]));
};

/**
 * Resolve dependencies against the immutable governance snapshot. Built-in
 * IDs are supplied by the host because they are not governance records.
 */
export const validatePluginDependencies = (manifest, { records = [], builtinIds = [] } = {}) => {
  validatePluginManifest(manifest);
  const byId = new Map(records.filter((record) => record?.pluginId).map((record) => [record.pluginId, record]));
  const builtins = new Set(builtinIds);
  for (const dependency of manifest.dependencies ?? []) {
    const record = byId.get(dependency.id);
    if (!record && !builtins.has(dependency.id)) {
      if (dependency.optional === true) continue;
      throw new Error(`PLUGIN_DEPENDENCY_MISSING:${dependency.id}`);
    }
    if (record) {
      if (record.state !== 'ACTIVE') throw new Error(`PLUGIN_DEPENDENCY_NOT_ACTIVE:${dependency.id}`);
      if (!dependencyRangeMatches(record.version, dependency.range)) {
        throw new Error(`PLUGIN_DEPENDENCY_VERSION_MISMATCH:${dependency.id}`);
      }
    }
  }
  return true;
};

const trustedPluginKeys = (env = process.env) => new Set(
  [env.HMCODEX_PLUGIN_TRUST_KEY, ...(env.HMCODEX_PLUGIN_TRUST_KEYS ?? '').split(',')]
    .flatMap((value) => (value ?? '').split(','))
    .map((value) => value.trim())
    .filter(Boolean)
);

const verifyPluginSignature = (manifest, signature, env = process.env) => {
  if (!signature || typeof signature !== 'object' || Array.isArray(signature)) {
    throw new Error('PLUGIN_SIGNATURE_INVALID');
  }
  if (signature.algorithm !== 'ed25519' || typeof signature.publicKey !== 'string'
    || typeof signature.signature !== 'string' || typeof signature.manifestDigest !== 'string') {
    throw new Error('PLUGIN_SIGNATURE_INVALID');
  }
  if (!trustedPluginKeys(env).has(signature.publicKey)) {
    throw new Error('PLUGIN_SIGNATURE_TRUST_UNAVAILABLE');
  }
  if (pluginGovernanceDigest(manifest) !== signature.manifestDigest) {
    throw new Error('PLUGIN_SIGNATURE_MANIFEST_MISMATCH');
  }
  const data = Buffer.from(JSON.stringify(manifest), 'utf8');
  let verified = false;
  try {
    verified = verify(null, data, signature.publicKey, Buffer.from(signature.signature, 'base64'));
  } catch {
    verified = false;
  }
  if (!verified) throw new Error('PLUGIN_SIGNATURE_INVALID');
  return structuredClone(signature);
};

/**
 * Loads a dynamic Cordis plugin only after host governance marks it ACTIVE.
 * Discovery never executes plugin code; activation verifies the exact file
 * digest again immediately before import. Loading does not grant permissions.
 */
export class DynamicPluginLoader {
  #rootDir;
  #governance;
  #registry;
  #importer;
  #loaded = new Map();

  constructor({ rootDir, governance, registry, importer = (url) => import(url) } = {}) {
    if (!rootDir || !governance || !registry) throw new Error('PLUGIN_LOADER_INVALID');
    this.#rootDir = rootDir;
    this.#governance = governance;
    this.#registry = registry;
    this.#importer = importer;
  }

  async discover({ manifest, entryPath, packageDigest, signature } = {}) {
    validatePluginManifest(manifest);
    const channel = resolveReleaseChannel();
    if (['WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL'].includes(channel) && !signature) {
      throw new Error('PLUGIN_SIGNATURE_REQUIRED');
    }
    const verifiedSignature = signature ? verifyPluginSignature(manifest, signature) : undefined;
    const file = await this.#authorizedFile(entryPath);
    const bytes = await readFile(file);
    const actualDigest = digestBytes(bytes);
    if (packageDigest !== undefined && packageDigest !== actualDigest) throw new Error('PLUGIN_PACKAGE_DIGEST_MISMATCH');
    const governedManifest = {
      ...clone(manifest),
      entryPath: relative(this.#rootDir, file).replaceAll('\\', '/'),
      entryDigest: actualDigest,
      ...(verifiedSignature ? { signature: verifiedSignature } : {})
    };
    const record = this.#governance.hasDurableSink
      ? await this.#governance.discoverDurably(governedManifest, { source: 'DYNAMIC_LOCAL' })
      : this.#governance.discover(governedManifest, { source: 'DYNAMIC_LOCAL' });
    return { ...record, entryDigest: actualDigest, ...(verifiedSignature ? { signature: verifiedSignature } : {}) };
  }

  async load(pluginId) {
    if (resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY') {
      throw new Error('RELEASE_CHANNEL_DYNAMIC_PLUGIN_DISABLED');
    }
    this.#governance.assertLoadable(pluginId);
    const record = this.#governance.get(pluginId);
    if (!record) throw new Error('PLUGIN_NOT_FOUND');
    if (record.state !== 'ACTIVE') throw new Error(`PLUGIN_NOT_ACTIVE:${record.state}`);
    const entryPath = record.manifest?.entryPath;
    const file = await this.#authorizedFile(entryPath);
    const bytes = await readFile(file);
    const actualDigest = digestBytes(bytes);
    if (actualDigest !== record.manifest?.entryDigest) throw new Error('PLUGIN_PACKAGE_DIGEST_MISMATCH');
    if (record.packageDigest !== pluginGovernanceDigest(record.manifest)) throw new Error('PLUGIN_RECORD_TAMPERED');
    const module = await this.#importer(`${pathToFileURL(file).href}?hmcodex=${randomUUID()}`);
    const plugin = module?.createPlugin ?? module?.createCordisPlugin ?? module?.default;
    const validPlugin = typeof plugin === 'function'
      || (plugin && typeof plugin === 'object' && typeof plugin.apply === 'function');
    if (!validPlugin) throw new Error('PLUGIN_ENTRYPOINT_INVALID');
    if (module?.manifest && pluginGovernanceDigest(module.manifest) !== pluginGovernanceDigest(record.manifest)) {
      throw new Error('PLUGIN_RUNTIME_MANIFEST_MISMATCH');
    }
    this.#registry.register(record.manifest);
    this.#loaded.set(pluginId, { plugin, loadedAtMs: Date.now(), entryDigest: actualDigest });
    return plugin;
  }

  get(pluginId) {
    const value = this.#loaded.get(pluginId);
    return value ? { pluginId, loadedAtMs: value.loadedAtMs, entryDigest: value.entryDigest } : undefined;
  }

  list() {
    return [...this.#loaded.entries()].map(([pluginId, value]) => ({
      pluginId,
      loadedAtMs: value.loadedAtMs,
      entryDigest: value.entryDigest
    }));
  }

  async #authorizedFile(entryPath) {
    if (typeof entryPath !== 'string' || !entryPath.trim()) throw new Error('PLUGIN_ENTRYPOINT_REQUIRED');
    const root = await mappedRealpath(this.#rootDir).catch(() => { throw new Error('PLUGIN_ROOT_UNAVAILABLE'); });
    const requested = resolve(root, entryPath);
    const file = await mappedRealpath(requested).catch(() => { throw new Error('PLUGIN_ENTRYPOINT_UNAVAILABLE'); });
    if (!inside(root, file)) throw new Error('PLUGIN_ENTRYPOINT_OUTSIDE_ROOT');
    if (!MODULE_EXTENSIONS.has(extname(file).toLowerCase())) throw new Error('PLUGIN_ENTRYPOINT_EXTENSION_INVALID');
    const metadata = await stat(file).catch(() => { throw new Error('PLUGIN_ENTRYPOINT_UNAVAILABLE'); });
    if (!metadata.isFile() || metadata.size > MAX_PLUGIN_BYTES) throw new Error('PLUGIN_ENTRYPOINT_INVALID');
    return file;
  }
}

export const createDynamicPluginLoader = (options) => new DynamicPluginLoader(options);
