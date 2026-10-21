import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  isPostAgentMissTerminalReplanEligible,
  isPostMissTerminalReplanEligible,
  postAgentMissTerminalReplanHostNote,
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

// T-amt-1: #68 + FAIL/STALLED + no #69 → exactly 1×; second stays stopped
test('T-amt-1: after #68 without #69, FAIL+writes yields exactly one post-agent-miss terminal replan', async () => {
  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), true);

  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: true
  }), false);

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
        sawAmt: recovery?.postAgentMissTerminalReplan === true,
        sawAgentMiss: recovery?.agentMissReplan === true
      };
    },
    // UNCERTAIN → #68; FAIL → amt terminal; FAIL → stop
    verify: sequencedVerify(['UNCERTAIN', 'FAIL', 'FAIL'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 0);
  assert.equal(bag.terminalEvents.length, 0);
  assert.equal(bag.amtEvents.length, 1);
  assert.equal(bag.amtEvents[0].status, 'FAIL');
  assert.equal(bag.amtEvents[0].priorAgentMissReplan, true);
  assert.ok(bag.amtEvents[0].failureCodes.includes('JEV_BEHAVIOR_REJECTED'));
  assert.equal(executions, 3);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postMissUncertainReplanned, undefined);
  assert.equal(result.postMissTerminalReplanned, undefined);
  assert.equal(result.postAgentMissTerminalReplanned, true);
  assert.equal(result.report.status, 'FAIL');

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
    assert.equal(bag2.amtEvents.length, 1);
    assert.equal(bag2.amtEvents[0].status, 'STALLED');
    assert.equal(bag2.terminalEvents.length, 0);
    assert.equal(r2.postAgentMissTerminalReplanned, true);
    assert.equal(r2.report.status, 'STALLED');
  }
});

// T-amt-2: #69 already + FAIL → no double-fire with this path (still #70 ≤1)
test('T-amt-2: after #69, FAIL fires #70 only — not post-agent-miss terminal', async () => {
  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: true,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

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

// T-amt-4: no #68 → no fire
test('T-amt-4: without #68, post-agent-miss terminal never fires', async () => {
  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    agentMissAlreadyReplanned: false,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

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

// T-amt-5: telemetry shape + no lease/hardDecision widen
test('T-amt-5: host note + sole SAFETY/lease DENY never eligible; no hardDecision widen', async () => {
  const note = postAgentMissTerminalReplanHostNote();
  assert.match(note, /HOST_POST_AGENT_MISS_TERMINAL_REPLAN/);
  assert.match(note, /FAIL or STALLED/);
  assert.match(note, /Do not claim PASS/);
  assert.match(note, /SAFETY \/ lease/);

  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['SAFETY_POLICY_DENY'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['LEASE_DENIED'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 2,
    failureCodes: ['HARD_DECISION_DENY'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

  assert.equal(isPostAgentMissTerminalReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    agentMissAlreadyReplanned: true,
    postMissUncertainAlreadyReplanned: false,
    postAgentMissTerminalAlreadyReplanned: false
  }), false);

  // Live path: sole SAFETY after #68 does not fire amt
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
