import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isLinuxCliPlatform } from '../platform/paths.mjs';
import { isResidentKernelEnabled } from './feature.mjs';
import { CAPABILITIES } from '../runtime-safety-monitor.mjs';
import { assessRequestRisk } from '../controlled-tools.mjs';
import { applyTextPatch, textDigest } from '../text-patch.mjs';
import { persistJsonFile, readPersistentJsonFile } from '../persistent-json-store.mjs';
import { parseHostRequestPayload } from './host-request-payload.mjs';

/**
 * Prime Phase-2a: side effects requested through kernel.host_request.
 *
 * Frozen contract (docs: dda-prime-phase2-design.md, FROZEN):
 *  - default OFF; effects need DDA_RESIDENT_KERNEL + DDA_KERNEL_EFFECTS + Linux
 *    CLI identity + CONTROLLED + a capability lease for the mapped capability;
 *  - the HOST executes every effect through the existing discrete executor
 *    tools (file.write / file.patch / test.execute) and their lease provider;
 *    the kernel worker never executes a write/test/shell/network;
 *  - 2a enables only fs.write / fs.patch / test.run (+ fs.write_batch when
 *    DDA_KERNEL_WRITE_BATCH is on); shell.exec / net.fetch are refused;
 *  - approval goes through the unchanged resolveApprovalOutcome path. This
 *    module can only ADD an approval requirement (per-request policy, host
 *    denylist hit, uncertain kernel outcome) - it never relaxes one;
 *  - KERNEL_OUTCOME_UNCERTAIN / KERNEL_TIMEOUT never replay and arm "the next
 *    effect needs an individual live approval"; this is additive to (and never
 *    clears) the verifier #16 re-approval flag.
 */

export const KERNEL_EFFECTS_FLAG = 'DDA_KERNEL_EFFECTS';
export const KERNEL_APPROVAL_FLAG = 'DDA_KERNEL_APPROVAL';
export const KERNEL_WRITE_BATCH_FLAG = 'DDA_KERNEL_WRITE_BATCH';

export const KERNEL_EFFECT_KINDS = Object.freeze(['fs.write', 'fs.patch', 'test.run']);
export const KERNEL_BATCH_KIND = 'fs.write_batch';
// Recognized but refused in Phase-2a (deferred to a later PR).
export const KERNEL_DEFERRED_EFFECT_KINDS = Object.freeze(['shell.exec', 'net.fetch']);

export const KERNEL_EFFECT_TOOLS = Object.freeze({
  'fs.write': Object.freeze({ tool: 'file.write', capability: CAPABILITIES.WRITE_FILE }),
  'fs.patch': Object.freeze({ tool: 'file.patch', capability: CAPABILITIES.WRITE_FILE }),
  'test.run': Object.freeze({ tool: 'test.execute', capability: CAPABILITIES.TEST })
});

// Discrete side-effect tools hidden from the model while kernel effects are
// requested (FROZEN #4). Any other non-read-only, non-kernel tool registered
// later (for example browser tools) is hidden by the same predicate.
export const HIDDEN_DISCRETE_EFFECT_TOOLS = Object.freeze(['file.write', 'file.patch', 'shell.execute', 'test.execute', 'network.request']);

export const KERNEL_EFFECT_RISK_CLASSES = Object.freeze([
  'workspace_write', 'secret_path', 'outside_workspace', 'test_command', 'dangerous_cmd'
]);

export const KERNEL_APPROVAL_POLICIES = Object.freeze({
  HOST_POLICY_AUDIT: 'host-policy-audit',
  PER_REQUEST: 'per-request'
});

export const KERNEL_BATCH_LIMITS = Object.freeze({ maxItems: 10, maxBytes: 256 * 1024, perRound: 1 });

