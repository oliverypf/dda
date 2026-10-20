import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCapabilityPath } from '../src/capability-path.mjs';
import { applyTrustXGate } from '../src/trust-x.mjs';
import {
  allocateDecisionCreditBlame,
  CreditBlameLedger
} from '../src/credit-blame-ledger.mjs';
import {
  BEHAVIOR_ASYMMETRIC,
  BEHAVIOR_POSTERIOR_VERSION,
  CAUSAL_EQUAL_SHARE,
  CAUSAL_PATH_WEIGHTED,
  TRUST_DEEPEN_MIN_EVIDENCE,
  allocatePathWeighted,
  applyBehaviorPosteriorToTrust,
  behaviorPosteriorKey,
  createBehaviorPosteriorStore,
  isTrustDeepenEnabled,
  normalizePathNodes,
  pathNodeWeights,
  resolveBehaviorPosterior,
  updateBehaviorPosterior
} from '../src/trust-deepen.mjs';

const allowGate = { decision: 'ALLOW', reasonCode: 'JEV_ACTION_GATE_ALLOW' };
const blockGate = { decision: 'BLOCK', reasonCode: 'HARD_BLOCK' };

test('helpers: enabled by default, version + asymmetric locked', () => {
  assert.equal(isTrustDeepenEnabled({}), true);
  assert.equal(isTrustDeepenEnabled({ DDA_TRUST_DEEPEN: '0' }), false);
  assert.equal(isTrustDeepenEnabled({ DDA_TRUST_DEEPEN: '1' }), true);
  assert.equal(BEHAVIOR_POSTERIOR_VERSION, 'behavior-beta-v1');
  assert.equal(BEHAVIOR_ASYMMETRIC.wSuccess, 0.25);
  assert.equal(BEHAVIOR_ASYMMETRIC.wFailure, 1.0);
  assert.equal(TRUST_DEEPEN_MIN_EVIDENCE, 3);
  assert.equal(
    behaviorPosteriorKey({ entityType: 'executor', entityId: 'e1', capabilityId: 'shell.execute' }),
    'behavior:executor:e1:shell.execute'
  );
  assert.equal(
    behaviorPosteriorKey({ entityId: 'e1' }),
    'behavior:executor:e1'
  );
});

test('T-td-1 same key: 1 success raises mean; 1 failure drops clearly (slow-build fast-drop)', () => {
  const storeS = createBehaviorPosteriorStore();
  const key = behaviorPosteriorKey({ entityId: 'actor-a', capabilityId: 'file.write' });
  const priorMean = 0.5; // α=1,β=1
  const afterSuccess = updateBehaviorPosterior({
    key,
    success: true,
    store: storeS
  });
  assert.equal(afterSuccess.version, 'behavior-beta-v1');
  assert.ok(afterSuccess.mean > priorMean, `success mean ${afterSuccess.mean} should rise`);
  assert.ok(Math.abs(afterSuccess.alpha - 1.25) < 1e-9, `α=${afterSuccess.alpha}`);
  assert.equal(afterSuccess.beta, 1);
  assert.equal(afterSuccess.evidenceCount, 1);

  const storeF = createBehaviorPosteriorStore();
  const afterFailure = updateBehaviorPosterior({
    key,
    success: false,
    store: storeF
  });
  assert.ok(afterFailure.mean < priorMean, `failure mean ${afterFailure.mean} should drop`);
  assert.equal(afterFailure.alpha, 1);
  assert.ok(Math.abs(afterFailure.beta - 2) < 1e-9, `β=${afterFailure.beta}`);

  const rise = afterSuccess.mean - priorMean;
  const drop = priorMean - afterFailure.mean;
  assert.ok(drop > rise, `fast-drop ${drop} must exceed slow-build rise ${rise}`);
});

