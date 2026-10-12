import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor } from '../src/safety-executor.mjs';
import {
  APPROVAL_OUTCOMES, createExplicitLeaseProvider, registerExecutorTools, resolveApprovalOutcome
} from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import {
  createKernelEffectAuditLog, createKernelEffectDenylist, createKernelEffectsDispatcher,
  isHiddenWhileKernelEffects, kernelEffectDenylistKey, kernelEffectsAvailability,
  parseKernelEffectsFlag, resolveKernelApprovalPolicy, KERNEL_BATCH_LIMITS
} from '../src/kernel/effects.mjs';
import { registerResidentKernelTools } from '../src/kernel/kernel-tools.mjs';

const FULL_ENV = Object.freeze({
  DDA_RESIDENT_KERNEL: '1', DDA_PLATFORM: 'linux-cli', DDA_KERNEL_EFFECTS: 'fs.write,fs.patch,test.run'
});
const digest = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

test('effects availability needs resident kernel + flag + Linux + CONTROLLED + lease (FROZEN #8)', () => {
  const canLease = () => true;
  const ok = kernelEffectsAvailability({ env: FULL_ENV, executionMode: 'CONTROLLED', canLease });
  assert.equal(ok.available, true);
  assert.deepEqual(ok.kinds, ['fs.write', 'fs.patch', 'test.run']);
  assert.equal(kernelEffectsAvailability({ env: { ...FULL_ENV, DDA_KERNEL_EFFECTS: '' }, executionMode: 'CONTROLLED', canLease }).reason, 'EFFECTS_DISABLED');
  assert.equal(kernelEffectsAvailability({ env: { ...FULL_ENV, DDA_RESIDENT_KERNEL: '0' }, executionMode: 'CONTROLLED', canLease }).reason, 'KERNEL_NOT_ATTACHED');
  assert.equal(kernelEffectsAvailability({ env: FULL_ENV, executionMode: 'CONTROLLED', canLease, kernelAttached: false }).reason, 'KERNEL_NOT_ATTACHED');
  assert.equal(kernelEffectsAvailability({ env: { ...FULL_ENV, DDA_PLATFORM: 'windows' }, executionMode: 'CONTROLLED', canLease }).reason, 'NON_LINUX_PLATFORM_IDENTITY');
  assert.equal(kernelEffectsAvailability({ env: FULL_ENV, executionMode: 'READ_ONLY', canLease }).reason, 'NOT_CONTROLLED');
  const noLease = kernelEffectsAvailability({ env: FULL_ENV, executionMode: 'CONTROLLED', canLease: () => false });
  assert.equal(noLease.reason, 'LEASE_NOT_GRANTED');
  assert.deepEqual(noLease.kinds, []);
  const partial = kernelEffectsAvailability({ env: FULL_ENV, executionMode: 'CONTROLLED', canLease: (cap) => cap === CAPABILITIES.WRITE_FILE });
  assert.deepEqual(partial.kinds, ['fs.write', 'fs.patch']);
  assert.deepEqual(partial.unleasedKinds, ['test.run']);
  assert.equal(partial.writeBatch, false, 'batch needs DDA_KERNEL_WRITE_BATCH');
  assert.equal(kernelEffectsAvailability({ env: { ...FULL_ENV, DDA_KERNEL_WRITE_BATCH: '1' }, executionMode: 'CONTROLLED', canLease }).writeBatch, true);
});

test('shell.exec and net.fetch can never be enabled in Phase-2a', () => {
  const flag = parseKernelEffectsFlag({ DDA_KERNEL_EFFECTS: 'fs.write,shell.exec,net.fetch,write_file' });
  assert.deepEqual(flag.kinds, ['fs.write']);
  assert.deepEqual(flag.refusedKinds, ['shell.exec', 'net.fetch', 'write_file']);
});

