import { readFile as readFileDefault } from 'node:fs/promises';

/**
 * Host-provided plugin revocation list.
 *
 * A revoked artifact must never be discovered or imported again, even when it
 * is re-presented as a side-by-side install after the fact. The list is an
 * operator input, not plugin input: it comes from the environment
 * (`HMCODEX_PLUGIN_REVOCATIONS`) or from a file
 * (`HMCODEX_PLUGIN_REVOCATION_FILE`) and every malformed entry fails closed.
 *
 * Supported entries:
 *   sha256:<64 hex> | <64 hex>   revoked code artifact or manifest digest
 *   <pluginId>@<version>         revoked plugin version
 */

export const PLUGIN_REVOCATIONS_ENV = 'HMCODEX_PLUGIN_REVOCATIONS';
export const PLUGIN_REVOCATION_FILE_ENV = 'HMCODEX_PLUGIN_REVOCATION_FILE';

const DIGEST_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/iu;
const VERSION_ENTRY_PATTERN = /^([a-z][a-z0-9._-]{1,127})@(\d+\.\d+(?:\.\d+)?)$/u;

export const normalizePluginDigest = (value) => {
  const match = typeof value === 'string' ? DIGEST_PATTERN.exec(value.trim()) : undefined;
  return match ? `sha256:${match[1].toLowerCase()}` : undefined;
};

const entriesFrom = (raw) => {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw.flatMap(entriesFrom);
  if (typeof raw !== 'string') throw new Error('PLUGIN_REVOCATION_LIST_INVALID');
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('PLUGIN_REVOCATION_LIST_INVALID'); }
    if (Array.isArray(parsed)) return parsed.flatMap(entriesFrom);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) return parsed.entries.flatMap(entriesFrom);
    throw new Error('PLUGIN_REVOCATION_LIST_INVALID');
  }
  return text.split(/[\n,;]+/u).map((entry) => entry.trim()).filter(Boolean);
};

/** Parse one revocation source into digest and version sets. */
export const parsePluginRevocations = (raw) => {
  const digests = new Set();
  const versions = new Set();
  const entries = [];
  for (const entry of entriesFrom(raw)) {
    if (typeof entry !== 'string') throw new Error('PLUGIN_REVOCATION_LIST_INVALID');
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const digest = normalizePluginDigest(trimmed);
    if (digest) {
      digests.add(digest);
      entries.push({ kind: 'DIGEST', value: digest });
      continue;
    }
    const versionMatch = VERSION_ENTRY_PATTERN.exec(trimmed);
    if (!versionMatch) throw new Error('PLUGIN_REVOCATION_LIST_INVALID');
    const key = `${versionMatch[1]}@${versionMatch[2]}`;
    versions.add(key);
    entries.push({ kind: 'VERSION', value: key });
  }
  return { schemaVersion: '1.0', entries, digests, versions };
};

/**
 * Read the configured revocation sources. A configured file that cannot be
 * read is a hard failure: an unreadable revocation list must never be treated
 * as an empty list.
 */
export const readPluginRevocations = async ({ env = process.env, readFile = readFileDefault } = {}) => {
  const sources = [];
  const filePath = env?.[PLUGIN_REVOCATION_FILE_ENV];
  if (typeof filePath === 'string' && filePath.trim()) {
    let content;
    try { content = await readFile(filePath.trim(), 'utf8'); } catch { throw new Error('PLUGIN_REVOCATION_LIST_UNAVAILABLE'); }
    sources.push(content);
  }
  const envValue = env?.[PLUGIN_REVOCATIONS_ENV];
  if (typeof envValue === 'string' && envValue.trim()) sources.push(envValue);
  const combined = parsePluginRevocations(sources.flatMap(entriesFrom));
  return {
    ...combined,
    sources: [
      ...(typeof filePath === 'string' && filePath.trim() ? [{ kind: 'FILE', path: filePath.trim() }] : []),
      ...(typeof envValue === 'string' && envValue.trim() ? [{ kind: 'ENV', name: PLUGIN_REVOCATIONS_ENV }] : [])
    ]
  };
};

/** Empty list used when the operator configured no revocation source at all. */
export const emptyPluginRevocations = () => parsePluginRevocations([]);

/**
 * Match one plugin identity against the revocation list. Digests cover the
 * code artifact and the governed manifest; the version entry covers the
 * plugin id together with its declared version.
 */
export const pluginRevocationHit = ({ pluginId, version, entryDigest, packageDigest } = {}, revocations = emptyPluginRevocations()) => {
  for (const candidate of [entryDigest, packageDigest]) {
    const digest = normalizePluginDigest(candidate);
    if (digest && revocations.digests?.has(digest)) return { hit: true, kind: 'DIGEST', value: digest };
  }
  const key = typeof pluginId === 'string' && typeof version === 'string' ? `${pluginId}@${version}` : undefined;
  if (key && revocations.versions?.has(key)) return { hit: true, kind: 'VERSION', value: key };
  return { hit: false };
};