export const KERNEL_EFFECT_ERROR_CODES = Object.freeze({
  REFUSED: 'KERNEL_SIDE_EFFECT_REFUSED',
  UNAVAILABLE: 'KERNEL_EFFECTS_UNAVAILABLE',
  NOT_ATTACHED: 'KERNEL_NOT_ATTACHED',
  LEASE_NOT_GRANTED: 'KERNEL_EFFECT_LEASE_NOT_GRANTED',
  APPROVAL_REQUIRED: 'KERNEL_EFFECT_APPROVAL_REQUIRED',
  INVALID_PAYLOAD: 'KERNEL_EFFECT_INVALID_PAYLOAD',
  AUDIT_UNAVAILABLE: 'KERNEL_EFFECT_AUDIT_UNAVAILABLE',
  BATCH_DISABLED: 'KERNEL_BATCH_DISABLED',
  BATCH_LIMIT: 'KERNEL_BATCH_LIMIT_EXCEEDED',
  BATCH_ROUND_LIMIT: 'KERNEL_BATCH_ROUND_LIMIT',
  BATCH_REFUSED: 'KERNEL_BATCH_REFUSED',
  OUTCOME_UNCERTAIN: 'KERNEL_OUTCOME_UNCERTAIN',
  TIMEOUT: 'KERNEL_TIMEOUT'
});

// Error codes after which the outcome of the effect is not known. They never
// replay and they arm the "next effect needs a live approval" flag.
const UNCERTAIN_ERROR_CODES = new Set([
  'KERNEL_OUTCOME_UNCERTAIN', 'KERNEL_TIMEOUT', 'KERNEL_WORKER_CRASHED',
  'EXECUTOR_TIMEOUT', 'EXECUTOR_OUTCOME_UNKNOWN', 'EXECUTOR_ABORTED'
]);

const isTruthyFlag = (value) => typeof value === 'string' && ['1', 'true', 'on', 'yes', 'enabled'].includes(value.trim().toLowerCase());

class KernelEffectError extends Error {
  constructor(code, message = '', details = undefined) {
    super(message ? `${code}:${message}` : code);
    this.name = 'KernelEffectError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const sha256 = (text) => `sha256:${createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
const digestOf = (value) => sha256(canonicalJson(value));

/** Parse DDA_KERNEL_EFFECTS. Only the 2a kinds can be enabled. */
export const parseKernelEffectsFlag = (env = process.env) => {
  const raw = typeof env?.[KERNEL_EFFECTS_FLAG] === 'string' ? env[KERNEL_EFFECTS_FLAG] : '';
  const items = [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
  const kinds = items.filter((item) => KERNEL_EFFECT_KINDS.includes(item));
  const refusedKinds = items.filter((item) => !KERNEL_EFFECT_KINDS.includes(item));
  return { requested: items.length > 0, kinds, refusedKinds };
};

/** DDA_KERNEL_APPROVAL; unknown values fail closed to per-request. */
export const resolveKernelApprovalPolicy = (env = process.env) => {
  const raw = String(env?.[KERNEL_APPROVAL_FLAG] ?? '').trim().toLowerCase();
  if (!raw || raw === 'host-policy-audit' || raw === 'host-policy') return KERNEL_APPROVAL_POLICIES.HOST_POLICY_AUDIT;
  return KERNEL_APPROVAL_POLICIES.PER_REQUEST;
};

export const isKernelWriteBatchEnabled = (env = process.env) => isTruthyFlag(env?.[KERNEL_WRITE_BATCH_FLAG]);

/**
 * FROZEN #8: effects only when every gate holds. The result never enables a
 * kind the operator did not lease; per-kind lease gaps are reported.
 */
export const kernelEffectsAvailability = ({ env = process.env, executionMode, kernelAttached = true, canLease } = {}) => {
  const flag = parseKernelEffectsFlag(env);
  const leasable = (kind) => typeof canLease === 'function' && canLease(KERNEL_EFFECT_TOOLS[kind].capability) === true;
  const leasedKinds = flag.kinds.filter(leasable);
  let reason = 'AVAILABLE';
  if (!flag.requested || flag.kinds.length === 0) reason = 'EFFECTS_DISABLED';
  else if (!isResidentKernelEnabled(env) || !kernelAttached) reason = 'KERNEL_NOT_ATTACHED';
  else if (!isLinuxCliPlatform(env)) reason = 'NON_LINUX_PLATFORM_IDENTITY';
  else if (executionMode !== 'CONTROLLED') reason = 'NOT_CONTROLLED';
  else if (leasedKinds.length === 0) reason = 'LEASE_NOT_GRANTED';
  return {
    available: reason === 'AVAILABLE',
    reason,
    requested: flag.requested,
    kinds: reason === 'AVAILABLE' ? leasedKinds : [],
    unleasedKinds: flag.kinds.filter((kind) => !leasable(kind)),
    refusedKinds: flag.refusedKinds,
    approvalPolicy: resolveKernelApprovalPolicy(env),
    writeBatch: reason === 'AVAILABLE' && isKernelWriteBatchEnabled(env) && leasedKinds.some((kind) => kind === 'fs.write' || kind === 'fs.patch')
  };
};

/** True when the operator asked for kernel-only effects (hide discrete tools). */
export const kernelEffectsRequested = (env = process.env) => parseKernelEffectsFlag(env).requested;

/** Registry predicate for FROZEN #4: hide every discrete side-effect tool. */
export const isHiddenWhileKernelEffects = (definition) => definition?.readOnly !== true
  && !String(definition?.name ?? '').startsWith('kernel.');

/** Stable risk bucket for the denylist key. */
export const kernelEffectRiskClass = ({ capability, request, workspaceRoot }) => {
  const assessment = assessRequestRisk({ capability, request, workspaceRoot });
  if (assessment.reasons.includes('DANGEROUS_WRITE_OUTSIDE_WORKSPACE')) return { riskClass: 'outside_workspace', assessment };
  if (assessment.reasons.includes('DANGEROUS_SECRET_FILE_PATH')) return { riskClass: 'secret_path', assessment };
  if (assessment.dangerous) return { riskClass: 'dangerous_cmd', assessment };
  return { riskClass: capability === CAPABILITIES.TEST ? 'test_command' : 'workspace_write', assessment };
};

export const kernelEffectDenylistKey = ({ executionMode, effectKind, riskClass }) => {
  if (typeof executionMode !== 'string' || !executionMode) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.INVALID_PAYLOAD, 'executionMode');
  if (!KERNEL_EFFECT_KINDS.includes(effectKind)) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.INVALID_PAYLOAD, 'effectKind');
  if (!KERNEL_EFFECT_RISK_CLASSES.includes(riskClass)) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.INVALID_PAYLOAD, 'riskClass');
  return `${executionMode}|${effectKind}|${riskClass}`;
};

