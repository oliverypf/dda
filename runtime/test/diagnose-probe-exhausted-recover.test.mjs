import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
  TOPOLOGY_PLAN_THEN_EXECUTE,
  TOPOLOGY_BUDGET_PROBES,
  DEFAULT_MAX_PROBES,
  DIAGNOSE_PROBE_EXHAUSTED_RECOVER_MAX_PER_RUN,
  createTopologyBudgetCounters,
  resolveTopologyBudgets,
  assertTopologyBudget,
  commitTopologyBudgetIncrement,
  isDiagnoseProbeExhaustedRecoverEligible,
  applyDiagnoseProbeExhaustedRecover,
  diagnoseProbeExhaustedRecoverHostNote,
  resetTopologyBudgetCountersOnUpgrade,
  upgradeTopologyAfterFailure,
  isProbeBudgetOnlyFailureEvidence,
  isEvidenceOnlyFailureEvidence,
  shouldSuppressPostDprDiagnoseUpgrade
} from '../src/execution-topology.mjs';

test('bound choice documented: ≤2× per run; default maxProbes stays 6', () => {
  assert.equal(DIAGNOSE_PROBE_EXHAUSTED_RECOVER_MAX_PER_RUN, 2);
  assert.equal(DEFAULT_MAX_PROBES, 6);
  assert.equal(resolveTopologyBudgets().maxProbes, 6);
});

// T-dpr-1: DIAGNOSE + probes at max → recover telemetry; no ≥3 consecutive pure probe BLOCKs without turn
test('T-dpr-1: DIAGNOSE + probes at max → recover telemetry; no ≥3 consecutive pure probe BLOCKs without turn', () => {
  const budgets = resolveTopologyBudgets({ maxWrites: 4, maxTools: 30, maxProbes: 2 });
  let counters = createTopologyBudgetCounters();
  let topology = TOPOLOGY_DIAGNOSE_PROBE_RECOVER;
  let recoversUsed = 0;
  const recovers = [];
  const probeBlocks = [];

  // Fill probe budget.
  for (let i = 0; i < 2; i++) {
    const r = assertTopologyBudget({
      topologyEnabled: true,
      topology,
      counters,
      budgets,
      toolName: 'workspace.read',
      toolReadOnly: true
    });
    assert.equal(r.allowed, true);
    counters = commitTopologyBudgetIncrement(counters, r.pendingIncrement);
  }
  assert.equal(counters.probes, 2);

  // Next three probe attempts: first two should recover+demote (and BLOCK),
  // after demote probes are no longer budgeted under PTE → allow (turn).
  for (let i = 0; i < 3; i++) {
    const r = assertTopologyBudget({
      topologyEnabled: true,
      topology,
      counters,
      budgets,
      toolName: 'workspace.read',
      toolReadOnly: true
    });
    if (r.blocked && r.reasonCode === TOPOLOGY_BUDGET_PROBES) {
      probeBlocks.push({ i, topology });
      if (isDiagnoseProbeExhaustedRecoverEligible({
        topology,
        wouldBlockProbes: true,
        recoversUsed
      })) {
        const recover = applyDiagnoseProbeExhaustedRecover({
          fromTopology: topology,
          probes: counters.probes,
          maxProbes: budgets.maxProbes,
          recoversUsed
        });
        recoversUsed += 1;
        recovers.push(recover);
        topology = recover.demotedTopology;
      }
    } else {
      // Allowed under demoted PTE — counts as a turn away from pure probe BLOCK.
      assert.equal(r.allowed, true, `attempt ${i} should be allowed after demote`);
      counters = commitTopologyBudgetIncrement(counters, r.pendingIncrement);
    }
  }

  assert.ok(recovers.length >= 1, `expected ≥1 recover, got ${recovers.length}`);
  assert.equal(recovers[0].fromTopology, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  assert.equal(recovers[0].demotedTopology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.equal(recovers[0].probes, 2);
  assert.equal(recovers[0].maxProbes, 2);
  assert.equal(recovers[0].strategy, 'demote_to_plan_then_execute');
  assert.equal(recovers[0].recoverOrdinal, 1);
  assert.match(diagnoseProbeExhaustedRecoverHostNote(), /HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER/);
  assert.match(diagnoseProbeExhaustedRecoverHostNote(), /file\.write|shell\.execute|test\.execute/i);
  assert.match(diagnoseProbeExhaustedRecoverHostNote(), /sticky execute|post_dpr_sticky_execute/i);

  // Consecutive pure probe BLOCKs without a recover turn must be < 3.
  // After first PROBES block we demote; subsequent probes under PTE are allowed.
  assert.ok(probeBlocks.length < 3, `expected <3 consecutive probe BLOCKs, got ${probeBlocks.length}`);
  assert.equal(topology, TOPOLOGY_PLAN_THEN_EXECUTE);
});

// T-dpr-2: recover does not bypass lease / hardDecision
test('T-dpr-2: recover does not bypass lease/hardDecision', () => {
  const hard = {
    decision: 'BLOCK',
    confidence: 1,
    source: 'rule',
    reasonCode: 'TOOL_NOT_ALLOWED_IN_MODE',
    decisionType: 'ACTION_GATE'
  };
  // Even at probe max under DIAGNOSE, hard BLOCK wins and recover is not a soft ALLOW.
  const budget = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    counters: { writes: 0, tools: 0, probes: 6 },
    budgets: resolveTopologyBudgets({ maxProbes: 6 }),
    toolName: 'workspace.read',
    toolReadOnly: true,
    hardBlocked: true,
    hardDecision: hard
  });
  assert.equal(budget.allowed, false);
  assert.equal(budget.preservedHardBlock, true);
  assert.equal(budget.reasonCode, 'TOOL_NOT_ALLOWED_IN_MODE');
  assert.notEqual(budget.reasonCode, TOPOLOGY_BUDGET_PROBES);

  // Eligible recover still only demotes; it never flips hard BLOCK to ALLOW.
  assert.equal(isDiagnoseProbeExhaustedRecoverEligible({
    topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    wouldBlockProbes: true,
    recoversUsed: 0
  }), true);
  const recover = applyDiagnoseProbeExhaustedRecover({
    fromTopology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    probes: 6,
    maxProbes: 6,
    recoversUsed: 0
  });
  assert.equal(recover.demotedTopology, TOPOLOGY_PLAN_THEN_EXECUTE);
  // Re-assert with hard block after demote — still hard BLOCK.
  const after = assertTopologyBudget({
    topologyEnabled: true,
    topology: recover.demotedTopology,
    counters: { writes: 0, tools: 0, probes: 6 },
    budgets: resolveTopologyBudgets(),
    toolName: 'file.write',
    hardBlocked: true,
    hardDecision: hard
  });
  assert.equal(after.preservedHardBlock, true);
  assert.equal(after.decision.decision, 'BLOCK');
  assert.equal(after.reasonCode, 'TOOL_NOT_ALLOWED_IN_MODE');
});

