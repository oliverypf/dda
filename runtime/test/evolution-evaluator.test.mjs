import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';
import { CreditBlameLedger, createCreditBlameLedger } from '../src/credit-blame-ledger.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const fixture = [
  { caseId: 'case-1', baseline: { status: 'FAILED', cost: 1, latencyMs: 100 }, candidate: { status: 'SUCCEEDED', cost: 1, latencyMs: 110 } },
  { caseId: 'case-2', baseline: { status: 'SUCCEEDED', cost: 1, latencyMs: 100 }, candidate: { status: 'SUCCEEDED', cost: 1, latencyMs: 90 } }
];

test('durable evolution outcomes and reports are committed to Harness', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const registry = new EvolutionRegistry({ eventStore, idFactory: () => 'proposal' });
  const proposal = await registry.propose({ candidateId: 'durable-evolution', version: '1.0.0' });
  const evaluator = new EvolutionEvaluator({ registry, eventStore, idFactory: () => 'evaluation' });
  const outcome = await evaluator.recordOutcome({ runId: 'task-evolution', proposalId: proposal.proposalId, taskClass: 'inspect', provider: 'fixture', protocol: 'test', model: 'fixture', status: 'SUCCEEDED', verified: true });
  await evaluator.replay({ proposalId: proposal.proposalId, fixtures: fixture });
  const events = await eventStore.list({ runId: 'task-evolution' });
  assert.equal(events[0].kind, 'EvolutionOutcomeRecorded');
  assert.equal(events[0].payload.outcomeDigest, outcome.outcomeDigest);
  assert.ok((await eventStore.list({ runId: 'evolution-evaluation:' + proposal.proposalId })).some((event) => event.kind === 'EvolutionEvaluationRecorded'));
});

test('evolution evaluator runs replay, shadow, canary, promotion and rollback with gates', async () => {
  const registry = new EvolutionRegistry({ idFactory: () => 'id' });
  const proposal = await registry.propose({ candidateId: 'router-v2', version: '2.0.0' });
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evaluator-'));
  const evaluator = new EvolutionEvaluator({ registry, storagePath: join(directory, 'reports.json'), idFactory: () => 'report' });
  const replay = await evaluator.replay({ proposalId: proposal.proposalId, fixtures: fixture });
  assert.equal(replay.decision.passed, true);
  const shadow = await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture });
  assert.equal(shadow.status, 'SHADOW');
  const canary = await evaluator.canary(proposal.proposalId, { eligibleTrafficPercent: 5 });
  assert.equal(canary.record.status, 'CANARY');
  const promoted = await evaluator.promote(proposal.proposalId);
  assert.equal(promoted.record.status, 'ACTIVE');
  const rolledBack = await evaluator.rollback(proposal.proposalId, 'safety regression');
  assert.equal(rolledBack.status, 'ROLLED_BACK');
  await evaluator.flush();
  assert.match(await readFile(join(directory, 'reports.json'), 'utf8'), /datasetDigest/);
});

