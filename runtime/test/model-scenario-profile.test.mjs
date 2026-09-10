import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelScenarioProfileRegistry } from '../src/model-scenario-profile.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createFeedbackRegistry } from '../src/feedback-registry.mjs';
const execFileAsync = promisify(execFile);

const sample = (overrides = {}) => ({
  outcomeId: 'outcome-1',
  independenceKey: 'outcome-1',
  scenarioKey: 'sha256:' + 'a'.repeat(64),
  candidateKey: 'provider/protocol/model/v1/planner/plugin',
  modelRegistryDigest: 'sha256:' + 'b'.repeat(64),
  policyVersion: 'runtime-safety-1',
  dimensions: { objectiveSuccess: true, verifierPass: true, userSatisfaction: 1, safetyIncident: false },
  ...overrides
});

test('rebuilds a persistent model-scenario profile projection from feedback samples', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-profile-'));
  const registry = createModelScenarioProfileRegistry({ storagePath: join(directory, 'profiles.json'), now: () => 100 });
  const result = await registry.rebuild({ samples: [sample()] });
  assert.equal(result.profiles.length, 1);
  assert.equal(result.profiles[0].status, 'SHADOW_ONLY');
  assert.equal(registry.list().length, 1);
  const reopened = createModelScenarioProfileRegistry({ storagePath: join(directory, 'profiles.json') });
  await reopened.load();
  assert.equal(reopened.list()[0].profileDigest.startsWith('sha256:'), true);
});

test('replays a committed model-scenario projection without a JSON cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-profile-harness-'));
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'harness.json') });
  await eventStore.load();
  const registry = createModelScenarioProfileRegistry({ eventStore, now: () => 100 });
  await registry.rebuild({ samples: [sample()] });
  const reopenedStore = createHarnessEventStore({ storagePath: join(directory, 'harness.json') });
  await reopenedStore.load();
  const reopened = createModelScenarioProfileRegistry({ eventStore: reopenedStore });
  await reopened.load();
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.list()[0].profileDigest, registry.list()[0].profileDigest);
});

test('model-profile CLI rebuilds into the configured Harness store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-profile-cli-'));
  const feedbackPath = join(directory, 'feedback.json');
  const profilePath = join(directory, 'profiles.json');
  const harnessPath = join(directory, 'harness.json');
  const feedback = createFeedbackRegistry({ storagePath: feedbackPath, now: () => 100 });
  await feedback.submit({
    runId: 'run-cli-profile', taskId: 'task-cli-profile', threadId: 'thread-cli-profile', decisionId: 'decision-cli-profile', outcomeId: 'outcome-cli-profile',
    modelIdentity: { provider: 'openai', protocol: 'responses', model: 'model-a', modelVersion: 'v1', modelRegistryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'planner', pluginVersion: 'plugin-v1' },
    scenario: { taskClass: 'READ', riskClass: 'LOW', operationClass: 'ANALYZE', requiredCapabilities: ['workspace.read'], workspaceCapabilityClass: 'READ_ONLY', platform: 'WINDOWS', policyClass: 'phase1' },
    sourceType: 'USER', dimensions: { rating: 5, objectiveSuccess: true, verifierPass: true, quality: 1, safetyIncident: false, usable: true }, reasonCodes: ['RESULT_EXCELLENT'], evidenceRefs: ['event-cli-profile']
  });
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, 'model-profile', 'rebuild', '--feedback-store', feedbackPath, '--profile-store', profilePath, '--harness-event-store', harnessPath], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  const store = createHarnessEventStore({ storagePath: harnessPath });
  await store.load();
  assert.equal((await store.list({ kind: 'ModelScenarioScoreProjected' })).length, 1);
});

test('model-profile CLI falls back to Harness feedback summaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-profile-durable-cli-'));
  const harnessPath = join(directory, 'harness.json');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const feedback = createFeedbackRegistry({ eventStore, now: () => 100 });
  await feedback.submit({
    runId: 'run-durable-profile', outcomeId: 'outcome-durable-profile', modelIdentity: { provider: 'openai', protocol: 'responses', model: 'model-a', modelVersion: 'v1', modelRegistryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'planner', pluginVersion: 'plugin-v1' },
    scenario: { taskClass: 'READ', riskClass: 'LOW', operationClass: 'ANALYZE', requiredCapabilities: ['workspace.read'], workspaceCapabilityClass: 'READ_ONLY', platform: 'WINDOWS', policyClass: 'phase1' },
    sourceType: 'USER', dimensions: { objectiveSuccess: true, verifierPass: true, userSatisfaction: 1, safetyIncident: false }, evidenceRefs: ['durable-profile']
  });
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, 'model-profile', 'rebuild', '--feedback-store', join(directory, 'missing-feedback.json'), '--profile-store', join(directory, 'profiles.json'), '--harness-event-store', harnessPath], { windowsHide: true });
  assert.equal(JSON.parse(stdout).profileCount, 1);
});

test('model-profile CLI excludes retracted Harness feedback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-model-profile-retracted-cli-'));
  const harnessPath = join(directory, 'harness.json');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const feedback = createFeedbackRegistry({ eventStore, now: () => 100 });
  const submitted = await feedback.submit({
    runId: 'run-retracted-profile', outcomeId: 'outcome-retracted-profile', modelIdentity: { provider: 'openai', protocol: 'responses', model: 'model-a', modelVersion: 'v1', modelRegistryDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'planner', pluginVersion: 'plugin-v1' },
    scenario: { taskClass: 'READ', riskClass: 'LOW', operationClass: 'ANALYZE', requiredCapabilities: ['workspace.read'], workspaceCapabilityClass: 'READ_ONLY', platform: 'WINDOWS', policyClass: 'phase1' },
    sourceType: 'USER', dimensions: { objectiveSuccess: true, verifierPass: true, userSatisfaction: 1, safetyIncident: false }, evidenceRefs: ['retracted-profile']
  });
  await feedback.retract(submitted.feedback.feedbackId);
  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const { stdout } = await execFileAsync(process.execPath, [cli, 'model-profile', 'rebuild', '--feedback-store', join(directory, 'missing-feedback.json'), '--profile-store', join(directory, 'profiles.json'), '--harness-event-store', harnessPath], { windowsHide: true });
  assert.equal(JSON.parse(stdout).profileCount, 0);
});

test('does not expose a model profile when durable projection is not committed', async () => {
  const registry = createModelScenarioProfileRegistry({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(() => registry.rebuild({ samples: [sample()] }), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(registry.list().length, 0);
});

test('marks safety-incident cohorts blocked and does not rank them', async () => {
  const registry = createModelScenarioProfileRegistry();
  const result = await registry.rebuild({ samples: [sample({ dimensions: { objectiveSuccess: false, verifierPass: false, safetyIncident: true } })] });
  assert.equal(result.profiles[0].status, 'BLOCKED_BY_SAFETY');
  const ranking = registry.rank({ candidates: [{ candidateKey: sample().candidateKey, scenarioKey: sample().scenarioKey, modelRegistryDigest: sample().modelRegistryDigest, safetyAllowed: true }] });
  assert.equal(ranking.ranked.length, 0);
  assert.equal(ranking.rejected[0].rejectionReason, 'SAFETY_INCIDENT_PRESENT');
});
