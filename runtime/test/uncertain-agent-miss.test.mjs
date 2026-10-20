import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MISS_TRIGGER_CODES,
  JEV_EVIDENCE_REQUIRED,
  isAgentMissReplanEligible,
  isSoleHardDenyFailure,
  runVerifierRecovery,
  stampJevEvidenceRequired
} from '../src/task-recovery-controller.mjs';

// T-um-1: writes≥1 + UNCERTAIN + JEV_EVIDENCE_REQUIRED → exactly 1× replan; second still stops
test('T-um-1: writes≥1 + UNCERTAIN + JEV_EVIDENCE_REQUIRED yields exactly one agent_miss replan', async () => {
  assert.equal(AGENT_MISS_TRIGGER_CODES.has(JEV_EVIDENCE_REQUIRED), true);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 2, successfulWrites: 2, failureCodes: [JEV_EVIDENCE_REQUIRED]
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
      status: 'UNCERTAIN',
      summary: 'Deterministic checks passed but Jev requires more evidence',
      nextAction: 'REQUEST_EVIDENCE',
      failureCodes: [JEV_EVIDENCE_REQUIRED]
    })
  });

  assert.equal(replanEvents.length, 1);
  assert.equal(replanEvents[0].writesApplied, 2);
  assert.equal(replanEvents[0].status, 'UNCERTAIN');
  assert.deepEqual(replanEvents[0].failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.agentMissReplanned, true);
  // Second UNCERTAIN must not replan again; latch holds.
  assert.equal(result.report.status, 'UNCERTAIN');
  assert.ok(result.history.some((h) => h.status === 'UNCERTAIN'));
});

// T-um-2: FAIL + REPEATED_ACTION / STALLED + REPEATED_ACTION → still exactly 1× (#64/#65 regress)
test('T-um-2: FAIL and STALLED + REPEATED_ACTION still yield exactly one agent_miss replan each', async () => {
  for (const status of ['FAIL', 'STALLED']) {
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
        status,
        summary: 'duplicates',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['REPEATED_ACTION']
      })
    });

    assert.equal(replanEvents.length, 1, `status=${status}`);
    assert.equal(replanEvents[0].status, status, `status=${status}`);
    assert.equal(executions, 2, `status=${status}`);
    assert.equal(result.ok, false, `status=${status}`);
    assert.equal(result.agentMissReplanned, true, `status=${status}`);
    assert.equal(result.report.status, status, `status=${status}`);
  }
});

// T-um-3: writes=0 + UNCERTAIN + JEV_EVIDENCE_REQUIRED → 0×
test('T-um-3: writes=0 + UNCERTAIN + JEV_EVIDENCE_REQUIRED does not agent-miss replan', async () => {
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 0, successfulWrites: 0, failureCodes: [JEV_EVIDENCE_REQUIRED]
  }), false);

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
      status: 'UNCERTAIN',
      summary: 'Deterministic checks passed but Jev requires more evidence',
      nextAction: 'REQUEST_EVIDENCE',
      failureCodes: [JEV_EVIDENCE_REQUIRED]
    })
  });

  assert.equal(replanEvents.length, 0);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.exhausted, true);
  assert.equal(result.report.status, 'UNCERTAIN');
  assert.equal(result.agentMissReplanned, undefined);
});

// T-um-4: sole SAFETY_* / lease DENY → 0× (including UNCERTAIN)
test('T-um-4: sole SAFETY/lease DENY never agent-miss replans on FAIL/STALLED/UNCERTAIN', async () => {
  assert.equal(isSoleHardDenyFailure(['SAFETY_COMMAND_NOT_ALLOWED']), true);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 5, failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED']
  }), false);
  // Mixed with JEV_EVIDENCE_REQUIRED is NOT sole hard deny — but T-um-4 covers sole deny.
  assert.equal(isSoleHardDenyFailure([JEV_EVIDENCE_REQUIRED, 'SAFETY_COMMAND_NOT_ALLOWED']), false);

  for (const status of ['FAIL', 'STALLED', 'UNCERTAIN']) {
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
      assert.equal(executions, 1, `status=${status}`);
      assert.equal(result.attempts, 1, `status=${status}`);
    } else {
      assert.equal(executions, 2, `status=${status}`);
      assert.equal(result.exhausted, true, `status=${status}`);
    }
  }
});

// T-um-5: Jev evidence-gap stamp lands JEV_EVIDENCE_REQUIRED in failureCodes
test('T-um-5: stampJevEvidenceRequired always writes JEV_EVIDENCE_REQUIRED (no summary-only)', () => {
  const stamped = stampJevEvidenceRequired(
    { status: 'PASS', summary: 'all green', failureCodes: [], checks: [{ id: 'det', status: 'PASS' }] },
    { reasonCode: 'NEED_MORE_EVIDENCE', evidenceIds: ['e1', 'e2'] }
  );
  assert.equal(stamped.status, 'UNCERTAIN');
  assert.equal(stamped.summary, 'Deterministic checks passed but Jev requires more evidence');
  assert.deepEqual(stamped.failureCodes, [JEV_EVIDENCE_REQUIRED]);
  assert.ok(stamped.checks.some((c) => c.id === 'jev-behavior-judge' && c.status === 'UNKNOWN'));

  // Soft / prior codes preserved; stamp still present.
  const soft = stampJevEvidenceRequired(
    { status: 'PASS', failureCodes: ['SOFT_HINT'], checks: [] },
    { reasonCode: 'GAP', evidenceIds: [] }
  );
  assert.ok(soft.failureCodes.includes(JEV_EVIDENCE_REQUIRED));
  assert.ok(soft.failureCodes.includes('SOFT_HINT'));
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 1, failureCodes: soft.failureCodes
  }), true);
});