test('evolution evaluator rejects a candidate with safety regression', async () => {
  const registry = new EvolutionRegistry();
  const proposal = await registry.propose({ candidateId: 'unsafe', version: '1.0.0' });
  const evaluator = new EvolutionEvaluator({ registry });
  const result = await evaluator.shadow({
    proposalId: proposal.proposalId,
    fixtures: [{ baseline: { status: 'SUCCEEDED' }, candidate: { status: 'SUCCEEDED', safetyIncident: true } }]
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(registry.get(proposal.proposalId).status, 'REJECTED');
  assert.ok(result.report.decision.reasonCodes.includes('SAFETY_REGRESSION'));
});

test('promotion can require a passed HOLDOUT dataset fixture', async () => {
  const registry = new EvolutionRegistry({ idFactory: () => 'holdout-proposal' });
  const proposal = await registry.propose({ candidateId: 'holdout-candidate', version: '1.0.0' });
  const evaluator = new EvolutionEvaluator({ registry, idFactory: () => 'holdout-report' });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture, datasetKind: 'DEV' });
  await evaluator.canary(proposal.proposalId, { fixtures: fixture, datasetKind: 'DEV' });
  await assert.rejects(
    evaluator.promote(proposal.proposalId, { requireHoldout: true }),
    /EVOLUTION_HOLDOUT_REQUIRED/
  );
  const holdout = JSON.parse(await readFile(new URL('./fixtures/holdout-dataset.json', import.meta.url), 'utf8'));
  const report = await evaluator.replay({
    proposalId: proposal.proposalId,
    fixtures: holdout.cases,
    datasetKind: holdout.datasetKind,
    datasetVersion: holdout.datasetVersion
  });
  assert.equal(report.datasetKind, 'HOLDOUT');
  assert.equal(report.datasetVersion, '1.0.0');
  assert.equal(report.decision.passed, true);
  assert.match(report.datasetDigest, /^sha256:[0-9a-f]{64}$/u);
  const promoted = await evaluator.promote(proposal.proposalId, { requireHoldout: true });
  assert.equal(promoted.record.status, 'ACTIVE');
  assert.equal(promoted.report.datasetKind, 'HOLDOUT');
  assert.equal(promoted.report.reportId, report.reportId);
  await assert.rejects(
    evaluator.replay({ proposalId: proposal.proposalId, fixtures: fixture, datasetKind: 'TUNING' }),
    /EVOLUTION_DATASET_KIND_INVALID/
  );
});

test('regression dataset fixture passes and a safety regression is rejected', async () => {
  const registry = new EvolutionRegistry({ idFactory: () => 'regression-proposal' });
  const proposal = await registry.propose({ candidateId: 'regression-candidate', version: '1.0.0' });
  const evaluator = new EvolutionEvaluator({ registry, idFactory: () => 'regression-report' });
  const regression = JSON.parse(await readFile(new URL('./fixtures/regression-dataset.json', import.meta.url), 'utf8'));
  const report = await evaluator.replay({
    proposalId: proposal.proposalId,
    fixtures: regression.cases,
    datasetKind: regression.datasetKind,
    datasetVersion: regression.datasetVersion
  });
  assert.equal(report.datasetKind, 'REGRESSION');
  assert.equal(report.datasetVersion, '1.0.0');
  assert.equal(report.decision.passed, true);
  assert.match(report.datasetDigest, /^sha256:[0-9a-f]{64}$/u);
  const failed = await evaluator.replay({
    proposalId: proposal.proposalId,
    fixtures: [{ caseId: 'regression-safety-1', baseline: { status: 'SUCCEEDED' }, candidate: { status: 'SUCCEEDED', safetyIncident: true } }],
    datasetKind: 'REGRESSION',
    datasetVersion: '1.0.0'
  });
  assert.equal(failed.decision.passed, false);
  assert.ok(failed.decision.reasonCodes.includes('SAFETY_REGRESSION'));
});

test('online monitor keeps a canary proposal unchanged until evidence is sufficient', async () => {
  const registry = new EvolutionRegistry();
  const evaluator = new EvolutionEvaluator({ registry });
  const proposal = await registry.propose({ candidateId: 'monitor-candidate', version: '1.0.0' });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture });
  await evaluator.canary(proposal.proposalId, { fixtures: fixture });

  const result = await evaluator.monitor({ proposalId: proposal.proposalId, minSamples: 2 });
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.report.stage, 'ONLINE_MONITOR');
  assert.equal(registry.get(proposal.proposalId).status, 'CANARY');
  assert.ok(result.report.decision.reasonCodes.includes('INSUFFICIENT_EVIDENCE'));
});

test('online monitor rolls back a canary proposal on a proven safety regression', async () => {
  const registry = new EvolutionRegistry();
  const evaluator = new EvolutionEvaluator({ registry });
  const proposal = await registry.propose({ candidateId: 'monitor-unsafe', version: '1.0.0' });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture });
  await evaluator.canary(proposal.proposalId, { fixtures: fixture });
  await evaluator.recordOutcome({
    proposalId: proposal.proposalId,
    runId: 'run-monitor-unsafe',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    safety: 0,
    safetyIncident: true
  });

  const result = await evaluator.monitor({ proposalId: proposal.proposalId, minSamples: 3 });
  assert.equal(result.status, 'ROLLED_BACK');
  assert.equal(result.report.decision.evidenceSufficient, false);
  assert.equal(registry.get(proposal.proposalId).status, 'ROLLED_BACK');
  assert.ok(result.report.decision.reasonCodes.includes('SAFETY_REGRESSION'));
});

