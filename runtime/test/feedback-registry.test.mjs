import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeedbackRegistry, feedbackDigest } from '../src/feedback-registry.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const input = (overrides = {}) => ({
  runId: 'run-feedback',
  taskId: 'task-feedback',
  threadId: 'thread-feedback',
  decisionId: 'decision-feedback',
  outcomeId: 'outcome-feedback',
  modelIdentity: {
    provider: 'openai',
    protocol: 'responses',
    model: 'model-a',
    modelVersion: 'v1',
    modelRegistryDigest: 'sha256:' + 'a'.repeat(64),
    role: 'planner',
    pluginVersion: 'plugin-v1'
  },
  scenario: {
    taskClass: 'READ',
    riskClass: 'LOW',
    operationClass: 'ANALYZE',
    requiredCapabilities: ['workspace.read'],
    workspaceCapabilityClass: 'READ_ONLY',
    platform: 'WINDOWS',
    policyClass: 'phase1'
  },
  sourceType: 'USER',
  dimensions: { rating: 5, objectiveSuccess: true, verifierPass: true, quality: 0.9, cost: 2, latency: 100, safetyIncident: false, usable: true },
  reasonCodes: ['RESULT_EXCELLENT'],
  evidenceRefs: ['event-feedback'],
  ...overrides
});

test('stores redacted feedback append-only with idempotency and scenario/candidate keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-feedback-'));
  const storagePath = join(root, 'feedback.json');
  const registry = createFeedbackRegistry({ storagePath, now: () => 100 });
  const first = await registry.submit(input(), { commandId: 'feedback-command-1' });
  const retry = await registry.submit(input(), { commandId: 'feedback-command-1' });
  assert.equal(first.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.match(first.feedback.scenario.scenarioKey, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.feedback.modelIdentity.candidateKey, 'openai/responses/model-a/v1/planner/plugin-v1');
  assert.equal(first.feedback.dimensions.userSatisfaction, 1);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list({ scenarioKey: first.feedback.scenario.scenarioKey }).length, 1);
  await assert.rejects(registry.submit(input({ dimensions: { rating: 4 } }), { commandId: 'feedback-command-1' }), /FEEDBACK_COMMAND_IDEMPOTENCY_CONFLICT/);
  const persisted = await readFile(storagePath, 'utf8');
  assert.doesNotMatch(persisted, /private prompt|reasoning|secret|api.key/i);
});

test('feedback does not expose a record for a non-committed durable fact', async () => {
  const registry = createFeedbackRegistry({ eventStore: { append: async () => ({ receipt: { status: 'PENDING', eventIds: [] } }) } });
  await assert.rejects(() => registry.submit(input({ runId: 'run-pending', outcomeId: 'outcome-pending' })), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(registry.list().length, 0);
});

test('feedback rejects a committed receipt with an unbound event', async () => {
  const registry = createFeedbackRegistry({ eventStore: { append: async () => ({ receipt: { status: 'COMMITTED', eventIds: ['wrong-event'] }, event: { eventId: 'wrong-event', kind: 'WrongKind', aggregateId: 'wrong-run', payload: {} } }) } });
  await assert.rejects(() => registry.submit(input()), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(registry.list().length, 0);
});

test('revises and retracts feedback without overwriting authoritative events', async () => {
  const registry = createFeedbackRegistry({ now: (() => { let value = 100; return () => ++value; })() });
  const first = await registry.submit(input());
  const revised = await registry.revise(first.feedback.feedbackId, input({ feedbackId: 'feedback-revised', dimensions: { rating: 2, usable: false } }));
  assert.equal(registry.get(first.feedback.feedbackId), undefined);
  assert.equal(registry.get(revised.feedback.feedbackId).dimensions.rating, 2);
  assert.equal(registry.listEvents().filter((event) => event.kind === 'FeedbackSubmitted').length, 1);
  assert.equal(registry.listEvents().filter((event) => event.kind === 'FeedbackRevised').length, 1);
  await registry.retract(revised.feedback.feedbackId);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.listEvents().filter((event) => event.kind === 'FeedbackRetracted').length, 1);
});

test('reads bounded feedback summaries from the Harness Event Store', async () => {
  const events = [{ eventId: 'harness-feedback-1', sequence: 1, aggregateId: 'run-feedback', kind: 'FeedbackFactRecorded', payload: {
    feedbackId: 'feedback-1', runId: 'run-feedback', outcomeId: 'outcome-feedback', eventKind: 'FeedbackSubmitted', recordDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    scenarioKey: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', modelRegistryDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', candidateKey: 'openai/responses/model-a/v1/planner/plugin-v1', dimensions: { objectiveSuccess: true }, evidenceRefs: ['event-feedback'], prompt: 'must not copy'
  } }];
  const registry = createFeedbackRegistry({ eventStore: { list: async () => events } });
  const summaries = await registry.listDurableSummaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].prompt, undefined);
  assert.equal(summaries[0].dimensions.objectiveSuccess, true);
  assert.equal(summaries[0].modelRegistryDigest, 'sha256:' + 'c'.repeat(64));
  assert.equal(Object.prototype.hasOwnProperty.call(summaries[0], 'prompt'), false);
  await assert.rejects(createFeedbackRegistry().listDurableSummaries(), /HARNESS_EVENT_STORE_REQUIRED/);
});

