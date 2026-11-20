import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DEFAULT_RELEASE_CHANNEL, resolveReleaseChannel } from './release-channel.mjs';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_RECORDS = 8192;
// 8MB holds about 5,000 records at the current record size. A full scan and
// an id lookup stay under a millisecond there. Every save rewrites the whole
// file, and past 8MB that rewrite is the cost that shows up.
const MAX_JSON_CHARS = 8 * 1024 * 1024;
// Once a write would pass the cap, move the oldest finished clusters out until
// the live file is back to three quarters of the cap. The cap itself stays.
const AGE_TARGET_NUMERATOR = 3;
const AGE_TARGET_DENOMINATOR = 4;
const STATES = Object.freeze({
  intent: ['PROPOSED', 'SAFETY_EVALUATING', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED'],
  approval: ['REQUESTED', 'PRESENTED', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED'],
  lease: ['PROPOSED', 'ACTIVE', 'CONSUMING', 'CONSUMED', 'REVOKED', 'EXPIRED']
});
const TERMINAL_STATES = Object.freeze({
  intent: new Set(['COMPLETED', 'FAILED', 'REJECTED']),
  approval: new Set(['APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED']),
  lease: new Set(['CONSUMED', 'REVOKED', 'EXPIRED'])
});
const TRANSITIONS = Object.freeze({
  intent: { PROPOSED: ['SAFETY_EVALUATING', 'REJECTED'], SAFETY_EVALUATING: ['WAITING_APPROVAL', 'APPROVED', 'REJECTED'], WAITING_APPROVAL: ['APPROVED', 'REJECTED'], APPROVED: ['EXECUTING', 'REJECTED'], EXECUTING: ['COMPLETED', 'FAILED'] },
  approval: { REQUESTED: ['PRESENTED', 'CANCELLED', 'EXPIRED'], PRESENTED: ['APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED'] },
  lease: { PROPOSED: ['ACTIVE', 'REVOKED', 'EXPIRED'], ACTIVE: ['CONSUMING', 'REVOKED', 'EXPIRED'], CONSUMING: ['CONSUMED', 'REVOKED'] }
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const clone = (value) => structuredClone(value);
const safeText = (value, max = 512) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : undefined;
const safeId = (value, max = 240) => typeof value === 'string' && value.trim()
  ? value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)
  : undefined;
const safeChannel = (value) => typeof value === 'string' && value.trim() ? resolveReleaseChannel(value.trim()) : DEFAULT_RELEASE_CHANNEL;
const digestOptional = (value) => value === undefined ? undefined : digest(value);
const reference = (recordId, recordType) => {
  if (typeof recordId !== 'string' || !recordId.trim()) throw new Error(`EXECUTION_${recordType.toUpperCase()}_REQUIRED`);
  return recordId.trim();
};
// Argument text can be a script body or a secret. Keep a digest of every
// arg, and a short preview only for tokens that identify the action: a
// subcommand, a long flag, or a path. Inline code and free text stay out.
const SAFE_ARG_WORDS = new Set([
  'status', 'diff', 'log', 'show', 'add', 'commit', 'push', 'pull', 'fetch', 'branch', 'checkout', 'switch',
  'restore', 'stash', 'rev-parse', 'merge', 'rebase', 'reset', 'clean', 'tag', 'remote', 'config', 'init',
  'clone', 'ls-files', 'describe', 'shortlog', 'install', 'ci', 'test', 'run', 'start', 'build', 'exec',
  'audit', 'outdated', 'ls', 'uninstall', 'update', 'publish', 'check', 'clippy', 'fmt', 'metadata', 'tree',
  'HEAD', 'ORIG_HEAD', 'FETCH_HEAD'
]);
const SAFE_SHORT_FLAGS = new Set(['-rf', '-fr', '-f', '-r', '-q', '-n', '-v', '-a', '-m', '-u', '-b', '-s', '-t', '-h', '--']);
const SECRET_ARG = /secret|token|password|passwd|credential|authorization|bearer|api[_-]?key/i;
const PATH_ARG = /^[A-Za-z0-9_.:@~\\/-]+$/;
const safeArgPreview = (value) => {
  if (typeof value !== 'string' || !value || value.length > 160 || value !== value.replace(/[\u0000-\u001f\u007f]/g, '')) return undefined;
  if (SECRET_ARG.test(value) || /[\s"'`$]/.test(value)) return undefined;
  const eq = value.indexOf('=');
  if (eq > 0) {
    const name = value.slice(0, eq);
    const rest = value.slice(eq + 1);
    if (!/^--[a-z0-9][a-z0-9-]{0,40}$/.test(name) || !safeArgPreview(rest)) return undefined;
    return value;
  }
  if (value.startsWith('-')) {
    if (SAFE_SHORT_FLAGS.has(value)) return value;
    return /^--[a-z0-9][a-z0-9-]{0,40}$/.test(value) ? value : undefined;
  }
  if (SAFE_ARG_WORDS.has(value) || /^[a-z][a-z0-9]*:[a-z0-9:_-]{1,40}$/.test(value)) return value;
  if (PATH_ARG.test(value) && (value.includes('/') || value.includes('\\') || /\.[A-Za-z0-9]{1,8}$/.test(value))) return value;
  return undefined;
};
const previewArgs = (args) => {
  if (!Array.isArray(args)) return [];
  const kept = [];
  for (const arg of args) {
    if (kept.length >= 8) break;
    const preview = safeArgPreview(arg);
    if (preview) kept.push(preview);
  }
  return kept;
};
const requestSummary = (request = {}) => {
  const argsPreview = previewArgs(request.args);
  return {
  ...(safeText(request.reason, 240) ? { reason: safeText(request.reason, 240) } : {}),
  ...(safeText(request.command, 4096) ? { command: safeText(request.command, 4096) } : {}),
  ...(Array.isArray(request.args) ? {
    argsDigest: digest(request.args),
    argCount: request.args.length,
    ...(argsPreview.length ? { argsPreview } : {})
  } : {}),
  ...(safeText(request.path) ? { path: safeText(request.path) } : {}),
  ...(safeText(request.cwd) ? { cwd: safeText(request.cwd) } : {}),
  ...(safeText(request.host, 253) ? { host: safeText(request.host, 253) } : {}),
  ...(Number.isInteger(request.port) ? { port: request.port } : {}),
  ...(request.scheme === 'https' || request.scheme === 'http' ? { scheme: request.scheme } : {}),
  ...(typeof request.method === 'string' && request.method ? { method: request.method.slice(0, 10) } : {}),
  ...(safeText(request.content) ? { contentDigest: digest(request.content), contentBytes: Buffer.byteLength(request.content, 'utf8') } : {}),
  ...(request.env && typeof request.env === 'object' && !Array.isArray(request.env) ? { envDigest: digest(request.env), envKeyCount: Object.keys(request.env).length } : {})
  };
};

const isDigest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const executionEventPayload = (record) => Object.fromEntries(Object.entries({
  recordId: record.recordId, recordType: record.recordType, state: record.state, runId: record.runId,
  intentId: record.intentId, approvalId: record.approvalId, capability: record.capability,
  requestDigest: record.requestDigest, displayedDigest: record.displayedDigest, snapshotDigest: record.snapshotDigest,
  scopeDigest: record.scopeDigest, bindingSnapshotDigest: record.bindingSnapshotDigest,
  capabilitySnapshotDigest: record.capabilitySnapshotDigest, releaseChannel: record.releaseChannel,
  operationId: record.operationId, policyVersion: record.policyVersion, transition: record.transition,
  transitionHistory: record.transitionHistory
}).filter(([, value]) => value !== undefined));

// References are persisted separately from their parent records, so validate
// the graph after all records have been loaded. This prevents a tampered or
// partially merged approval/lease from crossing runs or safety bindings.
const validateRecordGraph = (records) => {
  const byId = new Map(records.map((record) => [record.recordId, record]));
  for (const record of records) {
    if (typeof record.runId !== 'string' || !record.runId.trim() ||
        typeof record.capability !== 'string' || !record.capability.trim() ||
        !isDigest(record.requestDigest) ||
        typeof record.operationId !== 'string' || !record.operationId.trim() ||
        !Number.isFinite(record.createdAtMs) || !Number.isFinite(record.updatedAtMs)) {
      throw new Error('EXECUTION_STATE_INVALID_RECORD');
    }
    if (record.requestDigest !== undefined && !isDigest(record.requestDigest)) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
    if (record.scopeDigest !== undefined && !isDigest(record.scopeDigest)) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
      if (record.bindingSnapshotDigest !== undefined && !isDigest(record.bindingSnapshotDigest)) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
    if (record.capabilitySnapshotDigest !== undefined && !isDigest(record.capabilitySnapshotDigest)) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
    if (record.recordType === 'approval') {
      const intent = byId.get(record.intentId);
      if (!intent || intent.recordType !== 'intent' || intent.runId !== record.runId ||
          intent.capability !== record.capability || intent.requestDigest !== record.requestDigest ||
          (record.snapshotDigest !== undefined && intent.snapshotDigest !== undefined && record.snapshotDigest !== intent.snapshotDigest) ||
          (record.bindingSnapshotDigest !== undefined && intent.bindingSnapshotDigest !== undefined && record.bindingSnapshotDigest !== intent.bindingSnapshotDigest) ||
          (record.capabilitySnapshotDigest !== undefined && intent.capabilitySnapshotDigest !== undefined && record.capabilitySnapshotDigest !== intent.capabilitySnapshotDigest) ||
          (record.releaseChannel !== undefined && intent.releaseChannel !== undefined && record.releaseChannel !== intent.releaseChannel) ||
          (record.operationId !== undefined && intent.operationId !== undefined && record.operationId !== intent.operationId)) {
        throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
      }
      if (record.displayedDigest !== record.requestDigest) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
      if (record.operationId !== intent.operationId) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
    }
    if (record.recordType === 'lease') {
      const intent = byId.get(record.intentId);
      const approval = byId.get(record.approvalId);
      if (!intent || intent.recordType !== 'intent' || !approval || approval.recordType !== 'approval' ||
          intent.runId !== record.runId || approval.runId !== record.runId || approval.intentId !== intent.recordId ||
          intent.capability !== record.capability || approval.capability !== record.capability ||
          intent.requestDigest !== record.requestDigest || approval.requestDigest !== record.requestDigest ||
          approval.state !== 'APPROVED' ||
          (record.snapshotDigest !== undefined && intent.snapshotDigest !== undefined && record.snapshotDigest !== intent.snapshotDigest) ||
          (record.scopeDigest !== undefined && intent.scopeDigest !== undefined && record.scopeDigest !== intent.scopeDigest) ||
          (record.bindingSnapshotDigest !== undefined && intent.bindingSnapshotDigest !== undefined && record.bindingSnapshotDigest !== intent.bindingSnapshotDigest) ||
          (record.bindingSnapshotDigest !== undefined && approval.bindingSnapshotDigest !== undefined && record.bindingSnapshotDigest !== approval.bindingSnapshotDigest) ||
          (record.capabilitySnapshotDigest !== undefined && intent.capabilitySnapshotDigest !== undefined && record.capabilitySnapshotDigest !== intent.capabilitySnapshotDigest) ||
          (record.capabilitySnapshotDigest !== undefined && approval.capabilitySnapshotDigest !== undefined && record.capabilitySnapshotDigest !== approval.capabilitySnapshotDigest) ||
          (record.releaseChannel !== undefined && intent.releaseChannel !== undefined && record.releaseChannel !== intent.releaseChannel) ||
          (record.releaseChannel !== undefined && approval.releaseChannel !== undefined && record.releaseChannel !== approval.releaseChannel) ||
          (record.executorIdentity !== undefined && intent.executorIdentity !== undefined && record.executorIdentity !== intent.executorIdentity) ||
          (record.operationId !== intent.operationId) ||
          !Number.isFinite(record.expiresAt) ||
          !Array.isArray(record.commands) || record.commands.some((command) => typeof command !== 'string')) {
        throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
      }
    }
  }
};

const payloadOf = (records) => ({ schemaVersion: SCHEMA_VERSION, records });
const compactSize = (records) => JSON.stringify(payloadOf(records)).length;

// An intent and every approval or lease that points at it move together.
// A live approval or lease keeps the whole cluster in the hot file.
const closedClusters = (records) => {
  const groups = new Map();
  for (const record of records) {
    const intentId = record.recordType === 'intent' ? record.recordId : record.intentId;
    if (typeof intentId !== 'string' || !intentId) continue;
    const group = groups.get(intentId);
    if (group) group.push(record);
    else groups.set(intentId, [record]);
  }
  const order = new Map(records.map((record, index) => [record.recordId, index]));
  const clusters = [];
  for (const group of groups.values()) {
    const intent = group.find((record) => record.recordType === 'intent');
    if (!intent || !group.every((record) => TERMINAL_STATES[record.recordType]?.has(record.state))) continue;
    clusters.push(group);
  }
  clusters.sort((left, right) => {
    const older = left.find((record) => record.recordType === 'intent');
    const newer = right.find((record) => record.recordType === 'intent');
    return older.updatedAtMs - newer.updatedAtMs
      || older.createdAtMs - newer.createdAtMs
      || (order.get(older.recordId) ?? 0) - (order.get(newer.recordId) ?? 0);
  });
  return clusters;
};

export class ExecutionStateStore {
  #storagePath;
  #records = new Map();
  #queue = Promise.resolve();
  #loaded = false;
  #ownerPid;
  #runtimeInstanceId;
  #eventStore;
  #maxJsonChars;
  #maxRecords;

  constructor({ storagePath, ownerPid = process.pid, runtimeInstanceId = `runtime-${randomUUID()}`, eventStore, maxJsonChars = MAX_JSON_CHARS, maxRecords = MAX_RECORDS } = {}) {
    if (!Number.isSafeInteger(maxJsonChars) || maxJsonChars < 256 || maxJsonChars > MAX_JSON_CHARS) throw new Error('EXECUTION_STATE_LIMIT_INVALID');
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS) throw new Error('EXECUTION_STATE_LIMIT_INVALID');
    this.#storagePath = storagePath;
    this.#ownerPid = ownerPid;
    this.#runtimeInstanceId = runtimeInstanceId;
    this.#eventStore = eventStore;
    this.#maxJsonChars = maxJsonChars;
    this.#maxRecords = maxRecords;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); } catch { throw new Error('EXECUTION_STATE_READ_FAILED'); }
    if (parsed === undefined) return;
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.records) || parsed.records.length > MAX_RECORDS) throw new Error('EXECUTION_STATE_INVALID');
    const restored = [];
    for (const record of parsed.records) {
      if (!isObject(record) || typeof record.recordId !== 'string' || !['intent', 'approval', 'lease'].includes(record.recordType) || !STATES[record.recordType].includes(record.state) || typeof record.recordDigest !== 'string') throw new Error('EXECUTION_STATE_INVALID');
      const { recordDigest, ...unsigned } = record;
      if (recordDigest !== digest(unsigned)) throw new Error('EXECUTION_STATE_INVALID');
      restored.push(Object.freeze(clone(record)));
    }
    if (new Set(restored.map((record) => record.recordId)).size !== restored.length) throw new Error('EXECUTION_STATE_INVALID');
    validateRecordGraph(restored);
    for (const record of restored) this.#records.set(record.recordId, record);
    this.#loaded = true;
    if (restored.length > this.#maxRecords || compactSize(restored) > this.#maxJsonChars) {
      await this.#flushClosedRecords();
    }
  }

  async reload() {
    try { await this.#queue; } catch { /* a prior optimistic write may have failed */ }
    this.#queue = Promise.resolve();
    this.#records.clear();
    this.#loaded = false;
    await this.load();
    return this.list();
  }

  async createIntent({ runId, capability, request = {}, requestDigest, snapshotDigest, policyVersion = 'runtime-safety-1', scope, bindingSnapshot, capabilitySnapshot, releaseChannel, executorIdentity, operationId } = {}) {
    const normalizedRunId = safeId(runId, 160);
    const normalizedCapability = safeId(capability, 80);
    if (!normalizedRunId || !normalizedCapability) throw new Error('EXECUTION_INTENT_REQUIRED');
    // Approval checks executionDigest(approvalSubject(...)). A cell host.request
    // subject adds code, cellOpIndex, and hostRequest, so the caller passes that
    // digest. Omitting it keeps digest({ capability, request }).
    const boundRequestDigest = requestDigest === undefined ? digest({ capability, request }) : requestDigest;
    if (!isDigest(boundRequestDigest)) throw new Error('EXECUTION_STATE_INVALID_REFERENCE');
    return this.#create('intent', {
      runId: normalizedRunId,
      capability: normalizedCapability,
      requestSummary: requestSummary(request),
      requestDigest: boundRequestDigest,
      ...(safeText(snapshotDigest, 128) ? { snapshotDigest: safeText(snapshotDigest, 128) } : {}),
      ...(scope !== undefined ? { scopeDigest: digestOptional(scope) } : {}),
      ...(bindingSnapshot !== undefined ? { bindingSnapshotDigest: digestOptional(bindingSnapshot) } : {}),
      ...(capabilitySnapshot !== undefined ? { capabilitySnapshotDigest: digestOptional(capabilitySnapshot) } : {}),
      releaseChannel: safeChannel(releaseChannel),
      ...(safeId(executorIdentity) ? { executorIdentity: safeId(executorIdentity) } : {}),
      operationId: safeId(operationId) ?? `operation-${randomUUID()}`,
      ownerPid: this.#ownerPid,
      runtimeInstanceId: this.#runtimeInstanceId,
      policyVersion: safeText(policyVersion, 120) ?? 'runtime-safety-1'
    });
  }

  async createApproval({ runId, intentId, capability, requestDigest, displayedDigest, snapshotDigest, expiresAt, policyVersion = 'runtime-safety-1', operationId, bindingSnapshot, capabilitySnapshot, releaseChannel } = {}) {
    await this.load();
    const intent = this.#records.get(reference(intentId, 'intent'));
    const normalizedRunId = safeId(runId, 160);
    if (!normalizedRunId || !intent || intent.recordType !== 'intent' || intent.runId !== normalizedRunId) throw new Error('EXECUTION_INTENT_REFERENCE_INVALID');
    if (!['SAFETY_EVALUATING', 'WAITING_APPROVAL'].includes(intent.state)) throw new Error('EXECUTION_INTENT_STATE_INVALID');
    if (capability !== intent.capability || requestDigest !== intent.requestDigest) throw new Error('EXECUTION_INTENT_DIGEST_MISMATCH');
    if (displayedDigest !== requestDigest) throw new Error('EXECUTION_DISPLAY_DIGEST_MISMATCH');
    const boundSnapshotDigest = snapshotDigest === undefined ? intent.snapshotDigest : safeText(snapshotDigest, 128);
    if (boundSnapshotDigest !== intent.snapshotDigest) throw new Error('EXECUTION_SNAPSHOT_MISMATCH');
    const approvalBindingDigest = bindingSnapshot === undefined ? intent.bindingSnapshotDigest : digestOptional(bindingSnapshot);
    if (approvalBindingDigest !== intent.bindingSnapshotDigest) throw new Error('EXECUTION_BINDING_MISMATCH');
    const approvalCapabilityDigest = capabilitySnapshot === undefined ? intent.capabilitySnapshotDigest : digestOptional(capabilitySnapshot);
    if (approvalCapabilityDigest !== intent.capabilitySnapshotDigest) throw new Error('EXECUTION_CAPABILITY_SNAPSHOT_MISMATCH');
    if (releaseChannel !== undefined && safeChannel(releaseChannel) !== safeChannel(intent.releaseChannel)) throw new Error('EXECUTION_RELEASE_CHANNEL_MISMATCH');
    if (operationId !== undefined && operationId !== intent.operationId) throw new Error('EXECUTION_OPERATION_MISMATCH');
    return this.#create('approval', {
      runId: normalizedRunId,
      intentId: reference(intentId, 'intent'),
      capability: safeId(capability, 80),
      requestDigest: safeId(requestDigest, 128),
      displayedDigest: safeId(displayedDigest, 128),
      ...(boundSnapshotDigest ? { snapshotDigest: boundSnapshotDigest } : {}),
      ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}),
      ...(approvalBindingDigest ? { bindingSnapshotDigest: approvalBindingDigest } : {}),
      ...(approvalCapabilityDigest ? { capabilitySnapshotDigest: approvalCapabilityDigest } : {}),
      releaseChannel: safeChannel(releaseChannel ?? intent.releaseChannel),
      operationId: safeId(operationId) ?? intent.operationId,
      ownerPid: this.#ownerPid,
      runtimeInstanceId: this.#runtimeInstanceId,
      policyVersion: safeText(policyVersion, 120) ?? 'runtime-safety-1'
    });
  }

  async createLease({ runId, intentId, approvalId, capability, commands, expiresAt, requestDigest, snapshotDigest, policyVersion = 'runtime-safety-1', operationId, scope, bindingSnapshot, capabilitySnapshot, releaseChannel, executorIdentity } = {}) {
    await this.load();
    const intent = this.#records.get(reference(intentId, 'intent'));
    const approval = this.#records.get(reference(approvalId, 'approval'));
    const normalizedRunId = safeId(runId, 160);
    if (!normalizedRunId || !intent || intent.recordType !== 'intent' || intent.runId !== normalizedRunId) throw new Error('EXECUTION_INTENT_REFERENCE_INVALID');
    if (!approval || approval.recordType !== 'approval' || approval.runId !== normalizedRunId || approval.intentId !== intent.recordId) throw new Error('EXECUTION_APPROVAL_REFERENCE_INVALID');
    if (!['APPROVED', 'EXECUTING'].includes(intent.state)) throw new Error('EXECUTION_INTENT_STATE_INVALID');
    const boundRequestDigest = requestDigest ?? intent.requestDigest;
    if (capability !== intent.capability || boundRequestDigest !== intent.requestDigest || boundRequestDigest !== approval.requestDigest) throw new Error('EXECUTION_INTENT_DIGEST_MISMATCH');
    const leaseScopeDigest = scope === undefined ? intent.scopeDigest : digestOptional(scope);
    const leaseBindingDigest = bindingSnapshot === undefined ? intent.bindingSnapshotDigest : digestOptional(bindingSnapshot);
    const leaseExecutorIdentity = safeId(executorIdentity) ?? intent.executorIdentity;
    const leaseSnapshotDigest = snapshotDigest === undefined ? intent.snapshotDigest : safeText(snapshotDigest, 128);
    if (intent.scopeDigest && leaseScopeDigest !== intent.scopeDigest) throw new Error('EXECUTION_SCOPE_MISMATCH');
    if (leaseSnapshotDigest !== intent.snapshotDigest || approval.snapshotDigest !== intent.snapshotDigest) throw new Error('EXECUTION_SNAPSHOT_MISMATCH');
    if (intent.bindingSnapshotDigest && leaseBindingDigest !== intent.bindingSnapshotDigest) throw new Error('EXECUTION_BINDING_MISMATCH');
    const leaseCapabilityDigest = capabilitySnapshot === undefined ? intent.capabilitySnapshotDigest : digestOptional(capabilitySnapshot);
    if (intent.capabilitySnapshotDigest && leaseCapabilityDigest !== intent.capabilitySnapshotDigest) throw new Error('EXECUTION_CAPABILITY_SNAPSHOT_MISMATCH');
    if (releaseChannel !== undefined && safeChannel(releaseChannel) !== safeChannel(intent.releaseChannel)) throw new Error('EXECUTION_RELEASE_CHANNEL_MISMATCH');
    if (intent.executorIdentity && leaseExecutorIdentity !== intent.executorIdentity) throw new Error('EXECUTION_EXECUTOR_MISMATCH');
    if (approval.state !== 'APPROVED') throw new Error('EXECUTION_APPROVAL_NOT_APPROVED');
    if (approval.operationId !== intent.operationId || (operationId !== undefined && operationId !== intent.operationId)) throw new Error('EXECUTION_OPERATION_MISMATCH');
    if (scope !== undefined && leaseScopeDigest !== intent.scopeDigest) throw new Error('EXECUTION_SCOPE_MISMATCH');
    if (bindingSnapshot !== undefined && leaseBindingDigest !== intent.bindingSnapshotDigest) throw new Error('EXECUTION_BINDING_MISMATCH');
    if (executorIdentity !== undefined && leaseExecutorIdentity !== intent.executorIdentity) throw new Error('EXECUTION_EXECUTOR_MISMATCH');
    const normalizedCommands = commands === undefined ? [] : commands;
    if (!Array.isArray(normalizedCommands) || normalizedCommands.length > 64 || normalizedCommands.some((command) => typeof command !== 'string' || !command.trim() || command.length > 256)) throw new Error('EXECUTION_LEASE_COMMANDS_INVALID');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('EXECUTION_LEASE_EXPIRED');
    return this.#create('lease', {
      runId: normalizedRunId,
      intentId: reference(intentId, 'intent'),
      approvalId: reference(approvalId, 'approval'),
      capability: safeId(capability, 80),
      commands: normalizedCommands.slice(0, 64),
      expiresAt,
      requestDigest: safeId(boundRequestDigest, 128),
      ...(leaseSnapshotDigest ? { snapshotDigest: leaseSnapshotDigest } : {}),
      ...(leaseScopeDigest ? { scopeDigest: leaseScopeDigest } : {}),
      ...(leaseBindingDigest ? { bindingSnapshotDigest: leaseBindingDigest } : {}),
      ...(leaseCapabilityDigest ? { capabilitySnapshotDigest: leaseCapabilityDigest } : {}),
      releaseChannel: safeChannel(releaseChannel ?? intent.releaseChannel),
      ...(leaseExecutorIdentity ? { executorIdentity: leaseExecutorIdentity } : {}),
      operationId: safeId(operationId) ?? intent.operationId,
      ownerPid: this.#ownerPid,
      runtimeInstanceId: this.#runtimeInstanceId,
      policyVersion: safeText(policyVersion, 120) ?? 'runtime-safety-1'
    });
  }

  async transition(recordId, nextState, metadata = {}) {
    await this.load();
    const current = this.#records.get(recordId);
    if (!current) throw new Error('EXECUTION_STATE_NOT_FOUND');
    if (!STATES[current.recordType].includes(nextState) || !(TRANSITIONS[current.recordType][current.state] ?? []).includes(nextState)) throw new Error('EXECUTION_STATE_INVALID_TRANSITION');
    const transition = { from: current.state, to: nextState, metadata: requestSummary(metadata), atMs: Date.now() };
    const record = {
      ...clone(current),
      state: nextState,
      updatedAtMs: transition.atMs,
      transition,
      transitionHistory: [...(Array.isArray(current.transitionHistory) ? current.transitionHistory : []), transition].slice(-64)
    };
    return this.#save(record, current.recordDigest);
  }

  async claimLease(recordId, { requestDigest, operationId } = {}) {
    await this.load();
    const lease = this.#records.get(recordId);
    if (!lease || lease.recordType !== 'lease') throw new Error('EXECUTION_LEASE_NOT_FOUND');
    if (requestDigest && lease.requestDigest !== requestDigest) throw new Error('EXECUTION_LEASE_DIGEST_MISMATCH');
    if (operationId && lease.operationId !== operationId) throw new Error('EXECUTION_LEASE_OPERATION_MISMATCH');
    if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= Date.now()) {
      if (lease.state === 'ACTIVE' || lease.state === 'PROPOSED') await this.transition(recordId, 'EXPIRED', { reason: 'TTL_EXPIRED' });
      throw new Error('EXECUTION_LEASE_EXPIRED');
    }
    if (lease.state !== 'ACTIVE') throw new Error(`EXECUTION_LEASE_NOT_ACTIVE:${lease.state}`);
    return this.transition(recordId, 'CONSUMING', { operationId: lease.operationId });
  }

  async completeLease(recordId, { ok = true, outcomeDigest, errorCode, reason } = {}) {
    await this.load();
    const lease = this.#records.get(recordId);
    if (!lease || lease.recordType !== 'lease') throw new Error('EXECUTION_LEASE_NOT_FOUND');
    if (lease.state !== 'CONSUMING') throw new Error(`EXECUTION_LEASE_NOT_CONSUMING:${lease.state}`);
    const explicitReason = typeof reason === 'string' && /^[A-Z0-9_]{3,80}$/.test(reason) ? reason : undefined;
    const metadata = {
      reason: explicitReason ?? (ok ? 'EXECUTION_SUCCEEDED' : 'EXECUTOR_RESULT_FAILED'),
      ok: Boolean(ok),
      ...(typeof outcomeDigest === 'string' ? { outcomeDigest } : {}),
      ...(typeof errorCode === 'string' ? { errorCode } : {})
    };
    return this.transition(recordId, 'CONSUMED', metadata);
  }

  async revokeLease(recordId, reason = 'REVOKED') {
    await this.load();
    const lease = this.#records.get(recordId);
    if (!lease || lease.recordType !== 'lease') throw new Error('EXECUTION_LEASE_NOT_FOUND');
    if (lease.state === 'REVOKED' || lease.state === 'EXPIRED') return clone(lease);
    if (!['PROPOSED', 'ACTIVE', 'CONSUMING'].includes(lease.state)) throw new Error(`EXECUTION_LEASE_NOT_REVOCABLE:${lease.state}`);
    return this.transition(recordId, 'REVOKED', { reason });
  }

  async cancelOrphanedApproval(recordId, { expectedDigest, reason = 'RECOVERY_CANCELLED', isOwnerAlive = defaultOwnerAlive } = {}) {
    await this.load();
    const approval = this.#records.get(recordId);
    if (!approval || approval.recordType !== 'approval') throw new Error('EXECUTION_APPROVAL_NOT_FOUND');
    if (!['REQUESTED', 'PRESENTED'].includes(approval.state)) throw new Error(`EXECUTION_APPROVAL_NOT_PENDING:${approval.state}`);
    if (expectedDigest !== undefined && expectedDigest !== approval.recordDigest) throw new Error('EXECUTION_STATE_CONFLICT');
    if (typeof isOwnerAlive !== 'function') throw new Error('EXECUTION_APPROVAL_OWNER_ALIVE');
    const ownerAlive = Number.isInteger(approval.ownerPid) && approval.ownerPid >= 1 && isOwnerAlive(approval.ownerPid);
    if (ownerAlive) throw new Error('EXECUTION_APPROVAL_OWNER_ALIVE');
    return this.transition(recordId, 'CANCELLED', { reason });
  }

  async revokeLeaseWithDigest(recordId, { expectedDigest, reason = 'RECOVERY_REVOKED' } = {}) {
    await this.load();
    const lease = this.#records.get(recordId);
    if (!lease || lease.recordType !== 'lease') throw new Error('EXECUTION_LEASE_NOT_FOUND');
    if (expectedDigest !== undefined && expectedDigest !== lease.recordDigest) throw new Error('EXECUTION_STATE_CONFLICT');
    return this.revokeLease(recordId, reason);
  }

  async expireLeases(now = Date.now()) {
    await this.load();
    const expired = [];
    for (const lease of this.list('lease')) {
      if (['PROPOSED', 'ACTIVE'].includes(lease.state) && Number.isFinite(lease.expiresAt) && lease.expiresAt <= now) {
        expired.push(await this.transition(lease.recordId, 'EXPIRED', { reason: 'TTL_EXPIRED' }));
      }
    }
    return expired;
  }

  async reconcile({ now = Date.now(), isOwnerAlive = defaultOwnerAlive } = {}) {
    await this.load();
    if (typeof isOwnerAlive !== 'function') throw new Error('EXECUTION_RECONCILE_INVALID');
    const reconciled = [];
    const orphaned = (record) => !Number.isInteger(record.ownerPid) || record.ownerPid < 1 || !isOwnerAlive(record.ownerPid);
    for (const approval of this.list('approval')) {
      if (['REQUESTED', 'PRESENTED'].includes(approval.state) && orphaned(approval)) {
        const nextState = Number.isFinite(approval.expiresAt) && approval.expiresAt <= now ? 'EXPIRED' : 'CANCELLED';
        reconciled.push(await this.transition(approval.recordId, nextState, { reason: 'OWNER_PROCESS_LOST' }));
      }
    }
    for (const lease of this.list('lease')) {
      if (!['PROPOSED', 'ACTIVE', 'CONSUMING'].includes(lease.state)) continue;
      if (Number.isFinite(lease.expiresAt) && lease.expiresAt <= now && lease.state !== 'CONSUMING') {
        reconciled.push(await this.transition(lease.recordId, 'EXPIRED', { reason: 'TTL_EXPIRED' }));
      } else if (orphaned(lease)) {
        reconciled.push(await this.transition(lease.recordId, 'REVOKED', { reason: 'OWNER_PROCESS_LOST' }));
      }
    }
    const affectedIntentIds = new Set(reconciled.map((record) => record.intentId).filter(Boolean));
    for (const intent of this.list('intent')) {
      if (!affectedIntentIds.has(intent.recordId) && !orphaned(intent)) continue;
      if (['PROPOSED', 'SAFETY_EVALUATING', 'WAITING_APPROVAL', 'APPROVED'].includes(intent.state)) {
        reconciled.push(await this.transition(intent.recordId, 'REJECTED', { reason: 'OWNER_PROCESS_LOST' }));
      } else if (intent.state === 'EXECUTING') {
        reconciled.push(await this.transition(intent.recordId, 'FAILED', { reason: 'OUTCOME_UNCERTAIN_AFTER_CRASH' }));
      }
    }
    return {
      reconciled: reconciled.length,
      records: reconciled.map((record) => ({
        recordId: record.recordId,
        recordType: record.recordType,
        state: record.state,
        runId: record.runId,
        operationId: record.operationId
      }))
    };
  }

  get(recordId) { const value = this.#records.get(recordId); return value ? clone(value) : undefined; }
  list(recordType) { return [...this.#records.values()].filter((record) => !recordType || record.recordType === recordType).map(clone); }

  async #create(recordType, fields) {
    await this.load();
    if (this.#storagePath && this.#records.size >= this.#maxRecords) await this.#flushClosedRecords({ reserveSlot: true });
    if (this.#records.size >= this.#maxRecords) throw new Error('EXECUTION_STATE_FULL');
    const recordId = `${recordType}-${randomUUID()}`;
    const unsigned = {
      schemaVersion: SCHEMA_VERSION,
      recordId,
      ...(recordType === 'intent' ? { intentId: recordId } : {}),
      recordType,
      state: 'PROPOSED',
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      transitionHistory: [],
      ...fields
    };
    if (recordType === 'approval') unsigned.state = 'REQUESTED';
    const record = { ...unsigned, recordDigest: digest(unsigned) };
    return this.#save(record);
  }

  async #save(record, expectedDigest) {
    const { recordDigest: _recordDigest, ...unsigned } = record;
    const frozen = Object.freeze(clone({ ...unsigned, recordDigest: digest(unsigned) }));
    const previous = this.#records.get(record.recordId);
    // Validate the complete graph before exposing a newly-created or
    // transitioned record to callers. This keeps invalid approval/lease
    // bindings from being usable in memory until a later reload rejects them.
    const candidateRecords = [...this.#records.values()].filter((item) => item.recordId !== record.recordId);
    candidateRecords.push(frozen);
    validateRecordGraph(candidateRecords);
    if (this.#eventStore) {
      const payload = executionEventPayload(frozen);
      const result = await this.#eventStore.append({
        runId: frozen.runId,
        aggregateType: 'TaskRun',
        aggregateId: frozen.runId,
        kind: 'ExecutionStateChanged',
        payload,
        sensitivity: 'SECURITY_AUDIT',
        commandId: `execution-state:${frozen.recordId}:${frozen.recordDigest}`
      });
      const receipt = result?.receipt ?? result;
      const event = result?.event ?? result?.events?.[0];
      if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId)
        || event.kind !== 'ExecutionStateChanged' || event.aggregateId !== frozen.runId
        || digest(event.payload) !== digest(payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
    }
    this.#records.set(record.recordId, frozen);
    if (!this.#storagePath) return clone(frozen);
    let aged = [];
    const write = async () => {
      let payload = payloadOf(this.list());
      if (compactSize(payload.records) > this.#maxJsonChars || payload.records.length > this.#maxRecords) {
        const selected = this.#selectForArchive({ protectIds: new Set([frozen.recordId]) });
        if (selected.length === 0) {
          throw new Error(payload.records.length > this.#maxRecords ? 'EXECUTION_STATE_FULL' : 'EXECUTION_STATE_TOO_LARGE');
        }
        await this.#writeArchive(selected);
        for (const item of selected) this.#records.delete(item.recordId);
        aged = selected;
        payload = payloadOf(this.list());
        if (payload.records.length > this.#maxRecords) throw new Error('EXECUTION_STATE_FULL');
        if (compactSize(payload.records) > this.#maxJsonChars) throw new Error('EXECUTION_STATE_TOO_LARGE');
      }
      await this.#writeRecords({ payload, expectedRecordId: frozen.recordId, expectedDigest, drop: aged });
    };
    this.#queue = this.#queue.then(write, write);
    try {
      await this.#queue;
    } catch (error) {
      for (const item of aged) this.#records.set(item.recordId, item);
      if (previous) this.#records.set(record.recordId, previous);
      else this.#records.delete(record.recordId);
      throw error;
    }
    return clone(frozen);
  }

  // Drop oldest finished clusters until a new record fits and the live file
  // is back under the aging target. In-flight intents, approvals, and leases stay.
  #selectForArchive({ reserveSlot = false, protectIds = new Set() } = {}) {
    if (!this.#storagePath) return [];
    const records = [...this.#records.values()];
    const size = compactSize(records);
    const countPressure = records.length + (reserveSlot ? 1 : 0) > this.#maxRecords;
    const sizePressure = size > this.#maxJsonChars;
    if (!countPressure && !sizePressure) return [];
    const targetCount = Math.max(1, Math.floor(this.#maxRecords * AGE_TARGET_NUMERATOR / AGE_TARGET_DENOMINATOR));
    const targetSize = Math.max(1, Math.floor(this.#maxJsonChars * AGE_TARGET_NUMERATOR / AGE_TARGET_DENOMINATOR));
    const encoded = new Map(records.map((record) => [record.recordId, JSON.stringify(record).length]));
    const emptySize = compactSize([]);
    const estimatedSize = (items) => {
      if (items.length === 0) return emptySize;
      let total = emptySize + items.length - 1;
      for (const item of items) total += encoded.get(item.recordId) ?? 0;
      return total;
    };
    const clusters = closedClusters(records).filter((group) => group.every((record) => !protectIds.has(record.recordId)));
    const dropIds = new Set();
    let remaining = records;
    let cursor = 0;
    const settled = (exact) => remaining.length + (reserveSlot ? 1 : 0) <= targetCount
      && (exact ?? estimatedSize(remaining)) <= targetSize;
    while (cursor < clusters.length && !settled()) {
      for (const member of clusters[cursor]) dropIds.add(member.recordId);
      cursor += 1;
      remaining = records.filter((record) => !dropIds.has(record.recordId));
    }
    let exactSize = compactSize(remaining);
    while (cursor < clusters.length && !settled(exactSize)) {
      for (const member of clusters[cursor]) dropIds.add(member.recordId);
      cursor += 1;
      remaining = records.filter((record) => !dropIds.has(record.recordId));
      exactSize = compactSize(remaining);
    }
    if (dropIds.size === 0 || exactSize > this.#maxJsonChars || remaining.length + (reserveSlot ? 1 : 0) > this.#maxRecords) return [];
    validateRecordGraph(remaining);
    return records.filter((record) => dropIds.has(record.recordId));
  }

  async #flushClosedRecords({ reserveSlot = false } = {}) {
    let aged = [];
    const write = async () => {
      const selected = this.#selectForArchive({ reserveSlot });
      if (selected.length === 0) return;
      await this.#writeArchive(selected);
      for (const item of selected) this.#records.delete(item.recordId);
      aged = selected;
      await this.#writeRecords({ drop: aged });
    };
    this.#queue = this.#queue.then(write, write);
    try {
      await this.#queue;
    } catch (error) {
      for (const item of aged) this.#records.set(item.recordId, item);
      throw error;
    }
  }

  async #writeArchive(records) {
    const archivedAtMs = Date.now();
    const stamp = new Date(archivedAtMs).toISOString().replace(/[:.]/g, '-');
    const filePath = join(`${this.#storagePath}.archives`, `aged-${stamp}-${randomUUID()}.json`);
    await persistJsonFile(filePath, {
      schemaVersion: SCHEMA_VERSION,
      kind: 'execution-state-archive',
      archivedAtMs,
      reason: 'EXECUTION_STATE_CAPACITY',
      records: records.map((record) => clone(record))
    });
  }

  async #writeRecords({ payload, expectedRecordId, expectedDigest, drop = [] } = {}) {
    const body = payload ?? payloadOf(this.list());
    const dropUpdated = new Map(drop.map((record) => [record.recordId, record.updatedAtMs ?? 0]));
    await persistJsonFile(this.#storagePath, body, {
      merge: (existing, incoming) => {
        const prior = expectedRecordId && Array.isArray(existing?.records)
          ? existing.records.find((candidate) => candidate?.recordId === expectedRecordId)
          : undefined;
        if (expectedDigest && prior && prior.recordDigest !== expectedDigest) throw new Error('EXECUTION_STATE_CONFLICT');
        const merged = mergeRecordsById(existing, incoming, { collection: 'records', id: 'recordId' });
        // The live snapshot is a union, so a record backed up here has to be
        // removed again or the next load pulls it straight back in.
        const records = merged.records.filter((record) => {
          const archivedUpdated = dropUpdated.get(record?.recordId);
          if (archivedUpdated === undefined) return true;
          return (record?.updatedAtMs ?? 0) > archivedUpdated;
        });
        if (records.length > this.#maxRecords) throw new Error('EXECUTION_STATE_FULL');
        if (compactSize(records) > this.#maxJsonChars) throw new Error('EXECUTION_STATE_TOO_LARGE');
        return payloadOf(records);
      }
    });
  }
}

export const createExecutionStateStore = (options) => new ExecutionStateStore(options);
export { STATES as EXECUTION_STATES, digest as executionDigest };

const defaultOwnerAlive = (pid) => {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};
