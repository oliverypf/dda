import { effectivePermissionCeiling, permissionsWithinCeiling } from './plugin-permissions.mjs';

const SERVICE_PERMISSIONS = Object.freeze({
  workspaceReadonly: new Set([
    'workspace.read.metadata',
    'workspace.read.content',
    'workspace.read.snapshot'
  ]),
  toolRegistry: new Set([
    'workspace.read.metadata',
    'workspace.read.content',
    'workspace.read.snapshot',
    'workspace.write.patch',
    'filesystem.write.workspace',
    'process.execute.argv',
    'process.execute.shell',
    'process.spawn.restricted',
    'executor.invoke.controlled'
  ]),
  executor: new Set(['executor.invoke.controlled']),
  modelProvider: new Set(['network.connect.host']),
  evolutionRegistry: new Set(['profile.propose-update'])
});

const SAFE_CONTEXT_MEMBERS = new Set(['effect', 'logger']);
const BLOCKED_CONTEXT_MEMBERS = new Set([
  'root', 'reflect', 'registry', 'events', 'fiber', 'runtime',
  'plugin', 'inject', 'isolate', 'intercept', 'set', 'accessor', 'mixin',
  'emit', 'parallel', 'serial', 'bail', 'waterfall'
]);

const clone = (value) => structuredClone(value);

const permissionsOf = (manifest) => new Set(
  (manifest?.contributions ?? []).flatMap((contribution) => contribution?.permissions ?? [])
);

const normalizedInject = (plugin) => {
  const inject = plugin?.inject;
  if (inject === undefined || inject === null) return [];
  if (Array.isArray(inject)) return inject;
  if (typeof inject === 'object') return Object.keys(inject);
  throw new Error('PLUGIN_INJECT_INVALID');
};

/**
 * Translate manifest permissions into the small Cordis service surface that a
 * dynamic contribution may request. This is deliberately host-owned: a
 * plugin cannot invent a service name and turn it into a capability grant.
 */
export const allowedPluginServices = (manifest) => {
  // The service grant is the manifest's declared permissions intersected with
  // its effective ceiling, so a READ_ONLY contribution can never reach the
  // executor or tool-registry control surface even if a manifest slips past the
  // validator.
  const permissions = new Set(permissionsWithinCeiling(manifest));
  return new Set(Object.entries(SERVICE_PERMISSIONS)
    .filter(([, required]) => [...required].some((permission) => permissions.has(permission)))
    .map(([service]) => service));
};

export const validatePluginInject = (manifest, plugin) => {
  const allowed = allowedPluginServices(manifest);
  for (const service of normalizedInject(plugin)) {
    if (typeof service !== 'string' || !allowed.has(service)) {
      throw new Error(`PLUGIN_CONTEXT_CAPABILITY_DENIED:${String(service).slice(0, 120)}`);
    }
  }
  return true;
};

const providedServiceNames = (manifest) => {
  const pluginId = String(manifest?.id ?? '');
  const exact = new Set();
  for (const contribution of manifest?.contributions ?? []) {
    if (typeof contribution?.id === 'string') exact.add(contribution.id);
    if (typeof contribution?.entrypoint === 'string') exact.add(contribution.entrypoint);
  }
  return {
    exact,
    prefixes: pluginId ? [`${pluginId}.`, `${pluginId}:`] : []
  };
};

const contextDenied = (member) => {
  throw new Error(`PLUGIN_CONTEXT_CAPABILITY_DENIED:${String(member).slice(0, 120)}`);
};

/**
 * Build the only context object passed to dynamically loaded code. Cordis
 * itself enforces `inject` for normal property reads, but its diagnostic
 * `ctx.get()` API intentionally bypasses that rule. This membrane closes that
 * escape hatch and prevents access to the root registry/policy/event objects.
 *
 * This is an object-capability boundary, not an OS sandbox. Executable local
 * plugins therefore still require governance/evaluation before ACTIVE; a
 * future process adapter can reuse the same service grant calculation.
 */
export const createCapabilityScopedPluginContext = (ctx, manifest, plugin) => {
  if (!ctx || typeof ctx !== 'object') throw new Error('PLUGIN_CONTEXT_INVALID');
  validatePluginInject(manifest, plugin);
  const allowedServices = allowedPluginServices(manifest);
  const declaredInject = new Set(normalizedInject(plugin));
  const provided = providedServiceNames(manifest);
  const canProvide = (name) => typeof name === 'string' && name.length <= 160 && (
    provided.exact.has(name) || provided.prefixes.some((prefix) => name.startsWith(prefix))
  );

  const safeRead = (member) => {
    if (member === 'get') {
      return (name, strict = true) => {
        if (!declaredInject.has(name) || !allowedServices.has(name)) return contextDenied(name);
        return ctx.get(name, strict);
      };
    }
    if (member === 'provide') {
      return (name, value) => {
        if (!canProvide(name)) return contextDenied(name);
        return ctx.provide(name, value);
      };
    }
    if (SAFE_CONTEXT_MEMBERS.has(member)) return ctx[member];
    if (allowedServices.has(member) && declaredInject.has(member)) return ctx[member];
    if (BLOCKED_CONTEXT_MEMBERS.has(member) || typeof member === 'string') return contextDenied(member);
    return undefined;
  };

  const target = Object.create(null);
  return new Proxy(target, {
    get: (_target, member) => safeRead(member),
    set: (_target, member) => contextDenied(member),
    defineProperty: (_target, member) => contextDenied(member),
    deleteProperty: (_target, member) => contextDenied(member),
    getPrototypeOf: () => null,
    setPrototypeOf: () => false,
    ownKeys: () => ['get', 'provide', ...SAFE_CONTEXT_MEMBERS, ...declaredInject],
    getOwnPropertyDescriptor: (_target, member) => {
      if (['get', 'provide', ...SAFE_CONTEXT_MEMBERS, ...declaredInject].includes(member)) {
        return { configurable: true, enumerable: true, value: safeRead(member), writable: false };
      }
      return undefined;
    },
    has: (_target, member) => ['get', 'provide', ...SAFE_CONTEXT_MEMBERS, ...declaredInject].includes(member)
  });
};

export const pluginContextGrantSummary = (manifest, plugin) => ({
  pluginId: String(manifest?.id ?? '').slice(0, 128),
  services: [...allowedPluginServices(manifest)].filter((service) => normalizedInject(plugin).includes(service)).sort(),
  permissions: [...permissionsOf(manifest)].sort(),
  ceiling: effectivePermissionCeiling(manifest)
});

export const pluginContextPolicy = () => clone({
  servicePermissions: Object.fromEntries(Object.entries(SERVICE_PERMISSIONS).map(([key, value]) => [key, [...value]])),
  blockedMembers: [...BLOCKED_CONTEXT_MEMBERS]
});
