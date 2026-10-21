import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  isPostMissUncertainExhaustedReplanEligible,
  postMissUncertainExhaustedReplanHostNote,
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
        failureCodes: ['JEV_BEHAVIOR_REJECTED', 'ACTION_FAILED']
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

// T-ue-1: evidence-delta done + UNCERTAIN+JEV_EVIDENCE_REQUIRED + delta0 → exactly 1× exhausted; second stays stopped
test('T-ue-1: after evidence-delta, UNCERTAIN+JEV_EVIDENCE + write-delta=0 yields exactly one exhausted replan', async () => {
  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), true);

  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: true,
    writesAtEvidenceDelta: 2
  }), false);

  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: []
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
        sawExhausted: recovery?.postMissUncertainExhaustedReplan === true,
        sawDelta: recovery?.postMissEvidenceDeltaReplan === true
      };
    },
    // #68 → #69 → evidence-delta → exhausted → stop
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.deltaEvents.length, 1);
  assert.equal(bag.exhaustedEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 0);
  assert.equal(bag.exhaustedEvents[0].status, 'UNCERTAIN');
  assert.equal(bag.exhaustedEvents[0].priorPostMissEvidenceDeltaReplan, true);
  assert.equal(bag.exhaustedEvents[0].writesApplied, 2);
  assert.equal(bag.exhaustedEvents[0].writesAtEvidenceDelta, 2);
  assert.deepEqual(bag.exhaustedEvents[0].failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.equal(executions, 5);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 5);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postMissUncertainReplanned, true);
  assert.equal(result.postMissEvidenceDeltaReplanned, true);
  assert.equal(result.postMissUncertainExhaustedReplanned, true);
  assert.equal(result.postMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-ue-2: write-delta≥1 → no fire
test('T-ue-2: write-delta≥1 after evidence-delta does not fire exhausted latch', async () => {
  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 3,
    successfulWrites: 3,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), false);

  let writes = 2;
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: []
  };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: writes, successfulWrites: writes }),
      onReplan: (evt) => bag.agentEvents.push(evt),
      onPostMissReplan: (evt) => bag.postEvents.push(evt),
      onPostMissTerminalReplan: (evt) => bag.terminalEvents.push(evt),
      onPostMissEvidenceDeltaReplan: (evt) => {
        bag.deltaEvents.push(evt);
        // Simulate a new write landing after evidence-delta (delta≥1).
        writes = 3;
      },
      onPostMissUncertainExhaustedReplan: (evt) => bag.exhaustedEvents.push(evt)
    },
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: `w${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }]
      };
    },
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.deltaEvents.length, 1);
  assert.equal(bag.exhaustedEvents.length, 0);
  assert.equal(result.postMissUncertainExhaustedReplanned, undefined);
  // Without exhausted bonus, stops at attempt 4 (after #68+#69+ed).
  assert.equal(executions, 4);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-ue-3: FAIL/STALLED → no fire this latch (may still #70)
test('T-ue-3: FAIL/STALLED after evidence-delta never fire exhausted (terminal may still fire)', async () => {
  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), false);

  for (const terminal of ['FAIL', 'STALLED']) {
    const bag = {
      agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: []
    };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `t${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'b')}` }]
      }),
      // #68 UNCERTAIN → #69 UNCERTAIN → evidence-delta needs UNCERTAIN; then terminal
      // Path: U,U,U (ed fires), then FAIL/STALLED → terminal (#70), not exhausted
      verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', terminal, terminal])
    });
    assert.equal(bag.agentEvents.length, 1, terminal);
    assert.equal(bag.postEvents.length, 1, terminal);
    assert.equal(bag.deltaEvents.length, 1, terminal);
    assert.equal(bag.exhaustedEvents.length, 0, terminal);
    assert.equal(bag.terminalEvents.length, 1, terminal);
    assert.equal(result.postMissUncertainExhaustedReplanned, undefined, terminal);
    assert.equal(result.postMissTerminalReplanned, true, terminal);
    assert.equal(result.report.status, terminal);
  }
});

// T-ue-4: without prior evidence-delta → never
test('T-ue-4: without prior evidence-delta, exhausted latch never fires', async () => {
  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissEvidenceDeltaAlreadyReplanned: false,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), false);

  // Force evidence-delta ineligible by write-delta≥1 after #69 — exhausted must stay 0.
  let writes = 2;
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: []
  };
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: writes, successfulWrites: writes }),
      onReplan: (evt) => bag.agentEvents.push(evt),
      onPostMissReplan: (evt) => {
        bag.postEvents.push(evt);
        writes = 3; // delta≥1 → evidence-delta never fires
      },
      onPostMissTerminalReplan: (evt) => bag.terminalEvents.push(evt),
      onPostMissEvidenceDeltaReplan: (evt) => bag.deltaEvents.push(evt),
      onPostMissUncertainExhaustedReplan: (evt) => bag.exhaustedEvents.push(evt)
    },
    execute: async ({ attempt }) => ({
      text: `n${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'c')}` }]
    }),
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.deltaEvents.length, 0);
  assert.equal(bag.exhaustedEvents.length, 0);
  assert.equal(result.postMissEvidenceDeltaReplanned, undefined);
  assert.equal(result.postMissUncertainExhaustedReplanned, undefined);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-ue-5: telemetry kind / payload fields + host note; sole SAFETY never eligible
test('T-ue-5: exhausted telemetry payload fields complete; sole SAFETY never eligible', async () => {
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: []
  };
  await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `p${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'd')}` }]
    }),
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.exhaustedEvents.length, 1);
  const evt = bag.exhaustedEvents[0];
  assert.equal(evt.status, 'UNCERTAIN');
  assert.deepEqual(evt.failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.equal(typeof evt.writesApplied, 'number');
  assert.equal(typeof evt.writesAtEvidenceDelta, 'number');
  assert.equal(evt.priorPostMissEvidenceDeltaReplan, true);
  const note = postMissUncertainExhaustedReplanHostNote();
  assert.match(note, /HOST_POST_MISS_UNCERTAIN_EXHAUSTED_REPLAN/);
  assert.match(note, /LAST CHANCE|last chance/i);
  assert.match(note, /NEW write|checkable evidence|new write/i);

  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED'],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), false);

  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 2,
    failureCodes: ['HARD_DECISION_DENY'],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 2
  }), false);

  assert.equal(isPostMissUncertainExhaustedReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissEvidenceDeltaAlreadyReplanned: true,
    postMissUncertainExhaustedAlreadyReplanned: false,
    writesAtEvidenceDelta: 0
  }), false);
});
