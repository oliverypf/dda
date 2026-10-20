/**
 * S6 evolution cohort / verified / no-auto-ACTIVE — freeze lock tests.
 * Freeze: freeze-evolution-cohort-r1.md (baseline master dd1c6c5).
 * Prefer locking existing evolution-control / evaluator / registry / MemoryVerifier.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { EvolutionControlStore } from '../src/evolution-control.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';
import { MemoryVerifier } from '../src/memory-verifier.mjs';
import { MemoryJournal } from '../src/memory-journal.mjs';

const fixture = [
  { caseId: 'case-1', baseline: { status: 'FAILED', cost: 1, latencyMs: 100 }, candidate: { status: 'SUCCEEDED', cost: 1, latencyMs: 110 } },
  { caseId: 'case-2', baseline: { status: 'SUCCEEDED', cost: 1, latencyMs: 100 }, candidate: { status: 'SUCCEEDED', cost: 1, latencyMs: 90 } }
];

const greenFixtures = fixture;
const unsafeFixtures = [
  { caseId: 'unsafe-1', baseline: { status: 'SUCCEEDED' }, candidate: { status: 'SUCCEEDED', safetyIncident: true } }
];

async function makeStack({ verificationToken = 's6-token', withControl = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dda-s6-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const control = withControl ? new EvolutionControlStore({ eventStore }) : undefined;
  if (control) await control.load();
  const registry = new EvolutionRegistry({ eventStore, idFactory: () => `s6-${Math.random().toString(16).slice(2, 10)}` });
  await registry.load();
  const evaluator = new EvolutionEvaluator({
    registry,
    eventStore,
    control,
    verificationToken,
    idFactory: () => `s6-${Math.random().toString(16).slice(2, 10)}`
  });
  await evaluator.load();
  return { directory, eventStore, control, registry, evaluator, verificationToken };
}

test('T-s6-1 unverified outcome → proposeFromOutcome throws EVOLUTION_OUTCOME_NOT_VERIFIED', async (t) => {
  const { directory, evaluator } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unverified = await evaluator.recordOutcome({
    runId: 'run-uv',
    taskClass: 'inspect',
    provider: 'fixture',
    protocol: 'test',
    model: 'fixture',
    status: 'SUCCEEDED',
    verified: false,
    quality: 1,
    safety: 1
  });
  assert.equal(unverified.verified, false);
  await assert.rejects(
    () => evaluator.proposeFromOutcome({ outcomeId: unverified.outcomeId }),
    /EVOLUTION_OUTCOME_NOT_VERIFIED/
  );
});

test('T-s6-2 verified SUCCEEDED → PROPOSED only; never auto ACTIVE', async (t) => {
  const { directory, evaluator, registry, verificationToken } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const verified = await evaluator.recordOutcome({
    runId: 'run-ok',
    taskClass: 'inspect',
    provider: 'fixture',
    protocol: 'test',
    model: 'fixture',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken,
    quality: 0.95,
    safety: 1
  });
  assert.equal(verified.verified, true);
  const generated = await evaluator.proposeFromOutcome({ outcomeId: verified.outcomeId });
  assert.equal(generated.created, true);
  assert.equal(generated.proposal.status, 'PROPOSED');
  assert.notEqual(generated.proposal.status, 'ACTIVE');
  assert.equal(registry.get(generated.proposal.proposalId).status, 'PROPOSED');
  // Single verified success must not jump the ladder.
  await assert.rejects(
    () => evaluator.promote(generated.proposal.proposalId),
    /EVOLUTION_PROMOTION_STATE_INVALID/
  );
  assert.equal(registry.get(generated.proposal.proposalId).status, 'PROPOSED');
});

test('T-s6-3 control kill → recordOutcome / promote fail with EVOLUTION_CONTROL_KILLED', async (t) => {
  const { directory, evaluator, registry, control, verificationToken } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const proposal = await registry.propose({ candidateId: 'kill-candidate', version: '1.0.0' });
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures: greenFixtures });
  await evaluator.canary(proposal.proposalId, { fixtures: greenFixtures });
  assert.equal(registry.get(proposal.proposalId).status, 'CANARY');

  await control.kill({ reason: 's6-drill', actor: 's6-test' });
  assert.equal(control.state().enabled, false);

  await assert.rejects(
    () => evaluator.recordOutcome({
      runId: 'run-killed',
      taskClass: 'inspect',
      provider: 'fixture',
      protocol: 'test',
      model: 'fixture',
      status: 'SUCCEEDED',
      verified: true,
      verificationToken
    }),
    /EVOLUTION_CONTROL_KILLED:OUTCOME_RECORD/
  );
  await assert.rejects(
    () => evaluator.promote(proposal.proposalId),
    /EVOLUTION_CONTROL_KILLED:PROMOTION/
  );
  // Kill must not be bypassable by a green canary still sitting in registry.
  assert.equal(registry.get(proposal.proposalId).status, 'CANARY');
});

test('T-s6-4 promote only CANARY+green+control → ACTIVE; else fail', async (t) => {
  const { directory, evaluator, registry } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));

  const proposed = await registry.propose({ candidateId: 'promo-candidate', version: '1.0.0' });
  await assert.rejects(
    () => evaluator.promote(proposed.proposalId),
    /EVOLUTION_PROMOTION_STATE_INVALID/
  );

  await evaluator.shadow({ proposalId: proposed.proposalId, fixtures: greenFixtures });
  assert.equal(registry.get(proposed.proposalId).status, 'SHADOW');
  await assert.rejects(
    () => evaluator.promote(proposed.proposalId),
    /EVOLUTION_PROMOTION_STATE_INVALID/
  );

  await evaluator.canary(proposed.proposalId, { fixtures: greenFixtures });
  assert.equal(registry.get(proposed.proposalId).status, 'CANARY');

  // Green canary + control enabled → ACTIVE.
  const promoted = await evaluator.promote(proposed.proposalId);
  assert.equal(promoted.record.status, 'ACTIVE');
  assert.equal(registry.get(proposed.proposalId).status, 'ACTIVE');

  // Separate proposal: canary with safety regression report must reject promote.
  const unsafe = await registry.propose({ candidateId: 'unsafe-promo', version: '1.0.0' });
  // Shadow with green first so we can reach CANARY, then feed a failing promotion report.
  await evaluator.shadow({ proposalId: unsafe.proposalId, fixtures: greenFixtures });
  await evaluator.canary(unsafe.proposalId, { fixtures: greenFixtures });
  await assert.rejects(
    () => evaluator.promote(unsafe.proposalId, { fixtures: unsafeFixtures }),
    /EVOLUTION_PROMOTION_REJECTED/
  );
  assert.equal(registry.get(unsafe.proposalId).status, 'CANARY');
});

test('T-s6-5 cohort is readonly — proposal status unchanged', async (t) => {
  const { directory, evaluator, registry, verificationToken } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const proposal = await registry.propose({ candidateId: 'cohort-ro', version: '1.0.0' });
  await evaluator.recordOutcome({
    runId: 'run-cohort',
    proposalId: proposal.proposalId,
    taskClass: 'inspect',
    provider: 'fixture',
    protocol: 'test',
    model: 'fixture',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken,
    safety: 1
  });
  const before = registry.get(proposal.proposalId).status;
  assert.equal(before, 'PROPOSED');
  const cohort = evaluator.cohort({ proposalId: proposal.proposalId });
  assert.ok(cohort.outcomes.length >= 1);
  assert.equal(registry.get(proposal.proposalId).status, before);
  const fixtures = evaluator.fixturesFromOutcomes({ proposalId: proposal.proposalId });
  assert.ok(fixtures.length >= 1);
  assert.equal(registry.get(proposal.proposalId).status, before);
  // Unverified outcomes may appear in cohort for audit, but cannot propose.
  const unverified = await evaluator.recordOutcome({
    runId: 'run-cohort-uv',
    taskClass: 'inspect',
    provider: 'fixture',
    protocol: 'test',
    model: 'fixture',
    status: 'SUCCEEDED'
  });
  const mixed = evaluator.cohort({ taskClass: 'inspect' });
  assert.ok(mixed.outcomeIds.includes(unverified.outcomeId));
  await assert.rejects(
    () => evaluator.proposeFromOutcome({ outcomeId: unverified.outcomeId }),
    /EVOLUTION_OUTCOME_NOT_VERIFIED/
  );
});

test('T-s6-6 Memory without sourceEventIds → SOURCE_REQUIRED / accepted:false; not ACTIVE', async () => {
  const verifier = new MemoryVerifier();
  const reports = verifier.verify({
    sourceEvents: [{ eventId: 'event-1' }],
    existingMemories: [],
    candidates: [
      { statement: 'fact without sources', scope: 'workspace' },
      { statement: 'fact with empty sources', sourceEventIds: [], scope: 'workspace' },
      { statement: 'sourced fact', sourceEventIds: ['event-1'], scope: 'workspace' }
    ]
  });
  assert.equal(reports[0].verification.accepted, false);
  assert.ok(reports[0].verification.codes.includes('SOURCE_REQUIRED'));
  assert.equal(reports[1].verification.accepted, false);
  assert.ok(reports[1].verification.codes.includes('SOURCE_REQUIRED'));
  assert.equal(reports[2].verification.accepted, true);

  const journal = new MemoryJournal();
  const orphan = journal.propose({ runId: 'run-1', statement: 'unattributed fact' });
  assert.deepEqual(orphan.sourceEventIds, []);
  assert.equal(orphan.status, 'PROPOSED');
  assert.throws(() => journal.verify(orphan.memoryId, { accepted: true }), /MEMORY_SOURCE_REQUIRED/);
  assert.throws(() => journal.activate(orphan.memoryId), /MEMORY_NOT_VERIFIED/);
  assert.equal(journal.list('ACTIVE').length, 0);
  assert.notEqual(journal.get(orphan.memoryId).status, 'ACTIVE');
});

test('T-s6-7 sensitive fields must not enter proposal candidates', async (t) => {
  const { directory, evaluator, registry, verificationToken } = await makeStack();
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    () => registry.propose({ candidateId: 'bad', apiKey: 'sk-live-do-not-store', password: 'secret' }),
    /EVOLUTION_SENSITIVE_FIELD/
  );

  const sensitive = await evaluator.recordOutcome({
    runId: 'run-sens',
    taskClass: 'inspect',
    provider: 'apiKey=should-redact',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken,
    safety: 1
  });
  const generated = await evaluator.proposeFromOutcome({ outcomeId: sensitive.outcomeId });
  assert.equal(generated.proposal.status, 'PROPOSED');
  assert.equal(generated.proposal.route.provider, '[REDACTED]');
  const blob = JSON.stringify(generated.proposal);
  assert.doesNotMatch(blob, /apiKey=should-redact/i);
  assert.equal(Object.hasOwn(generated.proposal, 'prompt'), false);
  assert.equal(Object.hasOwn(generated.proposal, 'reasoning'), false);
  assert.equal(Object.hasOwn(generated.proposal, 'credential'), false);
  assert.equal(Object.hasOwn(generated.proposal, 'output'), false);
});

test('T-s6-index index.mjs has no post-pass / soft-fail auto-promote to ACTIVE', async () => {
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), '../src/index.mjs');
  const source = await readFile(indexPath, 'utf8');
  // The only promote invocation must be the explicit evolution CLI operation.
  const promoteCalls = [...source.matchAll(/\.promote\s*\(/g)];
  assert.equal(promoteCalls.length, 1, 'expected exactly one .promote( call (CLI)');
  const promoteIdx = source.indexOf('.promote(');
  const cliGuard = source.lastIndexOf("if (operation === 'promote')", promoteIdx);
  assert.ok(cliGuard !== -1 && cliGuard < promoteIdx, 'promote must sit inside evolution CLI operation branch');

  // Auto proposal is opt-in and only creates PROPOSED via proposeFromOutcome.
  assert.match(source, /autoEvolutionProposal && recordedOutcome\?\.verified === true/);
  assert.match(source, /parseBoolean\(process\.env\.DDA_AUTO_EVOLUTION_PROPOSAL,\s*false\)/);
  // softFailPostPassTelemetry / post-pass must not call promote.
  assert.doesNotMatch(source, /softFailPostPassTelemetry[\s\S]{0,400}\.promote\s*\(/);
  assert.doesNotMatch(source, /recordTaskOutcome[\s\S]{0,800}evaluator\.promote|evolutionEvaluator\.promote/);
});