/**
 * Host-owned denylist keyed by (executionMode, effectKind, riskClass).
 * Stored outside the workspace and outside session_state, with a digest over
 * its canonical entries. It can only ADD refusals of host-policy auto-approval:
 * there is no remove API; clearing is an explicit operator action on the file.
 * A digest mismatch or unreadable file fails closed (every key is denied).
 */
export const DENYLIST_VERSION = 1;
export const denylistDigest = (entries) => digestOf({ version: DENYLIST_VERSION, entries });

export const createKernelEffectDenylist = ({ storagePath } = {}) => {
  let entries = [];
  let integrity = 'MISSING';
  let loaded = false;
  const load = async () => {
    loaded = true;
    if (!storagePath) { entries = []; integrity = 'MEMORY_ONLY'; return { integrity }; }
    try {
      const stored = await readPersistentJsonFile(storagePath);
      if (stored === undefined) { entries = []; integrity = 'MISSING'; return { integrity }; }
      if (stored?.version !== DENYLIST_VERSION || !Array.isArray(stored.entries) || stored.digest !== denylistDigest(stored.entries)) {
        entries = []; integrity = 'TAMPERED'; return { integrity };
      }
      entries = stored.entries.filter((entry) => entry && typeof entry.key === 'string');
      integrity = 'OK';
    } catch {
      entries = []; integrity = 'TAMPERED';
    }
    return { integrity };
  };
  const ensure = async () => { if (!loaded) await load(); };
  return {
    load,
    get integrity() { return integrity; },
    async has(key) {
      await ensure();
      if (integrity === 'TAMPERED') return true;
      return entries.some((entry) => entry.key === key);
    },
    async list() { await ensure(); return entries.map((entry) => ({ ...entry })); },
    async add(key, { reason = 'OPERATOR', atMs = Date.now() } = {}) {
      await ensure();
      if (integrity === 'TAMPERED') throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.AUDIT_UNAVAILABLE, 'denylist digest mismatch; refusing to rewrite');
      if (entries.some((entry) => entry.key === key)) return { added: false };
      const [executionMode, effectKind, riskClass] = String(key).split('|');
      kernelEffectDenylistKey({ executionMode, effectKind, riskClass });
      entries = [...entries, { key, reason: String(reason).slice(0, 120), atMs }];
      if (storagePath) {
        await mkdir(dirname(storagePath), { recursive: true });
        await persistJsonFile(storagePath, { version: DENYLIST_VERSION, entries, digest: denylistDigest(entries) });
      }
      if (integrity === 'MISSING') integrity = 'OK';
      return { added: true };
    }
  };
};