test('online monitor waits for enough quality samples before rolling back', async () => {
  const registry = new EvolutionRegistry();
  const evaluator = new EvolutionEvaluator({ registry });
  const proposal = await registry.propose({
    candidateId: 'quality-regression',
    baselineMetrics: { sampleCount: 3, successRate: 1, safetyIncidentCount: 0, costMean: null, latencyMeanMs: null }
  });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture });
  await evaluator.canary(proposal.proposalId, { fixtures: fixture });
  for (let index = 0; index < 3; index += 1) {
    await evaluator.recordOutcome({ proposalId: proposal.proposalId, runId: `quality-${index}`, status: 'FAILED' });
    const result = await evaluator.monitor({ proposalId: proposal.proposalId });
    assert.equal(result.status, index < 2 ? 'INSUFFICIENT_EVIDENCE' : 'ROLLED_BACK');
    assert.equal(registry.get(proposal.proposalId).status, index < 2 ? 'CANARY' : 'ROLLED_BACK');
    assert.ok(result.report.decision.reasonCodes.includes('QUALITY_BELOW_BASELINE'));
  }
});

test('online monitor uses the persisted deployment report baseline for ordinary proposals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-monitor-baseline-'));
  const registry = new EvolutionRegistry({ storagePath: join(directory, 'proposals.json') });
  const evaluator = new EvolutionEvaluator({ registry, storagePath: join(directory, 'reports.json') });
  const proposal = await registry.propose({ candidateId: 'ordinary-candidate' });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: fixture });
  const deployment = await evaluator.canary(proposal.proposalId, { fixtures: fixture });
  // A subsequent unrelated replay must not replace the deployment baseline.
  await evaluator.replay({ proposalId: proposal.proposalId, fixtures: [
    { caseId: 'later', baseline: { status: 'FAILED' }, candidate: { status: 'SUCCEEDED' } }
  ] });
  for (let index = 0; index < 3; index += 1) {
    await evaluator.recordOutcome({ proposalId: proposal.proposalId, runId: `failed-${index}`, status: 'FAILED' });
  }
  await evaluator.flush();
  const restoredRegistry = new EvolutionRegistry({ storagePath: join(directory, 'proposals.json') });
  await restoredRegistry.load();
  const restored = new EvolutionEvaluator({ registry: restoredRegistry, storagePath: join(directory, 'reports.json') });
  const monitored = await restored.monitor({ proposalId: proposal.proposalId });
  assert.deepEqual(monitored.report.baseline, deployment.report.baseline);
  assert.equal(monitored.status, 'ROLLED_BACK');
  assert.ok(monitored.report.decision.reasonCodes.includes('QUALITY_BELOW_BASELINE'));
  await restored.flush();
});

test('credit blame ledger allocates only committed decisions and persists redacted evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-credit-'));
  const ledger = new CreditBlameLedger({ storagePath: join(directory, 'credit.json'), idFactory: () => 'id' });
  const allocations = ledger.record({
    decisions: [
      { decisionId: 'committed-1', runId: 'run-1', role: 'planner', status: 'COMMITTED' },
      { decisionId: 'rejected-1', runId: 'run-1', role: 'executor', status: 'REJECTED' }
    ],
    outcome: { outcomeId: 'outcome-1', status: 'SUCCEEDED', executionEventIds: ['event-1'] }
  });
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0].credit, 1);
  await ledger.flush();
  const restored = new CreditBlameLedger({ storagePath: join(directory, 'credit.json') });
  await restored.load();
  assert.equal(restored.summarize('run-1').recordCount, 1);
  assert.doesNotMatch(await readFile(join(directory, 'credit.json'), 'utf8'), /prompt|reasoning|secret/i);
});

