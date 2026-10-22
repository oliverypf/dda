import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFLIGHT_REQUIRE_WRITE_MAX_PER_RUN,
  isPreflightRequireWriteEligible,
  resolveRequiresWorkspaceMutation,
  preflightRequireWriteHostNote,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const zeroAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
  ...extra
});

const writesAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
  ...extra
});

test('resolveRequiresWorkspaceMutation: explicit / task / env; absent fail-open false', () => {
  assert.equal(resolveRequiresWorkspaceMutation({}), false);
  assert.equal(resolveRequiresWorkspaceMutation({ envValue: '' }), false);
  assert.equal(resolveRequiresWorkspaceMutation({ envValue: 'maybe' }), false);
  assert.equal(resolveRequiresWorkspaceMutation({ envValue: '1' }), true);
  assert.equal(resolveRequiresWorkspaceMutation({ envValue: 'true' }), true);
  assert.equal(resolveRequiresWorkspaceMutation({ envValue: 'yes' }), true);
  assert.equal(resolveRequiresWorkspaceMutation({ explicit: true }), true);
  assert.equal(resolveRequiresWorkspaceMutation({ explicit: false, envValue: '1' }), false);
  assert.equal(resolveRequiresWorkspaceMutation({ task: { requiresWorkspaceMutation: true } }), true);
  assert.equal(resolveRequiresWorkspaceMutation({ task: { requiresWorkspaceMutation: false }, envValue: '1' }), false);
  // lease alone is never consulted — no lease arg exists on purpose
});

test('bound choice documented: ≤2× per run', () => {
  assert.equal(PREFLIGHT_REQUIRE_WRITE_MAX_PER_RUN, 2);
});

// T-pw-1: requiresWorkspaceMutation + 0 write + about VERIFY → intercept ≥1×, note mentions write
test('T-pw-1: requiresWorkspaceMutation + 0 write + about VERIFY → intercept ≥1×, note mentions write', async () => {
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 0
  }), true);
  assert.match(preflightRequireWriteHostNote(), /HOST_PREFLIGHT_REQUIRE_WRITE/);
  assert.match(preflightRequireWriteHostNote(), /file\.write|small patch/i);

  const bag = { intercepts: [] };
  let executions = 0;
  let verifies = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    preflight: {
      requiresWorkspaceMutation: true,
      getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
      onIntercept: (evt) => bag.intercepts.push(evt)
    },
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      // After first intercept, still 0 writes → may intercept again; then verify.
      return {
        text: `explore-${attempt}`,
        actions: [{ name: 'workspace.list', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }],
        recoverySeen: recovery?.preflightRequireWrite === true
      };
    },
    verify: async () => {
      verifies += 1;
      return {
        status: 'FAIL',
        summary: 'behavior rejected',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['JEV_BEHAVIOR_REJECTED']
      };
    }
  });

  assert.ok(bag.intercepts.length >= 1, `expected ≥1 intercept, got ${bag.intercepts.length}`);
  assert.equal(bag.intercepts[0].writesApplied, 0);
  assert.equal(bag.intercepts[0].interceptOrdinal, 1);
  assert.ok(executions >= 2, 'must re-execute after intercept');
  assert.ok(verifies >= 1, 'eventually allows VERIFY after bound or still-zero path');
  assert.ok(Number(result.preflightRequireWriteIntercepts) >= 1);
  assert.equal(result.ok, false);
});

// T-pw-2: writes≥1 → 0×
test('T-pw-2: writes≥1 → 0× intercept', async () => {
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 2,
    successfulWrites: 2,
    interceptsUsed: 0
  }), false);

  const bag = { intercepts: [] };
  let verifies = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    preflight: {
      requiresWorkspaceMutation: true,
      ...writesAgent(),
      onIntercept: (evt) => bag.intercepts.push(evt)
    },
    execute: async () => ({
      text: 'patched',
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${'c'.repeat(64)}` }]
    }),
    verify: async () => {
      verifies += 1;
      return { status: 'PASS', summary: 'ok', nextAction: 'COMPLETE', failureCodes: [] };
    }
  });

  assert.equal(bag.intercepts.length, 0);
  assert.equal(verifies, 1);
  assert.equal(result.ok, true);
  assert.equal(result.preflightRequireWriteIntercepts, undefined);
});

// T-pw-3: no marker / read-only → 0× fail-open
test('T-pw-3: no marker / read-only → 0× fail-open', async () => {
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: false,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 0
  }), false);
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: undefined,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 0
  }), false);

  for (const preflight of [
    undefined,
    { requiresWorkspaceMutation: false, ...zeroAgent(), onIntercept: () => assert.fail('must not intercept') },
    { getRequiresWorkspaceMutation: () => false, ...zeroAgent(), onIntercept: () => assert.fail('must not intercept') }
  ]) {
    let verifies = 0;
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      preflight,
      execute: async () => ({
        text: 'read-only',
        actions: [{ name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: `sha256:${'d'.repeat(64)}` }]
      }),
      verify: async () => {
        verifies += 1;
        return { status: 'PASS', summary: 'ok', nextAction: 'COMPLETE', failureCodes: [] };
      }
    });
    assert.equal(verifies, 1);
    assert.equal(result.ok, true);
    assert.equal(result.preflightRequireWriteIntercepts, undefined);
  }
});

// T-pw-4: intercepts exhausted → allow VERIFY
test('T-pw-4: intercepts exhausted → allow VERIFY (can reach #80)', async () => {
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 2,
    maxIntercepts: 2
  }), false);
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 1,
    maxIntercepts: 2
  }), true);

  const bag = { intercepts: [] };
  let verifies = 0;
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    preflight: {
      requiresWorkspaceMutation: true,
      getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
      onIntercept: (evt) => bag.intercepts.push(evt)
    },
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: `still-zero-${attempt}`,
        actions: [{ name: 'test.execute', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'e')}` }]
      };
    },
    verify: async () => {
      verifies += 1;
      return {
        status: 'FAIL',
        summary: 'behavior rejected after empty explore',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['JEV_BEHAVIOR_REJECTED']
      };
    }
  });

  assert.equal(bag.intercepts.length, PREFLIGHT_REQUIRE_WRITE_MAX_PER_RUN);
  assert.equal(bag.intercepts[0].interceptOrdinal, 1);
  assert.equal(bag.intercepts[1].interceptOrdinal, 2);
  assert.equal(verifies, 1, 'VERIFY allowed exactly once after bound exhausted');
  assert.equal(executions, PREFLIGHT_REQUIRE_WRITE_MAX_PER_RUN + 1);
  assert.equal(result.preflightRequireWriteIntercepts, 2);
  assert.equal(result.report.status, 'FAIL');
  // #80 path remains available independently (zero-write latch can still fire post-verify)
});

test('T-pw sole SAFETY/lease DENY from execute result → 0×', () => {
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 0,
    result: {
      actions: [{ name: 'shell.execute', state: 'FAILED', errorCode: 'SAFETY_COMMAND_NOT_ALLOWED' }]
    }
  }), false);
  assert.equal(isPreflightRequireWriteEligible({
    requiresWorkspaceMutation: true,
    writesApplied: 0,
    successfulWrites: 0,
    interceptsUsed: 0,
    failureCodes: ['HARD_DECISION_DENY']
  }), false);
});
