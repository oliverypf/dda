import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { DynamicPluginLoader } from '../src/plugin-loader.mjs';
import {
  PLUGIN_REVOCATIONS_ENV,
  PLUGIN_REVOCATION_FILE_ENV,
  emptyPluginRevocations,
  parsePluginRevocations,
  pluginRevocationHit,
  readPluginRevocations
} from '../src/plugin-revocations.mjs';

const digestOf = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
const DIGEST = `sha256:${'a'.repeat(64)}`;

const manifest = {
  schemaVersion: '1.0',
  id: 'revocation-fixture',
  name: 'Revocation Fixture',
  version: '1.0.0',
  contributions: [{ id: 'revocation-fixture.contribution', type: 'skill', capabilities: [], permissions: [] }]
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-revocation-'));
  const source = 'export const createPlugin = () => {};\n';
  await writeFile(join(root, 'plugin.mjs'), source, 'utf8');
  const governance = new PluginGovernance();
  const registry = new PluginRegistry();
  return { root, source, entryDigest: digestOf(source), governance, registry };
};

const activate = async (governance, pluginId) => {
  for (const state of ['VALIDATING', 'INSTALLED', 'ENABLED', 'ACTIVE']) {
    await governance.transition(pluginId, state);
  }
};

test('a revocation list accepts digests and id@version entries only', () => {
  const parsed = parsePluginRevocations(`${DIGEST.toUpperCase()}, ${'b'.repeat(64)};revocation-fixture@2.1.0`);
  assert.equal(parsed.digests.size, 2);
  assert.ok(parsed.digests.has(DIGEST));
  assert.ok(parsed.digests.has(`sha256:${'b'.repeat(64)}`));
  assert.deepEqual([...parsed.versions], ['revocation-fixture@2.1.0']);
  assert.equal(parsePluginRevocations('[]').digests.size, 0);
  assert.equal(parsePluginRevocations('{"entries":["revocation-fixture@1.0.0"]}').versions.size, 1);
  assert.equal(parsePluginRevocations([DIGEST, '', '   '].join('\n')).digests.size, 1);
  // Malformed operator input fails closed instead of silently revoking nothing.
  for (const invalid of ['not-a-digest', 'revocation-fixture', `${'c'.repeat(63)}`, '{"entries":"x"}', 'sha256:zz']) {
    assert.throws(() => parsePluginRevocations(invalid), /PLUGIN_REVOCATION_LIST_INVALID/u);
  }
  assert.equal(pluginRevocationHit({ entryDigest: DIGEST }, emptyPluginRevocations()).hit, false);
  assert.deepEqual(
    pluginRevocationHit({ entryDigest: DIGEST.toUpperCase() }, parsePluginRevocations(DIGEST)),
    { hit: true, kind: 'DIGEST', value: DIGEST }
  );
  assert.deepEqual(
    pluginRevocationHit({ pluginId: 'revocation-fixture', version: '2.1.0' }, parsePluginRevocations('revocation-fixture@2.1.0')),
    { hit: true, kind: 'VERSION', value: 'revocation-fixture@2.1.0' }
  );
});

test('revocation sources merge and an unreadable file fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-revocation-source-'));
  const filePath = join(root, 'revocations.txt');
  await writeFile(filePath, `${'d'.repeat(64)}\n`, 'utf8');
  const merged = await readPluginRevocations({
    env: { [PLUGIN_REVOCATION_FILE_ENV]: filePath, [PLUGIN_REVOCATIONS_ENV]: 'revocation-fixture@3.0.0' }
  });
  assert.equal(merged.digests.size, 1);
  assert.deepEqual([...merged.versions], ['revocation-fixture@3.0.0']);
  assert.deepEqual(merged.sources, [{ kind: 'FILE', path: filePath }, { kind: 'ENV', name: PLUGIN_REVOCATIONS_ENV }]);
  assert.equal((await readPluginRevocations({ env: {} })).digests.size, 0);
  await assert.rejects(
    () => readPluginRevocations({ env: { [PLUGIN_REVOCATION_FILE_ENV]: join(root, 'missing.txt') } }),
    /PLUGIN_REVOCATION_LIST_UNAVAILABLE/u
  );
});

test('a revoked artifact or version is refused before governance records it', async () => {
  const { root, governance, registry, entryDigest } = await fixture();
  const byDigest = new DynamicPluginLoader({ rootDir: root, governance, registry, revocations: parsePluginRevocations(entryDigest) });
  await assert.rejects(() => byDigest.discover({ manifest, entryPath: 'plugin.mjs' }), /PLUGIN_PACKAGE_REVOKED/u);
  assert.equal(governance.list().length, 0);

  const byVersion = new DynamicPluginLoader({ rootDir: root, governance, registry, revocations: parsePluginRevocations('revocation-fixture@1.0.0') });
  await assert.rejects(() => byVersion.discover({ manifest, entryPath: 'plugin.mjs' }), /PLUGIN_VERSION_REVOKED/u);
  assert.equal(governance.list().length, 0);

  const allowed = new DynamicPluginLoader({ rootDir: root, governance, registry, revocations: emptyPluginRevocations() });
  const discovered = await allowed.discover({ manifest, entryPath: 'plugin.mjs' });
  assert.equal(discovered.state, 'DISCOVERED');
  assert.equal(governance.list().length, 1);
});

test('a revocation hit on load quarantines the active plugin', async () => {
  const { root, governance, registry, entryDigest } = await fixture();
  let revocations = emptyPluginRevocations();
  const loader = new DynamicPluginLoader({ rootDir: root, governance, registry, revocationProvider: () => revocations });
  const discovered = await loader.discover({ manifest, entryPath: 'plugin.mjs' });
  await activate(governance, discovered.pluginId);
  // The plugin activates normally while the list is empty.
  await loader.load(discovered.pluginId);
  assert.equal(governance.get(discovered.pluginId).state, 'ACTIVE');

  revocations = parsePluginRevocations(entryDigest);
  await assert.rejects(() => loader.load(discovered.pluginId), /PLUGIN_PACKAGE_REVOKED/u);
  const revoked = governance.get(discovered.pluginId);
  assert.equal(revoked.state, 'QUARANTINED');
  assert.equal(revoked.transition.metadata.reason, 'PLUGIN_REVOCATION_HIT_DIGEST');

  // A revoked plugin cannot be re-discovered as a new side-by-side install.
  await assert.rejects(() => loader.discover({ manifest, entryPath: 'plugin.mjs' }), /PLUGIN_PACKAGE_REVOKED/u);
});