test('T-td-2 same incidentId second failure → α/β unchanged (idempotent)', () => {
  const store = createBehaviorPosteriorStore();
  const key = behaviorPosteriorKey({ entityId: 'actor-b' });
  const first = updateBehaviorPosterior({
    key,
    success: false,
    incidentId: 'inc-1',
    store
  });
  const second = updateBehaviorPosterior({
    key,
    success: false,
    incidentId: 'inc-1',
    store
  });
  assert.equal(second.skipped, true);
  assert.equal(second.alpha, first.alpha);
  assert.equal(second.beta, first.beta);
  assert.equal(second.evidenceCount, first.evidenceCount);

  // Different incidentId still updates
  const third = updateBehaviorPosterior({
    key,
    success: false,
    incidentId: 'inc-2',
    store
  });
  assert.ok(third.beta > first.beta);
  assert.equal(third.evidenceCount, first.evidenceCount + 1);

  // resolveBehaviorPosterior reads store
  const resolved = resolveBehaviorPosterior(key, store);
  assert.equal(resolved.beta, third.beta);
});

test('T-td-3 no path → CAUSAL_EQUAL_SHARE, weights sum=1', () => {
  const decisions = [
    { decisionId: 'd1', runId: 'r1', role: 'planner', status: 'COMMITTED' },
    { decisionId: 'd2', runId: 'r1', role: 'executor', status: 'COMMITTED' }
  ];
  const outcome = { outcomeId: 'o1', status: 'FAILED', executionEventIds: ['e1'] };
  const alloc = allocatePathWeighted({ decisions, outcome });
  assert.equal(alloc.length, 2);
  assert.ok(alloc.every((a) => a.allocationMethod === CAUSAL_EQUAL_SHARE));
  const blameSum = alloc.reduce((s, a) => s + a.blame, 0);
  assert.ok(Math.abs(blameSum - 1) < 1e-9, `blameSum=${blameSum}`);
  assert.ok(alloc.every((a) => Math.abs(a.blame - 0.5) < 1e-9));

  // Ledger export with no path also equal-share
  const viaLedger = allocateDecisionCreditBlame({ decisions, outcome });
  assert.ok(viaLedger.every((a) => a.allocationMethod === CAUSAL_EQUAL_SHARE));
  assert.ok(Math.abs(viaLedger.reduce((s, a) => s + a.blame, 0) - 1) < 1e-9);
});

test('T-td-4 with path (+ highRiskSink) → CAUSAL_PATH_WEIGHTED, sink blame ≥ equal share; sum=1', () => {
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  assert.ok(pathAnalysis.highRiskSinks.length > 0, 'shell should expand to high-risk sinks');
  const nodes = normalizePathNodes({ pathAnalysis });
  assert.ok(nodes.length >= 2, `nodes=${nodes.length}`);

  // Decisions aligned to first and last (sink-ish) nodes
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const decisions = [
    { decisionId: 'd-first', runId: 'r1', role: 'executor', status: 'COMMITTED', toolName: first, capabilityId: first },
    { decisionId: 'd-last', runId: 'r1', role: 'executor', status: 'COMMITTED', toolName: last, capabilityId: last }
  ];
  const outcome = { outcomeId: 'o-fail', status: 'FAILED' };
  const alloc = allocatePathWeighted({
    decisions,
    outcome,
    pathAnalysis
  });
  assert.ok(alloc.every((a) => a.allocationMethod === CAUSAL_PATH_WEIGHTED));
  const blameSum = alloc.reduce((s, a) => s + a.blame, 0);
  assert.ok(Math.abs(blameSum - 1) < 1e-9, `blameSum=${blameSum}`);

  const equalShare = 1 / decisions.length;
  const lastAlloc = alloc.find((a) => a.decisionId === 'd-last');
  assert.ok(lastAlloc, 'last decision present');
  assert.ok(
    lastAlloc.blame >= equalShare - 1e-9,
    `sink/last blame ${lastAlloc.blame} should be ≥ equal share ${equalShare}`
  );

  // Explicit highRiskSink weighting: last node that is also a sink gets heavier
  const weights = pathNodeWeights({
    nodes: ['a', 'b', 'network.connect'],
    highRiskSinks: ['network.connect'],
    outcome: 'FAILED'
  });
  // raw: a=1, b=1, network=2(last)*2(sink)=4 → total 6 → 1/6, 1/6, 4/6
  assert.ok(Math.abs(weights[2] - 4 / 6) < 1e-9, `sink weight=${weights[2]}`);
  assert.ok(weights[2] > weights[0]);
});

