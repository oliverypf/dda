import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { EvolutionControlStore } from '../src/evolution-control.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';

test('evolution kill switch is durable, idempotent and fail-closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const control = new EvolutionControlStore({ eventStore });
  await control.load();
  assert.equal(control.state().enabled, true);

  const killed = await control.kill({ reason: 'release drill', actor: 'release-operator' });
  assert.equal(killed.idempotent, false);
  assert.equal(control.state().enabled, false);
  assert.equal(control.state().reason, 'release drill');
  const repeated = await control.kill();
  assert.equal(repeated.idempotent, true);

  const registry = new EvolutionRegistry({ eventStore });
  await registry.load();
  const evaluator = new EvolutionEvaluator({ registry, eventStore, control });
  await evaluator.load();
  const proposal = await registry.propose({ candidateId: 'killed-candidate', version: '1.0.0' });
  await assert.rejects(
    () => evaluator.replay({ proposalId: proposal.proposalId, fixtures: [{ caseId: 'case', candidate: { status: 'SUCCEEDED' } }] }),
    /EVOLUTION_CONTROL_KILLED:REPLAY/
  );
  await assert.rejects(
    () => evaluator.recordOutcome({ runId: 'run-killed', taskClass: 'inspect', provider: 'fixture', protocol: 'test', model: 'fixture', status: 'SUCCEEDED' }),
    /EVOLUTION_CONTROL_KILLED:OUTCOME_RECORD/
  );
  await registry.transition(proposal.proposalId, 'VALIDATING');
  await registry.transition(proposal.proposalId, 'SHADOW');
  await registry.transition(proposal.proposalId, 'CANARY');
  const rollback = await evaluator.rollback(proposal.proposalId, 'kill switch drill');
  assert.equal(rollback.status, 'ROLLED_BACK');

  const enabled = await control.enable({ reason: 'operator recovery' });
  assert.equal(enabled.idempotent, false);
  assert.equal(control.state().enabled, true);
  const restored = new EvolutionControlStore({ eventStore });
  await restored.load();
  assert.equal(restored.state().enabled, true);
  assert.equal(restored.state().reason, 'operator recovery');
  assert.ok((await eventStore.list({ aggregateType: 'EvolutionControl' })).length === 2);
});

test('online monitoring detects proposal version drift and rolls back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-drift-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'events.db') });
  await eventStore.load();
  const control = new EvolutionControlStore({ eventStore });
  await control.load();
  const registry = new EvolutionRegistry({ eventStore });
  await registry.load();
  const evaluator = new EvolutionEvaluator({ registry, eventStore, control });
  await evaluator.load();
  const proposal = await registry.propose({
    candidateId: 'drift-candidate',
    version: '1.0.0',
    packageDigest: 'sha256:' + 'a'.repeat(64),
    baselineMetrics: { sampleCount: 1, successCount: 1, successRate: 1 }
  });
  await evaluator.shadow({
    proposalId: proposal.proposalId,
    fixtures: [{ caseId: 'case', candidate: { status: 'SUCCEEDED' } }]
  });
  await evaluator.canary(proposal.proposalId, {});
  await evaluator.recordOutcome({
    runId: 'run-drift',
    proposalId: proposal.proposalId,
    taskClass: 'inspect',
    provider: 'fixture',
    protocol: 'test',
    model: 'fixture',
    modelVersion: 'fixture@2',
    pluginVersion: 'drift-candidate@1.0.0',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: undefined
  });
  const healthy = await evaluator.monitor({ proposalId: proposal.proposalId, minSamples: 1, expectedVersion: '1.0.0', expectedPackageDigest: 'sha256:' + 'a'.repeat(64) });
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.report.decision.reasonCodes.includes('VERSION_DRIFT'), false);

  const drifted = await evaluator.monitor({ proposalId: proposal.proposalId, minSamples: 1, expectedVersion: '1.0.1' });
  assert.equal(drifted.status, 'ROLLED_BACK');
  assert.equal(drifted.proposal.status, 'ROLLED_BACK');
  assert.equal(drifted.report.decision.reasonCodes.includes('VERSION_DRIFT'), true);
  assert.ok(drifted.report.reportDigest.startsWith('sha256:'));
});