/** Append-only JSONL audit of every kernel effect decision and outcome. */
export const createKernelEffectAuditLog = ({ storagePath, sink } = {}) => {
  const records = [];
  return {
    records,
    async append(record) {
      const line = { atMs: Date.now(), ...record };
      records.push(line);
      if (typeof sink === 'function') await sink(line);
      if (storagePath) {
        await mkdir(dirname(storagePath), { recursive: true });
        await appendFile(storagePath, `${JSON.stringify(line)}\n`, 'utf8');
      }
      return line;
    }
  };
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.INVALID_PAYLOAD, message);
const normalizeDigest = (value) => (typeof value === 'string' ? value.toLowerCase().replace(/^(?!sha256:)/, 'sha256:') : value);

/** Map a 2a host_request payload to the discrete executor tool input. */
export const toDiscreteToolInput = (kind, payload) => {
  if (!isPlainObject(payload)) throw invalid('payload must be an object');
  if (kind === 'fs.write') {
    if (typeof payload.path !== 'string' || typeof payload.content !== 'string') throw invalid('fs.write needs path and content');
    if (!Object.prototype.hasOwnProperty.call(payload, 'expectedBaseDigest')) throw invalid('fs.write needs expectedBaseDigest (null for a new file)');
    return { path: payload.path, content: payload.content, expectedDigest: payload.expectedBaseDigest };
  }
  if (kind === 'fs.patch') {
    if (typeof payload.path !== 'string' || !Array.isArray(payload.replacements)) throw invalid('fs.patch needs path and replacements');
    return {
      path: payload.path,
      replacements: payload.replacements,
      ...(typeof payload.expectedBaseDigest === 'string' ? { expectedDigest: payload.expectedBaseDigest } : {})
    };
  }
  if (kind === 'test.run') {
    if (typeof payload.command !== 'string') throw invalid('test.run needs command');
    const allowed = ['command', 'args', 'cwd', 'timeoutMs', 'maxOutputBytes', 'maxOutputChars'];
    return Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.includes(key)));
  }
  throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.REFUSED, `kind ${kind} is not enabled in Phase-2a`);
};

const errorCode = (error) => (typeof error?.code === 'string' ? error.code
  : String(error?.message ?? '').split(':', 1)[0]);

const resultIsUncertain = (result) => result?.state === 'UNKNOWN' || result?.timedOut === true || result?.aborted === true;

/**
 * Host-side dispatcher for kernel.host_request effects. Inert probes and
 * legacy aliases are not handled here and keep going to the worker, which
 * refuses side effects exactly as in Phase-1.
 */