test('approval policy defaults to host-policy-audit and unknown values fail closed', () => {
  assert.equal(resolveKernelApprovalPolicy({}), 'host-policy-audit');
  assert.equal(resolveKernelApprovalPolicy({ DDA_KERNEL_APPROVAL: 'host-policy' }), 'host-policy-audit');
  assert.equal(resolveKernelApprovalPolicy({ DDA_KERNEL_APPROVAL: 'per-request' }), 'per-request');
  assert.equal(resolveKernelApprovalPolicy({ DDA_KERNEL_APPROVAL: 'yolo' }), 'per-request');
});

test('hidden discrete tools are not listed or model-invocable but stay host-reachable', async () => {
  const registry = new ToolRegistry({ allowSideEffects: true });
  registry.register({ name: 'workspace.read', description: 'r', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true, handler: () => ({ ok: true }) });
  registry.register({ name: 'file.write', description: 'w', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: false, handler: () => ({ wrote: true }) });
  registry.register({ name: 'kernel.host_request', description: 'k', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: false, handler: () => ({ bridged: true }) });
  registry.hide(isHiddenWhileKernelEffects);
  assert.deepEqual(registry.list().map((tool) => tool.name).sort(), ['kernel.host_request', 'workspace.read']);
  await assert.rejects(registry.invoke('file.write', {}), /TOOL_NOT_FOUND/);
  assert.deepEqual(await registry.invokeInternal('file.write', {}), { wrote: true });
  assert.deepEqual(await registry.invoke('kernel.host_request', {}), { bridged: true });
});

// Mirrors the host requestApproval in index.mjs: unchanged
// resolveApprovalOutcome plus the batch grant short-circuit.
const hostApproval = ({ live = false, decide = () => true } = {}) => {
  const calls = [];
  const requestApproval = async ({ capability, request, requireApproval, context }) => {
    const batchGranted = requireApproval !== true && context?.kernelEffect?.batchGrant?.consume?.({ capability, request }) === true;
    calls.push({ capability, request, requireApproval, batchGranted });
    if (batchGranted) return true;
    const outcome = resolveApprovalOutcome({ requireApproval, hasLiveApprover: live });
    if (outcome === APPROVAL_OUTCOMES.REFUSE) return false;
    if (outcome === APPROVAL_OUTCOMES.AUTO_APPROVE) return true;
    return decide({ capability, request, requireApproval });
  };
  return { requestApproval, calls };
};

const harness = async ({
  live = false, decide, env = FULL_ENV, capabilities = [CAPABILITIES.WRITE_FILE, CAPABILITIES.TEST],
  files = {}, executorOverrides = {}, gateRequiresApproval = () => false, denylistPath, policyEnv = {}
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'dda-kernel-effects-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const store = new Map(Object.entries(files));
  const effects = [];
  const workspace = {
    async read(path) {
      if (!store.has(path)) throw new Error(`WORKSPACE_NOT_FOUND:${path}`);
      const content = store.get(path);
      return { path, content, digest: digest(content), truncated: false };
    }
  };
  const executor = {
    async shell() { effects.push({ kind: 'shell' }); return { ok: true, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'shell', cwd: '' }; },
    async writeFile(request) {
      if (executorOverrides.writeFile) return executorOverrides.writeFile(request, { store, effects });
      effects.push({ kind: 'write', path: request.path });
      store.set(request.path, request.content);
      return { ok: true, action: 'write_file', path: request.path, bytesWritten: Buffer.byteLength(request.content), contentDigest: digest(request.content) };
    },
    async test(request) {
      effects.push({ kind: 'test', command: request.command });
      return executorOverrides.test?.(request) ?? { ok: true, stdout: 'ok', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'test', cwd: '' };
    }
  };
  const verifier = { active: false };
  const approval = hostApproval({ live, decide });
  let leases = 0;
  const leaseProvider = createExplicitLeaseProvider({
    monitor, capabilities, commands: ['node'],
    requestApproval: approval.requestApproval,
    gateDecisionFor: ({ context }) => (verifier.active || context?.kernelEffect?.requireApproval || gateRequiresApproval(context) ? { requireApproval: true } : undefined),
    onLeaseIssued: () => { leases += 1; }
  });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, { leaseProvider, workspace });
  registry.hide(isHiddenWhileKernelEffects);
  const fullEnv = { ...env, ...policyEnv };
  const availability = kernelEffectsAvailability({ env: fullEnv, executionMode: 'CONTROLLED', canLease: (cap) => leaseProvider.canLease(cap) });
  const audit = createKernelEffectAuditLog();
  const denylist = createKernelEffectDenylist({ storagePath: denylistPath });
  const events = [];
  const dispatcher = createKernelEffectsDispatcher({
    availability, executionMode: 'CONTROLLED', workspaceRoot: root, workspace,
    invokeTool: (name, input, context) => registry.invokeInternal(name, input, context),
    canLease: (cap) => leaseProvider.canLease(cap),
    hasLiveApprover: () => live,
    verifierReapprovalActive: () => verifier.active,
    gateRequiresApproval,
    requestBatchApproval: ({ batchId, batchDigest, items }) => approval.requestApproval({
      capability: CAPABILITIES.WRITE_FILE, request: { kernelBatchId: batchId, kernelBatchDigest: batchDigest, kernelBatchItems: items }, requireApproval: false
    }),
    denylist, audit, emit: (type, payload) => events.push({ type, payload }), runId: 'run-test'
  });
  return { dispatcher, registry, effects, store, verifier, approval, audit, denylist, events, root, leases: () => leases };
};

