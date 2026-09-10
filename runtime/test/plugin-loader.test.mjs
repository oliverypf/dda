import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { DynamicPluginLoader } from '../src/plugin-loader.mjs';

const manifest = {
  schemaVersion: '1.0',
  id: 'dynamic-fixture',
  name: 'Dynamic Fixture',
  version: '1.0.0',
  contributions: [{ id: 'dynamic-fixture.contribution', type: 'skill', capabilities: [], permissions: [] }]
};

test('dynamic plugin discovery does not execute until governed ACTIVE state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-loader-'));
  await writeFile(join(root, 'plugin.mjs'), 'export const createPlugin = () => {};\n', 'utf8');
  const governance = new PluginGovernance();
  const registry = new PluginRegistry();
  let imported = false;
  const loader = new DynamicPluginLoader({
    rootDir: root,
    governance,
    registry,
    importer: async (url) => {
      imported = true;
      return import(url);
    }
  });
  const discovered = await loader.discover({ manifest, entryPath: 'plugin.mjs' });
  assert.equal(discovered.state, 'DISCOVERED');
  assert.equal(imported, false);
  await assert.rejects(() => loader.load(discovered.pluginId), /PLUGIN_NOT_ACTIVE:DISCOVERED/);
  await governance.transition(discovered.pluginId, 'VALIDATING');
  await governance.transition(discovered.pluginId, 'INSTALLED');
  await governance.transition(discovered.pluginId, 'ENABLED');
  await governance.transition(discovered.pluginId, 'ACTIVE');
  const plugin = await loader.load(discovered.pluginId);
  assert.equal(typeof plugin, 'function');
  assert.equal(imported, true);
  assert.equal(loader.list().length, 1);
  assert.equal(registry.list()[0].id, manifest.id);
});

test('dynamic plugin loader rejects traversal and digest mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-loader-'));
  const outside = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-outside-'));
  await writeFile(join(outside, 'plugin.mjs'), 'export const createPlugin = () => {};\n', 'utf8');
  const governance = new PluginGovernance();
  const loader = new DynamicPluginLoader({ rootDir: root, governance, registry: new PluginRegistry() });
  await assert.rejects(() => loader.discover({ manifest, entryPath: join('..', outside.split('\\').pop(), 'plugin.mjs') }), /PLUGIN_ENTRYPOINT_OUTSIDE_ROOT|PLUGIN_ENTRYPOINT_UNAVAILABLE/);
  await assert.rejects(() => loader.discover({ manifest, entryPath: 'missing.mjs', packageDigest: 'sha256:bad' }), /PLUGIN_ENTRYPOINT_UNAVAILABLE/);
});

