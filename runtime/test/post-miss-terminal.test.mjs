import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  isPostMissTerminalReplanEligible,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const writesAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
  onReplan: (evt) => (extra.agentEvents ??= []).push(evt),
  onPostMissReplan: (evt) => (extra.postEvents ??= []).push(evt),
  onPostMissTerminalReplan: (evt) => (extra.terminalEvents ??= []).push(evt),
  onPostMissEvidenceDeltaReplan: (evt) => (extra.deltaEvents ??= []).push(evt),
  onPostMissUncertainExhaustedReplan: (evt) => (extra.exhaustedEvents ??= []).push(evt),
  ...extra
});

// Sequence helper: UNCERTAIN, UNCERTAIN, then terminal statuses
const sequencedVerify = (statuses) => {
  let i = 0;
  return async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    if (status === 'UNCERTAIN') {
      return {
        status: 'UNCERTAIN',
        summary: 'Deterministic checks passed but Jev requires more evidence',
        nextAction: 'REQUEST_EVIDENCE',
        failureCodes: [JEV_EVIDENCE_REQUIRED]
      };
    }
    if (status === 'FAIL') {
      return {
        status: 'FAIL',
        summary: 'behavior rejected',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['JEV_BEHAVIOR_REJECTED', 'ACTION_FAILED', 'REPEATED_ACTION']
      };
    }
    if (status === 'STALLED') {
      return {
        status: 'STALLED',
        summary: 'repeated action',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['REPEATED_ACTION']
      };
    }
    return { status, failureCodes: [], nextAction: 'STOP_AND_REPORT' };
  };
};

// T-pt-1: #68+#69 (UNCERTAIN×2) then FAIL+writes → exactly 1× terminal; third FAIL stops
test('T-pt-1: after #68+#69 UNCERTAIN latches, FAIL+writes yields exactly one terminal replan', async () => {
  assert.equal(isPostMissTerminalReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    postMissUncertainAlreadyReplanned: true,
    postMissTerminalAlreadyReplanned: false
  }), true);

  const bag = { agentEvents: [], postEvents: [], terminalEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: `a${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        sawTerminal: recovery?.postMissTerminalReplan === true,
        sawPostMiss: recovery?.postMissUncertainReplan === true,
        sawAgentMiss: recovery?.agentMissReplan === true
      };
    },
    // UNCERTAIN → #68; UNCERTAIN → #69; FAIL → terminal; FAIL → stop
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 1);
  assert.equal(bag.terminalEvents[0].status, 'FAIL');
  assert.equal(bag.terminalEvents[0].priorPostMissUncertainReplan, true);
  assert.ok(bag.terminalEvents[0].failureCodes.includes('JEV_BEHAVIOR_REJECTED'));
  assert.equal(executions, 4);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 4);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postMissUncertainReplanned, true);
  assert.equal(result.postMissTerminalReplanned, true);
  assert.equal(result.report.status, 'FAIL');
});

// T-pt-2: same path but STALLED
test('T-pt-2: after #68+#69, STALLED+writes yields exactly one terminal replan', async () => {
  const bag = { agentEvents: [], postEvents: [], terminalEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: `s${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }]
      };
    },
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'STALLED', 'STALLED'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 1);
  assert.equal(bag.terminalEvents[0].status, 'STALLED');
  assert.equal(bag.terminalEvents[0].priorPostMissUncertainReplan, true);
  assert.equal(executions, 4);
  assert.equal(result.postMissTerminalReplanned, true);
  assert.equal(result.report.status, 'STALLED');
});

// T-pt-3: no post-miss → 0× terminal; pure UNCERTAIN after both → 0× terminal
test('T-pt-3: without post-miss, terminal latch never fires; pure UNCERTAIN after both stays 0× terminal', async () => {
  assert.equal(isPostMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['FAIL'],
    postMissUncertainAlreadyReplanned: false,
    postMissTerminalAlreadyReplanned: false
  }), false);

  // Path A: FAIL after #68 only (no #69) — terminal must not fire
  {
    const bag = { agentEvents: [], postEvents: [], terminalEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `f${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'b')}` }]
      }),
      // FAIL → #68; FAIL → stop (no UNCERTAIN so no #69; terminal needs #69)
      verify: sequencedVerify(['FAIL', 'FAIL'])
    });
    assert.equal(bag.agentEvents.length, 1);
    assert.equal(bag.postEvents.length, 0);
    assert.equal(bag.terminalEvents.length, 0);
    assert.equal(result.postMissTerminalReplanned, undefined);
    assert.equal(result.report.status, 'FAIL');
  }

  // Path B: pure UNCERTAIN after #68+#69 — terminal never for UNCERTAIN;
  // evidence-delta + uncertain-exhausted may fire once each on write-delta=0, still 0× terminal.
  {
    const bag = { agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `u${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'c')}` }]
      }),
      verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
    });
    assert.equal(bag.agentEvents.length, 1);
    assert.equal(bag.postEvents.length, 1);
    assert.equal(bag.terminalEvents.length, 0);
    assert.equal(bag.deltaEvents.length, 1);
    assert.equal(bag.exhaustedEvents.length, 1);
    assert.equal(result.postMissUncertainReplanned, true);
    assert.equal(result.postMissEvidenceDeltaReplanned, true);
    assert.equal(result.postMissUncertainExhaustedReplanned, true);
    assert.equal(result.postMissTerminalReplanned, undefined);
    assert.equal(result.report.status, 'UNCERTAIN');
  }
});

// T-pt-4: after terminal, another FAIL/STALLED → 0× second
test('T-pt-4: after terminal latch, a second FAIL/STALLED does not replan again', async () => {
  assert.equal(isPostMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['REPEATED_ACTION'],
    postMissUncertainAlreadyReplanned: true,
    postMissTerminalAlreadyReplanned: true
  }), false);

  const bag = { agentEvents: [], postEvents: [], terminalEvents: [] };
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
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'FAIL', 'FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 1);
  assert.equal(executions, 4);
  assert.equal(result.postMissTerminalReplanned, true);
  assert.equal(result.report.status, 'FAIL');
});
