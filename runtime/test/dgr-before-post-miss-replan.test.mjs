import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createPlanStepCoordinator } from '../src/plan-step-coordinator.mjs';
import {
  JEV_EVIDENCE_REQUIRED,
  isDeterministicGreenJevBehaviorReject,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const JEV_BEHAVIOR_REJECTED = 'JEV_BEHAVIOR_REJECTED';

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

/** Live residual shape from tip-r29 / topology-r17 mid AF+BR + tests green. */
const dgrEligibleFail = (extra = {}) => ({
  status: 'FAIL',
  summary: 'RULE_VERIFIER_FAILED: behavior rejected',
  nextAction: 'STOP_AND_REPORT',
  failureCodes: ['ACTION_FAILED', JEV_BEHAVIOR_REJECTED],
  checks: [
    { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
    { id: 'actions.progress', status: 'FAIL', message: '1 个动作执行失败（TOPOLOGY_BUDGET_PROBES）' },
    { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
    { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
  ],
  ...extra
});

const uncertainReport = () => ({
  status: 'UNCERTAIN',
  summary: 'Deterministic checks passed but Jev requires more evidence',
  nextAction: 'REQUEST_EVIDENCE',
  failureCodes: [JEV_EVIDENCE_REQUIRED]
});

const makeCoordinator = () => {
  const coordinator = {
    planState: undefined,
    async setPlanStateAndFlush(state) {
      this.planState = structuredClone(state);
      return { planState: structuredClone(state) };
    }
  };
  return coordinator;
};

const singleStepPlan = () => normalizePlannerPlan({
  planId: 'plan-dpr',
  steps: [{ stepId: 'execute', summary: 'do work', actionKind: 'WRITE' }]
}, { objectiveDigest: 'sha256:objective' });

// ——— T-dpr-1 ———

test('T-dpr-1: DGR-eligible FAIL after #68 does not fire post_agent_miss_terminal; coordinator promotes reason:dgr', async () => {
  assert.equal(isDeterministicGreenJevBehaviorReject(dgrEligibleFail()), true);

  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  let i = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `dpr1-${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '1')}` }]
    }),
    verify: async () => {
      i += 1;
      if (i === 1) return uncertainReport();
      return dgrEligibleFail();
    }
  });

  assert.equal(bag.agentEvents.length, 1, 'agent-miss #68 still fires once');
  assert.equal(bag.amtEvents.length, 0, 'post_agent_miss_terminal must NOT fire for DGR-eligible FAIL');
  assert.equal(bag.terminalEvents.length, 0);
  assert.equal(result.agentMissReplanned, true);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.postMissTerminalReplanned, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.report.status, 'FAIL');
  assert.equal(isDeterministicGreenJevBehaviorReject(result.report), true);
  assert.ok(result.report.failureCodes.includes(JEV_BEHAVIOR_REJECTED));
  assert.ok(result.report.failureCodes.includes('ACTION_FAILED'));

  // Same FAIL shape reaches coordinator DGR promote.
  const coordinator = makeCoordinator();
  let promotion;
  const scheduler = createPlanStepCoordinator({ coordinator, plan: singleStepPlan() });
  const promoted = await scheduler.run({
    maxAttempts: 1,
    executeStep: async ({ attempt }) => ({ outputDigest: `sha256:${String(attempt).padStart(64, '0')}` }),
    verifyStep: async () => dgrEligibleFail(),
    onVerificationPromoted: (event) => {
      promotion = event;
    }
  });
  assert.equal(promoted.ok, true);
  assert.equal(promoted.plan.steps[0].status, 'SUCCEEDED');
  assert.equal(promoted.results.at(-1).report.status, 'PASS');
  assert.equal(promotion?.reason, 'dgr');
  assert.equal(promotion?.priorStatus, 'FAIL');
});

// ——— T-dpr-2 ———

test('T-dpr-2: non-DGR-eligible FAIL after #68 still gets exactly one post-agent-miss-terminal replan', async () => {
  const testsFailed = {
    status: 'FAIL',
    summary: 'tests failed',
    nextAction: 'STOP_AND_REPORT',
    failureCodes: ['TESTS_FAILED', JEV_BEHAVIOR_REJECTED],
    checks: [
      { id: 'evidence.tests', status: 'FAIL', message: 'tests red' },
      { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
      { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
    ]
  };
  assert.equal(isDeterministicGreenJevBehaviorReject(testsFailed), false);

  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  let i = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `dpr2-${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '2')}` }]
    }),
    verify: async () => {
      i += 1;
      if (i === 1) return uncertainReport();
      // after amt bonus execute, stay FAIL
      return testsFailed;
    }
  });

  assert.equal(bag.agentEvents.length, 1);
  assert.equal(bag.amtEvents.length, 1, 'non-DGR FAIL must still get post_agent_miss_terminal');
  assert.equal(bag.amtEvents[0].status, 'FAIL');
  assert.equal(result.postAgentMissTerminalReplanned, true);
  assert.equal(result.report.status, 'FAIL');
  assert.ok(result.report.failureCodes.includes('TESTS_FAILED') || result.report.failureCodes.includes(JEV_BEHAVIOR_REJECTED));
});

// ——— T-dpr-3 ———

test('T-dpr-3: RA+REJECTED still DGR; DGR-eligible FAIL after #69 does not fire postMissTerminal', async () => {
  // Existing DGR(incl RA) predicate remains green.
  assert.equal(isDeterministicGreenJevBehaviorReject(dgrEligibleFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION', 'ACTION_FAILED']
  })), true);
  // RA+REJECTED without ACTION_FAILED: no actions.progress FAIL companion.
  assert.equal(isDeterministicGreenJevBehaviorReject(dgrEligibleFail({
    failureCodes: [JEV_BEHAVIOR_REJECTED, 'REPEATED_ACTION'],
    checks: [
      { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
      { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
      { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
    ]
  })), true);

  // Symmetric: after #68+#69, DGR-eligible FAIL must not fire post-miss-terminal.
  const bag = {
    agentEvents: [], postEvents: [], terminalEvents: [], amtEvents: [],
    deltaEvents: [], exhaustedEvents: []
  };
  let i = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: writesAgent(bag),
    execute: async ({ attempt }) => ({
      text: `dpr3-${attempt}`,
      actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '3')}` }]
    }),
    verify: async () => {
      i += 1;
      if (i <= 2) return uncertainReport(); // #68 then #69
      return dgrEligibleFail();
    }
  });

  assert.equal(bag.agentEvents.length, 1, 'agent-miss once');
  assert.equal(bag.postEvents.length, 1, 'post-miss-uncertain once');
  assert.equal(bag.terminalEvents.length, 0, 'post_miss_terminal must NOT fire for DGR-eligible FAIL');
  assert.equal(bag.amtEvents.length, 0);
  assert.equal(result.postMissUncertainReplanned, true);
  assert.equal(result.postMissTerminalReplanned, undefined);
  assert.equal(result.postAgentMissTerminalReplanned, undefined);
  assert.equal(result.report.status, 'FAIL');
  assert.equal(isDeterministicGreenJevBehaviorReject(result.report), true);
});

