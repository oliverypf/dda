import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore, harnessDigest } from '../src/harness-event-store.mjs';
import { pageProjectionTimeline, projectionCheck, rebuildReadModel, replayRun } from '../src/read-model-rebuilder.mjs';

const directory = async (prefix) => mkdtemp(join(tmpdir(), prefix));

test('single-run replay validates the full shared aggregate history before filtering', async () => {
  const store = createHarnessEventStore();
  await store.append({ runId: 'z-run', aggregateType: 'Shared', aggregateId: 'shared', kind: 'Observed' });
  await store.append({ runId: 'a-run', aggregateType: 'Shared', aggregateId: 'shared', kind: 'Observed' });
  const events = await store.list();
  const storagePath = join(await directory('hmcodex-shared-replay-'), 'projection.json');
  const projection = await replayRun({ eventStore: store, runId: 'a-run', storagePath });
  assert.equal(projection.runCount, 1);
  assert.equal(projection.runs[0].runId, 'a-run');
  assert.equal((await projectionCheck({ eventStore: store, runId: 'a-run', storagePath })).ok, true);
  await assert.rejects(replayRun({ events: events.filter((event) => event.runId === 'a-run'), runId: 'a-run' }), /AGGREGATE_VERSION_INVALID/);
});

const appendFixture = async (storagePath) => {
  const store = createHarnessEventStore({ storagePath, now: () => 1000, idFactory: (() => {
    let index = 0;
    return () => `fixture-${++index}`;
  })() });
  await store.append({ runId: 'run-a', kind: 'TaskRunCreated', payload: { title: 'redacted task' } });
  await store.append({ runId: 'run-a', kind: 'RunStateChanged', payload: { to: 'PLANNING' } });
  await store.append({ runId: 'run-a', kind: 'WorkspaceSnapshotCreated', payload: { rootLabel: 'workspace', entryCount: 2 } });
  await store.append({ runId: 'run-a', kind: 'VerificationCompleted', payload: { status: 'PASS', failureCodes: [] } });
  await store.append({ runId: 'run-a', kind: 'ModelScenarioScoreProjected', payload: { scenarioKey: 'sha256:' + '1'.repeat(64) } });
  await store.append({ runId: 'run-a', kind: 'FeedbackFactRecorded', payload: { feedbackId: 'feedback-fixture', outcomeId: 'task-outcome-run-a', eventKind: 'FeedbackSubmitted' } });
  await store.append({ runId: 'run-a', kind: 'TaskRunCompleted', payload: {} });
  await store.append({ runId: 'run-b', kind: 'TaskRunCreated', payload: { title: 'second task' } });
  await store.append({ runId: 'run-b', kind: 'CustomTelemetry', payload: { value: 'bounded' } });
  return store;
};

test('rebuilds a deterministic projection and preserves unknown noncritical event kinds', async () => {
  const root = await directory('hmcodex-read-model-');
  const eventsPath = join(root, 'events.json');
  const projectionPath = join(root, 'read-model.json');
  const store = await appendFixture(eventsPath);
  const first = await rebuildReadModel({ eventStore: store, storagePath: projectionPath, now: () => 2000 });
  const second = await rebuildReadModel({ eventStore: store, now: () => 2000 });
  const later = await rebuildReadModel({ eventStore: store, now: () => 9000 });
  assert.equal(first.projectionChecksum, second.projectionChecksum);
  assert.equal(first.projectionChecksum, later.projectionChecksum);
  assert.deepEqual(first.lastEventSequence, { 'run-a': 7, 'run-b': 2 });
  assert.equal(first.runCount, 2);
  assert.equal(first.runs.find((run) => run.runId === 'run-a').state, 'SUCCEEDED');
  assert.equal(first.workspace.entryCount, 2);
  assert.equal(first.verifier.status, 'PASS');
  assert.deepEqual(first.unknownEventKinds, ['CustomTelemetry']);
  assert.equal(first.timeline.some((item) => item.kind === 'ModelScenarioScoreProjected'), true);
  assert.equal(first.modelScenario.profileCount, 0);
  assert.equal(first.modelScenario.eventSequence, 5);
  assert.equal(first.timeline.some((item) => item.kind === 'FeedbackFactRecorded'), true);
  assert.deepEqual(first.outcomes, [{ outcomeId: 'task-outcome-run-a', runId: 'run-a', status: 'SUCCEEDED', sourceEventIds: [(await store.list({ runId: 'run-a' })).at(-1).eventId], eventSequence: 7 }]);
  assert.deepEqual(first.feedback.map((item) => item.feedbackId), ['feedback-fixture']);
  const persisted = JSON.parse(await readFile(projectionPath, 'utf8'));
  assert.equal(persisted.projectionChecksum, first.projectionChecksum);
});

