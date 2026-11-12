import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor } from '../src/runtime-safety-monitor.mjs';
import { RestrictedWindowsExecutor } from '../src/restricted-windows-executor.mjs';
import { assessRequestRisk, createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { createExecutionScopeSnapshot } from '../src/execution-scope-snapshot.mjs';
import { createTaskRunCoordinator } from '../src/task-run-coordinator.mjs';
import { createApprovalSession } from '../src/kernel/approval-session.mjs';

const DIGEST = `sha256:${'cd'.repeat(32)}`;

const waitFor = async (predicate, attempts = 100) => {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('timed out waiting for condition');
};

const make = async (t, { live = true } = {}) => {
  const base = await mkdtemp(join(tmpdir(), 'full-access-approval-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  const modeRef = { value: 'REQUIRE_APPROVAL' };

  const events = [];
  const store = createExecutionStateStore({});
  const real = createTaskRunCoordinator({ runId: 'run-full-access' });
  real.transition('PLANNING');
  real.transition('EXECUTING');
  const coordinator = {
    get state() { return real.state; },
    transition: (next, options) => real.transition(next, options),
    async transitionAndFlush(next, options) { const r = real.transition(next, options); await real.flush(); return r; },
    flush: () => real.flush()
  };
  const getWorkspaceAccessMode = async () => modeRef.value;
  const approvalContexts = new Map();
  const session = createApprovalSession({
    approvalContexts,
    runId: 'run-full-access',
    logger: console,
    emitEvent: (kind, payload) => events.push({ kind, payload }),
    approvalTtlMs: 4000,
    hasLiveApprover: () => live,
    executionState: () => store,
    coordinator: () => coordinator,
    workspaceRoot: project,
    getWorkspaceAccessMode,
    isSafeKernelBatchItem: async (item) => !assessRequestRisk({
      capability: CAPABILITIES.WRITE_FILE, request: { path: item?.path }, workspaceRoot: project, accessMode: modeRef.value
    }).dangerous,
    activeSnapshotDigest: () => DIGEST,
    releaseChannel: () => 'WINDOWS_PHASE1_5_CONTROLLED',
    executorIdentity: () => 'test-executor',
    bindingSnapshot: () => [],
    capabilitySnapshot: () => ({}),
    buildScope: async (input) => createExecutionScopeSnapshot({
      runId: 'run-full-access', operationId: input.operationId, allowedCapabilities: [input.capability],
      ...(input.accessMode === 'FULL_ACCESS' && ['shell.execute', 'test.execute'].includes(input.capability)
        ? { allowedPathScope: 'WORKSPACE' } : {}),
      executionMode: 'CONTROLLED', releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED', policyVersion: 'runtime-safety-1',
      bindingSnapshotDigest: input.bindingSnapshotDigest, createdAtMs: 1
    }),
    appendGitAuditCheckpoint: async () => ({ ok: true }),
    appendActionEvent: async () => ({ ok: true })
  });

  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: project, getAccessMode: getWorkspaceAccessMode });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const workspace = new ReadonlyWorkspace(project, { getAccessMode: getWorkspaceAccessMode });
  const effects = [];
  const leaseIds = new Set();
  const consumedLeaseIds = new Set();
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, {
    async shell(request, options) { effects.push('shell'); return executor.execute(ACTIONS.SHELL, request, options); },
    async test(request, options) { effects.push('test'); return executor.execute(ACTIONS.TEST, request, options); },
    async writeFile(request, options) { effects.push('write'); return executor.execute(ACTIONS.WRITE_FILE, request, options); }
  }, {
    workspace,
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL, CAPABILITIES.WRITE_FILE, CAPABILITIES.TEST],
      commands: ['node'],
      requestApproval: (input) => session.requestApproval(input),
      getWorkspaceAccessMode,
      onLeaseIssued: ({ lease }) => { if (lease?.id) leaseIds.add(lease.id); }
    }),
    onLeaseConsumed: ({ lease }) => { if (lease?.id) consumedLeaseIds.add(lease.id); }
  });
  const kinds = (kind) => events.filter((e) => e.kind === kind);
  const decline = (requestEvent) => session.handleLine(JSON.stringify({
    type: 'approval_response', requestId: requestEvent.payload.requestId,
    approved: false, displayedDigest: requestEvent.payload.requestDigest
  }));
  return { base, project, outside, events, kinds, registry, session, store, approvalContexts, monitor, modeRef, effects, leaseIds, consumedLeaseIds, decline };
};

