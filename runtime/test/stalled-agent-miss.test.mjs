import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isAgentMissReplanEligible,
  isSoleHardDenyFailure,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

// T-sm-1: writes≥1 + STALLED + REPEATED_ACTION → exactly 1 replan; second still stops
test('T-sm-1: successfulWrites≥1 + STALLED + REPEATED_ACTION yields exactly one agent_miss replan', async () => {
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 2, successfulWrites: 2, failureCodes: ['REPEATED_ACTION']
  }), true);

  const replanEvents = [];
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
      onReplan: (evt) => replanEvents.push(evt)
    },
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: attempt === 1 ? 'partial' : 'retry',
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        recoverySeen: recovery?.agentMissReplan === true
      };
    },
    verify: async () => ({
      status: 'STALLED',
      summary: 'verifier stalled on duplicates',
      nextAction: 'STOP_AND_REPORT',
      failureCodes: ['REPEATED_ACTION']
    })
  });

  assert.equal(replanEvents.length, 1);
  assert.equal(replanEvents[0].writesApplied, 2);
  assert.equal(replanEvents[0].status, 'STALLED');
  assert.deepEqual(replanEvents[0].failureCodes, ['REPEATED_ACTION']);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.agentMissReplanned, true);
  // Second STALLED must not replan again; latch holds.
  assert.equal(result.report.status, 'STALLED');
  assert.ok(result.history.some((h) => h.status === 'STALLED'));
});

// T-sm-2: FAIL path still exactly 1 (#64 regress)
test('T-sm-2: FAIL + REPEATED_ACTION still yields exactly one agent_miss replan', async () => {
  const replanEvents = [];
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 3, successfulWrites: 3 }),
      onReplan: (evt) => replanEvents.push(evt)
    },
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: attempt === 1 ? 'partial' : 'retry',
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }]
      };
    },
    verify: async () => ({
      status: 'FAIL',
      summary: 'duplicates',
      nextAction: 'STOP_AND_REPORT',
      failureCodes: ['REPEATED_ACTION', 'JEV_BEHAVIOR_REJECTED']
    })
  });

  assert.equal(replanEvents.length, 1);
  assert.equal(replanEvents[0].status, 'FAIL');
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.report.status, 'FAIL');
});

// T-sm-3: writes=0 + STALLED + REPEATED_ACTION → 0 replan
test('T-sm-3: writes=0 + STALLED + REPEATED_ACTION does not agent-miss replan', async () => {
  const replanEvents = [];
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 2,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
      onReplan: (evt) => replanEvents.push(evt)
    },
    execute: async () => {
      executions += 1;
      return { text: 'probe', actions: [{ name: 'workspace.focus', state: 'SUCCEEDED', argumentsDigest: `sha256:${'b'.repeat(64)}` }] };
    },
    verify: async () => ({
      status: 'STALLED',
      summary: 'stalled without writes',
      nextAction: 'REQUEST_EVIDENCE',
      failureCodes: ['REPEATED_ACTION']
    })
  });

  assert.equal(replanEvents.length, 0);
  // STALLED remains recoverable without agent-miss bonus — runs to maxAttempts.
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.report.status, 'STALLED');
  assert.equal(result.agentMissReplanned, undefined);
});

// T-sm-4: sole SAFETY/lease DENY → 0 (both FAIL and STALLED)
test('T-sm-4: sole SAFETY/lease DENY never agent-miss replans on FAIL or STALLED', async () => {
  assert.equal(isSoleHardDenyFailure(['SAFETY_COMMAND_NOT_ALLOWED']), true);
  assert.equal(isSoleHardDenyFailure(['LEASE_CAPABILITY_DENIED']), true);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 5, failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED']
  }), false);

  for (const status of ['FAIL', 'STALLED']) {
    const replanEvents = [];
    let executions = 0;
    const result = await runVerifierRecovery({
      maxAttempts: 2,
      agentMiss: {
        getWriteCounts: () => ({ writesApplied: 5, successfulWrites: 5 }),
        onReplan: (evt) => replanEvents.push(evt)
      },
      execute: async () => {
        executions += 1;
        return { text: 'x', actions: [] };
      },
      verify: async () => ({
        status,
        failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED'],
        nextAction: 'STOP_AND_REPORT'
      })
    });
    assert.equal(replanEvents.length, 0, `status=${status}`);
    assert.equal(result.ok, false, `status=${status}`);
    if (status === 'FAIL') {
      // FAIL is not recoverable → stop on first attempt.
      assert.equal(executions, 1, `status=${status}`);
      assert.equal(result.attempts, 1, `status=${status}`);
    } else {
      // STALLED is recoverable but not agent-miss eligible → exhaust maxAttempts.
      assert.equal(executions, 2, `status=${status}`);
      assert.equal(result.exhausted, true, `status=${status}`);
    }
  }

  // Lease-flavored sole deny on STALLED likewise never replans.
  const leaseEvents = [];
  const leaseResult = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 4, successfulWrites: 4 }),
      onReplan: (evt) => leaseEvents.push(evt)
    },
    execute: async () => ({ text: 'x', actions: [] }),
    verify: async () => ({
      status: 'STALLED',
      failureCodes: ['CAPABILITY_NOT_LEASED'],
      nextAction: 'STOP_AND_REPORT'
    })
  });
  assert.equal(leaseEvents.length, 0);
  assert.equal(leaseResult.ok, false);
  assert.equal(leaseResult.agentMissReplanned, undefined);
});