test('replay-run scopes projection to one run and projection-check validates checksum', async () => {
  const root = await directory('hmcodex-read-model-check-');
  const eventsPath = join(root, 'events.json');
  const projectionPath = join(root, 'read-model.json');
  const store = await appendFixture(eventsPath);
  const runProjection = await replayRun({ runId: 'run-a', eventStore: store, storagePath: projectionPath, now: () => 3000 });
  assert.deepEqual(runProjection.lastEventSequence, { 'run-a': 7 });
  assert.equal(runProjection.runCount, 1);
  const checked = await projectionCheck({ runId: 'run-a', eventStore: store, storagePath: projectionPath });
  assert.equal(checked.ok, true);
  assert.equal(checked.actualChecksum, runProjection.projectionChecksum);
});

test('projects cancelled task outcomes as CANCELLED instead of FAILED', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-cancelled', kind: 'TaskRunCreated', payload: { title: 'cancelled task' } });
  await store.append({ runId: 'run-cancelled', kind: 'TaskRunFailed', payload: {
    outcomeId: 'task-outcome-run-cancelled', outcomeStatus: 'CANCELLED'
  } });
  const projection = await rebuildReadModel({ eventStore: store, now: () => 2000 });
  assert.equal(projection.runs[0].state, 'CANCELLED');
  assert.equal(projection.runs[0].terminal, true);
  assert.deepEqual(projection.outcomes, [{
    outcomeId: 'task-outcome-run-cancelled', runId: 'run-cancelled', status: 'CANCELLED',
    sourceEventIds: [(await store.list({ runId: 'run-cancelled' })).at(-1).eventId], eventSequence: 2
  }]);
  assert.equal(projection.timeline.find((item) => item.kind === 'TaskRunFailed')?.status, 'CANCELLED');
});

test('supports controlled action requests without pausing the run projection', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-controlled-action', kind: 'TaskRunCreated', payload: { title: 'controlled action' } });
  await store.append({
    runId: 'run-controlled-action',
    kind: 'ActionRequested',
    payload: {
      operationId: 'operation-1',
      intentId: 'intent-1',
      approvalId: 'approval-1',
      capability: 'file.write',
      requestDigest: 'sha256:' + '2'.repeat(64),
      scopeSnapshotDigest: 'sha256:' + '3'.repeat(64)
    }
  });
  await store.append({ runId: 'run-controlled-action', kind: 'TaskRunCompleted', payload: {} });
  const projection = await rebuildReadModel({ eventStore: store, now: () => 2000 });
  const run = projection.runs[0];
  assert.equal(run.state, 'SUCCEEDED');
  assert.equal(run.terminal, true);
  assert.deepEqual(run.unsupportedEventIds ?? [], []);
  assert.equal(projection.unsupportedEvents.length, 0);
  assert.equal(projection.timeline.find((item) => item.kind === 'ActionRequested')?.status, 'INFO');
});