test('T-dpr-bound: recoversUsed≥2 → not eligible; lease-alone path unchanged', () => {
  assert.equal(isDiagnoseProbeExhaustedRecoverEligible({
    topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    wouldBlockProbes: true,
    recoversUsed: 2
  }), false);
  assert.equal(isDiagnoseProbeExhaustedRecoverEligible({
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    wouldBlockProbes: true,
    recoversUsed: 0
  }), false);
  assert.equal(isDiagnoseProbeExhaustedRecoverEligible({
    topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    wouldBlockProbes: false,
    recoversUsed: 0
  }), false);
});

test('T-dpr-#79: upgrade reset still independent of recover demote', () => {
  const reset = resetTopologyBudgetCountersOnUpgrade({
    fromTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    toTopology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER
  });
  assert.deepEqual(reset, { writes: 0, tools: 0, probes: 0 });
  // Demote recover must NOT reset (caller keeps counters); apply* returns no counters.
  const recover = applyDiagnoseProbeExhaustedRecover({
    fromTopology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    probes: 6,
    maxProbes: 6,
    recoversUsed: 0
  });
  assert.equal(recover.counters, undefined);
  assert.equal(recover.demotedTopology, TOPOLOGY_PLAN_THEN_EXECUTE);
});


// T-pds-1: after recover≥1 on PTE, probe-budget-only evidence → suppress upgrade
test('T-pds-1: post-dpr sticky — probe-budget-only FAIL does not upgrade DIAGNOSE', () => {
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: ['TOPOLOGY_BUDGET_PROBES'],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: [],
    checkMessages: ['actions.progress FAIL cites TOPOLOGY_BUDGET_PROBES']
  }), true);

  // Historical previousActions noise must not veto when checkMessages cite probe budget.
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: ['EXCERPT_NOT_FOUND', 'TOOL_ACTION_REQUIRES_EVIDENCE', 'TOPOLOGY_BUDGET_PROBES'],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);

  const suppress = shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  });
  assert.equal(suppress, true);

  // Simulate diagnose-stage gate: when suppress, keep PTE (do not call upgrade path).
  let topology = TOPOLOGY_PLAN_THEN_EXECUTE;
  let upgraded = false;
  if (!suppress) {
    const next = upgradeTopologyAfterFailure({
      topologyEnabled: true,
      currentTopology: topology,
      failureEvidence: {
        acceptanceFailureEvidence: true,
        verificationFailed: true,
        recoveryPointsDiagnose: true
      }
    });
    if (next !== topology) {
      upgraded = true;
      topology = next;
    }
  }
  assert.equal(upgraded, false);
  assert.equal(topology, TOPOLOGY_PLAN_THEN_EXECUTE);

  // Without suppress, upgrade would fire.
  const wouldUpgrade = upgradeTopologyAfterFailure({
    topologyEnabled: true,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureEvidence: {
      acceptanceFailureEvidence: true,
      verificationFailed: true,
      recoveryPointsDiagnose: true
    }
  });
  assert.equal(wouldUpgrade, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);

  // recovers=0 → no sticky suppress even with probe-budget evidence
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 0,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: []
  }), false);
});

