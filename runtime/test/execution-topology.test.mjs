import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPOLOGY_DIRECT_EXECUTE,
  TOPOLOGY_PLAN_THEN_EXECUTE,
  TOPOLOGY_DELIBERATE_THEN_EXECUTE,
  TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
  TOPOLOGY_BUDGET_WRITES,
  TOPOLOGY_BUDGET_TOOLS,
  TOPOLOGY_BUDGET_PROBES,
  DEFAULT_MAX_WRITES,
  DEFAULT_MAX_PROBES,
  isComplexTask,
  hasDiagnoseFailureEvidence,
  selectTopologyCandidates,
  ruleSelectTopology,
  maySelectDiagnoseInitially,
  upgradeTopologyAfterFailure,
  resolveTopologyBudgets,
  createTopologyBudgetCounters,
  assertTopologyBudget,
  commitTopologyBudgetIncrement,
  resolveTopologySelection,
  shouldDeliberateForTopology,
  normalizeTopology,
  isBudgetedTopology
} from '../src/execution-topology.mjs';
import { planTierInactiveReason } from '../src/decision/plan-tier.mjs';

test('T-topo-1 complex (dual acceptance) + topology on → initial PLAN_THEN_EXECUTE', () => {
  const acceptanceCommands = ['node --test a.test.js', 'node --test b.test.js'];
  assert.equal(isComplexTask({ acceptanceCommands }), true);
  const sel = resolveTopologySelection({
    topologyEnabled: true,
    complex: true,
    failureEvidence: false
  });
  assert.equal(sel.topology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.equal(sel.source, 'rule');
  assert.ok(sel.reasonCodes.includes('RULE_FALLBACK'));
  assert.equal(shouldDeliberateForTopology(sel.topology), true);
  const candidates = selectTopologyCandidates({
    topologyEnabled: true,
    complex: true,
    failureEvidence: false
  });
  assert.ok(candidates.includes(TOPOLOGY_PLAN_THEN_EXECUTE));
});

test('T-topo-2 no failure evidence → DIAGNOSE not initial / not selectable as start', () => {
  assert.equal(maySelectDiagnoseInitially({ failureEvidence: false }), false);
  const candidates = selectTopologyCandidates({
    topologyEnabled: true,
    complex: true,
    failureEvidence: false
  });
  assert.equal(candidates.includes(TOPOLOGY_DIAGNOSE_PROBE_RECOVER), false);
  const rule = ruleSelectTopology({
    topologyEnabled: true,
    complex: true,
    failureEvidence: false
  });
  assert.notEqual(rule, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  // Even if Jev asks for DIAGNOSE without evidence, Rule rejects it.
  const rejected = resolveTopologySelection({
    topologyEnabled: true,
    complex: true,
    failureEvidence: false,
    jevSelectedId: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    jevSource: 'jev'
  });
  assert.notEqual(rejected.topology, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  assert.equal(rejected.topology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.ok(rejected.reasonCodes.includes('DIAGNOSE_REQUIRES_FAILURE_EVIDENCE'));
});

test('T-topo-3 after acceptance fail → may upgrade to DIAGNOSE_PROBE_RECOVER', () => {
  assert.equal(hasDiagnoseFailureEvidence({ acceptanceFailureEvidence: true }), true);
  const candidates = selectTopologyCandidates({
    topologyEnabled: true,
    complex: true,
    failureEvidence: { acceptanceFailureEvidence: true }
  });
  assert.ok(candidates.includes(TOPOLOGY_DIAGNOSE_PROBE_RECOVER));
  const upgraded = upgradeTopologyAfterFailure({
    topologyEnabled: true,
    currentTopology: TOPOLOGY_PLAN_THEN_EXECUTE,
    failureEvidence: { verificationFailed: true, acceptanceFailureEvidence: true }
  });
  assert.equal(upgraded, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  const sel = resolveTopologySelection({
    topologyEnabled: true,
    complex: true,
    failureEvidence: { acceptanceFailureEvidence: true },
    jevSelectedId: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    jevSource: 'jev'
  });
  assert.equal(sel.topology, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  assert.equal(sel.source, 'jev');
});

test('T-topo-4 over maxWrites / maxProbes → blocked + budget reasonCode', () => {
  const budgets = resolveTopologyBudgets({ maxWrites: 2, maxTools: 10, maxProbes: 2 });
  let counters = createTopologyBudgetCounters();
  // Two writes OK, third blocked.
  for (let i = 0; i < 2; i++) {
    const r = assertTopologyBudget({
      topologyEnabled: true,
      topology: TOPOLOGY_PLAN_THEN_EXECUTE,
      counters,
      budgets,
      toolName: 'file.write'
    });
    assert.equal(r.allowed, true);
    counters = commitTopologyBudgetIncrement(counters, r.pendingIncrement);
  }
  assert.equal(counters.writes, 2);
  const overWrite = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    counters,
    budgets,
    toolName: 'file.write'
  });
  assert.equal(overWrite.allowed, false);
  assert.equal(overWrite.reasonCode, TOPOLOGY_BUDGET_WRITES);
  assert.ok(overWrite.reasonCodes.includes(TOPOLOGY_BUDGET_WRITES));
  assert.equal(overWrite.decision.decision, 'BLOCK');

  // Probes only under DIAGNOSE.
  let probeCounters = createTopologyBudgetCounters();
  for (let i = 0; i < 2; i++) {
    const r = assertTopologyBudget({
      topologyEnabled: true,
      topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
      counters: probeCounters,
      budgets,
      toolName: 'workspace.read',
      toolReadOnly: true
    });
    assert.equal(r.allowed, true);
    probeCounters = commitTopologyBudgetIncrement(probeCounters, r.pendingIncrement);
  }
  const overProbe = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
    counters: probeCounters,
    budgets,
    toolName: 'workspace.read',
    toolReadOnly: true
  });
  assert.equal(overProbe.allowed, false);
  assert.equal(overProbe.reasonCode, TOPOLOGY_BUDGET_PROBES);

  // Tools budget
  let toolCounters = { writes: 0, tools: 10, probes: 0 };
  const overTools = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    counters: toolCounters,
    budgets: { maxWrites: 4, maxTools: 10, maxProbes: 6 },
    toolName: 'shell.execute'
  });
  assert.equal(overTools.allowed, false);
  assert.equal(overTools.reasonCode, TOPOLOGY_BUDGET_TOOLS);

  assert.equal(DEFAULT_MAX_WRITES, 4);
  assert.equal(DEFAULT_MAX_PROBES, 6);
});