test('no live approver: a safe pre-leased write is AUTO-approved by host policy and audited', async () => {
  const h = await harness();
  const out = await h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'notes.txt', content: 'hi\n', expectedBaseDigest: null } }, { toolCallId: 'c1' });
  assert.equal(out.ok, true);
  assert.equal(out.approvalPath, 'AUTO_HOST_POLICY');
  assert.equal(out.riskClass, 'workspace_write');
  assert.equal(h.store.get('notes.txt'), 'hi\n');
  assert.equal(h.leases(), 1);
  assert.deepEqual(h.audit.records.map((r) => r.phase), ['REQUESTED', 'COMPLETED']);
  assert.equal(h.audit.records[1].key, 'CONTROLLED|fs.write|workspace_write');
});

test('fs.write requires expectedBaseDigest and honors stale-digest protection', async () => {
  const h = await harness({ files: { 'a.txt': 'old' } });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x' } }), /KERNEL_EFFECT_INVALID_PAYLOAD/);
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: digest('other') } }), /WRITE_STALE_DIGEST/);
  assert.equal(h.store.get('a.txt'), 'old');
});

test('fs.patch and test.run run through the discrete executor tools', async () => {
  const h = await harness({ files: { 'a.txt': 'hello world' } });
  const patched = await h.dispatcher.dispatch({ kind: 'fs.patch', payload: { path: 'a.txt', replacements: [{ oldText: 'world', newText: 'dda' }] } });
  assert.equal(patched.ok, true);
  assert.equal(h.store.get('a.txt'), 'hello dda');
  const tested = await h.dispatcher.dispatch({ kind: 'test.run', payload: { command: 'node', args: ['--test'] } });
  assert.equal(tested.ok, true);
  assert.equal(tested.riskClass, 'test_command');
  assert.equal(h.leases(), 2, 'one lease per effect');
});

test('shell.exec / net.fetch are refused and never reach an executor', async () => {
  const h = await harness();
  await assert.rejects(h.dispatcher.dispatch({ kind: 'shell.exec', payload: { command: 'ls' } }), /KERNEL_SIDE_EFFECT_REFUSED/);
  await assert.rejects(h.dispatcher.dispatch({ kind: 'net.fetch', payload: { host: 'example.com' } }), /KERNEL_SIDE_EFFECT_REFUSED/);
  assert.deepEqual(h.effects, []);
});

test('no live approver: dangerous writes (secret path / outside workspace) are refused', async () => {
  const h = await harness();
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: '.env', content: 'K=1', expectedBaseDigest: null } }), /SAFETY_LEASE_REQUIRED/);
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: '../escape.txt', content: 'x', expectedBaseDigest: null } }));
  assert.deepEqual(h.effects, []);
  assert.ok(h.audit.records.some((r) => r.phase === 'REFUSED' && r.riskClass === 'secret_path'));
});

