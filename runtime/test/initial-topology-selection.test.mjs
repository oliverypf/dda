import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOPOLOGY_DIRECT_EXECUTE,
  TOPOLOGY_PLAN_THEN_EXECUTE,
  TOPOLOGY_DIAGNOSE_PROBE_RECOVER,
  resolveTopologySelection,
  ruleSelectTopology,
  maySelectDiagnoseInitially
} from '../src/execution-topology.mjs';
import {
  runInitialTopologySelection,
  buildSelectTopologyDecisionRecord
} from '../src/initial-topology-selection.mjs';

/** Fake Jev that always picks DIAGNOSE — used to prove Rule rejection. */
const jevAlwaysDiagnose = {
  enabled: true,
  async selectCandidates() {
    return { source: 'jev', selectedCandidateId: TOPOLOGY_DIAGNOSE_PROBE_RECOVER };
  }
};

const jevDisabled = { enabled: false };

// T-sts-1: topology on + complex (dual acceptance) + single-equivalent path → PLAN_THEN_EXECUTE
test('T-sts-1 topology on + complex + single-equivalent → PLAN_THEN_EXECUTE', async () => {
  const dual = ['node --test a.test.js', 'node --test b.test.js'];
  const result = await runInitialTopologySelection({
    topologyEnabled: true,
    restoredResumePlan: false,
    prompt: 'fix dual acceptance',
    acceptanceCommands: dual,
    acceptanceFailureEvidence: false,
    topologyBudgets: { maxWrites: 4, maxTools: 30, maxProbes: 6 },
    planStepCount: 1,
    planDigest: 'digest-single',
    runId: 'run-sts-1',
    decisionEngine: jevDisabled
  });
  assert.ok(result, 'initial selection must run for single-equivalent caller');
  assert.equal(result.selectedTopology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.equal(result.topologySelection.topology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.equal(result.topologySelection.complex, true);
  assert.equal(result.resolved.source, 'rule');
  assert.ok(result.resolved.reasonCodes.includes('RULE_FALLBACK'));
  assert.equal(result.shouldDeliberate, true);
  // Decision record shape matches multi path (SELECT_TOPOLOGY).
  const rec = buildSelectTopologyDecisionRecord({
    runId: 'run-sts-1',
    parentDecisionId: 'parent-1',
    selectedTopology: result.selectedTopology,
    resolved: result.resolved,
    complexTask: result.complexTask,
    topologyCandidates: result.topologyCandidates
  });
  assert.equal(rec.decisionType, 'SELECT_TOPOLOGY');
  assert.equal(rec.selectedOptionId, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.ok(rec.selectionCriteria.includes('complex-default-plan-then-execute'));
});

// T-sts-2: no failure evidence → DIAGNOSE not initial (even if Jev asks)
test('T-sts-2 no failure evidence → initial not DIAGNOSE_PROBE_RECOVER', async () => {
  assert.equal(maySelectDiagnoseInitially({ failureEvidence: false }), false);
  const result = await runInitialTopologySelection({
    topologyEnabled: true,
    acceptanceCommands: ['node --test a.test.js', 'node --test b.test.js'],
    acceptanceFailureEvidence: false,
    topologyBudgets: {},
    planStepCount: 2,
    runId: 'run-sts-2',
    decisionEngine: jevAlwaysDiagnose
  });
  assert.ok(result);
  assert.notEqual(result.selectedTopology, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
  assert.equal(result.selectedTopology, TOPOLOGY_PLAN_THEN_EXECUTE);
  assert.ok(result.resolved.reasonCodes.includes('DIAGNOSE_REQUIRES_FAILURE_EVIDENCE'));
  assert.equal(result.topologySelection.rejectedJev, TOPOLOGY_DIAGNOSE_PROBE_RECOVER);
});

// T-sts-3: topology off → no forced topology
test('T-sts-3 topologyEnabled=false → no forced initial topology', async () => {
  const result = await runInitialTopologySelection({
    topologyEnabled: false,
    acceptanceCommands: ['node --test a.test.js', 'node --test b.test.js'],
    runId: 'run-sts-3',
    decisionEngine: jevDisabled
  });
  assert.equal(result, null);
  const pure = resolveTopologySelection({ topologyEnabled: false, complex: true });
  assert.equal(pure.topology, undefined);
  assert.equal(pure.source, 'off');
});

// T-sts-4 / not-complex → DIRECT_EXECUTE when on
test('T-sts-4 topology on + not complex → DIRECT_EXECUTE', async () => {
  const result = await runInitialTopologySelection({
    topologyEnabled: true,
    acceptanceCommands: ['node --test only-one.test.js'],
    acceptanceFailureEvidence: false,
    topologyBudgets: {},
    planStepCount: 1,
    runId: 'run-sts-4',
    decisionEngine: jevDisabled
  });
  assert.ok(result);
  assert.equal(result.selectedTopology, TOPOLOGY_DIRECT_EXECUTE);
  assert.equal(result.topologySelection.complex, false);
  assert.equal(result.shouldDeliberate, false);
  assert.equal(
    ruleSelectTopology({ topologyEnabled: true, complex: false, failureEvidence: false }),
    TOPOLOGY_DIRECT_EXECUTE
  );
});

test('T-sts-resume restored plan skips initial SELECT_TOPOLOGY', async () => {
  const result = await runInitialTopologySelection({
    topologyEnabled: true,
    restoredResumePlan: true,
    acceptanceCommands: ['a', 'b'],
    runId: 'run-sts-resume',
    decisionEngine: jevDisabled
  });
  assert.equal(result, null);
});
