import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  EXECUTION_MODES,
  RuntimeSafetyMonitor
} from '../src/safety-executor.mjs';
import {
  createExplicitLeaseProvider,
  registerExecutorTools,
  resolveApprovalOutcome,
  verifierStateRequiresReapproval,
  REAPPROVAL_VERIFIER_STATUSES,
  APPROVAL_OUTCOMES
} from '../src/controlled-tools.mjs';
import { ToolRegistry } from '../src/tool-registry.mjs';

// A verifier that cannot vouch for the result (UNCERTAIN) or reports stalled
// progress (STALLED) must freeze further side effects behind a re-approval; a
// healthy continuation (PASS/CONTINUE) or a hard failure (FAIL) must not.
test('only an uncertain or stalled verifier verdict arms re-approval', () => {
  assert.equal(verifierStateRequiresReapproval({ status: 'UNCERTAIN' }), true);
  assert.equal(verifierStateRequiresReapproval({ status: 'STALLED' }), true);
  assert.equal(verifierStateRequiresReapproval({ status: 'uncertain' }), true);
  assert.equal(verifierStateRequiresReapproval({ status: 'PASS' }), false);
  assert.equal(verifierStateRequiresReapproval({ status: 'CONTINUE' }), false);
  assert.equal(verifierStateRequiresReapproval({ status: 'FAIL' }), false);
  assert.equal(verifierStateRequiresReapproval({}), false);
  assert.deepEqual([...REAPPROVAL_VERIFIER_STATUSES].sort(), ['STALLED', 'UNCERTAIN']);
});

// Mirror the host approval path exactly as PR #15 does: prompt/refuse/auto-approve
// flows through the same shared policy the runtime uses.
const hostApproval = ({ hasLiveApprover, userDecision = true }) => {
  const calls = [];
  const requestApproval = async ({ capability, requireApproval, risk }) => {
    calls.push({ capability, requireApproval, risk });
    const outcome = resolveApprovalOutcome({ requireApproval, hasLiveApprover });
    if (outcome === APPROVAL_OUTCOMES.REFUSE) return false;
    if (outcome === APPROVAL_OUTCOMES.AUTO_APPROVE) return true;
    return userDecision;
  };
  return { requestApproval, calls };
};

// Build the same run-level gate the runtime wires: a verifier verdict arms a
// flag, and while armed the lease provider requires an explicit approval for
// the next side-effecting action regardless of the per-call Jev gate.
const controlledRegistry = async ({ requestApproval, verifierStatus }) => {
  const reapproval = { active: verifierStateRequiresReapproval({ status: verifierStatus }) };
  const gateDecisionFor = () => (reapproval.active ? { requireApproval: true } : undefined);
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-verifier-reapproval-'));
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const effects = [];
  const executor = {
    async shell() { effects.push('shell'); return { ok: true, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'shell', cwd: '' }; },
    async writeFile() { effects.push('write'); return { ok: true, action: 'write_file', path: 'x', bytesWritten: 1, contentDigest: 'sha256:' + '0'.repeat(64) }; },
    async test() { effects.push('test'); return { ok: true, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, action: 'test', cwd: '' }; }
  };
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, executor, {
    leaseProvider: createExplicitLeaseProvider({
      monitor,
      capabilities: [CAPABILITIES.SHELL],
      commands: ['node'],
      requestApproval,
      gateDecisionFor
    })
  });
  return { registry, effects, reapproval };
};

test('an uncertain verdict refuses the next side effect when no live user can answer', async () => {
  const { requestApproval, calls } = hostApproval({ hasLiveApprover: false });
  const { registry, effects } = await controlledRegistry({ requestApproval, verifierStatus: 'UNCERTAIN' });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, { toolCallId: 'call-a', argumentsDigest: 'digest-a' }),
    /SAFETY_LEASE_REQUIRED/
  );
  assert.deepEqual(effects, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requireApproval, true);
});

test('a stalled verdict prompts a live user before the next side effect and runs it on approval', async () => {
  const { requestApproval, calls } = hostApproval({ hasLiveApprover: true, userDecision: true });
  const { registry, effects } = await controlledRegistry({ requestApproval, verifierStatus: 'STALLED' });
  const result = await registry.invoke('shell.execute', { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, { toolCallId: 'call-b', argumentsDigest: 'digest-b' });
  assert.equal(result.ok, true);
  assert.deepEqual(effects, ['shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requireApproval, true);
});

test('an uncertain verdict a live user declines runs no effect', async () => {
  const { requestApproval } = hostApproval({ hasLiveApprover: true, userDecision: false });
  const { registry, effects } = await controlledRegistry({ requestApproval, verifierStatus: 'UNCERTAIN' });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, { toolCallId: 'call-c', argumentsDigest: 'digest-c' }),
    /SAFETY_LEASE_REQUIRED/
  );
  assert.deepEqual(effects, []);
});

test('a re-armed gate still fails closed when no approval mechanism exists at all', async () => {
  const { registry, effects } = await controlledRegistry({ requestApproval: undefined, verifierStatus: 'UNCERTAIN' });
  await assert.rejects(
    registry.invoke('shell.execute', { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, { toolCallId: 'call-d', argumentsDigest: 'digest-d' }),
    /SAFETY_LEASE_REQUIRED/
  );
  assert.deepEqual(effects, []);
});

test('a passing verdict keeps the prior host-policy auto-approval for a safe pre-set action', async () => {
  const { requestApproval, calls } = hostApproval({ hasLiveApprover: false });
  const { registry, effects } = await controlledRegistry({ requestApproval, verifierStatus: 'PASS' });
  const result = await registry.invoke('shell.execute', { command: 'node', args: ['-e', 'process.stdout.write("ok")'] }, { toolCallId: 'call-e', argumentsDigest: 'digest-e' });
  assert.equal(result.ok, true);
  assert.deepEqual(effects, ['shell']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requireApproval, false, 'a safe action after a clean verification must not be forced into approval');
});