// T-pds-2: real failures still allow upgrade (no false suppress)
test('T-pds-2: post-dpr sticky — real failure still upgrades', () => {
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: ['SHELL_FAILED'],
    checkMessages: []
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 2,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: ['SHELL_FAILED'],
    checkMessages: ['shell blew up']
  }), false);

  // Real failure path: upgrade proceeds.
  const next = upgradeTopologyAfterFailure({
    topologyEnabled: true,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureEvidence: {
      acceptanceFailureEvidence: true,
      verificationFailed: true,
      recoveryPointsDiagnose: true
    }
  });
  assert.equal(next, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
});

// T-pds-3: #82 max recovers still 2; DEFAULT_MAX_PROBES 6; hardDecision preserved
test('T-pds-3: sticky does not raise recover max / maxProbes; hardDecision preserved', () => {
  assert.equal(DIAGNOSE_PROBE_EXHAUSTED_RECOVER_MAX_PER_RUN, 2);
  assert.equal(DEFAULT_MAX_PROBES, 6);
  assert.equal(resolveTopologyBudgets().maxProbes, 6);

  const hard = {
    decision: 'BLOCK',
    confidence: 1,
    source: 'rule',
    reasonCode: 'TOOL_NOT_ALLOWED_IN_MODE',
    decisionType: 'ACTION_GATE'
  };
  const budget = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    counters: { writes: 0, tools: 0, probes: 6 },
    budgets: resolveTopologyBudgets(),
    toolName: 'file.write',
    hardBlocked: true,
    hardDecision: hard
  });
  assert.equal(budget.preservedHardBlock, true);
  assert.equal(budget.reasonCode, 'TOOL_NOT_ALLOWED_IN_MODE');
  assert.equal(budget.decision.decision, 'BLOCK');

  // Sticky suppress itself never flips hard BLOCK.
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: []
  }), true);
});

// T-smf-1: run62 t1a shape — probe-only via Chinese actions.progress message → suppress
test('T-smf-1: run62 probe-only fixture suppresses and would emit sticky (no upgrade)', () => {
  const failureCodes = ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'];
  const checkMessages = ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）'];
  // Historical EXCERPT noise must not veto when checks cite probe budget.
  const actionErrorCodes = ['EXCERPT_AMBIGUOUS', 'EXCERPT_NOT_FOUND', TOPOLOGY_BUDGET_PROBES];
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes, actionErrorCodes, checkMessages
  }), true);
  const suppress = shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes,
    actionErrorCodes,
    checkMessages
  });
  assert.equal(suppress, true);

  // Stage gate simulation: suppress → emit sticky path, 0× upgrade.
  const emitted = [];
  let topology = TOPOLOGY_PLAN_THEN_EXECUTE;
  let upgraded = 0;
  if (suppress) {
    emitted.push({
      kind: 'harness.post_dpr_sticky_execute',
      stickyExecute: true,
      suppressedDiagnoseUpgrade: true
    });
  } else {
    const next = upgradeTopologyAfterFailure({
      topologyEnabled: true,
      currentTopology: topology,
      failureEvidence: {
        acceptanceFailureEvidence: true,
        verificationFailed: true,
        recoveryPointsDiagnose: true
      }
    });
    if (next !== topology) {
      upgraded += 1;
      topology = next;
    }
  }
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].kind, 'harness.post_dpr_sticky_execute');
  assert.equal(upgraded, 0);
  assert.equal(topology, TOPOLOGY_PLAN_THEN_EXECUTE);

  // Defense path: empty checkMessages but FAILED action carries probe code/message.
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 2,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes,
    actionErrorCodes: ['EXCERPT_AMBIGUOUS', TOPOLOGY_BUDGET_PROBES],
    checkMessages: [TOPOLOGY_BUDGET_PROBES] // synthesized from previousActions errorCode
  }), true);
});