test('T-td-5 mean<0.4 → R≥0.4 → ALLOW→REQUIRE_APPROVAL; mean<0.2 → BLOCK band; high mean cannot demote', () => {
  // Build posterior with 3 failures → mean = 1/(1+3) = 0.25 → R floor 0.4
  const store = createBehaviorPosteriorStore();
  const key = behaviorPosteriorKey({ entityId: 'actor-c', capabilityId: 'shell.execute' });
  for (let i = 0; i < 3; i += 1) {
    updateBehaviorPosterior({ key, success: false, incidentId: `f-${i}`, store });
  }
  let posterior = resolveBehaviorPosterior(key, store);
  assert.equal(posterior.evidenceCount, 3);
  assert.ok(posterior.mean < 0.4 && posterior.mean >= 0.2, `mean=${posterior.mean}`);

  const trustLow = {
    A: 'actor-c', S: 'shell.execute', C: '*', O: 'default',
    R: 0, E: 0.3, empty: false, fallbackLevel: 0, key: 'k'
  };
  const injected = applyBehaviorPosteriorToTrust({ trust: trustLow, posterior });
  assert.ok(injected.R >= 0.4, `R=${injected.R}`);
  assert.equal(injected.A, 'actor-c');
  assert.equal(injected.S, 'shell.execute');
  assert.ok(injected.trustDeepen?.mean === posterior.mean);

  const gated = applyTrustXGate({
    gateDecision: allowGate,
    trust: injected,
    toolReadOnly: false
  });
  assert.equal(gated.decision, 'REQUIRE_APPROVAL');
  assert.equal(gated.elevated, true);

  // More failures → mean < 0.2 → R≥0.8 → BLOCK
  for (let i = 0; i < 5; i += 1) {
    updateBehaviorPosterior({ key, success: false, incidentId: `f-extra-${i}`, store });
  }
  posterior = resolveBehaviorPosterior(key, store);
  assert.ok(posterior.mean < 0.2, `mean=${posterior.mean}`);
  const injectedDeny = applyBehaviorPosteriorToTrust({
    trust: { ...trustLow, R: 0 },
    posterior
  });
  assert.ok(injectedDeny.R >= 0.8, `R=${injectedDeny.R}`);
  const gatedDeny = applyTrustXGate({
    gateDecision: allowGate,
    trust: injectedDeny,
    toolReadOnly: false
  });
  assert.equal(gatedDeny.decision, 'BLOCK');

  // High mean cannot demote: REQUIRE_APPROVAL stays; R not lowered
  const storeGood = createBehaviorPosteriorStore();
  const goodKey = behaviorPosteriorKey({ entityId: 'actor-d' });
  // Need evidenceCount≥3 and mean≥0.7: many successes
  // mean = (1 + 0.25n)/(2 + 0.25n) ≥ 0.7 → 1+0.25n ≥ 1.4 + 0.175n → 0.075n ≥ 0.4 → n ≥ 5.33
  for (let i = 0; i < 8; i += 1) {
    updateBehaviorPosterior({ key: goodKey, success: true, outcomeId: `ok-${i}`, store: storeGood });
  }
  const goodPost = resolveBehaviorPosterior(goodKey, storeGood);
  assert.ok(goodPost.mean >= 0.7, `mean=${goodPost.mean}`);
  const trustHighR = {
    A: 'actor-d', S: '*', C: '*', O: 'default',
    R: 0.8, E: 0.2, empty: false, fallbackLevel: 0, key: 'k2'
  };
  const afterGood = applyBehaviorPosteriorToTrust({ trust: trustHighR, posterior: goodPost });
  assert.equal(afterGood.R, 0.8, 'must not lower R');
  assert.ok(afterGood.E >= 0.5, `E bumped to ${afterGood.E}`);
  const noDemote = applyTrustXGate({
    gateDecision: { decision: 'REQUIRE_APPROVAL', reasonCode: 'UPSTREAM' },
    trust: afterGood,
    toolReadOnly: false
  });
  assert.equal(noDemote.decision, 'REQUIRE_APPROVAL');
  assert.equal(noDemote.elevated, false);
});

