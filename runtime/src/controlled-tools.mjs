import { createHash } from 'node:crypto';
import { isAbsolute, resolve as resolvePath, relative as relativePath, sep as pathSep } from 'node:path';
import { CAPABILITIES, EXECUTION_MODES, SAFETY_ERROR_CODES, SafetyError } from './runtime-safety-monitor.mjs';
import { applyTextPatch, MAX_PATCH_TEXT, MAX_PATCH_FILE_BYTES, TextPatchError, textDigest, unifiedTextDiff } from './text-patch.mjs';
import { RestrictedWindowsExecutor } from './restricted-windows-executor.mjs';
import { canonicalJson } from './model-tool-calls.mjs';

const MAX_COMMAND_LENGTH = 4096;
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_PATH_LENGTH = 512;

const MAX_FILE_CHARS = 1024 * 1024;

/** Keep only top-level keys declared in schema.properties (Fix 1a). */
export const pickDeclared = (value, schema) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return value;
  const picked = {};
  for (const key of Object.keys(properties)) {
    if (Object.prototype.hasOwnProperty.call(value, key)) picked[key] = value[key];
  }
  return picked;
};

const APPLIED_WRITES_LIMIT = 64;
const ledgerDigest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
const normalizeReplacements = (replacements) => (Array.isArray(replacements) ? replacements : []).map((item) => ({
  oldText: item.oldText,
  newText: item.newText,
  expectedCount: item.expectedCount === undefined ? 1 : item.expectedCount
}));
const ledgerKey = (path, contentHash) => `${String(path).replaceAll('\\', '/')}\0${contentHash}`;
const touchLedger = (ledger, key, entry) => {
  if (ledger.has(key)) ledger.delete(key);
  ledger.set(key, entry);
  while (ledger.size > APPLIED_WRITES_LIMIT) ledger.delete(ledger.keys().next().value);
};

// Bound JSON-encoded UTF-8, including escaping, before returning a successful
// write. A large preview must not turn an applied mutation into a tool error.
const diffPreview = (before, after, path) => {
  const full = unifiedTextDiff(before, after, path);
  let diff = full;
  while (Buffer.byteLength(JSON.stringify(diff), 'utf8') > 24 * 1024) diff = diff.slice(0, Math.floor(diff.length / 2));
  if (/[\uD800-\uDBFF]$/u.test(diff)) diff = diff.slice(0, -1);
  return { diff, diffTruncated: diff.length < full.length || full.length >= MAX_PATCH_TEXT };
};

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
    content: { type: 'string', maxLength: MAX_FILE_CHARS },
    expectedDigest: { type: ['string', 'null'], pattern: '^(sha256:)?[a-fA-F0-9]{64}$' }
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
    lease: { type: ['string', 'null'] },
    // The Linux/HarmonyOS POSIX executor reports whether the outcome was
    // observed or is unknown (timeout/abort). Without this the approved
    // CONTROLLED shell result was rejected as TOOL_INVALID_OUTPUT.
    state: { type: 'string', enum: ['OBSERVED', 'UNKNOWN'] }
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
    lease: { type: ['string', 'null'] },
    state: { type: 'string', enum: ['OBSERVED'] },
    idempotentReplay: { const: true }
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
    diffTruncated: { type: 'boolean' },
    bytesWritten: { type: 'integer', minimum: 0 },
    contentDigest: { type: 'string' },
    lease: { type: ['string', 'null'] },
    state: { type: 'string', enum: ['OBSERVED'] },
    idempotentReplay: { const: true }
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
    diff: { type: 'string' },
    diffTruncated: { type: 'boolean' }
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

// Risk-based approval outcomes. A dangerous action or a mid-task REQUIRE_APPROVAL
// must reach a human when one can answer, and must never be silently granted a
// lease when no live approver exists.
export const APPROVAL_OUTCOMES = Object.freeze({ PROMPT: 'PROMPT', REFUSE: 'REFUSE', AUTO_APPROVE: 'AUTO_APPROVE' });

/**
 * Decide the approval outcome for a side-effect request. This is the single
 * fail-closed policy shared by the host: when no live approver is connected a
 * request that requires approval is refused rather than auto-approved by host
 * policy; a pre-approved, non-risky request keeps the prior host-policy path.
 */
