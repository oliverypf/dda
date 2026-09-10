import { CAPABILITIES, EXECUTION_MODES, SAFETY_ERROR_CODES, SafetyError } from './runtime-safety-monitor.mjs';

const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_PATH_LENGTH = 512;
const MAX_FILE_CHARS = 1024 * 1024;

const commandInputSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_LENGTH },
    args: { type: 'array', maxItems: MAX_ARGUMENTS, items: { type: 'string', maxLength: MAX_ARGUMENT_LENGTH } },
    cwd: { type: 'string', maxLength: MAX_PATH_LENGTH },
    input: { type: 'string', maxLength: 64 * 1024 },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60 * 1000 },
    maxOutputBytes: { type: 'integer', minimum: 1, maximum: 256 * 1024 },
    maxOutputChars: { type: 'integer', minimum: 1, maximum: 256 * 1024 }
  },
  required: ['command'],
  additionalProperties: false
};

const writeInputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
    content: { type: 'string', maxLength: MAX_FILE_CHARS }
  },
  required: ['path', 'content'],
  additionalProperties: false
};

const processOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: ['integer', 'null'] },
    signal: { type: ['string', 'null'] },
    aborted: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    durationMs: { type: 'integer', minimum: 0 },
    action: { type: 'string' },
    commandDigest: { type: 'string' },
    cwd: { type: 'string' },
    lease: { type: ['string', 'null'] }
  },
  required: ['ok', 'timedOut', 'aborted', 'truncated', 'stdout', 'stderr', 'action', 'cwd'],
  additionalProperties: false
};

const writeOutputSchema = {
  type: 'object',
  properties: {
    ok: { const: true },
    action: { const: 'write_file' },
    path: { type: 'string' },
    bytesWritten: { type: 'integer', minimum: 0 },
    contentDigest: { type: 'string' },
    lease: { type: ['string', 'null'] }
  },
  required: ['ok', 'action', 'path', 'bytesWritten', 'contentDigest'],
  additionalProperties: false
};

const networkInputSchema = {
  type: 'object',
  properties: {
    host: { type: 'string', minLength: 1, maxLength: 253 },
    port: { type: 'integer', minimum: 1, maximum: 65535 },
    scheme: { type: 'string', enum: ['https', 'http'] },
    method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', minLength: 1, maxLength: 2048 },
    body: { type: 'string', maxLength: MAX_FILE_CHARS },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 60 * 1000 },
    maxResponseBytes: { type: 'integer', minimum: 1, maximum: 256 * 1024 },
    maxResponseChars: { type: 'integer', minimum: 1, maximum: 256 * 1024 }
  },
  required: ['host'],
  additionalProperties: false
};

const networkOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: ['integer', 'null'] },
    aborted: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    truncated: { type: 'boolean' },
    body: { type: 'string' },
    durationMs: { type: 'integer', minimum: 0 },
    action: { type: 'string' },
    targetDigest: { type: 'string' },
    lease: { type: ['string', 'null'] }
  },
  required: ['ok', 'status', 'aborted', 'timedOut', 'truncated', 'body', 'durationMs', 'action'],
  additionalProperties: false
};

const normalizeList = (value) => Array.isArray(value)
  ? [...new Set(value.filter((item) => typeof item === 'string' && item.length > 0))]
  : [];

/**
 * Create the only lease path used by model-facing side-effect tools. The
 * model never receives this callback or a lease object; the host decides
 * whether an explicitly approved capability may get one one-shot lease.
 */
export const createExplicitLeaseProvider = ({ monitor, capabilities = [], commands = [], networkTargets = [], ttlMs, requestApproval, onLeaseIssued } = {}) => {
  const approvedCapabilities = new Set(normalizeList(capabilities));
  const approvedCommands = normalizeList(commands);
  const approvedNetworkTargets = (Array.isArray(networkTargets) ? networkTargets : []).map((target) => {
    const parsed = typeof target === 'string' ? JSON.parse(target) : target;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.host !== 'string') {
      throw new TypeError('NETWORK_TARGET_INVALID');
    }
    return parsed;
  });
  return async ({ capability, request }) => {
    if (!monitor || monitor.mode !== EXECUTION_MODES.CONTROLLED) return undefined;
    if (!approvedCapabilities.has(capability)) return undefined;
    if ((capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST) && approvedCommands.length === 0) {
      return undefined;
    }
    if (typeof requestApproval === 'function') {
      const approved = await requestApproval({ capability, request });
      if (!approved) return undefined;
    }
    const lease = monitor.issueLease({
      capabilities: [capability],
      ...(approvedCommands.length ? { commands: approvedCommands } : {}),
      ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}),
      ...(ttlMs === undefined ? {} : { ttlMs })
    });
    await onLeaseIssued?.({ capability, request, lease });
    return lease;
  };
};