test('T-topo-5 topologyEnabled=false → baseline (no forced topology / no budget)', () => {
  assert.deepEqual(selectTopologyCandidates({ topologyEnabled: false, complex: true }), []);
  assert.equal(ruleSelectTopology({ topologyEnabled: false, complex: true }), undefined);
  const sel = resolveTopologySelection({ topologyEnabled: false, complex: true });
  assert.equal(sel.topology, undefined);
  assert.equal(sel.source, 'off');
  const budget = assertTopologyBudget({
    topologyEnabled: false,
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    counters: { writes: 99, tools: 99, probes: 99 },
    toolName: 'file.write'
  });
  assert.equal(budget.allowed, true);
  assert.equal(budget.blocked, false);
});

test('T-topo-6 hard BLOCK / lease not exempted by topology budget', () => {
  const hard = {
    decision: 'BLOCK',
    confidence: 1,
    source: 'rule',
    reasonCode: 'TOOL_NOT_ALLOWED_IN_MODE',
    decisionType: 'ACTION_GATE'
  };
  const result = assertTopologyBudget({
    topologyEnabled: true,
    topology: TOPOLOGY_PLAN_THEN_EXECUTE,
    counters: createTopologyBudgetCounters(),
    budgets: resolveTopologyBudgets(),
    toolName: 'file.write',
    hardBlocked: true,
    hardDecision: hard
  });
  assert.equal(result.allowed, false);
  assert.equal(result.preservedHardBlock, true);
  assert.equal(result.reasonCode, 'TOOL_NOT_ALLOWED_IN_MODE');
  assert.notEqual(result.reasonCode, TOPOLOGY_BUDGET_WRITES);
  // Under budget + hard BLOCK still hard BLOCK (never flipped to ALLOW).
  assert.equal(result.decision.decision, 'BLOCK');

  // Mutual exclusion with plan-tier preserved.
  assert.equal(
    planTierInactiveReason({
      agentMode: 'multi',
      decisionEnabled: true,
      planTierEnabled: true,
      topologyEnabled: true,
      resumedPlan: false
    }),
    'PLAN_TIER_TOPOLOGY_EXCLUSIVE'
  );
  assert.equal(normalizeTopology(TOPOLOGY_DELIBERATE_THEN_EXECUTE), TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.equal(isBudgetedTopology(TOPOLOGY_DELIBERATE_THEN_EXECUTE), true);
  assert.equal(isBudgetedTopology(TOPOLOGY_DIRECT_EXECUTE), false);
});

test('T-topo-hint topologyHint complex|diagnose marks complex without dual acceptance', () => {
  assert.equal(isComplexTask({ acceptanceCommands: ['one'], topologyHint: 'complex' }), true);
  assert.equal(isComplexTask({ acceptanceCommands: ['one'], topologyHint: 'diagnose' }), true);
  assert.equal(isComplexTask({ acceptanceCommands: ['one'], topologyHint: 'noop' }), false);
  assert.equal(isComplexTask({ acceptanceCommands: [] }), false);
});
