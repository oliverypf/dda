import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedPluginServices,
  createCapabilityScopedPluginContext,
  pluginContextGrantSummary,
  validatePluginInject
} from '../src/plugin-context.mjs';

const manifest = (permissions = []) => ({
  id: 'com.example.scoped',
  contributions: [{
    id: 'com.example.scoped.skill',
    entrypoint: 'ScopedSkill',
    type: 'skill',
    capabilities: [],
    permissions
  }]
});

const fakeContext = () => {
  const services = {
    workspaceReadonly: { snapshot: true },
    modelProvider: { invoke: true },
    executor: { execute: true }
  };
  const provided = new Map();
  const ctx = {
    ...services,
    root: { secret: true },
    reflect: { secret: true },
    effect: (callback) => callback,
    logger: () => undefined,
    get: (name) => services[name],
    provide: (name, value) => {
      provided.set(name, value);
      return () => provided.delete(name);
    }
  };
  return { ctx, provided };
};

test('maps only declared permissions to dynamic Cordis services', () => {
  assert.deepEqual(
    [...allowedPluginServices(manifest(['workspace.read.snapshot']))],
    ['workspaceReadonly', 'toolRegistry']
  );
  const plugin = () => undefined;
  plugin.inject = ['workspaceReadonly'];
  assert.equal(validatePluginInject(manifest(['workspace.read.snapshot']), plugin), true);

  const forged = () => undefined;
  forged.inject = ['executor'];
  assert.throws(
    () => validatePluginInject(manifest(['workspace.read.snapshot']), forged),
    /PLUGIN_CONTEXT_CAPABILITY_DENIED:executor/
  );
});

test('blocks ctx.get and root registry escape hatches outside the grant', () => {
  const { ctx } = fakeContext();
  const plugin = () => undefined;
  plugin.inject = ['workspaceReadonly'];
  const scoped = createCapabilityScopedPluginContext(ctx, manifest(['workspace.read.snapshot']), plugin);

  assert.equal(scoped.workspaceReadonly.snapshot, true);
  assert.equal(scoped.get('workspaceReadonly').snapshot, true);
  assert.throws(() => scoped.get('modelProvider'), /PLUGIN_CONTEXT_CAPABILITY_DENIED:modelProvider/);
  assert.throws(() => scoped.executor, /PLUGIN_CONTEXT_CAPABILITY_DENIED:executor/);
  assert.throws(() => scoped.root, /PLUGIN_CONTEXT_CAPABILITY_DENIED:root/);
  assert.throws(() => scoped.reflect, /PLUGIN_CONTEXT_CAPABILITY_DENIED:reflect/);
  assert.equal(Object.getPrototypeOf(scoped), null);
});

test('allows only contribution or plugin-namespaced service publication', () => {
  const { ctx, provided } = fakeContext();
  const plugin = () => undefined;
  const scoped = createCapabilityScopedPluginContext(ctx, manifest(), plugin);

  scoped.provide('ScopedSkill', { ok: true });
  scoped.provide('com.example.scoped.helper', { ok: true });
  assert.equal(provided.size, 2);
  assert.throws(() => scoped.provide('modelProvider', {}), /PLUGIN_CONTEXT_CAPABILITY_DENIED:modelProvider/);
  assert.throws(() => scoped.provide('unrelated', {}), /PLUGIN_CONTEXT_CAPABILITY_DENIED:unrelated/);
  assert.deepEqual(pluginContextGrantSummary(manifest(), plugin), {
    pluginId: 'com.example.scoped',
    services: [],
    permissions: [],
    // An undeclared ceiling keeps the full known vocabulary.
    ceiling: 'CONTROLLED'
  });
});
