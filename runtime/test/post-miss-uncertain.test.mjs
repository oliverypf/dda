import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  isPostMissUncertainReplanEligible,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const writesAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
  onReplan: (evt) => (extra.agentEvents ??= []).push(evt),
  onPostMissReplan: (evt) => (extra.postEvents ??= []).push(evt),
  ...extra
});

// T-pm-1: #68 already latched + UNCERTAIN+JEV_EVIDENCE+writes → exactly 1× post-miss; third still stops
test('T-pm-1: after agent-miss latch, UNCERTAIN+JEV_EVIDENCE+writes yields exactly one post-miss replan', async () => {
  assert.equal(isPostMissUncertainReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    agentMissAlreadyReplanned: true,
    postMissAlreadyReplanned: false
  }), true);

  const bag = { agentEvents: [], postEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: `a${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        sawPostMiss: recovery?.postMissUncertainReplan === true,
        sawAgentMiss: recovery?.agentMissReplan === true
      };
    },
    verify: async () => ({
      status: 'UNCERTAIN',
      summary: 'Deterministic checks passed but Jev requires more evidence',
      nextAction: 'REQUEST_EVIDENCE',
      failureCodes: [JEV_EVIDENCE_REQUIRED]
    })
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.postEvents[0].status, 'UNCERTAIN');
  assert.equal(bag.postEvents[0].priorAgentMissReplan, true);
  assert.deepEqual(bag.postEvents[0].failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.equal(executions, 3);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postMissUncertainReplanned, true);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-pm-2: without prior agent-miss → post-miss 0× (must not skip #68)
test('T-pm-2: without prior agent-miss, post-miss latch never fires alone', async () => {
  assert.equal(isPostMissUncertainReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    agentMissAlreadyReplanned: false,
    postMissAlreadyReplanned: false
  }), false);

  // Force agent-miss ineligible by zero writes while keeping UNCERTAIN+code —
  // then even with maxAttempts budget, post-miss must stay 0 because #68 never latched.
  const bag = { agentEvents: [], postEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 2,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
      onReplan: (evt) => bag.agentEvents.push(evt),
      onPostMissReplan: (evt) => bag.postEvents.push(evt)
    },
    execute: async () => {
      executions += 1;
      return { text: 'probe', actions: [{ name: 'workspace.focus', state: 'SUCCEEDED', argumentsDigest: `sha256:${'c'.repeat(64)}` }] };
    },
    verify: async () => ({
      status: 'UNCERTAIN',
      failureCodes: [JEV_EVIDENCE_REQUIRED],
      nextAction: 'REQUEST_EVIDENCE'
    })
  });

  assert.equal(bag.agentEvents.length, 0);
  assert.equal(bag.postEvents.length, 0);
  assert.equal(result.agentMissReplanned, undefined);
  assert.equal(result.postMissUncertainReplanned, undefined);
  assert.equal(result.report.status, 'UNCERTAIN');
  assert.equal(executions, 2);
});

// T-pm-3: after post-miss, still UNCERTAIN → 0× third
test('T-pm-3: after post-miss latch, a third UNCERTAIN does not replan again', async () => {
  assert.equal(isPostMissUncertainReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    agentMissAlreadyReplanned: true,
    postMissAlreadyReplanned: true
  }), false);

  const bag = { agentEvents: [], postEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async () => {
      executions += 1;
      return {
        text: 'x',
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(executions).padStart(64, 'd')}` }]
      };
    },
    verify: async () => ({
      status: 'UNCERTAIN',
      failureCodes: [JEV_EVIDENCE_REQUIRED],
      nextAction: 'REQUEST_EVIDENCE'
    })
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(executions, 3);
  assert.equal(result.postMissUncertainReplanned, true);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-pm-4: FAIL / STALLED / 0 writes / sole SAFETY → 0× post-miss
test('T-pm-4: FAIL/STALLED/0-write/sole SAFETY never fire post-miss latch', async () => {
  // FAIL after #68 agent-miss (FAIL triggers #68 first): second FAIL must NOT post-miss
  {
    const bag = { agentEvents: [], postEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `f${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'e')}` }]
      }),
      verify: async () => ({
        status: 'FAIL',
        failureCodes: ['JEV_BEHAVIOR_REJECTED'],
        nextAction: 'STOP_AND_REPORT'
      })
    });
    assert.equal(bag.agentEvents.length, 1);
    assert.equal(bag.postEvents.length, 0);
    assert.equal(result.agentMissReplanned, true);
    assert.equal(result.postMissUncertainReplanned, undefined);
    assert.equal(result.report.status, 'FAIL');
  }

  // STALLED similarly
  {
    const bag = { agentEvents: [], postEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `s${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'f')}` }]
      }),
      verify: async () => ({
        status: 'STALLED',
        failureCodes: ['REPEATED_ACTION'],
        nextAction: 'STOP_AND_REPORT'
      })
    });
    assert.equal(bag.agentEvents.length, 1);
    assert.equal(bag.postEvents.length, 0);
    assert.equal(result.postMissUncertainReplanned, undefined);
  }

  // 0 writes: neither latch
  {
    const bag = { agentEvents: [], postEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 2,
      agentMiss: {
        getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
        onReplan: (e) => bag.agentEvents.push(e),
        onPostMissReplan: (e) => bag.postEvents.push(e)
      },
      execute: async () => ({ text: 'z', actions: [] }),
      verify: async () => ({
        status: 'UNCERTAIN',
        failureCodes: [JEV_EVIDENCE_REQUIRED],
        nextAction: 'REQUEST_EVIDENCE'
      })
    });
    assert.equal(bag.agentEvents.length, 0);
    assert.equal(bag.postEvents.length, 0);
    assert.equal(result.postMissUncertainReplanned, undefined);
  }

  // sole SAFETY on UNCERTAIN
  {
    const bag = { agentEvents: [], postEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 2,
      agentMiss: writesAgent(bag),
      execute: async () => ({ text: 'safe', actions: [] }),
      verify: async () => ({
        status: 'UNCERTAIN',
        failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED'],
        nextAction: 'STOP_AND_REPORT'
      })
    });
    assert.equal(bag.agentEvents.length, 0);
    assert.equal(bag.postEvents.length, 0);
  }
});
