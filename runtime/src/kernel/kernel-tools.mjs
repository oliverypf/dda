import { createResidentKernel } from './resident-kernel.mjs';
import { createSessionStateStore } from './session-state.mjs';
import { residentKernelAvailability } from './feature.mjs';

/**
 * Model-facing tool surface for the resident kernel.
 *
 * In Phase-1 these tools are the primary surface the model uses, while the
 * discrete read-only workspace tools (workspace.list/read/focus) remain
 * registered as a fallback. Every kernel tool is read-only at the registry
 * boundary: workspace ops are pure reads, and session-state read/write mutates
 * host-owned session metadata rather than the workspace or the outside world.
 */

// An empty schema accepts any JSON value. The strict object dialect used by the
// tool registry forces additionalProperties:false whenever 'object' appears in a
// type list, which would reject nested session values; "any JSON" is the correct
// contract for an opaque session value or host_request payload.
const ANY_JSON_VALUE = {};

const workspaceListSchema = {
  type: 'object',
  properties: { path: { type: 'string', maxLength: 512 } },
  required: [],
  additionalProperties: false
};

const workspaceReadSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 512 },
    maxChars: { type: 'integer', minimum: 1, maximum: 32768 },
    offsetChars: { type: 'integer', minimum: 0 },
    findText: { type: 'string', minLength: 1, maxLength: 512 }
  },
  required: ['path'],
  additionalProperties: false
};

const workspaceFocusSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 512 },
    findText: { type: 'string', minLength: 1, maxLength: 512 },
    maxChars: { type: 'integer', minimum: 1, maximum: 6000 }
  },
  required: ['path', 'findText'],
  additionalProperties: false
};

const sessionKeySchema = {
  type: 'object',
  properties: { key: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' } },
  required: ['key'],
  additionalProperties: false
};

const sessionSetSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 240, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' },
    value: ANY_JSON_VALUE
  },
  required: ['key', 'value'],
  additionalProperties: false
};

const hostRequestSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', minLength: 1, maxLength: 120 },
    payload: ANY_JSON_VALUE
  },
  required: ['kind'],
  additionalProperties: false
};

