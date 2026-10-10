import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Release supply-chain facts for S2-13.
 *
 * Everything here is derived from real files and stores: package lock files,
 * the plugin governance store, the model registry and previously generated
 * evidence artifacts. Nothing is invented, and a missing input lowers the
 * release decision instead of being skipped.
 */

/**
 * Channels that permit controlled execution, and therefore qualify as a release
 * candidate. The phase-2 target WINDOWS_FULL_LOCAL runs controlled tasks, so the
 * release supply-chain gate must accept it alongside WINDOWS_PHASE1_5_CONTROLLED.
 * Hardcoding the phase-1.5 channel previously blocked the phase-2 candidate on
 * its own target channel.
 */
export const CONTROLLED_RELEASE_CHANNELS = Object.freeze(['WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL']);
export const isControlledReleaseChannel = (channel) => CONTROLLED_RELEASE_CHANNELS.includes(channel);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const releaseDigest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
export const releaseFileDigest = async (path) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;

const packageNameFromLockKey = (key) => {
  const trimmed = key.replace(/^(\.\/)?node_modules\//u, '');
  const parts = trimmed.split('node_modules/');
  return parts[parts.length - 1];
};

/** Build an SBOM component inventory from real npm lock files. */
export const buildSbom = async ({ lockPaths = [], generatedAtMs = Date.now() } = {}) => {
  const components = [];
  const sources = [];
  for (const path of lockPaths) {
    let parsed;
    let raw;
    try {
      raw = await readFile(path, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      sources.push({ path, status: 'UNAVAILABLE' });
      continue;
    }
    const entries = parsed?.packages && typeof parsed.packages === 'object' ? parsed.packages : {};
    let count = 0;
    for (const [key, value] of Object.entries(entries)) {
      if (!key) continue;
      const name = typeof value?.name === 'string' && value.name ? value.name : packageNameFromLockKey(key);
      if (!name) continue;
      components.push({
        name,
        version: typeof value?.version === 'string' ? value.version : undefined,
        integrity: typeof value?.integrity === 'string' ? value.integrity : undefined,
        resolved: typeof value?.resolved === 'string' ? value.resolved : undefined,
        license: typeof value?.license === 'string' ? value.license : undefined,
        scope: value?.dev === true ? 'DEV' : 'RUNTIME'
      });
      count += 1;
    }
    sources.push({ path, status: 'READ', lockfileVersion: parsed?.lockfileVersion, name: parsed?.name, version: parsed?.version, components: count, digest: `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}` });
  }
  components.sort((left, right) => left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
  return {
    schemaVersion: '1.0',
    artifact: 'HMCODEX_SBOM',
    format: 'hmcodex-sbom-1',
    generatedAtMs,
    componentCount: components.length,
    sources,
    components
  };
};

/** Plugin lock: every governance record plus every installed version lifecycle entry. */
export const buildPluginLock = ({ plugins = [], versionLifecycle, generatedAtMs = Date.now() } = {}) => {
  const entries = plugins.map((plugin) => ({
    pluginId: plugin.pluginId,
    version: plugin.version,
    state: plugin.state,
    source: plugin.source,
    packageDigest: plugin.packageDigest,
    recordDigest: plugin.recordDigest,
    lifecycleDigest: plugin.lifecycleDigest
  })).sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  const versions = Array.isArray(versionLifecycle?.versions) ? versionLifecycle.versions : [];
  const active = versionLifecycle?.active && typeof versionLifecycle.active === 'object' ? versionLifecycle.active : {};
  return {
    schemaVersion: '1.0',
    artifact: 'HMCODEX_PLUGIN_LOCK',
    generatedAtMs,
    unsignedPluginPolicy: 'RELEASE_MODE_REQUIRES_SIGNATURE',
    pluginCount: entries.length,
    plugins: entries,
    versions: versions.map((item) => ({
      pluginId: item.pluginId,
      version: item.version,
      state: item.state,
      packageDigest: item.packageDigest,
      installedAtMs: item.installedAtMs,
      activatedAtMs: item.activatedAtMs,
      failureCode: item.failureCode,
      lifecycleId: item.lifecycleId
    })),
    active: Object.fromEntries(Object.entries(active).sort(([left], [right]) => left.localeCompare(right)))
  };
};

/** Model lock: the effective model bindings the runtime is allowed to call. */
export const buildModelLock = ({ models = [], generatedAtMs = Date.now() } = {}) => {
  const entries = models.map((model) => ({
    modelId: model.modelId,
    provider: model.provider,
    protocol: model.protocol,
    model: model.model,
    state: model.state,
    version: model.version,
    capabilities: Array.isArray(model.capabilities) ? [...model.capabilities].sort() : [],
    roles: Array.isArray(model.roles) ? [...model.roles].sort() : [],
    recordDigest: model.recordDigest
  })).sort((left, right) => String(left.modelId).localeCompare(String(right.modelId)));
  return { schemaVersion: '1.0', artifact: 'HMCODEX_MODEL_LOCK', generatedAtMs, modelCount: entries.length, models: entries };
};

/**
 * Release decision report. Every required fact must be present and passing;
 * a missing artifact is a blocker, never a silent omission.
 */
export const buildReleaseDecision = ({ versionManifest, sbom, pluginLock, modelLock, checks = [], evidence = [], generatedAtMs = Date.now() } = {}) => {
  const blockers = [];
  if (!versionManifest?.versions?.protocolVersion) blockers.push('VERSION_MANIFEST_INCOMPLETE');
  if (!sbom || !Number.isSafeInteger(sbom.componentCount) || sbom.componentCount <= 0) blockers.push('SBOM_EMPTY');
  if (!modelLock || !Number.isSafeInteger(modelLock.modelCount) || modelLock.modelCount <= 0) blockers.push('MODEL_LOCK_EMPTY');
  for (const check of checks) if (check.ok !== true) blockers.push(`${check.name}_${check.code ?? 'FAILED'}`);
  for (const item of evidence) if (item.ok !== true) blockers.push(`${item.name}_${item.code ?? 'MISSING'}`);
  return {
    schemaVersion: '1.0',
    artifact: 'HMCODEX_RELEASE_DECISION',
    generatedAtMs,
    decision: blockers.length === 0 ? 'RELEASE_CANDIDATE' : 'NOT_READY',
    blockers,
    checks,
    evidence,
    pluginCount: pluginLock?.pluginCount ?? 0,
    modelCount: modelLock?.modelCount ?? 0,
    componentCount: sbom?.componentCount ?? 0
  };
};

const writeJson = async (path, value) => {
  if (!path) return undefined;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return path;
};

export const writeReleaseArtifacts = async ({ manifest, sbom, pluginLock, modelLock, decision, outputs = {} } = {}) => ({
  manifest: await writeJson(outputs.manifest, manifest),
  sbom: await writeJson(outputs.sbom, sbom),
  pluginLock: await writeJson(outputs.pluginLock, pluginLock),
  modelLock: await writeJson(outputs.modelLock, modelLock),
  decision: await writeJson(outputs.decision, decision)
});