export const resolveApprovalOutcome = ({ requireApproval = false, hasLiveApprover = false } = {}) =>
  hasLiveApprover
    ? APPROVAL_OUTCOMES.PROMPT
    : requireApproval ? APPROVAL_OUTCOMES.REFUSE : APPROVAL_OUTCOMES.AUTO_APPROVE;

// Verifier verdicts that must freeze further side effects behind an explicit
// re-approval instead of silently continuing recovery. A verifier (the Rule
// Verifier or a Jev VERIFY_BEHAVIOR judgment) that cannot vouch for the result
// (UNCERTAIN) or reports stalled progress (STALLED) is treated, for the next
// side-effecting action, like a mid-task REQUIRE_APPROVAL. Jev's "high
// uncertainty" is normalized into the UNCERTAIN status upstream, so keying off
// the settled verifier status also covers that case.
export const REAPPROVAL_VERIFIER_STATUSES = Object.freeze(new Set(['UNCERTAIN', 'STALLED']));

/**
 * Decide whether a settled verifier report must force an explicit re-approval of
 * the next side-effecting action. This never relaxes a decision: it only adds an
 * approval requirement, which the shared fail-closed policy then resolves to a
 * prompt (live user) or a refusal (no live approver).
 */
export const verifierStateRequiresReapproval = ({ status } = {}) =>
  REAPPROVAL_VERIFIER_STATUSES.has(String(status ?? '').toUpperCase());

const baseRiskForCapability = (capability) => {
  if (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.WRITE_FILE || capability === CAPABILITIES.NETWORK) return 'HIGH';
  if (capability === CAPABILITIES.TEST) return 'MEDIUM';
  return 'LOW';
};

// Secret material a controlled write must never touch without an explicit human
// decision, matched on any path segment so a nested .ssh/ or .aws/ still trips.
const SECRET_PATH_SEGMENT = /^(\.env(\..+)?|\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)$/i;
const SECRET_PATH_EXTENSION = /\.(pem|key|p12|pfx|keystore|jks|asc|ppk)$/i;

const isSecretPath = (path) => {
  const segments = String(path).split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => SECRET_PATH_SEGMENT.test(segment))) return true;
  const basename = segments.at(-1) ?? '';
  return SECRET_PATH_EXTENSION.test(basename) || /(^|[._-])secret/i.test(basename);
};

const pathEscapesWorkspace = (path, workspaceRoot) => {
  if (!workspaceRoot) return isAbsolute(path) || String(path).split(/[\\/]+/).includes('..');
  const resolved = resolvePath(workspaceRoot, path);
  const rel = relativePath(workspaceRoot, resolved);
  return rel === '..' || rel.startsWith(`..${pathSep}`) || rel.startsWith('../') || isAbsolute(rel);
};

const hasRecursiveForceRemove = (line) => /\brm\b/.test(line)
  && (/(^|\s)-{1,2}[a-z]*r[a-z]*f/i.test(line) || /(^|\s)-{1,2}[a-z]*f[a-z]*r/i.test(line)
    || (/--recursive/i.test(line) && /--force/i.test(line))
    || (/(^|\s)-[a-z]*r/i.test(line) && /(^|\s)-[a-z]*f/i.test(line)));

/**
 * A small, deterministic danger check applied before any lease is issued. It
 * never relaxes a decision: a match forces HIGH risk and an explicit approval,
 * independent of (and in addition to) the Jev action gate. It covers the
 * highest-impact irreversible actions: recursive force removal, privilege
 * escalation, destructive git operations, piping a download into a shell, and
 * writes that escape the workspace or target secret material.
 */