test('rejects sequence/digest corruption and pauses unknown critical events', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-invalid', kind: 'TaskRunCreated', payload: {} });
  await store.append({ runId: 'run-invalid', kind: 'CustomTelemetry', payload: {} });
  const validEvents = await store.list();
  await assert.rejects(rebuildReadModel({ events: [validEvents[1]] }), /READ_MODEL_SEQUENCE_INVALID/);
  const tampered = { ...validEvents[0], payload: { changed: true } };
  await assert.rejects(rebuildReadModel({ events: [tampered] }), /READ_MODEL_DIGEST_INVALID/);
  const criticalStore = createHarnessEventStore({ now: () => 1000 });
  await criticalStore.append({ runId: 'run-critical', kind: 'TaskRunUnknownCritical', payload: {} });
  await criticalStore.append({ runId: 'run-critical', kind: 'TaskRunCompleted', payload: {} });
  await criticalStore.append({ runId: 'run-critical', kind: 'ApprovalResolved', payload: { requestId: 'must-not-apply', state: 'APPROVED' } });
  await criticalStore.append({ runId: 'run-supported', kind: 'TaskRunCompleted', payload: {} });
  const paused = await rebuildReadModel({ eventStore: criticalStore });
  assert.equal(paused.runs.find((run) => run.runId === 'run-critical').state, 'PAUSED_UNSUPPORTED');
  assert.equal(paused.runs.find((run) => run.runId === 'run-critical').terminal, false);
  assert.equal(paused.runs.find((run) => run.runId === 'run-supported').state, 'SUCCEEDED');
  assert.equal(paused.approvals.length, 0);
  assert.equal(paused.unsupportedEvents.length, 1);
  assert.equal(paused.unsupportedEvents[0].recordDigest, (await criticalStore.list())[0].recordDigest);
  assert.equal(paused.lastEventSequence['run-critical'], 3);
  assert.equal((await rebuildReadModel({ eventStore: criticalStore })).projectionChecksum, paused.projectionChecksum);
  await assert.rejects(rebuildReadModel({ events: 'invalid' }), /READ_MODEL_EVENT_LIMIT/);
});

test('projects decision and memory facts from the durable event store', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-facts', kind: 'TaskRunCreated', payload: { title: 'facts' } });
  await store.append({
    runId: 'run-facts',
    kind: 'DecisionTraceEvent',
    payload: {
      decisionTraceEventId: 'decision-event-1',
      decisionId: 'decision-1',
      traceKind: 'DecisionCommitted',
      decisionSnapshot: {
        decisionId: 'decision-1',
        runId: 'run-facts',
        decisionType: 'route',
        role: 'router',
        status: 'COMMITTED',
        selectedOptionId: 'option-a',
        options: [{ optionId: 'option-a' }, { optionId: 'option-b' }]
      }
    }
  });
  await store.append({
    runId: 'run-facts',
    kind: 'DecisionTraceEvent',
    payload: {
      decisionTraceEventId: 'decision-event-2',
      decisionId: 'decision-1',
      traceKind: 'OutcomeLinked',
      decisionSnapshot: { decisionId: 'decision-1', status: 'COMMITTED', options: [{}, {}] },
      outcomeSnapshot: { outcomeId: 'outcome-1', status: 'SUCCEEDED' }
    }
  });
  await store.append({
    runId: 'run-facts',
    aggregateType: 'Memory',
    aggregateId: 'memory-1',
    kind: 'MemoryProposalCommitted',
    payload: {
      memoryId: 'memory-1',
      runId: 'run-facts',
      status: 'PROPOSED',
      scope: 'project',
      kind: 'fact',
      confidence: 0.8,
      sourceEventIds: ['event-1'],
      recordDigest: `sha256:${'a'.repeat(64)}`,
      lifecycleDigest: `sha256:${'b'.repeat(64)}`,
      createdAtMs: 1000,
      updatedAtMs: 1000
    }
  });
  await store.append({
    runId: 'run-facts',
    aggregateType: 'Memory',
    aggregateId: 'memory-1',
    kind: 'MemoryStateChanged',
    payload: {
      memoryId: 'memory-1',
      runId: 'run-facts',
      status: 'ACTIVE',
      scope: 'project',
      kind: 'fact',
      confidence: 0.9,
      sourceEventIds: ['event-1'],
      recordDigest: `sha256:${'c'.repeat(64)}`,
      lifecycleDigest: `sha256:${'d'.repeat(64)}`,
      createdAtMs: 1000,
      updatedAtMs: 2000
    }
  });
  await store.append({
    runId: 'run-facts',
    aggregateType: 'Memory',
    aggregateId: 'memory-1',
    kind: 'MemoryStateChanged',
    payload: {
      memoryId: 'memory-1',
      runId: 'run-facts',
      statement: '[DELETED]',
      status: 'PRUNED',
      scope: 'project',
      kind: 'fact',
      confidence: 0,
      sourceEventIds: [],
      untrainable: true,
      untrainableAtMs: 3000,
      recordDigest: `sha256:${'e'.repeat(64)}`,
      lifecycleDigest: `sha256:${'f'.repeat(64)}`,
      createdAtMs: 1000,
      updatedAtMs: 3000
    }
  });
  const durable = await store.list({ runId: 'run-facts' });
  const outcomeDecisionEvent = durable.find((event) => event.payload?.traceKind === 'OutcomeLinked');
  const projection = await rebuildReadModel({ eventStore: store, now: () => 3000 });
  assert.equal(projection.decisions.length, 1);
  assert.deepEqual(projection.decisions[0], {
    decisionId: 'decision-1',
    runId: 'run-facts',
    decisionType: 'route',
    role: 'router',
    status: 'COMMITTED',
    optionCount: 2,
    options: [
      { optionId: 'option-a', rejectionReasonCodes: [] },
      { optionId: 'option-b', rejectionReasonCodes: [] }
    ],
    selectedOptionId: 'option-a',
    outcomeStatus: 'SUCCEEDED',
    eventId: outcomeDecisionEvent.eventId,
    eventSequence: outcomeDecisionEvent.sequence,
    updatedAtMs: 1000
  });
  assert.equal(projection.memories.length, 1);
  assert.equal(projection.memories[0].statement, '[DELETED]');
  assert.equal(projection.memories[0].status, 'PRUNED');
  assert.equal(projection.memories[0].untrainable, true);
  assert.equal(projection.memories[0].eventSequence, 6);
  assert.equal(
    projection.projectionChecksum,
    (await rebuildReadModel({ eventStore: store, now: () => 3000 })).projectionChecksum
  );
});

