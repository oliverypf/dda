import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { PluginRegistry } from '../src/plugins/registry.mjs';
import { DynamicPluginLoader, validatePluginManifest } from '../src/plugin-loader.mjs';
import { allowedPluginServices, createCapabilityScopedPluginContext } from '../src/plugin-context.mjs';
import {
  CEILING_PERMISSIONS,
  effectivePermissionCeiling,
  permissionsExceedingCeiling,
  permissionsWithinCeiling
} from '../src/plugin-permissions.mjs';

const manifestWith = (permissions, permissionCeiling) => ({
  schemaVersion: '1.0',
  id: 'ceiling-fixture',
  name: 'Ceiling Fixture',
  version: '1.0.0',
  contributions: [{
    id: 'ceiling-fixture.contribution',
    entrypoint: 'ceiling-fixture',
    type: 'tooling',
    capabilities: [],
    permissions,
    ...(permissionCeiling ? { permissionCeiling } : {})
  }]
});

test('a READ_ONLY ceiling cannot declare control-level permissions', () => {
  const exceeding = manifestWith(['workspace.read.content', 'executor.invoke.controlled'], 'READ_ONLY');
  assert.deepEqual(permissionsExceedingCeiling(exceeding), [
    { contributionId: 'ceiling-fixture.contribution', ceiling: 'READ_ONLY', permission: 'executor.invoke.controlled' }
  ]);
  assert.throws(() => validatePluginManifest(exceeding), /PLUGIN_PERMISSION_CEILING_EXCEEDED/u);
  // The same declaration is legal under the CONTROLLED ceiling.
  assert.doesNotThrow(() => validatePluginManifest(manifestWith(['workspace.read.content', 'executor.invoke.controlled'], 'CONTROLLED')));
  // Unknown permissions stay rejected independently of the ceiling.
  assert.throws(() => validatePluginManifest(manifestWith(['not.a.permission'], 'CONTROLLED')), /PLUGIN_PERMISSIONS_UNDECLARED/u);
});

test('an undeclared ceiling keeps the historical vocabulary and a declared one narrows it', () => {
  assert.equal(effectivePermissionCeiling(manifestWith(['executor.invoke.controlled'])), 'CONTROLLED');
  assert.equal(effectivePermissionCeiling(manifestWith(['executor.invoke.controlled'], 'READ_ONLY')), 'READ_ONLY');
  assert.deepEqual(permissionsWithinCeiling(manifestWith(['executor.invoke.controlled', 'workspace.read.content'], 'READ_ONLY')), ['workspace.read.content']);
  // READ_ONLY never contains a mutating or egress permission.
  for (const permission of ['executor.invoke.controlled', 'process.execute.shell', 'filesystem.write.workspace', 'network.connect.host', 'trajectory.write']) {
    assert.equal(CEILING_PERMISSIONS.READ_ONLY.includes(permission), false, permission);
  }
});

test('the capability membrane denies services above the ceiling even for a hand-built manifest', () => {
  const permissions = ['workspace.read.content', 'executor.invoke.controlled'];
  const request = { inject: ['workspaceReadonly', 'executor'] };
  // Without a ceiling the declared control permission still grants the executor
  // service, preserving existing behaviour for bundled/legacy manifests.
  assert.deepEqual([...allowedPluginServices(manifestWith(permissions))].sort(), ['executor', 'toolRegistry', 'workspaceReadonly']);
  const scoped = manifestWith(permissions, 'READ_ONLY');
  // A READ_ONLY grant still exposes the read-only tool surface, but never the
  // controlled executor service that the declared permission would have granted.
  assert.deepEqual([...allowedPluginServices(scoped)].sort(), ['toolRegistry', 'workspaceReadonly']);
  const ctx = { workspaceReadonly: { ok: true }, executor: { execute: true }, effect: (callback) => callback, logger: () => undefined };
  // The membrane refuses to build a context whose inject list reaches above the ceiling.
  assert.throws(() => createCapabilityScopedPluginContext(ctx, scoped, request), /PLUGIN_CONTEXT_CAPABILITY_DENIED:executor/u);
  const guarded = createCapabilityScopedPluginContext(ctx, scoped, { inject: ['workspaceReadonly'] });
  assert.deepEqual(guarded.workspaceReadonly, { ok: true });
  assert.throws(() => guarded.executor, /PLUGIN_CONTEXT_CAPABILITY_DENIED/u);
});

test('discovery rejects a manifest whose ceiling is exceeded before any code runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-ceiling-'));
  await writeFile(join(root, 'plugin.mjs'), 'export const createPlugin = () => {};\n', 'utf8');
  const loader = new DynamicPluginLoader({ rootDir: root, governance: new PluginGovernance(), registry: new PluginRegistry() });
  await assert.rejects(
    () => loader.discover({ manifest: manifestWith(['executor.invoke.controlled'], 'READ_ONLY'), entryPath: 'plugin.mjs' }),
    /PLUGIN_PERMISSION_CEILING_EXCEEDED/u
  );
  assert.equal(loader.list().length, 0);
});