test('FULL_ACCESS auto-approves ordinary outside writes with real leases + audit', async (t) => {
  const { outside, kinds, registry, modeRef, effects, leaseIds, consumedLeaseIds } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  const target = join(outside, 'auto.txt');
  const first = await registry.invoke('file.write', { path: target, content: 'auto-written' });
  assert.equal(first.ok, true);
  assert.equal(await readFile(target, 'utf8'), 'auto-written');
  assert.equal(effects.length, 1);
  assert.equal(kinds('approval.auto_approved').length, 1);
  const auto = kinds('approval.auto_approved')[0].payload;
  assert.equal(auto.mode, 'FULL_ACCESS');
  assert.equal(auto.scope, 'USER_FILESYSTEM');
  assert.ok(auto.approvalId && auto.intentId && auto.requestId, 'audit ids present');
  assert.equal(kinds('approval.requested').length, 0, 'no human card / no notification');
  const second = await registry.invoke('file.write', { path: join(outside, 'two.txt'), content: 'second' });
  assert.equal(second.ok, true);
  assert.equal(effects.length, 2);
  assert.equal(kinds('approval.auto_approved').length, 2, 'each op gets its own approval record');
  assert.equal(kinds('approval.requested').length, 0);
  assert.equal(leaseIds.size >= 2, true, 'unique lease per operation');
  assert.ok([...leaseIds].every((id) => consumedLeaseIds.has(id)), 'every lease consumed by the effect');
});

const dangerousCases = [
  { name: 'node -e inline', input: { command: 'node', args: ['-e', '1'] } },
  { name: 'node.exe -e inline', input: { command: 'node.exe', args: ['-e', '1'] } },
  { name: 'powershell -enc', input: { command: 'powershell.exe', args: ['-enc', 'AA=='] } },
  { name: 'cmd /c', input: { command: 'cmd.exe', args: ['/c', 'dir'] } },
  { name: 'python3.11 -c', input: { command: 'python3.11', args: ['-c', 'pass'] } },
  { name: 'rm outside args', input: { command: 'rm', args: ['/definitely-outside/file.txt'] } },
  { name: 'rm.exe outside inline', input: { command: 'rm.exe C:/outside/x.txt' } },
  { name: 'del .. escape', input: { command: 'del', args: ['../../outside.txt'] } },
  { name: 'rd /s recursive', input: { command: 'rd', args: ['/s', 'subdir'] } },
  { name: 'rm missing operand', input: { command: 'rm', args: [] } },
  { name: 'format disk', input: { command: 'format', args: ['D:'] } },
  { name: 'runas', input: { command: 'runas', args: ['/user:admin', 'x'] } }
];

test('dangerous/extreme requests stay human even under FULL_ACCESS', async (t) => {
  const { kinds, registry, modeRef, effects, leaseIds, decline } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  for (const { name, input } of dangerousCases) {
    const before = kinds('approval.requested').length;
    const pending = registry.invoke('shell.execute', input).catch((e) => e);
    await waitFor(() => kinds('approval.requested').length > before, 60);
    const card = kinds('approval.requested')[before];
    // Every human card carries host reason codes; the node -e case also
    // carries a JSON argv preview the reviewer can inspect.
    assert.ok(Array.isArray(card.payload.reasonCodes) && card.payload.reasonCodes.length > 0, `${name}: reasonCodes present`);
    if (input.command === 'node.exe') {
      assert.ok(card.payload.reasonCodes.includes('DANGEROUS_INLINE_INTERPRETER'), 'inline interpreter reason');
      const preview = JSON.parse(card.payload.commandPreview);
      assert.equal(preview.command, 'node.exe');
      assert.deepEqual(preview.args, ['-e', '1']);
      assert.equal(preview.cwd, '.');
      assert.equal(card.payload.risk, 'HIGH', 'forged caller risk cannot stay LOW');
    }
    decline(card);
    const settled = await pending;
    assert.ok(settled instanceof Error || settled?.ok === false, `${name}: declined dangerous op must fail`);
  }
  assert.equal(kinds('approval.auto_approved').length, 0, 'no auto-approval for dangerous ops');
  assert.equal(effects.length, 0, 'no effect ran without approval');
  assert.equal(leaseIds.size, 0, 'no lease issued for declined ops');
});

