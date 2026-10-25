import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAggregatePlanVerification,
  selectAuthoritativePlanStepEntries
} from '../src/promote-align-aggregate.mjs';

const TIP_PATH_ID = 'deterministic-green-jev-uncertain-tip-path';

const uncertainPrePromote = {
  status: 'UNCERTAIN',
  summary: 'Deterministic checks passed but Jev requires more evidence',
  nextAction: 'COMPLETE',
  failureCodes: ['JEV_EVIDENCE_REQUIRED'],
  checks: [
    { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
    { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
    { id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'evidence-gap' }
  ]
};

const tipPathPass = {
  status: 'PASS',
  summary: 'Deterministic checks green; tip-path promoted terminal evidence-only JEV_EVIDENCE_REQUIRED UNCERTAIN to PASS',
  nextAction: 'COMPLETE',
  failureCodes: [],
  checks: [
    { id: 'evidence.tests', status: 'PASS', message: 'tests green' },
    { id: 'output.non_empty', status: 'PASS', message: 'non-empty' },
    { id: 'jev-behavior-judge', status: 'UNKNOWN', message: 'evidence-gap' },
    { id: TIP_PATH_ID, status: 'PASS', message: 'tip-path promote' }
  ]
};

const entry = (report, attempt) => ({
  stepId: 'execute',
  attempt,
  report: structuredClone(report),
  result: {
    stepId: 'execute',
    ok: report.status === 'PASS',
    result: { text: `attempt-${attempt}`, actions: [] },
    verification: structuredClone(report),
    recoveryRun: { attempt }
  }
});

// ——— T-pat-1 ———

test('T-pat-1: tip-path promote then multi-attempt aggregate stays PASS (promote-align miss=0)', () => {
  // Mirrors run101a t2-172: same stepId, pre-promote UNCERTAIN + tip-path PASS.
  const completedPlanEntries = [
    entry(uncertainPrePromote, 1),
    entry(tipPathPass, 2)
  ];

  // Document the pre-fix poison: folding every attempt without last-per-step → FAIL.
  const naiveAllPass = completedPlanEntries
    .map((e) => e.report)
    .every((report) => report.status === 'PASS');
  assert.equal(naiveAllPass, false, 'naive every-attempt fold would be FAIL (the residual bug)');

  const authoritative = selectAuthoritativePlanStepEntries(completedPlanEntries);
  assert.equal(authoritative.length, 1);
  assert.equal(authoritative[0].report.status, 'PASS');
  assert.ok(
    (authoritative[0].report.checks ?? []).some((c) => c.id === TIP_PATH_ID),
    'authoritative entry keeps tip-path audit check'
  );

  const aggregate = buildAggregatePlanVerification(completedPlanEntries);
  assert.equal(aggregate.status, 'PASS', 'terminal aggregate must stay PASS after tip-path promote');
  assert.equal(aggregate.hasPromotedVerification, true);
  assert.equal(aggregate.nextAction, 'COMPLETE');
  assert.equal(aggregate.failureCodes.length, 0);
  assert.equal(aggregate.summary, 'Verified 1 plan step(s)');
  assert.equal(aggregate.authoritativeEntries.length, 1);
  assert.ok(
    aggregate.checks.some((c) => c.id === `execute.${TIP_PATH_ID}`),
    'aggregate checks include tip-path promote id'
  );

  // Score-topology promote_align_miss: any promoted:true → last must be PASS.
  const lastVer = aggregate.status;
  const anyPromoted = aggregate.hasPromotedVerification;
  const promote_align_miss = anyPromoted && lastVer !== 'PASS' ? 1 : 0;
  assert.equal(promote_align_miss, 0);
});

test('T-pat-1b: two distinct promoted steps still aggregate PASS', () => {
  const a = entry(tipPathPass, 1);
  a.stepId = 'execute';
  a.result.stepId = 'execute';
  const bReport = {
    ...structuredClone(tipPathPass),
    checks: [
      ...tipPathPass.checks.filter((c) => c.id !== TIP_PATH_ID),
      { id: 'deterministic-green-jev-behavior-reject-promote', status: 'PASS', message: 'dgr' }
    ]
  };
  const b = entry(bReport, 1);
  b.stepId = 'finalize';
  b.result.stepId = 'finalize';

  const aggregate = buildAggregatePlanVerification([a, b]);
  assert.equal(aggregate.status, 'PASS');
  assert.equal(aggregate.hasPromotedVerification, true);
  assert.equal(aggregate.summary, 'Verified 2 plan step(s)');
  assert.equal(aggregate.authoritativeEntries.length, 2);
});

test('T-pat-1c: non-promoted real FAIL still aggregates FAIL', () => {
  const fail = entry({
    status: 'FAIL',
    summary: 'real fail',
    nextAction: 'STOP_AND_REPORT',
    failureCodes: ['ACTION_FAILED'],
    checks: [{ id: 'evidence.tests', status: 'FAIL', message: 'red' }]
  }, 1);
  const aggregate = buildAggregatePlanVerification([fail]);
  assert.equal(aggregate.status, 'FAIL');
  assert.equal(aggregate.hasPromotedVerification, false);
  assert.equal(aggregate.nextAction, 'STOP_AND_REPORT');
});
