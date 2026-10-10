import { CAPABILITIES, EXECUTION_MODES, SAFETY_ERROR_CODES, SafetyError } from './runtime-safety-monitor.mjs';
import { applyTextPatch, MAX_PATCH_TEXT, TextPatchError, textDigest, unifiedTextDiff } from './text-patch.mjs';
import { RestrictedWindowsExecutor } from './restricted-windows-executor.mjs';

const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_PATH_LENGTH = 512;
const MAX_FILE_CHARS = 1024 * 1024;

// Use the workspace API's own page size. A truncated read is never a complete
// patch source: stitching pages must retain one full-file digest throughout.
const readCompleteText = async (workspace, path, { maxChars = MAX_FILE_CHARS, maxBytes = Infinity } = {}) => {
  let current, content = '';
  do {
    const page = await workspace.read(path, undefined, content.length);
    if (current && (page.digest !== current.digest || page.path !== current.path)) throw new TextPatchError('PATCH_STALE_DIGEST');
    current ??= page;
    if (content.length + page.content.length > maxChars) throw new TextPatchError('PATCH_TOO_LARGE');
    if (page.truncated && !page.content.length) throw new Error('WORKSPACE_INVALID_READ_PAGE');
    content += page.content;
    if (Buffer.byteLength(content, 'utf8') > maxBytes) throw new TextPatchError('PATCH_TOO_LARGE');
    if (!page.truncated) break;
  } while (true);
  return { ...current, content, truncated: false };
};

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

const patchInputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
    expectedDigest: { type: 'string', maxLength: 128 },
    replacements: {
      type: 'array', minItems: 1, maxItems: 32,
      items: {
        type: 'object',
        properties: {
          oldText: { type: 'string', minLength: 1, maxLength: MAX_FILE_CHARS },
          newText: { type: 'string', maxLength: MAX_FILE_CHARS },
          expectedCount: { type: 'integer', minimum: 1, maximum: 32 }
        },
        required: ['oldText', 'newText'],
        additionalProperties: false
      }
    }
  },
  required: ['path', 'replacements'],
  additionalProperties: false
};

const diffInputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
    baseContent: { type: 'string', maxLength: MAX_FILE_CHARS },
    maxChars: { type: 'integer', minimum: 1, maximum: MAX_FILE_CHARS }
  },
  required: ['path', 'baseContent'],
  additionalProperties: false
};

const patchOutputSchema = {
  type: 'object',
  properties: {
    ok: { const: true },
    action: { const: 'patch_file' },
    path: { type: 'string' },
    beforeDigest: { type: 'string' },
    afterDigest: { type: 'string' },
    diff: { type: 'string' },
    bytesWritten: { type: 'integer', minimum: 0 },
    contentDigest: { type: 'string' },
    lease: { type: ['string', 'null'] }
  },
  required: ['ok', 'action', 'path', 'beforeDigest', 'afterDigest', 'diff', 'bytesWritten', 'contentDigest'],
  additionalProperties: false
};

const diffOutputSchema = {
  type: 'object',
  properties: {
    ok: { const: true },
    action: { const: 'diff_file' },
    path: { type: 'string' },
    beforeDigest: { type: 'string' },
    afterDigest: { type: 'string' },
    changed: { type: 'boolean' },
    diff: { type: 'string' }
  },
  required: ['ok', 'action', 'path', 'beforeDigest', 'afterDigest', 'changed', 'diff'],
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
  const provider = async ({ capability, request }) => {
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
  provider.canLease = capability => monitor?.mode === EXECUTION_MODES.CONTROLLED && approvedCapabilities.has(capability)
    && (![CAPABILITIES.SHELL, CAPABILITIES.TEST].includes(capability) || approvedCommands.length > 0);
  return provider;
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
  networkAdapter,
  workspace,
  includeReadOnlyPatchTools = true
} = {}) => {
  requireMethod(executor, 'shell');
  requireMethod(executor, 'writeFile');
  requireMethod(executor, 'test');
  const getLease = typeof leaseProvider === 'function' ? leaseProvider : () => undefined;
  const effectMetadata = capability => ({ actionClass: 'SIDE_EFFECT', capability,
    ...(typeof leaseProvider?.canLease === 'function' ? { available: leaseProvider.canLease(capability) } : {}) });
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
    metadata: effectMetadata(CAPABILITIES.SHELL),
    handler: async (input) => executeWithLease(CAPABILITIES.SHELL, input, (lease) => executor.shell(input, { lease }))
  });
  registry.register({
    name: 'file.write',
    description: 'Write UTF-8 text to one explicitly approved file in the workspace.',
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
    readOnly: false,
    metadata: effectMetadata(CAPABILITIES.WRITE_FILE),
    handler: async (input) => executeWithLease(CAPABILITIES.WRITE_FILE, input, (lease) => executor.writeFile(input, { lease }))
  });
  if (workspace && typeof workspace.read === 'function') {
    if (includeReadOnlyPatchTools) {
      registry.register({
        name: 'file.diff',
        description: 'Compare one authorized workspace file with supplied base text and return a bounded unified diff.',
        inputSchema: diffInputSchema,
        outputSchema: diffOutputSchema,
        readOnly: true,
        metadata: { actionClass: 'READ_ONLY' },
        handler: async ({ path, baseContent, maxChars = MAX_FILE_CHARS }) => {
          const current = await readCompleteText(workspace, path, { maxChars });
          const diff = unifiedTextDiff(baseContent, current.content, current.path);
          return {
            ok: true,
            action: 'diff_file',
            path: current.path,
            beforeDigest: textDigest(baseContent),
            afterDigest: current.digest,
            changed: diff.length > 0,
            diff
          };
        }
      });
    }
    registry.register({
      name: 'file.patch',
      description: 'Apply bounded exact replacements to a complete authorized workspace file (up to 256 KiB UTF-8). Optional expectedDigest accepts sha256:hex or the same 64 hex digits and rejects stale content.',
      inputSchema: patchInputSchema,
      outputSchema: patchOutputSchema,
      readOnly: false,
      metadata: effectMetadata(CAPABILITIES.WRITE_FILE),
      handler: async ({ path, expectedDigest, replacements }) => {
        const current = await readCompleteText(workspace, path, { maxBytes: MAX_PATCH_TEXT });
        const content = applyTextPatch(current.content, replacements, expectedDigest);
        const writeResult = await executeWithLease(CAPABILITIES.WRITE_FILE, { path: current.path, content }, async (lease) => {
          const latest = await workspace.read(current.path);
          if (latest.digest !== current.digest) throw new TextPatchError('PATCH_STALE_DIGEST');
          return executor.writeFile({ path: current.path, content }, { lease });
        });
        return {
          ...writeResult,
          action: 'patch_file',
          beforeDigest: current.digest,
          afterDigest: textDigest(content),
          diff: unifiedTextDiff(current.content, content, current.path)
        };
      }
    });
  }
  registry.register({
    name: 'test.execute',
    description: 'Run one explicitly approved test command in the authorized workspace.',
    inputSchema: commandInputSchema,
    outputSchema: processOutputSchema,
    readOnly: false,
    metadata: { ...effectMetadata(CAPABILITIES.TEST),
      ...(executor instanceof RestrictedWindowsExecutor ? { processObservationPolicy: 'RESTRICTED_WINDOWS_NO_PRELOAD' } : {}) },
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
      metadata: effectMetadata(CAPABILITIES.NETWORK),
      handler: async (input) => executeWithLease(CAPABILITIES.NETWORK, input, (lease) => networkAdapter.request(input, { lease }))
    });
  }
  return registry;
};