test('revocation stops the next auto-approval: outside is denied, inside gets a real card', async (t) => {
  const { outside, kinds, registry, modeRef, decline } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  await registry.invoke('file.write', { path: join(outside, 'one.txt'), content: 'a' });
  assert.equal(kinds('approval.auto_approved').length, 1);
  modeRef.value = 'REQUIRE_APPROVAL';
  // Outside write is now refused at the guard before any card or mutation.
  const outsideDenied = await registry.invoke('file.write', { path: join(outside, 'two.txt'), content: 'b' }).catch((e) => e);
  assert.ok(outsideDenied instanceof Error || outsideDenied?.ok === false, 'revoked outside write must fail');
  assert.equal(kinds('approval.requested').length, 0, 'no card for a guard-level denial');
  assert.equal(kinds('approval.auto_approved').length, 1, 'no second auto-approval after revocation');
  // An ordinary inside-workspace write now goes through the human card.
  const pending = registry.invoke('file.write', { path: 'inside.txt', content: 'x' }).catch((e) => e);
  await waitFor(() => kinds('approval.requested').length === 1);
  decline(kinds('approval.requested')[0]);
  await pending;
});

test('REQUIRE_APPROVAL mode keeps exactly one standard pending card', async (t) => {
  const { kinds, registry, session, decline } = await make(t);
  const pending = registry.invoke('file.write', { path: 'std.txt', content: 'x' }).catch((e) => e);
  await waitFor(() => kinds('approval.requested').length === 1);
  assert.equal(session.pendingApprovals.size, 1, 'exactly one pending card');
  decline(kinds('approval.requested')[0]);
  const settled = await pending;
  assert.ok(settled instanceof Error || settled?.ok === false, 'declined write must fail');
  assert.equal(kinds('approval.auto_approved').length, 0);
});

test('throwing getWorkspaceAccessMode callback fails closed to a real card', async (t) => {
  const { project, outside, session, decline, kinds } = await make(t);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: project });
  const registry = new ToolRegistry({ allowSideEffects: true });
  const executor = new RestrictedWindowsExecutor({ monitor });
  registerExecutorTools(registry, {
    async shell() { throw new Error('shell must not run'); },
    async test() { throw new Error('test must not run'); },
    async writeFile(request, options) { return executor.execute(ACTIONS.WRITE_FILE, request, options); }
  }, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.WRITE_FILE],
      requestApproval: (input) => session.requestApproval(input),
      getWorkspaceAccessMode: () => { throw new Error('policy read failed'); }
    })
  });
  const pending = registry.invoke('file.write', { path: 'in.txt', content: 'x' }).catch((e) => e);
  await waitFor(() => kinds('approval.requested').length === 1, 60);
  decline(kinds('approval.requested')[0]);
  await pending;
  assert.equal(kinds('approval.auto_approved').length, 0, 'throwing reader never auto-approves');
});

test('mandatoryApproval still produces a real card under FULL_ACCESS', async (t) => {
  const { kinds, session, modeRef, decline } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  const request = session.requestApproval({
    capability: CAPABILITIES.WRITE_FILE,
    request: { path: 'in.txt' },
    requireApproval: true, mandatoryApproval: true, context: {}
  }).then((value) => value === true ? 'approved' : 'rejected');
  await waitFor(() => kinds('approval.requested').length === 1, 60);
  const card = kinds('approval.requested')[0];
  assert.ok(card.payload.reasonCodes.includes('MANDATORY_SAFETY_REVIEW'), 'mandatory reason code');
  decline(card);
  assert.equal(await request, 'rejected');
  assert.equal(kinds('approval.auto_approved').length, 0, 'mandatory never auto-approves');
});