const requireMethod = (executor, name) => {
  if (!executor || typeof executor[name] !== 'function') throw new TypeError(`EXECUTOR_${name.toUpperCase()}_MISSING`);
};

/** Register the controlled executor behind strict, provider-neutral tools. */
export const registerExecutorTools = (registry, executor, {
  leaseProvider,
  onLeaseStarted,
  onLeaseConsumed,
  onLeaseFailed,
  networkAdapter
} = {}) => {
  requireMethod(executor, 'shell');
  requireMethod(executor, 'writeFile');
  requireMethod(executor, 'test');
  const getLease = typeof leaseProvider === 'function' ? leaseProvider : () => undefined;
  const executeWithLease = async (capability, input, operation) => {
    let lease;
    try {
      lease = await getLease({ capability, request: input });
      if (typeof leaseProvider === 'function' && !lease) throw new SafetyError(SAFETY_ERROR_CODES.LEASE_REQUIRED);
      await onLeaseStarted?.({ capability, request: input, lease });
      const result = await operation(lease);
      await onLeaseConsumed?.({ capability, request: input, lease, result });
      return result;
    } catch (error) {
      // Include provider and approval failures: a provider may have issued or
      // persisted a lease before a later callback failed.
      try {
        await onLeaseFailed?.({ capability, request: input, lease, error });
      } catch {
        // Cleanup/reporting failures must not replace the original error. The next runtime reconciliation can still revoke the lease.
      }
      throw error;
    } finally {
      lease?.releaseWorkspace?.();
    }
  };

  registry.register({
    name: 'shell.execute',
    description: 'Run one explicitly approved executable in the authorized workspace.',
    inputSchema: commandInputSchema,
    outputSchema: processOutputSchema,
    readOnly: false,
    metadata: { actionClass: 'SIDE_EFFECT', capability: CAPABILITIES.SHELL },
    handler: async (input) => executeWithLease(CAPABILITIES.SHELL, input, (lease) => executor.shell(input, { lease }))
  });
  registry.register({
    name: 'file.write',
    description: 'Write UTF-8 text to one explicitly approved file in the workspace.',
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
    readOnly: false,
    metadata: { actionClass: 'SIDE_EFFECT', capability: CAPABILITIES.WRITE_FILE },
    handler: async (input) => executeWithLease(CAPABILITIES.WRITE_FILE, input, (lease) => executor.writeFile(input, { lease }))
  });
  registry.register({
    name: 'test.execute',
    description: 'Run one explicitly approved test command in the authorized workspace.',
    inputSchema: commandInputSchema,
    outputSchema: processOutputSchema,
    readOnly: false,
    metadata: { actionClass: 'SIDE_EFFECT', capability: CAPABILITIES.TEST },
    handler: async (input) => executeWithLease(CAPABILITIES.TEST, input, (lease) => executor.test(input, { lease }))
  });
  if (networkAdapter) {
    if (typeof networkAdapter.request !== 'function') throw new TypeError('EXECUTOR_NETWORK_ADAPTER_INVALID');
    registry.register({
      name: 'network.request',
      description: 'Send one explicitly approved network request to an authorized target.',
      inputSchema: networkInputSchema,
      outputSchema: networkOutputSchema,
      readOnly: false,
      metadata: { actionClass: 'SIDE_EFFECT', capability: CAPABILITIES.NETWORK },
      handler: async (input) => executeWithLease(CAPABILITIES.NETWORK, input, (lease) => networkAdapter.request(input, { lease }))
    });
  }
  return registry;
};
