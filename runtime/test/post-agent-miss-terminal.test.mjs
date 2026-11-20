import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  agentMissReplanHostNote,
  isPostMissTerminalReplanEligible,
  postMissTerminalReplanHostNote,
  postMissUncertainReplanHostNote,
  recoveryContinuationText,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const writesAgent = (extra = {}) => ({
  getWriteCounts: () => ({ writesApplied: 2, successfulWrites: 2 }),
  onReplan: (evt) => (extra.agentEvents ??= []).push(evt),
  onPostMissReplan: (evt) => (extra.postEvents ??= []).push(evt),
  onPostMissTerminalReplan: (evt) => (extra.terminalEvents ??= []).push(evt),
  onPostAgentMissTerminalReplan: (evt) => (extra.amtEvents ??= []).push(evt),
  onPostMissEvidenceDeltaReplan: (evt) => (extra.deltaEvents ??= []).push(evt),
  onPostMissUncertainExhaustedReplan: (evt) => (extra.exhaustedEvents ??= []).push(evt),
  ...extra
});

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

// T-amt-1: #68 + FAIL/STALLED with no #69 → stop after the second attempt.
// User decision 2026-11-05: the retry budget is two executions; a second terminal
// verification ends the run instead of granting a terminal replan.
test('T-amt-1: after #68 without #69, second FAIL stops — no terminal replan', async () => {

  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: `a${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        sawAgentMiss: recovery?.agentMissReplan === true
      };
    },
    // UNCERTAIN → #68; FAIL → stop (no terminal replan, no third attempt)
    verify: sequencedVerify(['UNCERTAIN', 'FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 0);
  assert.equal(bag.terminalEvents.length, 0);
  assert.equal(bag.amtEvents.length, 0, 'no third attempt: two executions then stop');
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postMissUncertainReplanned, undefined);
  assert.equal(result.postMissTerminalReplanned, undefined);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'FAIL');
  assert.deepEqual(result.history.map((item) => item.status), ['UNCERTAIN', 'FAIL']);

  // STALLED variant
  {
    const bag2 = {
      agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: []
    };
    const r2 = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag2),
      execute: async ({ attempt }) => ({
        text: `s${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }]
      }),
      verify: sequencedVerify(['UNCERTAIN', 'STALLED', 'STALLED'])
    });
    assert.equal(bag2.amtEvents.length, 0, 'no third attempt on STALLED either');
    assert.equal(bag2.terminalEvents.length, 0);
    assert.equal(r2.attempts, 2);
    assert.equal(r2.postAgentMissTerminalReplanned, undefined);
    assert.equal(r2.report.status, 'STALLED');
  }
});

// T-amt-2: #69 already + FAIL → no double-fire with this path (still #70 ≤1)
test('T-amt-2: after #69, FAIL fires #70 only — no terminal replan path remains', async () => {
  assert.equal(isPostMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    postMissUncertainAlreadyReplanned: true,
    postMissTerminalAlreadyReplanned: false
  }), true);

  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `t${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'b')}` }]
    }),
    // #68 → #69 → #70 → stop
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 1);
  assert.equal(bag.amtEvents.length, 0);
  assert.equal(result.postMissTerminalReplanned, true);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'FAIL');
});

// T-amt-3: UNCERTAIN → no fire this latch
test('T-amt-3: UNCERTAIN after #68 does not fire post-agent-miss terminal', async () => {
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `u${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'c')}` }]
    }),
    // All UNCERTAIN → #68 → #69 → ed → exhausted; never amt
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.amtEvents.length, 0);
  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-amt-4: no #68 → no fire (the terminal latch no longer exists; kept as a
// never-fires guard for the two-executions budget).
test('T-amt-4: without #68, no terminal replan ever fires', async () => {
  // Force zero writes so #68 itself cannot fire; FAIL stays FAIL.
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: []
  };
  const result = await runVerifierRecovery({
    maxAttempts: 2,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 0, successfulWrites: 0 }),
      onReplan: (evt) => bag.agentEvents.push(evt),
      onPostMissReplan: (evt) => bag.postEvents.push(evt),
      onPostMissTerminalReplan: (evt) => bag.terminalEvents.push(evt),
      onPostAgentMissTerminalReplan: (evt) => bag.amtEvents.push(evt)
    },
    execute: async ({ attempt }) => ({
      text: `z${attempt}`,
      actions: []
    }),
    verify: sequencedVerify(['FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 0);
  assert.equal(bag.amtEvents.length, 0);
  assert.equal(result.agentMissReplanned, undefined);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'FAIL');
});

