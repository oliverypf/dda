import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createTrajectoryStore } from '../src/trajectory-store.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';

const run = (args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const parse = (result) => JSON.parse(result.stdout.trim());

const manifest = {
  schemaVersion: '1.0',
  id: 'com.example.cli-fixture',
  name: 'CLI Fixture',
  version: '1.0.0',
  contributions: [{
    id: 'com.example.cli-fixture.contribution',
    type: 'skill',
    capabilities: [],
    permissions: []
  }]
};

test('plugin CLI persists governance and only loads ACTIVE plugins', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-cli-'));
  const pluginRoot = join(root, 'plugins');
  const entryPath = join(pluginRoot, 'fixture.mjs');
  const manifestPath = join(root, 'plugin.json');
  const governancePath = join(root, 'plugin-governance.json');
  const evolutionPath = join(root, 'evolution-proposals.json');
  const evaluationPath = join(root, 'evolution-evaluations.json');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(entryPath, 'export const createPlugin = () => {}\n', 'utf8');
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  const env = {
    HMCODEX_PLUGIN_GOVERNANCE_STORE: governancePath,
    HMCODEX_PLUGIN_ROOT: pluginRoot,
    HMCODEX_EVOLUTION_STORE: evolutionPath,
    HMCODEX_EVALUATION_STORE: evaluationPath
  };

  const discovered = await run([
    'plugin', 'discover', '--manifest-path', manifestPath, '--entry-path', 'fixture.mjs'
  ], env);
  assert.equal(discovered.code, 0, `${discovered.stderr}\n${discovered.stdout}`);
  const discoveredPayload = parse(discovered);
  assert.equal(discoveredPayload.ok, true);
  assert.equal(discoveredPayload.plugin.pluginId, manifest.id);
  assert.equal(discoveredPayload.plugin.state, 'DISCOVERED');

  const beforeActive = await run(['plugin', 'load', '--plugin-id', manifest.id], env);
  assert.equal(beforeActive.code, 1);
  assert.equal(parse(beforeActive).error, 'PLUGIN_NOT_ACTIVE:DISCOVERED');

  const listed = await run(['plugin', 'list'], env);
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  assert.equal(parse(listed).plugins[0].state, 'DISCOVERED');

  const validated = await run(['plugin', 'validate', '--plugin-id', manifest.id], env);
  assert.equal(validated.code, 0, `${validated.stderr}\n${validated.stdout}`);
  assert.equal(parse(validated).plugin.state, 'VALIDATING');
  for (const state of ['INSTALLED', 'ENABLED']) {
    const transitioned = await run([
      'plugin', '--operation', 'transition', '--plugin-id', manifest.id, '--state', state,
      '--metadata', JSON.stringify({ source: 'cli-test', nonce: randomUUID() })
    ], env);
    assert.equal(transitioned.code, 0, `${transitioned.stderr}\n${transitioned.stdout}`);
    assert.equal(parse(transitioned).plugin.state, state);
  }

  const evolutionRegistry = new EvolutionRegistry({ storagePath: evolutionPath });
  await evolutionRegistry.load();
  const evaluator = new EvolutionEvaluator({ registry: evolutionRegistry, storagePath: evaluationPath });
  await evaluator.load();
  const proposal = await evolutionRegistry.propose({
    candidateId: manifest.id,
    pluginId: manifest.id,
    packageDigest: discoveredPayload.plugin.packageDigest,
    version: manifest.version
  });
  const fixtures = [{ caseId: 'plugin-cli-case', baseline: { status: 'FAILED' }, candidate: { status: 'SUCCEEDED' } }];
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures });
  await evaluator.canary(proposal.proposalId, { fixtures, eligibleTrafficPercent: 5 });
  await evaluator.promote(proposal.proposalId);
  const report = evaluator.latest(proposal.proposalId, 'CANARY');
  assert.ok(report);
  const active = await run([
    'plugin', '--operation', 'transition', '--plugin-id', manifest.id, '--state', 'ACTIVE',
    '--metadata', JSON.stringify({
      source: 'cli-test',
      evaluation: {
        reportId: report.reportId,
        reportDigest: report.reportDigest,
        pluginId: manifest.id,
        packageDigest: discoveredPayload.plugin.packageDigest
      }
    })
  ], env);
  assert.equal(active.code, 0, `${active.stderr}\n${active.stdout}`);
  assert.equal(parse(active).plugin.state, 'ACTIVE');

  const loaded = await run(['plugin', 'load', '--plugin-id', manifest.id], env);
  assert.equal(loaded.code, 0, `${loaded.stderr}\n${loaded.stdout}`);
  const loadedPayload = parse(loaded);
  assert.equal(loadedPayload.ok, true);
  assert.equal(loadedPayload.plugin.state, 'ACTIVE');
  assert.equal(loadedPayload.loaded.pluginId, manifest.id);
  assert.equal(loadedPayload.registry[0].id, manifest.id);

  const persisted = JSON.parse(await readFile(governancePath, 'utf8'));
  assert.equal(persisted.plugins[0].state, 'ACTIVE');
  assert.equal(persisted.plugins[0].history.length, 4);
});