test('rebuilds and pages a ten-thousand-event timeline deterministically', async () => {
  const events = Array.from({ length: 10_000 }, (_, index) => {
    const unsigned = {
      schemaVersion: '1.0',
      protocolVersion: '1.0',
      storageSchemaVersion: 1,
      appVersion: '0.1.0',
      producerVersion: 'hmcodex-runtime@0.1.0',
      policyVersion: 'runtime-safety-1',
      eventId: `scale-event-${index}`,
      runId: 'run-scale',
      sequence: index + 1,
      aggregateType: 'TaskRun',
      aggregateId: 'run-scale',
      aggregateVersion: index + 1,
      kind: 'Observed',
      actorType: 'SYSTEM',
      actorId: 'hmcodex-runtime',
      emittedAtMs: 1000 + index,
      observedAtMs: 1000 + index,
      payload: { index },
      payloadDigest: harnessDigest({ index }),
      sensitivity: 'INTERNAL'
    };
    return { ...unsigned, recordDigest: harnessDigest(unsigned) };
  });
  const startedAt = Date.now();
  const projection = await rebuildReadModel({ events, now: () => 2000 });
  assert.equal(projection.timeline.length, 10_000);
  assert.equal(projection.runCount, 1);
  assert.deepEqual(projection.lastEventSequence, { 'run-scale': 10_000 });
  assert.ok(Date.now() - startedAt < 30_000);

  const firstPage = pageProjectionTimeline(projection, { cursor: 0, limit: 500 });
  assert.equal(firstPage.timelinePage.items.length, 500);
  assert.equal(firstPage.timelinePage.total, 10_000);
  assert.equal(firstPage.timelinePage.hasMore, true);
  assert.equal(firstPage.timelinePage.nextCursor, 500);
  const lastPage = pageProjectionTimeline(projection, { cursor: 9_800, limit: 500 });
  assert.equal(lastPage.timelinePage.items.length, 200);
  assert.equal(lastPage.timelinePage.hasMore, false);
  assert.equal(lastPage.timelinePage.nextCursor, undefined);

  const rebuiltAgain = await rebuildReadModel({ events, now: () => 9000 });
  assert.equal(rebuiltAgain.projectionChecksum, projection.projectionChecksum);
});