test('no live approver: Jev REQUIRE_APPROVAL refuses; live approver is prompted', async () => {
  const refused = await harness({ gateRequiresApproval: () => true });
  await assert.rejects(refused.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } }), /KERNEL_EFFECT_APPROVAL_REQUIRED/);
  assert.deepEqual(refused.effects, []);
  const prompted = await harness({ live: true, gateRequiresApproval: () => true });
  const out = await prompted.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } });
  assert.equal(out.ok, true);
  assert.equal(out.approvalPath, 'LIVE_APPROVAL');
  assert.equal(prompted.approval.calls[0].requireApproval, true);
});

test('missing lease: an un-leased kind is refused before any approval', async () => {
  const h = await harness({ capabilities: [CAPABILITIES.WRITE_FILE] });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'test.run', payload: { command: 'node' } }), /KERNEL_SIDE_EFFECT_REFUSED/);
  assert.equal(h.approval.calls.length, 0);
});

test('per-request policy refuses every effect without a live approver', async () => {
  const h = await harness({ policyEnv: { DDA_KERNEL_APPROVAL: 'per-request' } });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } }), /KERNEL_APPROVAL_PER_REQUEST/);
  assert.deepEqual(h.effects, []);
});

test('denylist (host-owned, digest-checked) only adds refusals', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dda-denylist-'));
  const denylistPath = join(dir, 'denylist.json');
  const seed = createKernelEffectDenylist({ storagePath: denylistPath });
  const key = kernelEffectDenylistKey({ executionMode: 'CONTROLLED', effectKind: 'fs.write', riskClass: 'workspace_write' });
  assert.deepEqual(await seed.add(key, { reason: 'AUDIT_REVIEW' }), { added: true });
  assert.equal(typeof seed.remove, 'undefined', 'no API can lift a denial');
  const stored = JSON.parse(await readFile(denylistPath, 'utf8'));
  assert.match(stored.digest, /^sha256:[0-9a-f]{64}$/);

  const h = await harness({ denylistPath });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } }), /KERNEL_EFFECT_DENYLISTED/);
  // A different key (test.run) keeps the master AUTO path.
  assert.equal((await h.dispatcher.dispatch({ kind: 'test.run', payload: { command: 'node' } })).approvalPath, 'AUTO_HOST_POLICY');
  // A dangerous action is still refused even though it is not denylisted.
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: '.ssh/id_rsa', content: 'x', expectedBaseDigest: null } }));
  // With a live approver the denylisted key is prompted, never auto-approved.
  const live = await harness({ denylistPath, live: true });
  await live.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } });
  assert.equal(live.approval.calls[0].requireApproval, true);

  // Tampering fails closed: every key is treated as denied.
  await writeFile(denylistPath, JSON.stringify({ ...stored, entries: [] }), 'utf8');
  const tampered = await harness({ denylistPath });
  await assert.rejects(tampered.dispatcher.dispatch({ kind: 'test.run', payload: { command: 'node' } }), /KERNEL_EFFECT_DENYLISTED/);
  assert.equal(tampered.denylist.integrity, 'TAMPERED');
});

test('#16 armed: next effect needs a live approval and the dispatcher never clears the verifier flag', async () => {
  const none = await harness();
  none.verifier.active = true;
  await assert.rejects(none.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } }), /VERIFIER_REAPPROVAL/);
  const live = await harness({ live: true });
  live.verifier.active = true;
  const out = await live.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } });
  assert.equal(out.ok, true);
  assert.equal(live.approval.calls[0].requireApproval, true);
  assert.equal(live.verifier.active, true, 'only a clean verifier PASS clears #16');
});