test('round-trips feedback summaries through a real Harness store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-feedback-harness-'));
  const eventStore = createHarnessEventStore({ storagePath: join(root, 'events.json') });
  await eventStore.load();
  const registry = createFeedbackRegistry({ eventStore, now: () => 100 });
  const submitted = await registry.submit(input());
  const summaries = await registry.listDurableSummaries({ runId: submitted.feedback.runId });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].feedbackId, submitted.feedback.feedbackId);
  assert.equal(summaries[0].modelRegistryDigest, submitted.feedback.modelIdentity.modelRegistryDigest);
  const reopenedStore = createHarnessEventStore({ storagePath: join(root, 'events.json') });
  await reopenedStore.load();
  assert.equal((await createFeedbackRegistry({ eventStore: reopenedStore }).listDurableSummaries()).length, 1);
});

test('projects durable feedback revisions and retractions to active summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-feedback-projection-'));
  const eventStore = createHarnessEventStore({ storagePath: join(root, 'events.json') });
  await eventStore.load();
  const registry = createFeedbackRegistry({ eventStore, now: () => 100 });
  const first = await registry.submit(input(), { commandId: 'projection-submit' });
  const revised = await registry.revise(first.feedback.feedbackId, input({ feedbackId: 'feedback-revised', dimensions: { rating: 4 } }), { commandId: 'projection-revise' });
  assert.equal((await registry.listDurableSummaries()).length, 1);
  assert.equal((await registry.listDurableSummaries())[0].feedbackId, revised.feedback.feedbackId);
  const durableEvents = await eventStore.list({ kind: 'FeedbackFactRecorded' });
  assert.equal(durableEvents.some((event) => event.payload.previousFeedbackId === first.feedback.feedbackId), true);
  await registry.retract(revised.feedback.feedbackId, { commandId: 'projection-retract' });
  assert.equal((await registry.listDurableSummaries()).length, 0);
});

test('rejects a durable summary with a cross-run aggregate binding', async () => {
  const registry = createFeedbackRegistry({ eventStore: { list: async () => [{
    eventId: 'harness-feedback-cross-run', sequence: 1, aggregateId: 'different-run', kind: 'FeedbackFactRecorded',
    payload: { feedbackId: 'feedback-1', runId: 'run-feedback', outcomeId: 'outcome-feedback', eventKind: 'FeedbackSubmitted', recordDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  }] } });
  await assert.rejects(registry.listDurableSummaries(), /FEEDBACK_STORE_INVALID_EVENT/);
});

test('rejects a durable revision with an invalid predecessor id', async () => {
  const registry = createFeedbackRegistry({ eventStore: { list: async () => [{
    eventId: 'harness-feedback-invalid-revision', sequence: 1, aggregateId: 'run-feedback', kind: 'FeedbackFactRecorded',
    payload: { feedbackId: 'feedback-revised', runId: 'run-feedback', outcomeId: 'outcome-feedback', eventKind: 'FeedbackRevised', previousFeedbackId: 42, recordDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  }] } });
  await assert.rejects(registry.listDurableSummaries(), /FEEDBACK_STORE_INVALID_EVENT/);
});

test('lists retracted events without treating tombstones as full feedback', async () => {
  const registry = createFeedbackRegistry({ now: () => 100 });
  const submitted = await registry.submit(input());
  await registry.retract(submitted.feedback.feedbackId);
  const records = registry.list({ includeRetracted: true });
  assert.equal(records.length, 2);
  assert.equal(records.some((record) => record.eventKind === 'FeedbackRetracted'), true);
  assert.equal(registry.list({ includeRetracted: true, scenarioKey: submitted.feedback.scenario.scenarioKey }).length, 1);
});

test('reloads, rejects sensitive input and detects tampered feedback records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-feedback-tamper-'));
  const storagePath = join(root, 'feedback.json');
  const registry = createFeedbackRegistry({ storagePath });
  await registry.submit(input());
  const restored = createFeedbackRegistry({ storagePath });
  await restored.load();
  assert.equal(restored.list().length, 1);
  await assert.rejects(restored.submit(input({ prompt: 'never store this' })), /FEEDBACK_FORBIDDEN_CONTENT/);
  const parsed = JSON.parse(await readFile(storagePath, 'utf8'));
  parsed.events[0].feedback.dimensions.rating = 1;
  await writeFile(storagePath, JSON.stringify(parsed), 'utf8');
  await assert.rejects(createFeedbackRegistry({ storagePath }).load(), /FEEDBACK_STORE_INVALID_DIGEST/);
  assert.match(feedbackDigest({ a: 1 }), /^sha256:[0-9a-f]{64}$/u);
});