test('credit and blame allocation commits to Harness before cache updates', async () => {
  const eventStore = createHarnessEventStore();
  await eventStore.load();
  const ledger = createCreditBlameLedger({ eventStore, idFactory: () => 'allocation' });
  const records = await ledger.recordDurably({
    decisions: [{ decisionId: 'decision-1', runId: 'credit-run', role: 'planner', status: 'COMMITTED' }],
    outcome: { runId: 'credit-run', outcomeId: 'outcome-1', status: 'FAILED', executionEventIds: ['event-1'] }
  });
  const events = await eventStore.list({ runId: 'credit-run' });
  assert.equal(events[0].kind, 'CreditBlameRecorded');
  assert.equal(events[0].payload.allocations[0].allocationDigest, records[0].allocationDigest);
  assert.equal(ledger.list('credit-run').length, 1);
});

test('records redacted online outcomes without changing proposal state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evaluator-outcome-'));
  const registry = new EvolutionRegistry();
  const proposal = await registry.propose({ candidateId: 'candidate', version: '1.0.0' });
  const evaluator = new EvolutionEvaluator({
    registry,
    storagePath: join(directory, 'reports.json'),
    idFactory: () => 'outcome-id'
  });
  const outcome = await evaluator.recordOutcome({
    runId: 'run-1',
    proposalId: proposal.proposalId,
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    quality: 0.9,
    safety: 1,
    latencyMs: 42,
    sourceEventId: 'event-1'
  });
  await evaluator.flush();
  assert.equal(evaluator.listOutcomes({ runId: 'run-1' }).length, 1);
  assert.equal(registry.get(proposal.proposalId).status, 'PROPOSED');
  assert.doesNotMatch(await readFile(join(directory, 'reports.json'), 'utf8'), /prompt|reasoning|credential|secret/i);
  const restored = new EvolutionEvaluator({ registry, storagePath: join(directory, 'reports.json') });
  await restored.load();
  assert.equal(restored.listOutcomes()[0].outcomeDigest, outcome.outcomeDigest);
});

test('derives an idempotent PROPOSED candidate from a verified outcome only', async () => {
  const registry = new EvolutionRegistry();
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evaluator-derived-'));
  let outcomeSequence = 0;
  const verificationToken = 'test-verification-token';
  const evaluator = new EvolutionEvaluator({
    registry,
    storagePath: join(directory, 'reports.json'),
    idFactory: () => `derived-id-${++outcomeSequence}`,
    verificationToken
  });
  const unverified = await evaluator.recordOutcome({
    runId: 'run-unverified',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    quality: 1,
    safety: 1
  });
  await assert.rejects(
    evaluator.proposeFromOutcome({ outcomeId: unverified.outcomeId }),
    /EVOLUTION_OUTCOME_NOT_VERIFIED/
  );

  const forged = await evaluator.recordOutcome({
    runId: 'run-forged',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: 'wrong-token',
    quality: 1,
    safety: 1
  });
  assert.equal(forged.verified, false);

  const verified = await evaluator.recordOutcome({
    runId: 'run-verified',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken,
    quality: 0.9,
    safety: 1,
    sourceEventId: 'event-completed'
  });
  const first = await evaluator.proposeFromOutcome({ outcomeId: verified.outcomeId });
  assert.equal(first.created, true);
  assert.equal(first.proposal.status, 'PROPOSED');
  assert.equal(first.proposal.candidateType, 'OUTCOME_DERIVED');
  assert.deepEqual(first.proposal.sourceOutcomeIds, [verified.outcomeId]);
  assert.deepEqual(first.proposal.route, {
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test'
  });
  assert.equal(Object.hasOwn(first.proposal, 'prompt'), false);
  assert.equal(Object.hasOwn(first.proposal, 'output'), false);
  assert.equal(Object.hasOwn(first.proposal, 'reasoning'), false);
  assert.equal(Object.hasOwn(first.proposal, 'credential'), false);
  assert.equal(JSON.stringify(first.proposal).match(/prompt|reasoning|credential|api[_-]?key/i), null);

  const second = await evaluator.proposeFromOutcome({ outcomeId: verified.outcomeId });
  assert.equal(second.created, false);
  assert.equal(second.proposal.proposalId, first.proposal.proposalId);
  assert.equal(registry.list().length, 1);
});