test('KERNEL_TIMEOUT / uncertain outcome: never replays, refuses the next auto-approval, adds to denylist', async () => {
  const h = await harness({ executorOverrides: { test: () => ({ ok: false, stdout: '', stderr: '', timedOut: true, aborted: false, truncated: false, action: 'test', cwd: '', state: 'UNKNOWN' }) } });
  const first = await h.dispatcher.dispatch({ kind: 'test.run', payload: { command: 'node' } });
  assert.equal(first.ok, false);
  assert.equal(first.outcome, 'UNKNOWN');
  assert.equal(h.effects.length, 1, 'no replay');
  assert.equal(h.dispatcher.outcomeUncertain.active, true);
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } }), /KERNEL_OUTCOME_UNCERTAIN/);
  assert.equal(h.effects.length, 1);
  assert.equal(await h.denylist.has('CONTROLLED|test.run|test_command'), true, 'auto-approved unknown outcome is denylisted');
  assert.ok(h.events.some((e) => e.type === 'kernel.effect_outcome_uncertain'));
});

test('bridge KERNEL_TIMEOUT arms uncertain; a live individual approval discharges it without touching #16', async () => {
  const h = await harness({ live: true });
  h.dispatcher.noteBridgeOutcome('KERNEL_TIMEOUT');
  assert.equal(h.dispatcher.outcomeUncertain.active, true);
  h.verifier.active = true;
  await h.dispatcher.dispatch({ kind: 'fs.write', payload: { path: 'a.txt', content: 'x', expectedBaseDigest: null } });
  assert.equal(h.approval.calls[0].requireApproval, true);
  assert.equal(h.dispatcher.outcomeUncertain.active, false);
  assert.equal(h.verifier.active, true);
});

const batchEnv = { ...FULL_ENV, DDA_KERNEL_WRITE_BATCH: '1' };
const items3 = [
  { op: 'write', path: 'a.txt', content: 'A', expectedBaseDigest: null },
  { op: 'write', path: 'b.txt', content: 'B', expectedBaseDigest: null },
  { op: 'patch', path: 'c.txt', replacements: [{ oldText: 'c', newText: 'C' }] }
];

test('fs.write_batch is refused unless DDA_KERNEL_WRITE_BATCH is on', async () => {
  const h = await harness({ files: { 'c.txt': 'c' } });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3 } }, { roundId: 'r1' }), /KERNEL_BATCH_DISABLED/);
  assert.deepEqual(h.effects, []);
});

test('no live approver: a safe batch auto-approves N items with N leases', async () => {
  const h = await harness({ env: batchEnv, files: { 'c.txt': 'c' } });
  const out = await h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3 } }, { roundId: 'r1' });
  assert.equal(out.ok, true);
  assert.equal(out.committed.length, 3);
  assert.equal(h.store.get('c.txt'), 'C');
  assert.equal(h.leases(), 3);
  assert.ok(out.committed.every((item) => item.approvalPath === 'AUTO_HOST_POLICY'));
});

test('live approver: one batch card covers the pre-admitted items', async () => {
  const h = await harness({ env: batchEnv, live: true, files: { 'c.txt': 'c' } });
  const out = await h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3 } }, { roundId: 'r1' });
  assert.equal(out.ok, true);
  const prompts = h.approval.calls.filter((call) => !call.batchGranted);
  assert.equal(prompts.length, 1, 'only the batch card prompts');
  assert.ok(Array.isArray(prompts[0].request.kernelBatchItems));
  assert.equal(h.approval.calls.filter((call) => call.batchGranted).length, 3);
  assert.equal(h.leases(), 3);
});

test('batch: declined card writes nothing; one dangerous item refuses the whole batch without a live approver', async () => {
  const declined = await harness({ env: batchEnv, live: true, decide: () => false, files: { 'c.txt': 'c' } });
  await assert.rejects(declined.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3 } }, { roundId: 'r1' }), /KERNEL_BATCH_REFUSED/);
  assert.deepEqual(declined.effects, []);
  const dangerous = await harness({ env: batchEnv, files: { 'c.txt': 'c' } });
  await assert.rejects(dangerous.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: [...items3, { op: 'write', path: '.env', content: 'x', expectedBaseDigest: null }] } }, { roundId: 'r1' }), /KERNEL_BATCH_REFUSED/);
  assert.deepEqual(dangerous.effects, []);
});

