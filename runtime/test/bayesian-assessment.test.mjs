import test from 'node:test';
import assert from 'node:assert/strict';
import { assessBayesian, bayesianDigest, rankSafeCandidates } from '../src/bayesian-assessment.mjs';

const sample = (overrides = {}) => ({
  feedbackId: 'feedback-1',
  outcomeId: 'outcome-1',
  runId: 'run-1',
  independenceKey: 'outcome-1',
  scenarioKey: 'sha256:' + 'a'.repeat(64),
  candidateKey: 'openai/responses/model-a/v1/planner/plugin-v1',
  modelRegistryDigest: 'sha256:' + 'b'.repeat(64),
  policyVersion: 'runtime-safety-1',
  dimensions: { objectiveSuccess: true, verifierPass: true, userSatisfaction: 1, safetyIncident: false },
  evidenceRefs: ['event-1'],
  ...overrides
});

test('computes Beta-Bernoulli posteriors with credible bounds and prior-only cold start', () => {
  const empty = assessBayesian({ samples: [sample({ dimensions: {} })], now: () => 100 });
  const emptyMetric = empty.assessments[0].metrics.objectiveSuccess;
  assert.equal(emptyMetric.alpha, 1);
  assert.equal(emptyMetric.beta, 1);
  assert.equal(emptyMetric.priorOnly, true);
  assert.ok(emptyMetric.lowerCredibleBound < emptyMetric.mean);
  const assessed = assessBayesian({ samples: [
    sample(),
    sample({ feedbackId: 'feedback-2', outcomeId: 'outcome-2', independenceKey: 'outcome-2', dimensions: { objectiveSuccess: false, verifierPass: false, userSatisfaction: 0, safetyIncident: false } }),
    sample({ feedbackId: 'feedback-3', outcomeId: 'outcome-3', independenceKey: 'outcome-3', dimensions: { objectiveSuccess: true, verifierPass: true, userSatisfaction: 0.8, safetyIncident: false } })
  ], now: () => 100 });
  const metrics = assessed.assessments[0].metrics;
  assert.equal(metrics.objectiveSuccess.alpha, 3);
  assert.equal(metrics.objectiveSuccess.beta, 2);
  assert.equal(metrics.objectiveSuccess.effectiveSampleCount, 3);
  assert.ok(metrics.objectiveSuccess.lowerCredibleBound > 0);
  assert.equal(metrics.userSatisfaction.effectiveSampleCount, 3);
  assert.match(assessed.datasetDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('deduplicates independent evidence and excludes unknown/cancelled/not-executed outcomes', () => {
  const result = assessBayesian({ samples: [
    sample(),
    sample({ feedbackId: 'duplicate', independenceKey: 'outcome-1', dimensions: { objectiveSuccess: false } }),
    sample({ feedbackId: 'unknown', outcomeId: 'outcome-unknown', independenceKey: 'outcome-unknown', outcomeStatus: 'UNKNOWN', dimensions: { objectiveSuccess: false } }),
    sample({ feedbackId: 'cancelled', outcomeId: 'outcome-cancelled', independenceKey: 'outcome-cancelled', outcomeStatus: 'CANCELLED', dimensions: { objectiveSuccess: false } }),
    sample({ feedbackId: 'failed', outcomeId: 'outcome-failed', independenceKey: 'outcome-failed', outcomeStatus: 'FAILED', dimensions: { objectiveSuccess: false, verifierPass: false, userSatisfaction: 0, safetyIncident: true } })
  ] });
  const assessment = result.assessments[0];
  assert.equal(assessment.sampleCount, 2);
  assert.deepEqual(result.excludedOutcomeCounts, { CANCELLED: 1, UNKNOWN: 1 });
  assert.equal(assessment.metrics.objectiveSuccess.effectiveSampleCount, 2);
  assert.ok(assessment.metrics.objectiveSuccess.uncertaintyCodes.includes('SAFETY_INCIDENT_PRESENT'));
});

test('Bayesian ranking only orders safety-approved candidates and cannot grant authority', () => {
  const assessment = assessBayesian({ samples: [sample()] }).assessments;
  const result = rankSafeCandidates({
    assessments: assessment,
    candidates: [
      { candidateKey: 'openai/responses/model-a/v1/planner/plugin-v1', scenarioKey: sample().scenarioKey, modelRegistryDigest: sample().modelRegistryDigest, safetyAllowed: true },
      { candidateKey: 'unsafe/candidate', scenarioKey: sample().scenarioKey, modelRegistryDigest: sample().modelRegistryDigest, safetyAllowed: false }
    ]
  });
  assert.equal(result.ranked.length, 1);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.safetyFilterApplied, true);
  assert.equal(result.canChangePermissions, false);
  assert.equal(result.canCreateApproval, false);
  assert.equal(result.canCreateLease, false);
  assert.match(bayesianDigest({ candidate: result.ranked[0].candidateKey }), /^sha256:[0-9a-f]{64}$/u);
});
