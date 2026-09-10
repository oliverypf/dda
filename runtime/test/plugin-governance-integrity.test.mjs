import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const manifest = {
  schemaVersion: '1.0',
  id: 'integrity-plugin',
  name: 'Integrity Plugin',
  version: '1.0.0',
  contributions: [{ id: 'integrity-plugin.contribution', type: 'skill', capabilities: [], permissions: [] }]
};

test('plugin governance persists lifecycle versions across independent instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-versions-'));
  const storagePath = join(directory, 'governance.json');
  const writer = new PluginGovernance({ storagePath });
  await writer.load();
  writer.installVersion({ pluginId: 'demo', version: '1', packageDigest: 'a' });
  writer.installVersion({ pluginId: 'demo', version: '2', packageDigest: 'b' });
  await writer.activateVersion('demo', '1');
  await writer.activateVersion('demo', '2');
  await writer.flush();
  const reader = new PluginGovernance({ storagePath });
  await reader.load();
  assert.equal(reader.versionLifecycle.active('demo').version, '2');
  assert.equal(reader.listVersions('demo').length, 2);
  await reader.rollbackVersion('demo');
  await reader.flush();
  const recovered = new PluginGovernance({ storagePath });
  await recovered.load();
  assert.equal(recovered.versionLifecycle.active('demo').version, '1');
  const repeated = await recovered.activateVersion('demo', '1');
  assert.equal(repeated.idempotent, true);
  assert.equal(recovered.versionLifecycle.active('demo').state, 'ACTIVE');
  const failed = await recovered.activateVersion('demo', '2', { selfTest: async () => ({ ok: false }) });
  assert.equal(failed.activated, false);
  await recovered.flush();
  const afterFailure = new PluginGovernance({ storagePath });
  await afterFailure.load();
  assert.equal(afterFailure.versionLifecycle.active('demo').version, '1');
  assert.equal(afterFailure.listVersions('demo').find((record) => record.version === '2').state, 'DEGRADED');
});


test('plugin governance replays durable records without a JSON cache', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new PluginGovernance({ eventStore });
  const plugin = await writer.discoverDurably(manifest);
  const reader = new PluginGovernance({ eventStore });
  await reader.load();
  assert.deepEqual(reader.get(plugin.pluginId), plugin);
});

test('plugin governance rejects a malformed durable record snapshot', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new PluginGovernance({ eventStore });
  await writer.discoverDurably(manifest);
  const originalList = eventStore.list.bind(eventStore);
  eventStore.list = async (options) => {
    const events = await originalList(options);
    return events.map((event) => event.kind === 'PluginDiscovered'
      ? { ...event, payload: { ...event.payload, record: { ...event.payload.record, recordDigest: 'sha256:' + '0'.repeat(64) } } }
      : event);
  };
  await assert.rejects(() => new PluginGovernance({ eventStore }).load(), /PLUGIN_GOVERNANCE_INVALID/);
});

test('plugin governance rejects a durable transition with an invalid predecessor state', async () => {
  const { createHarnessEventStore } = await import('../src/harness-event-store.mjs');
  const eventStore = createHarnessEventStore();
  const writer = new PluginGovernance({ eventStore });
  const plugin = await writer.discoverDurably(manifest);
  await writer.transitionDurably(plugin.pluginId, 'VALIDATING');
  const originalList = eventStore.list.bind(eventStore);
  eventStore.list = async (options) => (await originalList(options)).map((event) => event.kind === 'PluginStateChangeCommitted'
    ? { ...event, payload: { ...event.payload, from: 'ACTIVE' } }
    : event);
  await assert.rejects(() => new PluginGovernance({ eventStore }).load(), /PLUGIN_GOVERNANCE_INVALID/);
});

test('plugin governance rejects tampered state and history lifecycle fields', async () => {
  const storagePath = join(await mkdtemp(join(tmpdir(), 'hmcodex-plugin-integrity-')), 'plugins.json');
  const governance = new PluginGovernance({ storagePath });
  const plugin = governance.discover(manifest);
  governance.transition(plugin.pluginId, 'VALIDATING');
  governance.transition(plugin.pluginId, 'INSTALLED');
  governance.transition(plugin.pluginId, 'ENABLED');
  governance.transition(plugin.pluginId, 'ACTIVE');
  await governance.flush();
  const original = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.match(original.plugins[0].lifecycleDigest, /^sha256:[0-9a-f]{64}$/);

  const stateTampered = structuredClone(original);
  stateTampered.plugins[0].state = 'DISABLED';
  await writeFile(storagePath, `${JSON.stringify(stateTampered)}\n`, 'utf8');
  await assert.rejects(() => new PluginGovernance({ storagePath }).load(), /PLUGIN_GOVERNANCE_INVALID/);

  const historyTampered = structuredClone(original);
  historyTampered.plugins[0].history[0].metadata = { forged: true };
  await writeFile(storagePath, `${JSON.stringify(historyTampered)}\n`, 'utf8');
  await assert.rejects(() => new PluginGovernance({ storagePath }).load(), /PLUGIN_GOVERNANCE_INVALID/);
});

test('plugin governance keeps loading legacy records without lifecycle seals', async () => {
  const storagePath = join(await mkdtemp(join(tmpdir(), 'hmcodex-plugin-legacy-')), 'plugins.json');
  const governance = new PluginGovernance({ storagePath });
  const plugin = governance.discover(manifest);
  governance.transition(plugin.pluginId, 'VALIDATING');
  governance.transition(plugin.pluginId, 'INSTALLED');
  governance.transition(plugin.pluginId, 'ENABLED');
  governance.transition(plugin.pluginId, 'ACTIVE');
  await governance.flush();
  const legacy = JSON.parse(await readFile(storagePath, 'utf8'));
  delete legacy.plugins[0].lifecycleDigest;
  await writeFile(storagePath, `${JSON.stringify(legacy)}\n`, 'utf8');
  const restored = new PluginGovernance({ storagePath });
  await restored.load();
  assert.equal(restored.get(plugin.pluginId).state, 'ACTIVE');
});