test('batch limits: item count, bytes, one batch per round', async () => {
  const h = await harness({ env: batchEnv, files: { 'c.txt': 'c' } });
  const many = Array.from({ length: KERNEL_BATCH_LIMITS.maxItems + 1 }, (_, i) => ({ op: 'write', path: `f${i}.txt`, content: 'x', expectedBaseDigest: null }));
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: many } }, { roundId: 'r0' }), /KERNEL_BATCH_LIMIT_EXCEEDED/);
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: [{ op: 'write', path: 'big.txt', content: 'x'.repeat(KERNEL_BATCH_LIMITS.maxBytes + 1), expectedBaseDigest: null }] } }, { roundId: 'r0b' }), /KERNEL_BATCH_LIMIT_EXCEEDED/);
  await h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3.slice(0, 1) } }, { roundId: 'r1' });
  await assert.rejects(h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3.slice(1, 2) } }, { roundId: 'r1' }), /KERNEL_BATCH_ROUND_LIMIT/);
});

test('batch failure stops, reports the committed prefix, skips the rest, never rolls back', async () => {
  const h = await harness({
    env: batchEnv,
    files: { 'c.txt': 'c' },
    executorOverrides: {
      writeFile(request, { store, effects }) {
        if (request.path === 'b.txt') throw Object.assign(new Error('EXECUTOR_WRITE_FAILED'), { code: 'EXECUTOR_WRITE_FAILED' });
        effects.push({ kind: 'write', path: request.path });
        store.set(request.path, request.content);
        return { ok: true, action: 'write_file', path: request.path, bytesWritten: 1, contentDigest: digest(request.content) };
      }
    }
  });
  const out = await h.dispatcher.dispatch({ kind: 'fs.write_batch', payload: { items: items3 } }, { roundId: 'r1' });
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, false);
  assert.deepEqual(out.committed.map((item) => item.path), ['a.txt']);
  assert.equal(out.failed.path, 'b.txt');
  assert.deepEqual(out.skipped.map((item) => item.path), ['c.txt']);
  assert.equal(h.store.get('a.txt'), 'A', 'committed prefix stays');
  assert.equal(h.store.get('c.txt'), 'c');
});

test('kernel.host_request becomes a side-effect tool only when effects are available', async () => {
  const kernel = { request: async (op, params) => ({ op, params }) };
  const off = new ToolRegistry({ allowSideEffects: true });
  registerResidentKernelTools(off, kernel);
  assert.equal(off.list().find((tool) => tool.name === 'kernel.host_request').readOnly, true);
  const on = new ToolRegistry({ allowSideEffects: true });
  const dispatched = [];
  registerResidentKernelTools(on, kernel, { hostRequestDispatcher: {
    availability: { available: true, kinds: ['fs.write'], writeBatch: false },
    handles: (kind) => kind === 'fs.write',
    dispatch: async (request) => { dispatched.push(request.kind); return { ok: true }; },
    noteBridgeOutcome: () => {}
  } });
  const tool = on.list().find((item) => item.name === 'kernel.host_request');
  assert.equal(tool.readOnly, false);
  assert.match(tool.description, /fs\.write payload/);
  await on.invoke('kernel.host_request', { kind: 'fs.write', payload: {} });
  assert.deepEqual(dispatched, ['fs.write']);
  const probe = await on.invoke('kernel.host_request', { kind: 'host.ping' });
  assert.equal(probe.op, 'host_request', 'inert probes still go to the worker');
});

test('bridge timeouts from the worker are reported to the dispatcher (never replayed)', async () => {
  let noted;
  const kernel = { request: async () => { throw Object.assign(new Error('KERNEL_TIMEOUT'), { code: 'KERNEL_TIMEOUT' }); } };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerResidentKernelTools(registry, kernel, { hostRequestDispatcher: {
    availability: { available: true, kinds: ['fs.write'] }, handles: () => false, dispatch: async () => ({}),
    noteBridgeOutcome: (code) => { noted = code; }
  } });
  await assert.rejects(registry.invoke('kernel.host_request', { kind: 'host.ping' }), /KERNEL_TIMEOUT/);
  assert.equal(noted, 'KERNEL_TIMEOUT');
});
