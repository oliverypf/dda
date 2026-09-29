import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROLLED_RELEASE_CHANNELS, buildModelLock, buildPluginLock, buildReleaseDecision, buildSbom, isControlledReleaseChannel } from '../src/release-manifest.mjs';

const lockFile = (packages) => JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, packages });

test('sbom inventories real lock files and never invents a component', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-sbom-'));
  const goodPath = join(root, 'package-lock.json');
  await writeFile(goodPath, lockFile({
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/alpha': { version: '1.2.3', integrity: 'sha512-aaa', license: 'MIT' },
    'node_modules/beta': { version: '2.0.0', integrity: 'sha512-bbb', dev: true }
  }), 'utf8');
  const sbom = await buildSbom({ lockPaths: [goodPath, join(root, 'missing-lock.json')] });
  assert.equal(sbom.componentCount, 2);
  assert.deepEqual(sbom.components.map((item) => item.name), ['alpha', 'beta']);
  assert.equal(sbom.components[1].scope, 'DEV');
  assert.equal(sbom.sources.find((item) => item.path === goodPath).status, 'READ');
  assert.equal(sbom.sources.find((item) => item.path.endsWith('missing-lock.json')).status, 'UNAVAILABLE');
  assert.match(sbom.sources[0].digest, /^sha256:[0-9a-f]{64}$/u);
});

test('plugin and model locks keep the persisted digests and active version pointer', () => {
  const pluginLock = buildPluginLock({
    plugins: [
      { pluginId: 'com.example.one', version: '2.0.0', state: 'ACTIVE', source: 'SIGNED', packageDigest: 'sha256:a', recordDigest: 'sha256:r', lifecycleDigest: 'sha256:l' }
    ],
    versionLifecycle: {
      versions: [
        { pluginId: 'com.example.one', version: '2.0.0', state: 'ACTIVE', packageDigest: 'sha256:a', installedAtMs: 1, lifecycleId: 'life-1' }
      ],
      active: { 'com.example.one': 'com.example.one@2.0.0' }
    }
  });
  assert.equal(pluginLock.pluginCount, 1);
  assert.equal(pluginLock.plugins[0].recordDigest, 'sha256:r');
  assert.equal(pluginLock.active['com.example.one'], 'com.example.one@2.0.0');
  assert.equal(pluginLock.versions[0].lifecycleId, 'life-1');

  const modelLock = buildModelLock({ models: [
    { modelId: 'b/model', provider: 'b', protocol: 'p', model: 'm', state: 'ACTIVE', version: '1', capabilities: ['z', 'a'], roles: ['executor'], recordDigest: 'sha256:m' },
    { modelId: 'a/model', provider: 'a', protocol: 'p', model: 'm', state: 'ACTIVE', version: '1', capabilities: [], roles: [], recordDigest: 'sha256:n' }
  ] });
  assert.equal(modelLock.modelCount, 2);
  assert.deepEqual(modelLock.models.map((item) => item.modelId), ['a/model', 'b/model']);
  assert.deepEqual(modelLock.models[1].capabilities, ['a', 'z']);
});

test('release decision blocks on missing or failing evidence instead of skipping it', () => {
  const sbom = { componentCount: 3 };
  const pluginLock = { pluginCount: 0 };
  const modelLock = { modelCount: 1 };
  const versionManifest = { versions: { protocolVersion: '1.0' } };
  const ready = buildReleaseDecision({ versionManifest, sbom, pluginLock, modelLock });
  assert.equal(ready.decision, 'RELEASE_CANDIDATE');
  assert.deepEqual(ready.blockers, []);

  const blocked = buildReleaseDecision({
    versionManifest,
    sbom,
    pluginLock,
    modelLock,
    checks: [{ name: 'controlledChannel', ok: false, code: 'RELEASE_CHANNEL_NOT_CONTROLLED' }],
    evidence: [{ name: 'w10Evidence', ok: false, code: 'W10_NOT_READY' }]
  });
  assert.equal(blocked.decision, 'NOT_READY');
  assert.ok(blocked.blockers.includes('controlledChannel_RELEASE_CHANNEL_NOT_CONTROLLED'));
  assert.ok(blocked.blockers.includes('w10Evidence_W10_NOT_READY'));

  const empty = buildReleaseDecision({ versionManifest: {}, sbom: { componentCount: 0 }, modelLock: { modelCount: 0 } });
  assert.ok(empty.blockers.includes('VERSION_MANIFEST_INCOMPLETE'));
  assert.ok(empty.blockers.includes('SBOM_EMPTY'));
  assert.ok(empty.blockers.includes('MODEL_LOCK_EMPTY'));
});

test('the controlled-channel gate accepts the phase-2 target and rejects the baseline', () => {
  // The phase-2 release candidate ships on WINDOWS_FULL_LOCAL; a gate that only
  // accepted the phase-1.5 channel made the candidate block on its own target.
  assert.deepEqual([...CONTROLLED_RELEASE_CHANNELS], ['WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL']);
  assert.equal(isControlledReleaseChannel('WINDOWS_FULL_LOCAL'), true);
  assert.equal(isControlledReleaseChannel('WINDOWS_PHASE1_5_CONTROLLED'), true);
  assert.equal(isControlledReleaseChannel('WINDOWS_PHASE1_READ_ONLY'), false);
  assert.equal(isControlledReleaseChannel('WINDOWS_MVP_PRE_PHASE1'), false);
  assert.equal(isControlledReleaseChannel(undefined), false);
});