// T-amt-5: sole SAFETY/lease DENY after #68 stops without any replan.
test('T-amt-5: sole SAFETY/lease DENY after #68 stops — no terminal replan, no hardDecision widen', async () => {
  // Live path: sole SAFETY after #68 stops; nothing fires
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: []
  };
  let i = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `h${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'd')}` }]
    }),
    verify: async () => {
      i += 1;
      if (i === 1) {
        return {
          status: 'UNCERTAIN',
          summary: 'need evidence',
          nextAction: 'REQUEST_EVIDENCE',
          failureCodes: [JEV_EVIDENCE_REQUIRED]
        };
      }
      return {
        status: 'FAIL',
        summary: 'hard deny',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['SAFETY_POLICY_DENY']
      };
    }
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.amtEvents.length, 0);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'FAIL');
  assert.deepEqual(result.report.failureCodes, ['SAFETY_POLICY_DENY']);
});

test('T-steal-amt-1: after #68 without #69, continuation carries agent-miss guidance and the run stops at two', async () => {
  for (const status of ['FAIL', 'STALLED']) {
    const failureCodes = status === 'FAIL'
      ? ['JEV_BEHAVIOR_REJECTED', 'ACTION_FAILED', 'REPEATED_ACTION']
      : ['REPEATED_ACTION'];
    const bag = { amtEvents: [] };
    const recoveries = [];
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt, recovery }) => {
        if (recovery) recoveries.push(structuredClone(recovery));
        return {
          text: `carry-${status}-${attempt}`,
          actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'e')}` }]
        };
      },
      verify: sequencedVerify(['UNCERTAIN', status, status])
    });

    assert.equal(bag.amtEvents.length, 0, 'no terminal replan: two executions then stop');
    const missRecoveries = recoveries.filter((recovery) => recovery.agentMissReplan === true);
    assert.equal(missRecoveries.length, 1);
    const recovery = missRecoveries[0];
    // The attempt-2 recovery is built from the UNCERTAIN report that fired #68,
    // not from the later terminal FAIL.
    assert.deepEqual(recovery.failureCodes, [JEV_EVIDENCE_REQUIRED]);
    const beforeNote = structuredClone(recovery);
    const continuation = recoveryContinuationText(recovery);
    assert.ok(continuation.includes(agentMissReplanHostNote()));
    assert.doesNotMatch(continuation, /HOST_POST_AGENT_MISS_TERMINAL_REPLAN/);
    assert.deepEqual(recovery, beforeNote, 'host guidance must not mutate recovery evidence');
    assert.deepEqual(result.history.map((item) => item.status), ['UNCERTAIN', status]);
    assert.equal(result.ok, false);
    assert.equal(result.report.status, status);
    assert.deepEqual(result.report.failureCodes, failureCodes);
  }
});

test('T-steal-amt-2: agent-miss-only, #70, and UNCERTAIN continuations retain their own notes', async () => {
  for (const scenario of [
    {
      name: 'agent-miss-only',
      statuses: ['FAIL', 'PASS'],
      recoveryFlag: 'agentMissReplan',
      expectedNote: agentMissReplanHostNote()
    },
    {
      name: 'post-miss-terminal #70',
      statuses: ['UNCERTAIN', 'UNCERTAIN', 'FAIL', 'FAIL'],
      recoveryFlag: 'postMissTerminalReplan',
      expectedNote: postMissTerminalReplanHostNote()
    },
    {
      name: 'UNCERTAIN',
      statuses: ['UNCERTAIN'],
      recoveryFlag: 'postMissUncertainReplan',
      expectedNote: postMissUncertainReplanHostNote()
    }
  ]) {
    const bag = { amtEvents: [] };
    const recoveries = [];
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt, recovery }) => {
        if (recovery) recoveries.push(structuredClone(recovery));
        return {
          text: `isolation-${scenario.name}-${attempt}`,
          actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'f')}` }]
        };
      },
      verify: sequencedVerify(scenario.statuses)
    });

    assert.equal(bag.amtEvents.length, 0, scenario.name);
    assert.equal(result.postAgentMissTerminalReplanned, undefined, scenario.name);
    const expectedRecovery = recoveries.find((recovery) => recovery[scenario.recoveryFlag] === true);
    assert.ok(expectedRecovery, `${scenario.name} must reach its own recovery path`);
    assert.ok(recoveryContinuationText(expectedRecovery).includes(scenario.expectedNote), scenario.name);
    for (const recovery of recoveries) {
      assert.doesNotMatch(recoveryContinuationText(recovery), /HOST_POST_AGENT_MISS_TERMINAL_REPLAN/, scenario.name);
    }
  }
});