test('plugin CLI rejects malformed metadata and missing plugin identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-plugin-cli-errors-'));
  const env = { HMCODEX_PLUGIN_GOVERNANCE_STORE: join(root, 'plugins.json') };
  const missingId = await run(['plugin', 'transition', '--state', 'ACTIVE'], env);
  assert.equal(missingId.code, 1);
  assert.equal(parse(missingId).error, 'PLUGIN_ID_REQUIRED');
  const malformedMetadata = await run([
    'plugin', 'transition', '--plugin-id', 'missing', '--state', 'ACTIVE', '--metadata', '[]'
  ], env);
  assert.equal(malformedMetadata.code, 1);
  assert.equal(parse(malformedMetadata).error, 'PLUGIN_METADATA_INVALID');
});

test('evolution CLI cannot bypass evaluator promotion gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-cli-gate-'));
  const proposalPath = join(root, 'proposals.json');
  const evaluationPath = join(root, 'evaluations.json');
  const registry = new EvolutionRegistry({ storagePath: proposalPath });
  const proposal = await registry.propose({ candidateId: 'candidate', version: '1.0.0' });
  await registry.transition(proposal.proposalId, 'VALIDATING');
  await registry.transition(proposal.proposalId, 'SHADOW');
  await registry.transition(proposal.proposalId, 'CANARY');

  const attempted = await run([
    'evolution', 'transition', '--proposal-id', proposal.proposalId, '--state', 'ACTIVE'
  ], {
    HMCODEX_EVOLUTION_STORE: proposalPath,
    HMCODEX_EVALUATION_STORE: evaluationPath
  });
  assert.equal(attempted.code, 1);
  assert.equal(parse(attempted).error, 'EVOLUTION_PROMOTION_REQUIRED');

  const restored = new EvolutionRegistry({ storagePath: proposalPath });
  await restored.load();
  assert.equal(restored.get(proposal.proposalId).status, 'CANARY');
});

test('evolution CLI requires a passed HOLDOUT dataset for holdout-gated promotion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-cli-holdout-'));
  const proposalPath = join(root, 'proposals.json');
  const evaluationPath = join(root, 'evaluations.json');
  const devFixturePath = join(root, 'dev-fixture.json');
  const holdoutPath = join(root, 'holdout-dataset.json');
  await writeFile(devFixturePath, JSON.stringify([
    { caseId: 'dev-1', baseline: { status: 'FAILED' }, candidate: { status: 'SUCCEEDED' } }
  ]));
  const holdout = JSON.parse(await readFile(new URL('./fixtures/holdout-dataset.json', import.meta.url), 'utf8'));
  await writeFile(holdoutPath, JSON.stringify(holdout));
  const registry = new EvolutionRegistry({ storagePath: proposalPath });
  const proposal = await registry.propose({ candidateId: 'holdout-cli', version: '1.0.0' });
  await registry.transition(proposal.proposalId, 'VALIDATING');
  await registry.transition(proposal.proposalId, 'SHADOW');
  await registry.transition(proposal.proposalId, 'CANARY');
  const env = {
    HMCODEX_EVOLUTION_STORE: proposalPath,
    HMCODEX_EVALUATION_STORE: evaluationPath,
    HMCODEX_HARNESS_EVENT_STORE: join(root, 'events.db')
  };
  const blocked = await run([
    'evolution', 'promote', '--proposal-id', proposal.proposalId,
    '--fixtures', devFixturePath, '--require-holdout'
  ], env);
  assert.equal(blocked.code, 1, `${blocked.stderr}\n${blocked.stdout}`);
  assert.equal(parse(blocked).error, 'EVOLUTION_HOLDOUT_REQUIRED');
  const replay = await run([
    'evolution', 'replay', '--proposal-id', proposal.proposalId, '--fixtures', holdoutPath
  ], env);
  assert.equal(replay.code, 0, `${replay.stderr}\n${replay.stdout}`);
  assert.equal(parse(replay).report.datasetKind, 'HOLDOUT');
  const promoted = await run([
    'evolution', 'promote', '--proposal-id', proposal.proposalId, '--require-holdout'
  ], env);
  assert.equal(promoted.code, 0, `${promoted.stderr}\n${promoted.stdout}`);
  const payload = parse(promoted);
  assert.equal(payload.record.status, 'ACTIVE');
  assert.equal(payload.report.datasetKind, 'HOLDOUT');
});

