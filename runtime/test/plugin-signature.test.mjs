import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginGovernance, pluginGovernanceDigest } from '../src/plugin-governance.mjs';
import { createDynamicPluginLoader } from '../src/plugin-loader.mjs';

const manifest = {
  schemaVersion: '1.0',
  id: 'com.example.signed',
  name: 'Signed Fixture',
  version: '1.0.0',
  contributions: [{
    id: 'com.example.signed.contribution',
    type: 'skill',
    capabilities: [],
    permissions: []
  }]
};

test('release channel requires a trusted Ed25519 plugin signature', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString().trim();
  const manifestDigest = pluginGovernanceDigest(manifest);
  const signature = sign(null, Buffer.from(JSON.stringify(manifest), 'utf8'), privateKey).toString('base64');
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-signature-'));
  const pluginRoot = join(root, 'plugins');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(join(pluginRoot, 'fixture.mjs'), 'export const createPlugin = () => {};\n', 'utf8');
  const governance = new PluginGovernance();
  const loader = createDynamicPluginLoader({
    rootDir: pluginRoot,
    governance,
    registry: { register() {} }
  });
  process.env.HMCODEX_BAKED_RELEASE_CHANNEL = 'WINDOWS_PHASE1_5_CONTROLLED';
  await assert.rejects(
    () => loader.discover({ manifest, entryPath: 'fixture.mjs' }),
    /PLUGIN_SIGNATURE_REQUIRED/u
  );
  await assert.rejects(
    () => loader.discover({ manifest, entryPath: 'fixture.mjs', signature: {
      algorithm: 'ed25519', manifestDigest, publicKey: publicKeyPem, signature
    } }),
    /PLUGIN_SIGNATURE_TRUST_UNAVAILABLE/u
  );
  process.env.HMCODEX_PLUGIN_TRUST_KEY = publicKeyPem;
  const discovered = await loader.discover({ manifest, entryPath: 'fixture.mjs', signature: {
    algorithm: 'ed25519', manifestDigest, publicKey: publicKeyPem, signature
  } });
  assert.equal(discovered.signature.manifestDigest, manifestDigest);
  delete process.env.HMCODEX_PLUGIN_TRUST_KEY;
  delete process.env.HMCODEX_BAKED_RELEASE_CHANNEL;
});

test('revocation quarantines an active plugin and records the reason', async () => {
  const governance = new PluginGovernance();
  const plugin = await governance.discover(manifest, { source: 'TEST' });
  await governance.validate(plugin.pluginId);
  await governance.transition(plugin.pluginId, 'INSTALLED');
  await governance.transition(plugin.pluginId, 'ENABLED');
  await governance.transition(plugin.pluginId, 'ACTIVE');
  const revoked = await governance.revoke(plugin.pluginId, 'SUPPLY_CHAIN_REVOKED');
  assert.equal(revoked.state, 'QUARANTINED');
  assert.equal(revoked.transition?.metadata?.reason, 'SUPPLY_CHAIN_REVOKED');
  assert.equal(revoked.transition?.metadata?.revocation, true);
  assert.throws(() => governance.assertLoadable(plugin.pluginId), /PLUGIN_NOT_ACTIVE:QUARANTINED/u);
});
