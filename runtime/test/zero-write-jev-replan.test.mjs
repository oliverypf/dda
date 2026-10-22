import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  ZERO_WRITE_JEV_TRIGGER_CODES,
  isZeroWriteJevReplanEligible,
  isAgentMissReplanEligible,
  isSoleHardDenyFailure,
  zeroWriteJevReplanHostNote,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const zeroAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
  onReplan: (evt) => (extra.agentEvents ??= []).push(evt),
  onZeroWriteJevReplan: (evt) => (extra.zwEvents ??= []).push(evt),
  onPostMissReplan: (evt) => (extra.postEvents ??= []).push(evt),
  ...extra
});

const writesAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
  onReplan: (evt) => (extra.agentEvents ??= []).push(evt),
  onZeroWriteJevReplan: (evt) => (extra.zwEvents ??= []).push(evt),
  onPostMissReplan: (evt) => (extra.postEvents ??= []).push(evt),
  ...extra
});

// T-zw-1: writes=0 + FAIL/JEV_BEHAVIOR_REJECTED → exactly 1× zero-write replan; second still stops
test('T-zw-1: writes=0 + FAIL/JEV_BEHAVIOR_REJECTED yields exactly one zero-write replan', async () => {
  assert.equal(ZERO_WRITE_JEV_TRIGGER_CODES.has('JEV_BEHAVIOR_REJECTED'), true);
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    status: 'FAIL',
    failureCodes: ['JEV_BEHAVIOR_REJECTED']
  }), true);
  // #68 still refuses zero writes
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    failureCodes: ['JEV_BEHAVIOR_REJECTED']
  }), false);

  const bag = { agentEvents: [], zwEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: zeroAgent(bag),
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: attempt === 1 ? 'explore' : 'retry',
        actions: [{ name: 'workspace.focus', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }],
        recoverySeen: recovery?.zeroWriteJevReplan === true
      };
    },
    verify: async () => ({
      status: 'FAIL',
      summary: 'behavior rejected',
      nextAction: 'STOP_AND_REPORT',
      failureCodes: ['JEV_BEHAVIOR_REJECTED']
    })
  });

  assert.equal(bag.zwEvents.length, 1);
  assert.equal(bag.agentEvents.length, 0);
  assert.equal(bag.zwEvents[0].writesApplied, 0);
  assert.equal(bag.zwEvents[0].status, 'FAIL');
  assert.deepEqual(bag.zwEvents[0].failureCodes, ['JEV_BEHAVIOR_REJECTED']);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.zeroWriteJevReplanned, true);
  assert.equal(result.agentMissReplanned, undefined);
  // Second FAIL stops (latch already used; FAIL not recoverable)
  assert.equal(result.report.status, 'FAIL');
  assert.match(zeroWriteJevReplanHostNote(), /HOST_ZERO_WRITE_JEV_REPLAN/);
  assert.match(zeroWriteJevReplanHostNote(), /file\.write|small patch/i);
});

// T-zw-2: writes=0 + UNCERTAIN/JEV_EVIDENCE_REQUIRED → exactly 1×
test('T-zw-2: writes=0 + UNCERTAIN/JEV_EVIDENCE_REQUIRED yields exactly one zero-write replan', async () => {
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    status: 'UNCERTAIN',
    failureCodes: [JEV_EVIDENCE_REQUIRED]
  }), true);

  const bag = { agentEvents: [], zwEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: zeroAgent(bag),
    execute: async () => {
      executions += 1;
      return {
        text: 'probe',
        actions: [{ name: 'test.execute', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(executions).padStart(64, 'b')}` }]
      };
    },
    verify: async () => ({
      status: 'UNCERTAIN',
      summary: 'Deterministic checks passed but Jev requires more evidence',
      nextAction: 'REQUEST_EVIDENCE',
      failureCodes: [JEV_EVIDENCE_REQUIRED]
    })
  });

  assert.equal(bag.zwEvents.length, 1);
  assert.equal(bag.agentEvents.length, 0);
  assert.equal(bag.zwEvents[0].status, 'UNCERTAIN');
  assert.deepEqual(bag.zwEvents[0].failureCodes, [JEV_EVIDENCE_REQUIRED]);
  // Latch fires once → bonus attempt → second UNCERTAIN stops (latch used; maxAttempts exhausted)
  assert.equal(executions, 2);
  assert.equal(result.zeroWriteJevReplanned, true);
  assert.equal(result.agentMissReplanned, undefined);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-zw-3: writes≥1 + same codes → zero-write latch 0× (still walks #68)
test('T-zw-3: writes≥1 + Jev codes does not fire zero-write latch (stays on #68)', async () => {
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    status: 'FAIL',
    failureCodes: ['JEV_BEHAVIOR_REJECTED']
  }), false);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED']
  }), true);

  const bag = { agentEvents: [], zwEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: `w${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'c')}` }]
      };
    },
    verify: async () => ({
      status: 'FAIL',
      summary: 'behavior rejected',
      nextAction: 'STOP_AND_REPORT',
      failureCodes: ['JEV_BEHAVIOR_REJECTED']
    })
  });

  assert.equal(bag.zwEvents.length, 0);
  assert.equal(bag.agentEvents.length, 1);
  assert.equal(result.zeroWriteJevReplanned, undefined);
  assert.equal(result.agentMissReplanned, true);
  // #68 then #74 post-agent-miss-terminal may each add one bonus → 3 execs; zw stays 0×.
  assert.ok(executions >= 2);
  assert.equal(result.report.status, 'FAIL');
});

// T-zw-4: sole SAFETY/lease DENY → 0×
test('T-zw-4: sole SAFETY/lease DENY never fires zero-write latch', async () => {
  assert.equal(isSoleHardDenyFailure(['SAFETY_COMMAND_NOT_ALLOWED']), true);
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    status: 'FAIL',
    failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED']
  }), false);
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    status: 'UNCERTAIN',
    failureCodes: ['HARD_DECISION_DENY']
  }), false);
  assert.equal(isZeroWriteJevReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    status: 'FAIL',
    failureCodes: ['LEASE_DENIED']
  }), false);

  for (const status of ['FAIL', 'UNCERTAIN']) {
    const bag = { agentEvents: [], zwEvents: [] };
    let executions = 0;
    const result = await runVerifierRecovery({
      maxAttempts: 2,
      agentMiss: zeroAgent(bag),
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
    assert.equal(bag.zwEvents.length, 0, `status=${status}`);
    assert.equal(bag.agentEvents.length, 0, `status=${status}`);
    assert.equal(result.zeroWriteJevReplanned, undefined, `status=${status}`);
    assert.equal(result.ok, false, `status=${status}`);
    if (status === 'FAIL') {
      assert.equal(executions, 1, `status=${status}`);
      assert.equal(result.report.status, 'FAIL', `status=${status}`);
    } else {
      assert.equal(executions, 2, `status=${status}`);
      assert.equal(result.exhausted, true, `status=${status}`);
    }
  }
});