export const createKernelEffectsDispatcher = ({
  availability,
  executionMode = 'CONTROLLED',
  workspaceRoot,
  workspace,
  invokeTool,
  canLease,
  hasLiveApprover = () => false,
  isKernelAlive = async () => true,
  verifierReapprovalActive = () => false,
  gateRequiresApproval = () => false,
  requestBatchApproval,
  denylist = createKernelEffectDenylist(),
  audit = createKernelEffectAuditLog(),
  emit = () => {},
  runId,
  autoDenylistOnUnknown = true
} = {}) => {
  if (typeof invokeTool !== 'function') throw new TypeError('KERNEL_EFFECTS_INVOKE_REQUIRED');
  const enabledKinds = new Set(availability?.available ? availability.kinds : []);
  const policy = availability?.approvalPolicy ?? KERNEL_APPROVAL_POLICIES.PER_REQUEST;
  const outcomeUncertain = { active: false, reasonCode: undefined };
  const batchRounds = new Set();

  const handles = (kind) => KERNEL_EFFECT_KINDS.includes(kind) || kind === KERNEL_BATCH_KIND || KERNEL_DEFERRED_EFFECT_KINDS.includes(kind);

  const armUncertain = (reasonCode) => {
    outcomeUncertain.active = true;
    outcomeUncertain.reasonCode = reasonCode;
    emit('kernel.effect_outcome_uncertain', { reasonCode });
  };

  const assertAlive = async () => {
    let alive = false;
    try { alive = await isKernelAlive(); } catch { alive = false; }
    if (!alive) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.NOT_ATTACHED, 'resident kernel unavailable; only read-only tools remain');
  };

  const forcedReasons = async (key, context) => {
    const reasons = [];
    if (policy === KERNEL_APPROVAL_POLICIES.PER_REQUEST) reasons.push('KERNEL_APPROVAL_PER_REQUEST');
    if (await denylist.has(key)) reasons.push('KERNEL_EFFECT_DENYLISTED');
    if (outcomeUncertain.active) reasons.push(KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN);
    if (verifierReapprovalActive()) reasons.push('VERIFIER_REAPPROVAL');
    if (gateRequiresApproval(context)) reasons.push('ACTION_GATE_REQUIRE_APPROVAL');
    return reasons;
  };

  const runEffect = async (kind, payload, context = {}, { batchId, batchGrant, discreteInput } = {}) => {
    if (!enabledKinds.has(kind)) {
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.REFUSED, `${kind} is not enabled (DDA_KERNEL_EFFECTS / lease)`);
    }
    const { tool, capability } = KERNEL_EFFECT_TOOLS[kind];
    if (typeof canLease === 'function' && !canLease(capability)) {
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.LEASE_NOT_GRANTED, capability);
    }
    const input = discreteInput ?? toDiscreteToolInput(kind, payload);
    const { riskClass, assessment } = kernelEffectRiskClass({ capability, request: input, workspaceRoot });
    const key = kernelEffectDenylistKey({ executionMode, effectKind: kind, riskClass });
    const forced = await forcedReasons(key, context);
    const live = hasLiveApprover() === true;
    const requestId = `kernel-effect-${randomUUID()}`;
    const base = {
      runId, requestId, kind, key, riskClass,
      toolCallId: context?.toolCallId, argsDigest: digestOf(input),
      ...(batchId ? { batchId } : {}),
      forcedReasons: forced, dangerReasons: assessment.reasons, liveApprover: live
    };
    if (forced.length && !live) {
      await audit.append({ ...base, phase: 'REFUSED', approvalPath: 'REFUSED_NO_LIVE_APPROVER' }).catch(() => {});
      emit('kernel.effect_refused', { requestId, kind, key, reasons: forced });
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.APPROVAL_REQUIRED, `${forced.join(',')}; no live approver`);
    }
    try {
      await audit.append({ ...base, phase: 'REQUESTED' });
    } catch {
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.AUDIT_UNAVAILABLE);
    }
    const approvalPath = live || forced.length ? 'LIVE_APPROVAL' : 'AUTO_HOST_POLICY';
    const effectContext = {
      ...(context ?? {}),
      kernelEffect: {
        requestId, kind, key,
        requireApproval: forced.length > 0,
        ...(batchGrant && forced.length === 0 && !assessment.dangerous ? { batchGrant } : {})
      }
    };
    let result;
    try {
      result = await invokeTool(tool, input, effectContext);
    } catch (error) {
      const code = errorCode(error);
      const uncertain = UNCERTAIN_ERROR_CODES.has(code);
      if (uncertain) armUncertain(code);
      const refused = code === 'SAFETY_LEASE_REQUIRED';
      await audit.append({ ...base, phase: uncertain ? 'UNKNOWN' : refused ? 'REFUSED' : 'FAILED', approvalPath: refused ? 'REFUSED' : approvalPath, errorCode: code }).catch(() => {});
      if (uncertain && approvalPath === 'AUTO_HOST_POLICY' && autoDenylistOnUnknown) await denylist.add(key, { reason: 'AUTO_APPROVED_OUTCOME_UNKNOWN' }).catch(() => {});
      throw error;
    }
    const uncertain = resultIsUncertain(result);
    // A live, individually approved effect discharges the uncertain-outcome
    // requirement. It never touches the verifier #16 flag (owned by the host).
    if (!uncertain && forced.includes(KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN)) {
      outcomeUncertain.active = false;
      outcomeUncertain.reasonCode = undefined;
    }
    if (uncertain) {
      armUncertain(result?.timedOut ? KERNEL_EFFECT_ERROR_CODES.TIMEOUT : KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN);
      if (approvalPath === 'AUTO_HOST_POLICY' && autoDenylistOnUnknown) await denylist.add(key, { reason: 'AUTO_APPROVED_OUTCOME_UNKNOWN' }).catch(() => {});
    }
    const phase = uncertain ? 'UNKNOWN' : result?.ok === false ? 'FAILED' : 'COMPLETED';
    await audit.append({
      ...base, phase, approvalPath: batchGrant && approvalPath === 'LIVE_APPROVAL' && !forced.length ? 'LIVE_BATCH_APPROVAL' : approvalPath,
      resultDigest: digestOf(result ?? null),
      ...(typeof result?.lease === 'string' ? { leaseId: result.lease } : {})
    }).catch(() => {});
    emit('kernel.effect_completed', { requestId, kind, key, phase, approvalPath });
    return { ok: result?.ok !== false && !uncertain, kind, riskClass, approvalPath, ...(uncertain ? { outcome: 'UNKNOWN' } : {}), result };
  };

  const readFullText = async (path) => {
    let content = '';
    let first;
    do {
      const page = await workspace.read(path, undefined, content.length);
      if (first && page.digest !== first.digest) throw invalid('file changed while reading');
      first ??= page;
      content += page.content;
      if (!page.truncated) break;
      if (!page.content.length) throw invalid('empty page');
      if (content.length > 1024 * 1024) throw invalid('file too large');
    } while (true);
    return { path: first.path, digest: first.digest, content };
  };

  const runBatch = async (payload, context = {}) => {
    if (!availability?.writeBatch) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_DISABLED, 'set DDA_KERNEL_WRITE_BATCH=1');
    if (!isPlainObject(payload) || !Array.isArray(payload.items) || payload.items.length === 0) throw invalid('fs.write_batch needs items');
    const items = payload.items;
    if (items.length > KERNEL_BATCH_LIMITS.maxItems) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_LIMIT, `at most ${KERNEL_BATCH_LIMITS.maxItems} items`);
    const roundKey = context?.roundId ?? 'unscoped-round';
    if (batchRounds.has(roundKey)) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_ROUND_LIMIT, 'one fs.write_batch per model round');
    let totalBytes = 0;
    const seen = new Set();
    for (const item of items) {
      if (!isPlainObject(item) || !['write', 'patch'].includes(item.op) || typeof item.path !== 'string') throw invalid('each item needs op write|patch and path');
      if (seen.has(item.path)) throw invalid(`duplicate path ${item.path}`);
      seen.add(item.path);
      const text = item.op === 'write' ? item.content : JSON.stringify(item.replacements ?? []);
      if (typeof text !== 'string') throw invalid('write item needs content');
      totalBytes += Buffer.byteLength(text, 'utf8');
    }
    if (totalBytes > KERNEL_BATCH_LIMITS.maxBytes) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_LIMIT, `at most ${KERNEL_BATCH_LIMITS.maxBytes} bytes`);
    batchRounds.add(roundKey);
    const batchId = `kernel-batch-${randomUUID()}`;
    // Pre-admission: resolve every item to a concrete write and check the N
    // leases/risks before anything executes.
    const prepared = [];
    for (const item of items) {
      const effectKind = item.op === 'write' ? 'fs.write' : 'fs.patch';
      if (!enabledKinds.has(effectKind)) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.REFUSED, `${effectKind} is not enabled`);
      if (typeof canLease === 'function' && !canLease(CAPABILITIES.WRITE_FILE)) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.LEASE_NOT_GRANTED, CAPABILITIES.WRITE_FILE);
      let discreteInput;
      if (item.op === 'write') {
        discreteInput = toDiscreteToolInput('fs.write', item);
      } else {
        if (!workspace || typeof workspace.read !== 'function') throw invalid('patch items need a workspace');
        const current = await readFullText(item.path);
        if (typeof item.expectedBaseDigest === 'string' && normalizeDigest(item.expectedBaseDigest) !== current.digest) throw invalid(`stale base digest for ${item.path}`);
        const content = applyTextPatch(current.content, item.replacements);
        discreteInput = { path: current.path, content, expectedDigest: current.digest };
      }
      const { riskClass, assessment } = kernelEffectRiskClass({ capability: CAPABILITIES.WRITE_FILE, request: discreteInput, workspaceRoot });
      const key = kernelEffectDenylistKey({ executionMode, effectKind, riskClass });
      const forced = await forcedReasons(key, context);
      prepared.push({ item, effectKind, discreteInput, riskClass, key, forced, dangerous: assessment.dangerous,
        contentDigest: textDigest(discreteInput.content), bytes: Buffer.byteLength(discreteInput.content, 'utf8') });
    }
    const nonQualifying = prepared.filter((entry) => entry.dangerous || entry.forced.length > 0);
    const live = hasLiveApprover() === true;
    const summary = prepared.map(({ item, discreteInput, bytes, contentDigest }) => ({ op: item.op, path: discreteInput.path, bytes, contentDigest }));
    const batchDigest = digestOf({ batchId, items: summary });
    emit('kernel.batch_requested', { batchId, batchDigest, size: prepared.length, nonQualifying: nonQualifying.length });
    if (nonQualifying.length && !live) {
      await audit.append({ runId, batchId, batchDigest, phase: 'BATCH_REFUSED', approvalPath: 'REFUSED_NO_LIVE_APPROVER',
        reasons: nonQualifying.map((entry) => ({ path: entry.discreteInput.path, forced: entry.forced, dangerous: entry.dangerous })) }).catch(() => {});
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_REFUSED, 'an item needs approval and no live approver is connected; nothing was written');
    }
    let batchGrant;
    if (!nonQualifying.length && live) {
      const approved = typeof requestBatchApproval === 'function'
        ? await requestBatchApproval({ batchId, batchDigest, items: summary }) : false;
      if (!approved) {
        await audit.append({ runId, batchId, batchDigest, phase: 'BATCH_DECLINED' }).catch(() => {});
        throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.BATCH_REFUSED, 'batch approval declined; nothing was written');
      }
      const remaining = new Map(prepared.map((entry) => [entry.discreteInput.path, entry.contentDigest]));
      const expiresAt = Date.now() + 120_000;
      batchGrant = {
        batchId,
        batchDigest,
        // Consumed by the host approval path for exactly one matching item.
        consume: ({ capability, request } = {}) => {
          if (capability !== CAPABILITIES.WRITE_FILE || Date.now() > expiresAt) return false;
          if (verifierReapprovalActive() || outcomeUncertain.active) return false;
          const expected = remaining.get(request?.path);
          if (!expected || typeof request?.content !== 'string' || textDigest(request.content) !== expected) return false;
          remaining.delete(request.path);
          return true;
        }
      };
    }
    const committed = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const entry = prepared[index];
      try {
        const outcome = await runEffect('fs.write', undefined, context, {
          batchId,
          discreteInput: entry.discreteInput,
          ...(batchGrant ? { batchGrant } : {})
        });
        if (!outcome.ok) throw Object.assign(new Error(outcome.outcome === 'UNKNOWN' ? KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN : 'EXECUTOR_RESULT_FAILED'),
          { code: outcome.outcome === 'UNKNOWN' ? KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN : 'EXECUTOR_RESULT_FAILED' });
        committed.push({ path: entry.discreteInput.path, op: entry.item.op, contentDigest: outcome.result?.contentDigest, approvalPath: outcome.approvalPath });
      } catch (error) {
        const result = {
          ok: false,
          batchId,
          batchDigest,
          rolledBack: false,
          committed,
          failed: { path: entry.discreteInput.path, op: entry.item.op, errorCode: errorCode(error) },
          skipped: prepared.slice(index + 1).map((next) => ({ path: next.discreteInput.path, op: next.item.op, state: 'SKIPPED' }))
        };
        emit('kernel.batch_stopped', { batchId, committed: committed.length, failedPath: result.failed.path, errorCode: result.failed.errorCode });
        return result;
      }
    }
    emit('kernel.batch_completed', { batchId, size: committed.length });
    return { ok: true, batchId, batchDigest, committed, skipped: [] };
  };

  const dispatch = async ({ kind, payload: rawPayload } = {}, context = {}) => {
    const payload = parseHostRequestPayload(rawPayload);
    if (KERNEL_DEFERRED_EFFECT_KINDS.includes(kind)) {
      throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.REFUSED, `${kind} is deferred and refused in Phase-2a`);
    }
    if (!availability?.available) throw new KernelEffectError(KERNEL_EFFECT_ERROR_CODES.UNAVAILABLE, availability?.reason ?? 'EFFECTS_DISABLED');
    await assertAlive();
    if (kind === KERNEL_BATCH_KIND) return runBatch(payload, context);
    return runEffect(kind, payload, context);
  };

  return {
    handles,
    dispatch,
    outcomeUncertain,
    noteBridgeOutcome(code) {
      if (code === KERNEL_EFFECT_ERROR_CODES.OUTCOME_UNCERTAIN || code === KERNEL_EFFECT_ERROR_CODES.TIMEOUT) armUncertain(code);
    },
    availability
  };
};

export { KernelEffectError };