export const assessRequestRisk = ({ capability, request = {}, workspaceRoot } = {}) => {
  const reasons = [];
  if (capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST) {
    const command = typeof request.command === 'string' ? request.command : '';
    const args = Array.isArray(request.args) ? request.args.filter((item) => typeof item === 'string') : [];
    const line = [command, ...args].join(' ');
    const lower = line.toLowerCase();
    if (hasRecursiveForceRemove(lower)) reasons.push('DANGEROUS_RECURSIVE_REMOVE');
    if (/(^|\s|[\\/])sudo(\s|$)/.test(lower)) reasons.push('DANGEROUS_PRIVILEGE_ESCALATION');
    if (/\bgit\s+push\b/.test(lower)) reasons.push('DANGEROUS_GIT_PUSH');
    if (/\bgit\s+reset\b[\s\S]*--hard\b/.test(lower)) reasons.push('DANGEROUS_GIT_RESET_HARD');
    if (/\bgit\s+clean\b[\s\S]*(^|\s)-[a-z]*f/.test(lower)) reasons.push('DANGEROUS_GIT_CLEAN_FORCE');
    if (/\b(curl|wget|fetch)\b[\s\S]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python[0-9.]*|node|ruby|perl)\b/.test(lower)
      || /\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/.test(lower)) reasons.push('DANGEROUS_PIPE_TO_SHELL');
  }
  if (capability === CAPABILITIES.WRITE_FILE) {
    const path = typeof request.path === 'string' ? request.path : '';
    if (path) {
      if (pathEscapesWorkspace(path, workspaceRoot)) reasons.push('DANGEROUS_WRITE_OUTSIDE_WORKSPACE');
      if (isSecretPath(path)) reasons.push('DANGEROUS_SECRET_FILE_PATH');
    }
  }
  const dangerous = reasons.length > 0;
  return { dangerous, risk: dangerous ? 'HIGH' : baseRiskForCapability(capability), reasons };
};

/**
 * Create the only lease path used by model-facing side-effect tools. The
 * model never receives this callback or a lease object; the host decides
 * whether an explicitly approved capability may get one one-shot lease.
 */
