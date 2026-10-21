import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_EVIDENCE_REQUIRED,
  isPostMissEvidenceDeltaReplanEligible,
  postMissEvidenceDeltaReplanHostNote,
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

// T-ed-1: #69 done + UNCERTAIN+JEV_EVIDENCE_REQUIRED + delta0 → exactly 1× evidence-delta; second stays stopped
test('T-ed-1: after #69, UNCERTAIN+JEV_EVIDENCE + write-delta=0 yields exactly one evidence-delta replan', async () => {
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    successfulWrites: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), true);

  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: true,
    writesAtPostMiss: 2
  }), false);

  const bag = { agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: `a${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        sawDelta: recovery?.postMissEvidenceDeltaReplan === true,
        sawPostMiss: recovery?.postMissUncertainReplan === true
      };
    },
    // #68 → #69 → evidence-delta → exhausted → stop
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.deltaEvents.length, 1); // evidence-delta still exactly 1×
  assert.equal(bag.exhaustedEvents.length, 1);
  assert.equal(bag.terminalEvents.length, 0);
  assert.equal(bag.deltaEvents[0].status, 'UNCERTAIN');
  assert.equal(bag.deltaEvents[0].priorPostMissUncertainReplan, true);
  assert.equal(bag.deltaEvents[0].writesApplied, 2);
  assert.equal(bag.deltaEvents[0].writesAtPostMiss, 2);
  assert.deepEqual(bag.deltaEvents[0].failureCodes, [JEV_EVIDENCE_REQUIRED]);
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

// T-ed-2: write-delta≥1 → no fire
test('T-ed-2: write-delta≥1 after #69 does not fire evidence-delta latch', async () => {
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 3,
    successfulWrites: 3,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), false);

  let writes = 2;
  const bag = { agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [] };
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: writes, successfulWrites: writes }),
      onReplan: (evt) => bag.agentEvents.push(evt),
      onPostMissReplan: (evt) => {
        bag.postEvents.push(evt);
        // Simulate a new write landing after #69 (delta≥1).
        writes = 3;
      },
      onPostMissTerminalReplan: (evt) => bag.terminalEvents.push(evt),
      onPostMissEvidenceDeltaReplan: (evt) => bag.deltaEvents.push(evt),
      onPostMissUncertainExhaustedReplan: (evt) => (bag.exhaustedEvents ??= []).push(evt)
    },
    execute: async ({ attempt }) => {
      executions += 1;
      return {
        text: `w${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'a')}` }]
      };
    },
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.postEvents.length, 1);
  assert.equal(bag.deltaEvents.length, 0);
  assert.equal(result.postMissEvidenceDeltaReplanned, undefined);
  // Without evidence-delta bonus, stops at attempt 3 (after #68+#69).
  assert.equal(executions, 3);
  assert.equal(result.report.status, 'UNCERTAIN');
});

// T-ed-3: FAIL/STALLED → no fire this latch (may still #70)
test('T-ed-3: FAIL/STALLED after #69 never fire evidence-delta (terminal may still fire)', async () => {
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    failureCodes: ['JEV_BEHAVIOR_REJECTED'],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), false);

  for (const terminal of ['FAIL', 'STALLED']) {
    const bag = { agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [] };
    const result = await runVerifierRecovery({
      maxAttempts: 1,
      agentMiss: writesAgent(bag),
      execute: async ({ attempt }) => ({
        text: `t${attempt}`,
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'b')}` }]
      }),
      verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', terminal, terminal])
    });
    assert.equal(bag.agentEvents.length, 1, terminal);
    assert.equal(bag.postEvents.length, 1, terminal);
    assert.equal(bag.deltaEvents.length, 0, terminal);
    assert.equal(bag.terminalEvents.length, 1, terminal);
    assert.equal(result.postMissEvidenceDeltaReplanned, undefined, terminal);
    assert.equal(result.postMissTerminalReplanned, true, terminal);
    assert.equal(result.report.status, terminal);
  }
});

// T-ed-4: telemetry kind / payload fields present (via onPostMissEvidenceDeltaReplan callback shape)
test('T-ed-4: evidence-delta telemetry payload fields are complete; host note names write/evidence duty', async () => {
  const bag = { agentEvents: [], postEvents: [], terminalEvents: [], deltaEvents: [], exhaustedEvents: [] };
  await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `p${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, 'c')}` }]
    }),
    verify: sequencedVerify(['UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN', 'UNCERTAIN'])
  });

  assert.equal(bag.deltaEvents.length, 1);
  const evt = bag.deltaEvents[0];
  assert.equal(evt.status, 'UNCERTAIN');
  assert.deepEqual(evt.failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.equal(typeof evt.writesApplied, 'number');
  assert.equal(typeof evt.writesAtPostMiss, 'number');
  assert.equal(evt.priorPostMissUncertainReplan, true);
  // Kind string is emitted by index.mjs; unit surface is the callback contract + host note.
  const note = postMissEvidenceDeltaReplanHostNote();
  assert.match(note, /HOST_POST_MISS_EVIDENCE_DELTA_REPLAN/);
  assert.match(note, /NEW write|checkable evidence|new write/i);
  assert.match(note, /Ban focus/i);
});

// T-ed-5 (by omission): sole SAFETY / hard deny never eligible — lease/hardDecision untouched
test('T-ed-5: sole SAFETY / hard deny never eligible for evidence-delta', async () => {
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED'],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), false);

  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    failureCodes: ['HARD_DECISION_DENY'],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), false);

  // Without prior #69 → never
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 2,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissUncertainAlreadyReplanned: false,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 2
  }), false);

  // 0 writes → never
  assert.equal(isPostMissEvidenceDeltaReplanEligible({
    writesApplied: 0,
    successfulWrites: 0,
    failureCodes: [JEV_EVIDENCE_REQUIRED],
    postMissUncertainAlreadyReplanned: true,
    postMissEvidenceDeltaAlreadyReplanned: false,
    writesAtPostMiss: 0
  }), false);
});
