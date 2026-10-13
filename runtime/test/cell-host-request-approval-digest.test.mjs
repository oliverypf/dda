import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor } from '../src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';
import {
  createKernelEffectAuditLog, createKernelEffectsDispatcher, kernelEffectsAvailability
} from '../src/kernel/effects.mjs';
import { approvalSubject } from '../src/kernel/cell-approval.mjs';
import { createExecutionStateStore, executionDigest } from '../src/execution-state-store.mjs';
import { createCellHost, KERNEL_CODE_CELLS_FLAG, KERNEL_WINDOWS_UNSANDBOXED_FLAG } from '../src/kernel/cell-host.mjs';

const textDigest = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

// Cell-originated host.requests use toolCallId `${cellId}::${requestId}`.
// createApproval checks executionDigest(approvalSubject(...)), which adds
// code, cellOpIndex, and hostRequest. createIntent must persist that digest.
test('cell host.request needing approval stores the approval digest and leaves non-cell digests unchanged', async () => {
  const runId = 'run-cell-approval-digest';
  const cellId = 'cell-digest-1';
  const root = await mkdtemp(join(tmpdir(), 'dda-cell-approval-digest-'));
  const store = createExecutionStateStore();
  const files = new Map();
  const failures = [];
  const saved = [];
  const workspace = {
    async read(path) {
      if (!files.has(path)) throw new Error(`WORKSPACE_NOT_FOUND:${path}`);
      const content = files.get(path);
      return { path, content, digest: textDigest(content), truncated: false };
    }
  };
  const executor = {
    async shell() { return { ok: true, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'shell', cwd: '' }; },
    async writeFile(request) {
      files.set(request.path, request.content);
      return {
        ok: true, action: 'write_file', path: request.path,
        bytesWritten: Buffer.byteLength(request.content), contentDigest: textDigest(request.content)
      };
    },
    async test() { return { ok: true, stdout: 'ok', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'test', cwd: '' }; }
  };
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const requestApproval = async ({ capability, request, context, requireApproval }) => {
    const requestDigest = executionDigest(approvalSubject({ capability, request, context }));
    try {
      const intent = await store.createIntent({
        runId, capability, request, requestDigest, operationId: `operation-${randomUUID()}`
      });
      await store.transition(intent.recordId, 'SAFETY_EVALUATING');
      const approval = await store.createApproval({
        runId, intentId: intent.recordId, capability, requestDigest, displayedDigest: requestDigest
      });
      await store.transition(approval.recordId, 'PRESENTED');
      await store.transition(intent.recordId, 'WAITING_APPROVAL');
      await store.transition(approval.recordId, 'APPROVED');
      await store.transition(intent.recordId, 'APPROVED');
      saved.push({ capability, request, context, requireApproval, intent, approval, requestDigest });
      return true;
    } catch (error) {
      failures.push(error);
      return false;
    }
  };
  const leaseProvider = createExplicitLeaseProvider({
    monitor,
    capabilities: [CAPABILITIES.WRITE_FILE],
    commands: ['node'],
    requestApproval,
    gateDecisionFor: ({ context }) => (context?.kernelEffect?.requireApproval ? { requireApproval: true } : undefined),
    onLeaseIssued: async ({ capability, request, lease, context }) => {
      const entry = saved.find((item) => item.requestDigest === executionDigest(approvalSubject({ capability, request, context })));
      await store.transition(entry.intent.recordId, 'EXECUTING');
      entry.lease = await store.createLease({
        runId,
        intentId: entry.intent.recordId,
        approvalId: entry.approval.recordId,
        capability,
        commands: lease.commands,
        expiresAt: lease.expiresAt,
        requestDigest: entry.intent.requestDigest
      });
    }
  });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, { leaseProvider, workspace });
  const env = {
    DDA_RESIDENT_KERNEL: '1',
    DDA_PLATFORM: 'linux-cli',
    DDA_KERNEL_EFFECTS: 'fs.write',
    DDA_KERNEL_APPROVAL: 'per-request'
  };
  const availability = kernelEffectsAvailability({
    env, executionMode: 'CONTROLLED', canLease: (capability) => leaseProvider.canLease(capability)
  });
  const dispatcher = createKernelEffectsDispatcher({
    availability,
    executionMode: 'CONTROLLED',
    workspaceRoot: root,
    workspace,
    invokeTool: (name, input, context) => registry.invokeInternal(name, input, context),
    canLease: (capability) => leaseProvider.canLease(capability),
    hasLiveApprover: () => true,
    audit: createKernelEffectAuditLog(),
    runId
  });
  const journalPath = join(root, 'journal.json');
  await writeFile(journalPath, JSON.stringify({ journalSchema: 1, effects: [], uncertainClears: [] }));
  const host = createCellHost({
    env: {
      DDA_RESIDENT_KERNEL: '1',
      DDA_PLATFORM: 'windows-cli',
      [KERNEL_CODE_CELLS_FLAG]: '1',
      [KERNEL_WINDOWS_UNSANDBOXED_FLAG]: '1'
    },
    platform: 'win32',
    workspaceRoot: root,
    journal: { available: true },
    effectsDispatcher: dispatcher,
    cellTimeoutMs: 10_000
  });
  try {
    const started = await host.start({ journalPath });
    assert.equal(started.ready, true, started.reason);
    const code = 'return await host.request("fs.write", { path: "notes.txt", content: "from cell\\n", expectedBaseDigest: null });';
    let cellExec;
    try {
      cellExec = await host.exec({ code, cellId });
    } catch (error) {
      cellExec = { ok: false, errorCode: error?.code, errorMessage: error?.message };
    }
    assert.equal(failures.length, 0, failures.map((error) => error?.message ?? String(error)).join('\n'));
    assert.equal(cellExec.ok, true, `${cellExec.errorCode ?? ''} ${cellExec.errorMessage ?? ''}`);
    assert.equal(cellExec.result?.approvalPath, 'LIVE_APPROVAL');
    assert.equal(files.get('notes.txt'), 'from cell\n');

    const plain = await dispatcher.dispatch({
      kind: 'fs.write',
      payload: { path: 'plain.txt', content: 'plain\n', expectedBaseDigest: null }
    }, { toolCallId: 'call-plain' });
    assert.equal(failures.length, 0, failures.map((error) => error?.message ?? String(error)).join('\n'));
    assert.equal(plain.ok, true);
    assert.equal(plain.approvalPath, 'LIVE_APPROVAL');
    assert.equal(files.get('plain.txt'), 'plain\n');

    const cell = saved.find((item) => item.context?.cellId === cellId);
    const nonCell = saved.find((item) => item.context?.toolCallId === 'call-plain');
    assert.ok(cell);
    assert.ok(nonCell);
    assert.equal(cell.requireApproval, true);
    assert.equal(nonCell.requireApproval, true);
    assert.equal(cell.context.toolCallId, `${cellId}::hr-1`);
    assert.equal(cell.context.fromCell, true);
    assert.equal(cell.context.cellApproval.cellOpIndex, 1);
    assert.equal(cell.context.cellApproval.hostRequest.kind, 'fs.write');
    const cellSubject = approvalSubject({ capability: cell.capability, request: cell.request, context: cell.context });
    assert.equal(cellSubject.cellId, undefined);
    assert.equal(cellSubject.toolCallId, undefined);
    assert.equal(cellSubject.epoch, undefined);
    const cellDigest = executionDigest(cellSubject);
    const cellPlainDigest = executionDigest({ capability: cell.capability, request: cell.request });
    assert.notEqual(cellDigest, cellPlainDigest);
    assert.equal(cell.intent.requestDigest, cellDigest);
    assert.equal(cell.approval.requestDigest, cellDigest);
    assert.equal(cell.approval.displayedDigest, cellDigest);
    assert.equal(cell.lease.requestDigest, cellDigest);
    assert.equal(cell.lease.requestDigest, cell.intent.requestDigest);

    const nonCellDigest = executionDigest({ capability: nonCell.capability, request: nonCell.request });
    assert.equal(executionDigest(approvalSubject({ capability: nonCell.capability, request: nonCell.request, context: nonCell.context })), nonCellDigest);
    assert.equal(nonCell.intent.requestDigest, nonCellDigest);
    assert.equal(nonCell.approval.requestDigest, nonCellDigest);
    assert.equal(nonCell.lease.requestDigest, nonCellDigest);
    const omitted = await store.createIntent({
      runId: 'run-non-cell-omit',
      capability: nonCell.capability,
      request: nonCell.request
    });
    assert.equal(omitted.requestDigest, nonCellDigest);
  } finally {
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