// T-smf-2: real failures still upgrade (no false sticky suppress)
test('T-smf-2: real non-probe failures do not suppress', () => {
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 2,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: ['SHELL_FAILED'],
    checkMessages: ['shell blew up']
  }), false);
});


// T-pde-1: after recover≥1 on PTE, JEV_EVIDENCE_REQUIRED-only → suppress upgrade
test('T-pde-1: post-dpr sticky — JEV_EVIDENCE_REQUIRED-only does not upgrade DIAGNOSE', () => {
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: [],
    checkMessages: []
  }), true);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: [],
    actionErrorCodes: [],
    checkMessages: ['verifier UNCERTAIN (JEV_EVIDENCE_REQUIRED)']
  }), true);
  // Historical EXCERPT noise must not veto when failureCodes are evidence-only.
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: ['EXCERPT_NOT_FOUND', 'TOOL_ACTION_REQUIRES_EVIDENCE'],
    checkMessages: []
  }), true);

  const suppress = shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: [],
    checkMessages: []
  });
  assert.equal(suppress, true);

  let topology = TOPOLOGY_PLAN_THEN_EXECUTE;
  let upgraded = false;
  if (!suppress) {
    const next = upgradeTopologyAfterFailure({
      topologyEnabled: true,
      currentTopology: topology,
      failureEvidence: {
        acceptanceFailureEvidence: true,
        verificationFailed: true,
        recoveryPointsDiagnose: true
      }
    });
    if (next !== topology) {
      upgraded = true;
      topology = next;
    }
  }
  assert.equal(upgraded, false);
  assert.equal(topology, TOPOLOGY_PLAN_THEN_EXECUTE);

  // Probe-shaped failureCodes must not be claimed as evidence-only.
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), false);

  // Live run67 t3a shape: evidence failureCodes + miss-fire-synthesized probe
  // checkMessages must still suppress (neither path used to fire → upgrade leaked).
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);
});

// T-pde-2: real failures still allow upgrade (no false evidence sticky)
test('T-pde-2: post-dpr sticky — real failure still upgrades despite JEV_EVIDENCE_REQUIRED', () => {
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['JEV_EVIDENCE_REQUIRED', 'TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: ['SHELL_FAILED'],
    checkMessages: []
  }), false);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: [],
    checkMessages: ['JEV_EVIDENCE_REQUIRED']
  }), false);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['RULE_VERIFIER'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(isEvidenceOnlyFailureEvidence({
    failureCodes: ['RULE_VERIFIER_SCHEMA'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);

  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['JEV_EVIDENCE_REQUIRED', 'TESTS_FAILED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 2,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED'],
    actionErrorCodes: [],
    checkMessages: ['JEV_EVIDENCE_REQUIRED']
  }), false);
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: ['SHELL_FAILED'],
    checkMessages: []
  }), false);

  const next = upgradeTopologyAfterFailure({
    topologyEnabled: true,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureEvidence: {
      acceptanceFailureEvidence: true,
      verificationFailed: true,
      recoveryPointsDiagnose: true
    }
  });
  assert.equal(next, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
});

// T-pde-3: pre-dpr evidence still upgrades; #83 probe sticky does not regress
test('T-pde-3: recovers=0 evidence still upgrades; probe sticky regression green', () => {
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 0,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['JEV_EVIDENCE_REQUIRED'],
    actionErrorCodes: [],
    checkMessages: []
  }), false);

  // #83 probe sticky still fires after dpr.
  assert.equal(shouldSuppressPostDprDiagnoseUpgrade({
    diagnoseProbeExhaustedRecovers: 1,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);
  assert.equal(isProbeBudgetOnlyFailureEvidence({
    failureCodes: ['ACTION_FAILED', 'JEV_BEHAVIOR_REJECTED'],
    actionErrorCodes: [TOPOLOGY_BUDGET_PROBES],
    checkMessages: ['1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）']
  }), true);
});
