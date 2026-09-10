import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginVersionLifecycle } from '../src/plugin-version-lifecycle.mjs';

test('plugin versions activate side by side and rollback atomically', async () => {
  const lifecycle = new PluginVersionLifecycle({ now: (() => { let n = 0; return () => ++n; })() });
  lifecycle.install({ pluginId: 'demo', version: '1.0.0', packageDigest: 'sha256:a', config: { mode: 'old' } });
  lifecycle.install({ pluginId: 'demo', version: '2.0.0', packageDigest: 'sha256:b', config: { mode: 'new' } });
  await lifecycle.activate('demo', '1.0.0');
  const result = await lifecycle.activate('demo', '2.0.0', { migrate: async ({ to }) => ({ ok: true, config: { ...to, migrated: true } }) });
  assert.equal(result.activated, true);
  assert.equal(lifecycle.active('demo').version, '2.0.0');
  assert.equal((await lifecycle.rollback('demo')).version, '1.0.0');
});

test('failed self-test leaves previous version active', async () => {
  const lifecycle = new PluginVersionLifecycle();
  lifecycle.install({ pluginId: 'demo', version: '1.0.0', packageDigest: 'a' });
  lifecycle.install({ pluginId: 'demo', version: '2.0.0', packageDigest: 'b' });
  await lifecycle.activate('demo', '1.0.0');
  const result = await lifecycle.activate('demo', '2.0.0', { selfTest: async () => ({ ok: false }) });
  assert.equal(result.activated, false);
  assert.equal(lifecycle.active('demo').version, '1.0.0');
});

test('version lifecycle snapshot restores atomically and rejects invalid active pointers', async () => {
  const source = new PluginVersionLifecycle();
  source.install({ pluginId: 'demo', version: '1.0.0', packageDigest: 'a' });
  await source.activate('demo', '1.0.0');
  const target = new PluginVersionLifecycle();
  target.restore(source.snapshot());
  assert.equal(target.active('demo').version, '1.0.0');
  assert.throws(() => target.restore({ ...source.snapshot(), active: { demo: 'demo@missing' } }), /PLUGIN_VERSION_SNAPSHOT_INVALID/);
  assert.equal(target.active('demo').version, '1.0.0');
});

test('lifecycle change callback fires for install, activation and rollback', async () => {
  let changes = 0;
  const lifecycle = new PluginVersionLifecycle({ onChange: () => { changes += 1; } });
  lifecycle.install({ pluginId: 'demo', version: '1', packageDigest: 'a' });
  lifecycle.install({ pluginId: 'demo', version: '2', packageDigest: 'b' });
  await lifecycle.activate('demo', '1');
  await lifecycle.activate('demo', '2');
  await lifecycle.rollback('demo');
  assert.equal(changes, 5);
});

test('concurrent activations serialize and leave one active version', async () => {
  const lifecycle = new PluginVersionLifecycle();
  lifecycle.install({ pluginId: 'demo', version: '1', packageDigest: 'a' });
  lifecycle.install({ pluginId: 'demo', version: '2', packageDigest: 'b' });
  const gate = Promise.resolve();
  const results = await Promise.all([
    lifecycle.activate('demo', '1', { selfTest: async () => { await gate; return { ok: true }; } }),
    lifecycle.activate('demo', '2')
  ]);
  assert.equal(results.filter((result) => result.activated).length, 2);
  assert.equal(lifecycle.list('demo').filter((record) => record.state === 'ACTIVE').length, 1);
  assert.ok(['1', '2'].includes(lifecycle.active('demo').version));
});