test('risk table: outside deletes, roots, inline flags, versions, omitted cwd are dangerous', async () => {
  const ws = 'C:/work/project';
  const check = (capability, request, accessMode) => assessRequestRisk({ capability, request, workspaceRoot: ws, accessMode });
  // Deletions outside stay dangerous even in FULL mode.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'rm', args: ['C:/outside/x'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'rm.exe /tmp/file' }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'rm' }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'del', args: ['..\\..\\..\\x'], cwd: 'sub/dir' }, 'FULL_ACCESS').dangerous, true);
  // sub/dir + ../../x stays inside the workspace and is correctly not flagged.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'del', args: ['..\\..\\x'], cwd: 'sub/dir' }, 'FULL_ACCESS').dangerous, false);
  // Workspace-root target is dangerous.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'rm', args: [ws] }, 'FULL_ACCESS').dangerous, true);
  // Inline interpreters across extensions and versions.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'powershell.exe', args: ['-enc', 'AA'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node.exe', args: ['-e', '1'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'python3.11', args: ['-c', 'pass'] }, 'FULL_ACCESS').dangerous, true);
  // A direct script entrypoint ends Node option parsing: script args like
  // tsc's -p/--project are not interpreter flags.
  const tscArgs = ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'];
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: tscArgs }, 'FULL_ACCESS').dangerous, false);
  assert.equal(check(CAPABILITIES.TEST, { command: 'node', args: tscArgs }, 'FULL_ACCESS').dangerous, false);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['build.js', '-p'] }, 'FULL_ACCESS').dangerous, false);
  // True eval/print before an entrypoint — including attached forms — stays dangerous.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['-p', 'script.js'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['-econsole.log(1)'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['-pe1'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['--eval=1'] }, 'FULL_ACCESS').dangerous, true);
  // '--' + non-stdin entrypoint ends option parsing; stdin '-' keeps scanning.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['--', 'script.js', '-p'] }, 'FULL_ACCESS').dangerous, false);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['-', '-p'] }, 'FULL_ACCESS').dangerous, true);
  // Option-prefixed invocation stays conservative — operands are not a script boundary.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'node', args: ['--inspect', 'script.js', '-p'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'cmd', args: ['/k', 'dir'] }, 'FULL_ACCESS').dangerous, true);
  // Extreme disk + elevation.
  assert.equal(check(CAPABILITIES.SHELL, { command: 'format', args: ['D:'] }, 'FULL_ACCESS').dangerous, true);
  assert.equal(check(CAPABILITIES.SHELL, { command: 'runas', args: ['/user:a', 'x'] }, 'FULL_ACCESS').dangerous, true);
  // Ordinary inside-workspace ops stay ordinary in FULL; outside WRITE is not dangerous under FULL.
  assert.equal(check(CAPABILITIES.WRITE_FILE, { path: 'C:/outside/new.txt' }, 'FULL_ACCESS').dangerous, false);
  assert.equal(check(CAPABILITIES.WRITE_FILE, { path: '../outside.txt' }, 'FULL_ACCESS').dangerous, false);
  assert.equal(check(CAPABILITIES.WRITE_FILE, { path: 'inside.txt' }, 'REQUIRE_APPROVAL').dangerous, false);
  // Omitted cwd must not throw.
  assert.doesNotThrow(() => check(CAPABILITIES.SHELL, { command: 'rm', args: ['x'] }, 'REQUIRE_APPROVAL'));
});

test('FULL_ACCESS: direct-entry tsc skips ordinary prompt, node -p demands human card', async (t) => {
  const { kinds, registry, modeRef, effects, decline } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  // Direct script entrypoint: tsc's -p is a script argument, not an eval flag.
  const ordinary = await registry.invoke('shell.execute',
    { command: 'node', args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'] });
  assert.ok(ordinary, 'tsc invocation resolves');
  assert.equal(kinds('approval.requested').filter((c) => c.payload.command?.includes('tsc')).length, 0,
    'no human card for a script-argument -p');
  // True -p before the entrypoint is still dangerous and must reach a human.
  const pending = registry.invoke('shell.execute', { command: 'node', args: ['-p', 'process.env'] }).catch((e) => e);
  await waitFor(() => kinds('approval.requested').length > 0, 60);
  const card = kinds('approval.requested').at(-1);
  assert.ok(card.payload.reasonCodes.includes('DANGEROUS_INLINE_INTERPRETER'));
  assert.equal(card.payload.risk, 'HIGH');
  decline(card);
  const settled = await pending;
  assert.ok(settled instanceof Error || settled?.ok === false);
});

test('async getWorkspaceAccessMode resolves before buildScope sets allowedPathScope=WORKSPACE on shell.execute', async (t) => {
  const { registry, approvalContexts, modeRef } = await make(t);
  modeRef.value = 'FULL_ACCESS';
  const r = await registry.invoke('shell.execute', { command: 'node', args: ['-v'] });
  assert.equal(r.ok, true);
  const ctx = [...approvalContexts.values()].at(-1);
  assert.equal(ctx?.scopeSnapshot?.allowedPathScope, 'WORKSPACE', 'resolved FULL_ACCESS string reaches async buildScope');
});