test('projects bounded Decision DAG edges from durable decision facts', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-dag', kind: 'TaskRunCreated', payload: { title: 'dag' } });
  const appendDecision = (decisionId, snapshot) => store.append({
    runId: 'run-dag',
    kind: 'DecisionTraceEvent',
    payload: { decisionTraceEventId: `dte-${decisionId}`, decisionId, traceKind: 'DecisionCommitted', decisionSnapshot: { decisionId, runId: 'run-dag', status: 'COMMITTED', options: [], ...snapshot } }
  });
  await appendDecision('decision-root', { decisionType: 'plan', role: 'planner', stepId: 'step-1', agentInstanceId: 'agent-1' });
  await appendDecision('decision-child', { decisionType: 'route', role: 'router', stepId: 'step-2', parentDecisionIds: ['decision-root', 'decision-root'] });
  await appendDecision('decision-superseding', {
    decisionType: 'route',
    role: 'router',
    stepId: 'step-3',
    parentDecisionIds: ['decision-root', 'decision-child', 'decision-superseding'],
    supersedesDecisionId: 'decision-child'
  });

  const projection = await rebuildReadModel({ eventStore: store, now: () => 3000 });
  const byId = Object.fromEntries(projection.decisions.map((item) => [item.decisionId, item]));
  assert.equal(projection.decisions.length, 3);
  assert.equal(byId['decision-root'].stepId, 'step-1');
  assert.equal(byId['decision-root'].agentInstanceId, 'agent-1');
  assert.equal(byId['decision-root'].parentDecisionIds, undefined);
  assert.deepEqual(byId['decision-child'].parentDecisionIds, ['decision-root']);
  // Self-referencing parents are dropped so the DAG cannot gain a cycle.
  assert.deepEqual(byId['decision-superseding'].parentDecisionIds, ['decision-root', 'decision-child']);
  assert.equal(byId['decision-superseding'].supersedesDecisionId, 'decision-child');
  assert.equal(byId['decision-child'].supersedesDecisionId, undefined);
});

test('projects a bounded candidate set with per-option scores and elimination reasons', async () => {
  const store = createHarnessEventStore({ now: () => 1000 });
  await store.append({ runId: 'run-candidates', kind: 'TaskRunCreated', payload: { title: 'candidates' } });
  await store.append({
    runId: 'run-candidates',
    kind: 'DecisionTraceEvent',
    payload: {
      decisionTraceEventId: 'dte-select-candidate',
      decisionId: 'decision-select',
      traceKind: 'DecisionCommitted',
      decisionSnapshot: {
        decisionId: 'decision-select',
        runId: 'run-candidates',
        decisionType: 'SELECT_CANDIDATE',
        role: 'planner',
        status: 'COMMITTED',
        selectedOptionId: 'binding-b',
        reasonCodes: ['CANDIDATE_SELECTION_JUDGE_RANKED'],
        selectionCriteria: ['deterministic_hard_elimination', 'independent_judge_ranking'],
        options: [
          { optionId: 'binding-a', actionKind: 'model.candidate', expectedQuality: 0.4, expectedCost: 1, expectedLatencyMs: 90 },
          { optionId: 'binding-b', actionKind: 'model.candidate', expectedQuality: 0.9, expectedCost: 2, expectedLatencyMs: 40 },
          { optionId: 'binding-c', actionKind: 'model.candidate', rejectionReasonCodes: ['TEST_FAILED'] }
        ]
      }
    }
  });
  const projection = await rebuildReadModel({ eventStore: store, now: () => 3000 });
  const [decision] = projection.decisions;
  assert.equal(decision.decisionType, 'SELECT_CANDIDATE');
  assert.equal(decision.optionCount, 3);
  assert.deepEqual(decision.reasonCodes, ['CANDIDATE_SELECTION_JUDGE_RANKED']);
  assert.deepEqual(decision.selectionCriteria, ['deterministic_hard_elimination', 'independent_judge_ranking']);
  assert.deepEqual(decision.options.map((option) => option.optionId), ['binding-a', 'binding-b', 'binding-c']);
  // Scores stay attributed to the candidate that actually produced them.
  assert.equal(decision.options[0].expectedQuality, 0.4);
  assert.equal(decision.options[1].expectedQuality, 0.9);
  assert.equal(decision.options[2].expectedQuality, undefined);
  assert.deepEqual(decision.options[2].rejectionReasonCodes, ['TEST_FAILED']);
});