/** Register the kernel ops on a ToolRegistry as the primary model surface. */
export const registerResidentKernelTools = (registry, kernel, { hostRequestDispatcher } = {}) => {
  if (!registry || typeof registry.register !== 'function') throw new Error('KERNEL_TOOLS_REGISTRY_REQUIRED');
  if (!kernel || typeof kernel.request !== 'function') throw new Error('KERNEL_TOOLS_KERNEL_REQUIRED');

  const kernelMeta = { actionClass: 'READ_ONLY', surface: 'resident-kernel' };

  registry.register({
    name: 'kernel.workspace_list',
    description: 'List visible entries in the authorized workspace or a child directory through the resident kernel. path MUST be relative (empty string or e.g. src); never an absolute path.',
    inputSchema: workspaceListSchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ path = '' }) => kernel.request('workspace.list', { path })
  });
  registry.register({
    name: 'kernel.workspace_read',
    description: 'Read a bounded UTF-8 text file from the authorized workspace through the resident kernel. path MUST be relative. For files over 32KB page with offsetChars, or pass findText (literal) to locate a match.',
    inputSchema: workspaceReadSchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ path, maxChars, offsetChars, findText }) => kernel.request('workspace.read', {
      path,
      ...(maxChars === undefined ? {} : { maxChars }),
      ...(offsetChars === undefined ? {} : { offsetChars }),
      ...(findText === undefined ? {} : { findText })
    })
  });
  registry.register({
    name: 'kernel.workspace_focus',
    description: 'Extract source around one unique literal locator in a known relative file through the resident kernel. Returns the full-file digest, offset and a bounded excerpt. Ambiguous or missing locators fail.',
    inputSchema: workspaceFocusSchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ path, findText, maxChars }) => kernel.request('workspace.focus', {
      path,
      findText,
      ...(maxChars === undefined ? {} : { maxChars })
    })
  });
  registry.register({
    name: 'kernel.session_get',
    description: 'Read one value from durable session state by key. Returns found:false when the key is unset.',
    inputSchema: sessionKeySchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ key }) => kernel.request('session_state.get', { key })
  });
  registry.register({
    name: 'kernel.session_list',
    description: 'List the keys currently stored in durable session state.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    readOnly: true,
    metadata: kernelMeta,
    handler: () => kernel.request('session_state.list', {})
  });
  registry.register({
    name: 'kernel.session_set',
    description: 'Write one JSON value to durable session state under key. Session state is host-owned metadata persisted across kernel restarts; it is not a workspace side effect.',
    inputSchema: sessionSetSchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ key, value }) => kernel.request('session_state.set', { key, value })
  });
  registry.register({
    name: 'kernel.session_delete',
    description: 'Remove one key from durable session state.',
    inputSchema: sessionKeySchema,
    readOnly: true,
    metadata: kernelMeta,
    handler: ({ key }) => kernel.request('session_state.delete', { key })
  });
  const effectsOn = Boolean(hostRequestDispatcher?.availability?.available);
  const effectKinds = effectsOn ? hostRequestDispatcher.availability.kinds : [];
  const batchOn = effectsOn && hostRequestDispatcher.availability.writeBatch === true;
  const bridgeToWorker = async (kind, payload) => {
    try {
      return await kernel.request('host_request', { kind, ...(payload === undefined ? {} : { payload }) });
    } catch (error) {
      // A bridge timeout/uncertain outcome is never replayed and arms the
      // "next effect needs an individual live approval" flag (FROZEN #6).
      hostRequestDispatcher?.noteBridgeOutcome?.(error?.code);
      throw error;
    }
  };
  registry.register({
    name: 'kernel.host_request',
    description: effectsOn
      ? 'Host bridge of the resident kernel. Inert probes: host.ping, host.capabilities. Host-executed side effects (Phase-2a, each one gated, approved and leased by the host exactly like the former discrete tools): '
        + effectKinds.map((kind) => ({
          'fs.write': 'fs.write payload {path, content, expectedBaseDigest (digest from the latest read, or null for a new file)}',
          'fs.patch': 'fs.patch payload {path, replacements:[{oldText,newText,expectedCount?}], expectedBaseDigest?}',
          'test.run': 'test.run payload {command, args?, cwd?, timeoutMs?} (lease-approved test commands only)'
        })[kind]).join('; ')
        + (batchOn ? `; fs.write_batch payload {items:[{op:'write'|'patch', path, content|replacements, expectedBaseDigest}]} (<=${10} items, <=256KB, one batch per round; stops at the first failure and never rolls back)` : '')
        + '. shell.exec and net.fetch are refused. Paths MUST be workspace-relative.'
      : 'Phase-1 host bridge stub. Answers only inert probes (host.ping, host.capabilities). Any side-effecting request is refused with KERNEL_SIDE_EFFECT_REFUSED until Phase-2. Blocked in READ_ONLY even though the registry marks it readOnly (inert probes only); it is the Phase-2 side-effect bridge.',
    inputSchema: hostRequestSchema,
    // With effects on the bridge is a side-effect tool (never read-only).
    readOnly: !effectsOn,
    metadata: effectsOn ? { actionClass: 'SIDE_EFFECT', surface: 'resident-kernel', kernelEffects: effectKinds, kernelWriteBatch: batchOn } : kernelMeta,
    handler: async ({ kind, payload }, context) => {
      if (hostRequestDispatcher && typeof hostRequestDispatcher.handles === 'function' && hostRequestDispatcher.handles(kind)) {
        return hostRequestDispatcher.dispatch({ kind, payload }, context);
      }
      return bridgeToWorker(kind, payload);
    }
  });
  return registry;
};

/**
 * Attach a resident kernel to a tool registry when the feature is available,
 * otherwise return a no-op handle so the caller falls back to discrete tools.
 * The returned handle always exposes stop() for clean shutdown.
 */
export const attachResidentKernel = async ({
  registry,
  workspaceRoot,
  excludedPaths = [],
  sessionId,
  sessionStatePath,
  env = process.env,
  platform = process.platform,
  nodeVersion = process.version,
  workerPath,
  nodeBinary,
  requestTimeoutMs,
  hostRequestDispatcher
} = {}) => {
  const availability = residentKernelAvailability(env, { platform, nodeVersion });
  if (!availability.available) {
    return { attached: false, availability, kernel: null, sessionStore: null, stop: async () => {} };
  }
  const sessionStore = createSessionStateStore({ storagePath: sessionStatePath, sessionId });
  const kernel = createResidentKernel({
    workspaceRoot,
    excludedPaths,
    sessionId,
    sessionStore,
    env,
    ...(workerPath ? { workerPath } : {}),
    ...(nodeBinary ? { nodeBinary } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {})
  });
  try {
    await kernel.start();
  } catch (error) {
    await kernel.stop().catch(() => {});
    return {
      attached: false,
      availability: { ...availability, available: false, reason: 'START_FAILED', error: error?.message },
      kernel: null,
      sessionStore: null,
      stop: async () => {}
    };
  }
  registerResidentKernelTools(registry, kernel, { hostRequestDispatcher });
  return { attached: true, availability, kernel, sessionStore, stop: () => kernel.stop() };
};