test('T-td-6 hard BLOCK / DDA_TRUST_DEEPEN=0 → baseline', () => {
  // Hard BLOCK untouched even with bad posterior
  const badTrust = {
    A: 'x', S: '*', C: '*', O: 'default',
    R: 1, E: 1, empty: false, fallbackLevel: 0, key: 'k',
    trustDeepen: { mean: 0.01, alpha: 1, beta: 100 }
  };
  const blocked = applyTrustXGate({
    gateDecision: blockGate,
    trust: badTrust,
    toolReadOnly: false
  });
  assert.equal(blocked.decision, 'BLOCK');
  assert.equal(blocked.elevated, false);
  assert.equal(blocked.preservedBlock, true);

  // evidenceCount < 3 → no Trust change
  const lowEv = applyBehaviorPosteriorToTrust({
    trust: { A: 'x', S: '*', C: '*', O: 'default', R: 0, E: 0.1, empty: false },
    posterior: { alpha: 1, beta: 10, mean: 0.09, evidenceCount: 2, version: 'behavior-beta-v1' }
  });
  assert.equal(lowEv.R, 0);
  assert.equal(lowEv.trustDeepen, undefined);

  // DDA_TRUST_DEEPEN=0 → ledger never PATH_WEIGHTED even with path
  const decisions = [
    { decisionId: 'd1', runId: 'r1', role: 'executor', status: 'COMMITTED', toolName: 'shell.execute' },
    { decisionId: 'd2', runId: 'r1', role: 'planner', status: 'COMMITTED', toolName: 'file.write' }
  ];
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });
  const disabled = allocateDecisionCreditBlame({
    decisions,
    outcome: { outcomeId: 'o', status: 'FAILED' },
    pathAnalysis,
    env: { DDA_TRUST_DEEPEN: '0' }
  });
  assert.ok(disabled.every((a) => a.allocationMethod === CAUSAL_EQUAL_SHARE));
  assert.ok(Math.abs(disabled.reduce((s, a) => s + a.blame, 0) - 1) < 1e-9);
});

test('ledger record with path uses PATH_WEIGHTED; without path equal-share; digests differ', () => {
  const decisions = [
    { decisionId: 'd1', runId: 'r1', role: 'executor', status: 'COMMITTED', capabilityId: 'shell.execute', toolName: 'shell.execute' },
    { decisionId: 'd2', runId: 'r1', role: 'planner', status: 'COMMITTED', capabilityId: 'file.write', toolName: 'file.write' }
  ];
  const outcome = { outcomeId: 'o-digest', status: 'FAILED', runId: 'r1', executionEventIds: ['e1'] };
  const pathAnalysis = analyzeCapabilityPath({ toolName: 'shell.execute' });

  const ledgerEq = new CreditBlameLedger();
  const eq = ledgerEq.record({ decisions, outcome });
  assert.ok(eq.every((a) => a.allocationMethod === CAUSAL_EQUAL_SHARE));

  const ledgerPw = new CreditBlameLedger();
  const pw = ledgerPw.record({ decisions, outcome, pathAnalysis });
  assert.ok(pw.every((a) => a.allocationMethod === CAUSAL_PATH_WEIGHTED));

  // Different allocation ids (source digest includes method + pathNodes)
  const eqIds = new Set(eq.map((a) => a.allocationId));
  const pwIds = new Set(pw.map((a) => a.allocationId));
  assert.equal([...eqIds].some((id) => pwIds.has(id)), false);
});