test('evolution CLI derives a PROPOSED candidate from a persisted verified outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-evolution-cli-outcome-'));
  const proposalPath = join(root, 'proposals.json');
  const evaluationPath = join(root, 'evaluations.json');
  const registry = new EvolutionRegistry({ storagePath: proposalPath });
  await registry.load();
  const evaluator = new EvolutionEvaluator({
    registry,
    storagePath: evaluationPath,
    verificationToken: 'cli-verification-token'
  });
  await evaluator.load();
  const outcome = await evaluator.recordOutcome({
    runId: 'run-cli-derived',
    taskClass: 'inspect',
    provider: 'openai',
    protocol: 'responses',
    model: 'gpt-test',
    status: 'SUCCEEDED',
    verified: true,
    verificationToken: 'cli-verification-token',
    quality: 1,
    safety: 1,
    sourceEventId: 'event-cli-derived'
  });
  await evaluator.flush();

  const generated = await run([
    'evolution', 'propose-from-outcome', '--outcome-id', outcome.outcomeId
  ], {
    HMCODEX_EVOLUTION_STORE: proposalPath,
    HMCODEX_EVALUATION_STORE: evaluationPath
  });
  assert.equal(generated.code, 0, `${generated.stderr}\n${generated.stdout}`);
  const payload = parse(generated);
  assert.equal(payload.ok, true);
  assert.equal(payload.created, true);
  assert.equal(payload.proposal.status, 'PROPOSED');
  assert.deepEqual(payload.proposal.sourceOutcomeIds, [outcome.outcomeId]);
  assert.equal(Object.hasOwn(payload.proposal, 'prompt'), false);

  const persisted = JSON.parse(await readFile(proposalPath, 'utf8'));
  assert.equal(persisted.proposals.length, 1);
  assert.equal(persisted.proposals[0].status, 'PROPOSED');
  assert.doesNotMatch(JSON.stringify(persisted), /prompt|reasoning|credential|api[_-]?key/i);
});

test('memory CLI requires source event ids to exist in the trajectory and match the run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-memory-cli-sources-'));
  const memoryPath = join(root, 'memory.json');
  const trajectoryPath = join(root, 'trajectory.jsonl');
  const trajectory = createTrajectoryStore(trajectoryPath);
  const event = await trajectory.append({ runId: 'run-source', kind: 'TaskRunCompleted', payload: { status: 'SUCCEEDED' } });
  const env = {
    HMCODEX_MEMORY_STORE: memoryPath,
    HMCODEX_TRAJECTORY_STORE: trajectoryPath
  };

  const missing = await run([
    'memory', 'propose', '--run-id', 'run-source', '--statement', 'missing source',
    '--source-event-ids', JSON.stringify(['event-missing'])
  ], env);
  assert.equal(missing.code, 1);
  assert.match(parse(missing).error, /^MEMORY_SOURCE_NOT_FOUND:/);

  const mismatch = await run([
    'memory', 'propose', '--run-id', 'other-run', '--statement', 'wrong run',
    '--source-event-ids', JSON.stringify([event.eventId])
  ], env);
  assert.equal(mismatch.code, 1);
  assert.equal(parse(mismatch).error, 'MEMORY_SOURCE_RUN_MISMATCH');

  const accepted = await run([
    'memory', 'propose', '--run-id', 'run-source', '--statement', 'verified source',
    '--source-event-ids', JSON.stringify([event.eventId])
  ], env);
  assert.equal(accepted.code, 0, `${accepted.stderr}\n${accepted.stdout}`);
  assert.equal(parse(accepted).memory.sourceEventIds[0], event.eventId);
});