test('does not derive a candidate from an outcome marked with a safety incident', async () => {
  const registry = new EvolutionRegistry();
  const evaluator = new EvolutionEvaluator({ registry, verificationToken: 'test-verification-token' });
  const outcome = await evaluator.recordOutcome({
    runId: 'run-unsafe',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: 'test-verification-token',
    safety: 0,
    safetyIncident: true
  });
  await assert.rejects(
    evaluator.proposeFromOutcome({ outcomeId: outcome.outcomeId }),
    /EVOLUTION_OUTCOME_NOT_VERIFIED/
  );
  assert.equal(registry.list().length, 0);
});

test('redacts sensitive route labels and rejects zero-safety outcomes', async () => {
  const registry = new EvolutionRegistry();
  const evaluator = new EvolutionEvaluator({ registry, verificationToken: 'safe-token' });
  const outcome = await evaluator.recordOutcome({
    runId: 'run-sensitive',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'apiKey=should-not-copy',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: 'safe-token',
    safety: 0
  });
  await assert.rejects(
    evaluator.proposeFromOutcome({ outcomeId: outcome.outcomeId }),
    /EVOLUTION_OUTCOME_NOT_VERIFIED/
  );

  const safeOutcome = await evaluator.recordOutcome({
    runId: 'run-sensitive-safe',
    taskClass: 'inspect',
    provider: 'apiKey=provider-label',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: 'safe-token',
    safety: 1
  });
  const generated = await evaluator.proposeFromOutcome({ outcomeId: safeOutcome.outcomeId });
  assert.equal(generated.proposal.route.provider, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(generated.proposal), /apiKey=provider-label/i);
});

test('forms a stable filtered outcome cohort and replay fixtures', async () => {
  const registry = new EvolutionRegistry();
  const proposal = await registry.propose({ candidateId: 'cohort-candidate', version: '1.0.0' });
  let id = 0;
  const evaluator = new EvolutionEvaluator({
    registry,
    idFactory: () => `cohort-${++id}`,
    now: (() => { let value = 1000; return () => value += 1; })()
  });
  await evaluator.recordOutcome({
    runId: 'run-a', taskClass: 'inspect', provider: 'openai', protocol: 'responses', model: 'gpt-a',
    status: 'SUCCEEDED', quality: 0.9, safety: 1
  });
  await evaluator.recordOutcome({
    runId: 'run-b', taskClass: 'inspect', provider: 'openai', protocol: 'responses', model: 'gpt-a',
    status: 'FAILED', quality: 0.2, safety: 1
  });
  await evaluator.recordOutcome({
    runId: 'run-c', taskClass: 'build', provider: 'openai', protocol: 'responses', model: 'gpt-a',
    status: 'SUCCEEDED', quality: 1, safety: 1
  });

  const cohort = evaluator.cohort({ taskClass: 'inspect', provider: 'openai', protocol: 'responses' });
  assert.equal(cohort.outcomes.length, 2);
  assert.equal(cohort.metrics.sampleCount, 2);
  assert.equal(cohort.metrics.successRate, 0.5);
  assert.equal(cohort.cohortId, evaluator.cohort({ taskClass: 'inspect', provider: 'openai', protocol: 'responses' }).cohortId);
  assert.deepEqual(cohort.outcomeIds, cohort.outcomes.map((outcome) => outcome.outcomeId));

  const fixtures = evaluator.fixturesFromOutcomes({ taskClass: 'inspect', limit: 1 });
  assert.equal(fixtures.length, 1);
  assert.equal(fixtures[0].baseline.outcomeId, cohort.outcomes[1].outcomeId);
  assert.equal(Object.hasOwn(fixtures[0], 'prompt'), false);
  const report = await evaluator.replay({
    proposalId: proposal.proposalId,
    fixtures,
    evaluator: async () => ({ status: 'SUCCEEDED' })
  });
  assert.equal(report.baseline.sampleCount, 1);
  assert.equal(report.candidate.successRate, 1);
});