export const createExplicitLeaseProvider = ({ monitor, capabilities = [], commands = [], networkTargets = [], ttlMs, requestApproval, gateDecisionFor, onLeaseIssued } = {}) => {
  const approvedCapabilities = new Set(normalizeList(capabilities));
  const approvedCommands = normalizeList(commands);
  const approvedNetworkTargets = (Array.isArray(networkTargets) ? networkTargets : []).map((target) => {
    const parsed = typeof target === 'string' ? JSON.parse(target) : target;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.host !== 'string') {
      throw new TypeError('NETWORK_TARGET_INVALID');
    }
    return parsed;
  });
  const provider = async ({ capability, request, context } = {}) => {
    if (!monitor || monitor.mode !== EXECUTION_MODES.CONTROLLED) return undefined;
    if (!approvedCapabilities.has(capability)) return undefined;
    if ((capability === CAPABILITIES.SHELL || capability === CAPABILITIES.TEST) && approvedCommands.length === 0) {
      return undefined;
    }
    // A mid-task Jev REQUIRE_APPROVAL (persisted by tool-call id/arg hash) or a
    // deterministic danger match forces an explicit approval. Pre-approved,
    // non-risky actions keep their prior host-policy path.
    const assessment = assessRequestRisk({ capability, request, workspaceRoot: monitor.workspaceRoot });
    const gate = typeof gateDecisionFor === 'function' ? await gateDecisionFor({ capability, request, context }) : undefined;
    const requireApproval = assessment.dangerous || gate?.requireApproval === true;
    // Fail closed: a risky action may never receive a lease when there is no
    // approval mechanism at all to answer for it.
    if (requireApproval && typeof requestApproval !== 'function') return undefined;
    if (typeof requestApproval === 'function') {
      const approved = await requestApproval({ capability, request, context, requireApproval, risk: assessment.risk, dangerReasons: assessment.reasons });
      if (!approved) return undefined;
    }
    const lease = monitor.issueLease({
      capabilities: [capability],
      ...(approvedCommands.length ? { commands: approvedCommands } : {}),
      ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}),
      ...(ttlMs === undefined ? {} : { ttlMs })
    });
    await onLeaseIssued?.({ capability, request, lease, context });
    return lease;
  };
  provider.canLease = capability => monitor?.mode === EXECUTION_MODES.CONTROLLED && approvedCapabilities.has(capability)
    && (![CAPABILITIES.SHELL, CAPABILITIES.TEST].includes(capability) || approvedCommands.length > 0);
  // Model-facing guidance is a snapshot, never an authorization mechanism.
  Object.defineProperty(provider, 'approvedCommands', { value: Object.freeze([...approvedCommands]) });
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
  // Per-registry in-memory applied-write ledger (Fix 1c): path+content hash → digests.
  const appliedWrites = new Map();
  const getLease = typeof leaseProvider === 'function' ? leaseProvider : () => undefined;
  const effectMetadata = capability => ({ actionClass: 'SIDE_EFFECT', capability,
    ...(typeof leaseProvider?.canLease === 'function' ? { available: leaseProvider.canLease(capability) } : {}) });
  const commandMetadata = capability => ({ ...effectMetadata(capability),
    ...(Array.isArray(leaseProvider?.approvedCommands) ? { approvedCommands: leaseProvider.approvedCommands } : {}) });
  const commandGuidance = Array.isArray(leaseProvider?.approvedCommands)
    ? ` Lease-approved executables: ${JSON.stringify(leaseProvider.approvedCommands)}; executor restrictions still apply. Pass the executable in command and each argument separately in args, with a workspace-relative cwd. Use workspace.list/workspace.read for inspection. Do not substitute an unapproved shell or bypass a denied command.`
    : '';
  const executeWithLease = async (capability, input, operation, context) => {
    let lease;
    try {
      lease = await getLease({ capability, request: input, context });
      if (typeof leaseProvider === 'function' && !lease) throw new SafetyError(SAFETY_ERROR_CODES.LEASE_REQUIRED);
      await onLeaseStarted?.({ capability, request: input, lease, context });
      const result = await operation(lease);
      await onLeaseConsumed?.({ capability, request: input, lease, result, context });
      return result;
    } catch (error) {
      // Include provider and approval failures: a provider may have issued or
      // persisted a lease before a later callback failed.
      try {
        await onLeaseFailed?.({ capability, request: input, lease, error, context });
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
    description: 'Run one explicitly approved executable in the authorized workspace.' + commandGuidance,
    inputSchema: commandInputSchema,
    outputSchema: processOutputSchema,
    readOnly: false,
    metadata: commandMetadata(CAPABILITIES.SHELL),
    handler: async (input, context) => pickDeclared(
      await executeWithLease(CAPABILITIES.SHELL, input, (lease) => executor.shell(input, { lease }), context),
      processOutputSchema
    )
  });
  registry.register({
    name: 'file.write',
    description: 'Write UTF-8 text to one explicitly approved file in the workspace. Supply expectedDigest from the latest workspace read (null for a new file). The host checks the source version before and after approval; a conflict requires a fresh read.',
    inputSchema: writeInputSchema,
    outputSchema: writeOutputSchema,
    readOnly: false,
    metadata: effectMetadata(CAPABILITIES.WRITE_FILE),
    handler: async (input, context) => {
      let request = input;
      let currentDigest = null;
      let resolvedPath = typeof input.path === 'string' ? input.path : '';
      if (workspace && typeof workspace.read === 'function') {
        let current;
        try { current = await workspace.read(input.path, 1); }
        catch (error) {
          if (!String(error.message).startsWith('WORKSPACE_NOT_FOUND:')) throw error;
          current = null;
        }
        currentDigest = current?.digest ?? null;
        resolvedPath = current?.path ?? input.path;
        const expected = typeof input.expectedDigest === 'string' ? input.expectedDigest.toLowerCase().replace(/^(?!sha256:)/, 'sha256:') : input.expectedDigest;
        if (expected !== undefined && expected !== currentDigest) throw new TextPatchError('WRITE_STALE_DIGEST');
        request = { ...input, expectedDigest: currentDigest };
      }
      const writeKey = ledgerKey(resolvedPath, ledgerDigest(String(input.content ?? '')));
      const prior = appliedWrites.get(writeKey);
      if (prior) {
        touchLedger(appliedWrites, writeKey, prior);
        if (currentDigest === prior.afterDigest) {
          return pickDeclared({
            ok: true,
            action: 'write_file',
            path: resolvedPath,
            bytesWritten: 0,
            contentDigest: prior.afterDigest,
            lease: null,
            state: 'OBSERVED',
            idempotentReplay: true
          }, writeOutputSchema);
        }
        if (currentDigest !== null && currentDigest !== prior.beforeDigest) {
          throw new TextPatchError('WRITE_STALE_DIGEST');
        }
      }
      const writeResult = await executeWithLease(CAPABILITIES.WRITE_FILE, request, (lease) => executor.writeFile(request, { lease }), context);
      // Ledger write after lease consumed, before registry output validation (Fix 1c / B4).
      touchLedger(appliedWrites, writeKey, {
        beforeDigest: currentDigest,
        afterDigest: writeResult.contentDigest
      });
      return pickDeclared(writeResult, writeOutputSchema);
    }
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
          const preview = diffPreview(baseContent, current.content, current.path);
          return {
            ok: true,
            action: 'diff_file',
            path: current.path,
            beforeDigest: textDigest(baseContent),
            afterDigest: current.digest,
            changed: baseContent !== current.content,
            ...preview
          };
        }
      });
    }
    registry.register({
      name: 'file.patch',
      description: 'Apply small exact replacements to a complete authorized workspace file (source and result up to 1 MiB UTF-8; each replacement up to 256 KiB). Prefer small separate patches within tool-call argument limits. Optional expectedDigest accepts sha256:hex or the same 64 hex digits and rejects stale content.',
      inputSchema: patchInputSchema,
      outputSchema: patchOutputSchema,
      readOnly: false,
      metadata: effectMetadata(CAPABILITIES.WRITE_FILE),
      handler: async ({ path, expectedDigest, replacements }, context) => {
        const current = await readCompleteText(workspace, path, { maxBytes: MAX_PATCH_FILE_BYTES });
        const normalized = normalizeReplacements(replacements);
        const patchKey = ledgerKey(current.path, ledgerDigest(normalized));
        const prior = appliedWrites.get(patchKey);
        if (prior) {
          touchLedger(appliedWrites, patchKey, prior);
          if (current.digest === prior.afterDigest) {
            return pickDeclared({
              ok: true,
              action: 'patch_file',
              path: current.path,
              beforeDigest: prior.beforeDigest,
              afterDigest: prior.afterDigest,
              diff: typeof prior.diff === 'string' ? prior.diff : '',
              ...(prior.diffTruncated !== undefined ? { diffTruncated: prior.diffTruncated } : {}),
              bytesWritten: 0,
              contentDigest: prior.afterDigest,
              lease: null,
              state: 'OBSERVED',
              idempotentReplay: true
            }, patchOutputSchema);
          }
          if (current.digest !== prior.beforeDigest) throw new TextPatchError('PATCH_STALE_DIGEST');
          // digest === beforeDigest: fall through and re-apply via the normal path.
        }
        const content = applyTextPatch(current.content, replacements, expectedDigest);
        const afterDigest = textDigest(content);
        const preview = diffPreview(current.content, content, current.path);
        const writeResult = await executeWithLease(CAPABILITIES.WRITE_FILE, { path: current.path, content }, async (lease) => {
          const latest = await workspace.read(current.path);
          if (latest.digest !== current.digest) throw new TextPatchError('PATCH_STALE_DIGEST');
          return executor.writeFile({ path: current.path, content, expectedDigest: current.digest }, { lease });
        }, context);
        // Ledger must be written even if registry later rejects the output (AFTER_EFFECT path).
        touchLedger(appliedWrites, patchKey, {
          beforeDigest: current.digest,
          afterDigest,
          diff: preview.diff,
          diffTruncated: preview.diffTruncated
        });
        return pickDeclared({
          ok: true,
          action: 'patch_file',
          path: current.path,
          beforeDigest: current.digest,
          afterDigest,
          ...preview,
          bytesWritten: writeResult.bytesWritten,
          contentDigest: writeResult.contentDigest ?? afterDigest,
          lease: writeResult.lease ?? null,
          ...(writeResult.state === 'OBSERVED' ? { state: 'OBSERVED' } : {})
        }, patchOutputSchema);
      }
    });
  }
  registry.register({
    name: 'test.execute',
    description: 'Run one explicitly approved test command in the authorized workspace.' + commandGuidance,
    inputSchema: commandInputSchema,
    outputSchema: processOutputSchema,
    readOnly: false,
    metadata: { ...commandMetadata(CAPABILITIES.TEST),
      ...(executor instanceof RestrictedWindowsExecutor ? { processObservationPolicy: 'RESTRICTED_WINDOWS_NO_PRELOAD' } : {}) },
    handler: async (input, context) => pickDeclared(
      await executeWithLease(CAPABILITIES.TEST, input, (lease) => executor.test(input, { lease }), context),
      processOutputSchema
    )
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
      handler: async (input, context) => pickDeclared(
        await executeWithLease(CAPABILITIES.NETWORK, input, (lease) => networkAdapter.request(input, { lease }), context),
        networkOutputSchema
      )
    });
  }
  return registry;
};
