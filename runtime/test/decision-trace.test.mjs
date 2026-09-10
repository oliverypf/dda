import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentDecisionTrace, decisionTraceDigest } from '../src/decision-trace.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const input = (overrides = {}) => ({
  runId: 'run-1',
  stepId: 'step-1',
  agentInstanceId: 'agent-1',
  role: 'planner',
  roleContextId: 'role-context-1',
  bindingSnapshotId: 'binding-1',
  decisionType: 'SELECT_NEXT_STEP',
  objectiveRef: 'objective-1',
  constraintSnapshotId: 'constraints-1',
  featureSnapshotId: 'features-1',
  evidenceRefs: [{ evidenceId: 'event-1', eventId: 'event-1', evidenceType: 'verifier', stance: 'SUPPORTS', freshnessAtMs: 10 }],
  assumptions: [{ assumptionId: 'assumption-1', statement: 'workspace is available', source: 'WORKSPACE', testable: true }],
  options: [
    { optionId: 'option-read', actionKind: 'WORKSPACE_READ', summary: 'Inspect the target file', evidenceRefs: ['event-1'], requiredCapabilityIds: ['workspace.read'], riskCodes: [], rejectionReasonCodes: [] },
    { optionId: 'option-stop', actionKind: 'STOP', summary: 'Stop and report the issue', evidenceRefs: [], requiredCapabilityIds: [], riskCodes: ['LOW'], rejectionReasonCodes: ['NO_PROGRESS'] }
  ],
  selectedOptionId: 'option-read',
  decisionSummary: 'Inspect the target file to gather deterministic evidence.',
  selectionCriteria: ['evidence-coverage'],
  reasonCodes: ['NEXT_STEP_REQUIRED'],
  uncertaintyCodes: ['WORKSPACE_STATE_UNKNOWN'],
  expectedOutcome: { successCriteriaRefs: ['criterion-1'], predictedOutcomeCode: 'EVIDENCE_AVAILABLE', predictedProgress: 0.2, predictedRiskCodes: [] },
  outputRefs: ['plan-step-1'],
  sensitivity: 'INTERNAL',
  ...overrides
});

test('records structured candidates and links an independent outcome without prompt or reasoning fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-trace-'));
  const storagePath = join(directory, 'decision-trace.json');
  const trace = new AgentDecisionTrace({ storagePath, now: () => 100 });
  const proposed = await trace.propose(input({ promptTemplateVersion: 'planner-v1' }));

  assert.equal(proposed.status, 'PROPOSED');
  assert.equal(proposed.options.length, 2);
  assert.equal(proposed.selectedOptionId, 'option-read');
  assert.match(proposed.recordDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(proposed).includes('reasoning'), false);

  const committed = await trace.commit(proposed.decisionId);
  assert.equal(committed.status, 'COMMITTED');
  assert.deepEqual(trace.assertCommitted(proposed.decisionId).decisionId, proposed.decisionId);
  const outcome = await trace.linkOutcome(proposed.decisionId, {
    status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1',
    executionEventIds: ['event-execution-1'], verifierReportIds: ['report-1'],
    observedEffects: ['artifact-1'], progressDelta: 0.25, qualityScore: 0.9
  });
  assert.equal(outcome.decisionId, proposed.decisionId);
  assert.match(outcome.outcomeDigest, /^sha256:[0-9a-f]{64}$/);

  const persisted = await readFile(storagePath, 'utf8');
  assert.equal(persisted.includes('promptTemplateVersion'), true);
  assert.equal(persisted.includes('private user prompt'), false);
  assert.equal(persisted.includes('chain of thought'), false);
  const reopened = new AgentDecisionTrace({ storagePath });
  await reopened.load();
  assert.equal(reopened.get(proposed.decisionId).status, 'COMMITTED');
  assert.equal(reopened.listOutcomes(proposed.decisionId).length, 1);
  assert.equal(reopened.listEvents({ decisionId: proposed.decisionId }).length, 3);
});

test('commits trace lifecycle events to the Harness Event Store before exposing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-sqlite-replay-'));
  const storagePath = join(directory, 'hmcodex.db');
  const eventStore = createHarnessEventStore({ storagePath });
  const trace = new AgentDecisionTrace({ eventStore, now: () => 300 });
  const decision = await trace.propose(input());
  await trace.commit(decision.decisionId);
  await trace.linkOutcome(decision.decisionId, { status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1' });
  const events = await eventStore.list({ runId: 'run-1' });
  assert.deepEqual(events.map((event) => event.kind), ['DecisionTraceEvent', 'DecisionTraceEvent', 'DecisionTraceEvent']);
  assert.equal(events[0].payload.traceKind, 'DecisionProposed');
  assert.equal(events[1].payload.traceKind, 'DecisionCommitted');
  assert.equal(events[2].payload.traceKind, 'DecisionOutcomeLinked');
  // Preserve candidate structure in the durable redacted snapshot. Recovery
  // must not need a JSON cache or restore the original free-text summaries.
  const durableOptions = decision.options.map((option) => ({ ...option, summary: 'OPTION_SUMMARY_REDACTED' }));
  assert.deepEqual(events[1].payload.decisionSnapshot.options, durableOptions);
  assert.doesNotMatch(JSON.stringify(events), /Inspect the target file|private user prompt|chain of thought/);
  const reopened = new AgentDecisionTrace({ eventStore: createHarnessEventStore({ storagePath }) });
  await reopened.load();
  assert.equal(reopened.get(decision.decisionId).status, 'COMMITTED');
  assert.deepEqual(reopened.get(decision.decisionId).options, durableOptions);
  assert.equal(reopened.listOutcomes(decision.decisionId).length, 1);
  assert.deepEqual(reopened.get(decision.decisionId), trace.get(decision.decisionId));
  assert.deepEqual(reopened.listOutcomes(), trace.listOutcomes());
});

test('rejects prompt/reasoning input, missing evidence, and agent-authored outcomes', async () => {
  const trace = new AgentDecisionTrace();
  await assert.rejects(trace.propose(input({ prompt: 'private user prompt' })), /DECISION_FORBIDDEN_CONTENT/);
  await assert.rejects(trace.propose(input({ rawPrompt: 'private user prompt' })), /DECISION_FORBIDDEN_CONTENT/);
  await assert.rejects(trace.propose(input({ inputMessages: ['private user prompt'] })), /DECISION_FORBIDDEN_CONTENT/);
  await assert.rejects(trace.propose(input({ hiddenReasoning: 'do not persist this' })), /DECISION_FORBIDDEN_CONTENT/);
  await assert.rejects(trace.propose(input({ decisionSummary: 'chain of thought should never be stored' })), /DECISION_INVALID_SUMMARY/);
  await assert.rejects(trace.propose(input({ options: [{ ...input().options[0], evidenceRefs: ['missing'] }] })), /DECISION_EVIDENCE_NOT_FOUND/);
  const proposed = await trace.propose(input());
  await assert.rejects(trace.linkOutcome(proposed.decisionId, { status: 'SUCCEEDED', sourceType: 'agent', sourceId: 'agent-1' }), /DECISION_OUTCOME_ACTOR_FORBIDDEN/);
  await assert.rejects(trace.linkOutcome(proposed.decisionId, { status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1' }), /DECISION_OUTCOME_REQUIRES_COMMIT/);
});

test('an authoritative event store never resurrects decisions from a legacy cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-authority-'));
  const storagePath = join(directory, 'decision-trace.json');
  const legacy = new AgentDecisionTrace({ storagePath });
  await legacy.propose(input());
  const eventStore = createHarnessEventStore({ storagePath: join(directory, 'hmcodex.db') });
  const empty = new AgentDecisionTrace({ storagePath, eventStore });
  await empty.load();
  assert.equal(empty.list().length, 0);
  await eventStore.append({ runId: 'run-1', kind: 'DecisionTraceEvent', payload: { traceKind: 'DecisionProposed' } });
  const unsupported = new AgentDecisionTrace({ storagePath, eventStore });
  await assert.rejects(unsupported.load(), /DECISION_STORE_REPLAY_UNAVAILABLE/);
});

test('failed durable replay exposes no partial prefix and can retry after repair', async () => {
  const eventStore = createHarnessEventStore();
  const writer = new AgentDecisionTrace({ eventStore });
  const decision = await writer.propose(input());
  await writer.commit(decision.decisionId);
  const valid = await eventStore.list();
  let source = [...valid, { eventId: 'bad', sequence: 3, runId: 'run-1', kind: 'DecisionTraceEvent', payload: {} }];
  const reader = new AgentDecisionTrace({ eventStore: { list: async () => source } });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(reader.load(), /DECISION_STORE_REPLAY_UNAVAILABLE/);
    assert.deepEqual(reader.list(), []);
    assert.deepEqual(reader.listOutcomes(), []);
    assert.deepEqual(reader.listEvents(), []);
  }
  source = valid;
  await reader.load();
  assert.equal(reader.get(decision.decisionId).status, 'COMMITTED');
});

test('durable replay rejects inconsistent outer trace references', async () => {
  const store = createHarnessEventStore();
  const writer = new AgentDecisionTrace({ eventStore: store });
  await writer.propose(input());
  const [event] = await store.list();
  for (const patch of [
    { decisionTraceEventId: 'wrong' },
    { traceKind: 'DecisionCommitted' },
    { traceEventDigest: decisionTraceDigest({ wrong: true }) },
    { tracePayload: { status: 'COMMITTED' } }
  ]) {
    // Append through the real store so the outer envelope/digests are valid.
    const inconsistent = createHarnessEventStore();
    await inconsistent.append({ runId: event.runId, kind: event.kind, payload: { ...event.payload, ...patch } });
    const reader = new AgentDecisionTrace({ eventStore: inconsistent });
    await assert.rejects(reader.load(), /DECISION_STORE_REPLAY_INVALID/);
    assert.deepEqual(reader.list(), []);
  }
});

test('durable replay rejects re-signed outcomes with mismatched decision, identity or status', async () => {
  const source = createHarnessEventStore();
  const writer = new AgentDecisionTrace({ eventStore: source });
  const decision = await writer.propose(input());
  await writer.commit(decision.decisionId);
  await writer.linkOutcome(decision.decisionId, { status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1' });
  const events = await source.list();
  for (const patch of [{ decisionId: 'different' }, { outcomeId: 'different' }, { status: 'FAILED' }]) {
    const destination = createHarnessEventStore();
    for (const event of events) {
      const payload = structuredClone(event.payload);
      if (payload.outcomeSnapshot) {
        const { outcomeDigest, ...unsigned } = { ...payload.outcomeSnapshot, ...patch };
        payload.outcomeSnapshot = { ...unsigned, outcomeDigest: decisionTraceDigest(unsigned) };
      }
      await destination.append({ runId: event.runId, kind: event.kind, payload });
    }
    const reader = new AgentDecisionTrace({ eventStore: destination });
    await assert.rejects(reader.load(), patch.decisionId ? /DECISION_STORE_INVALID/ : /DECISION_STORE_REPLAY_INVALID/);
    assert.deepEqual(reader.listOutcomes(), []);
  }
});

test('replay rejects later snapshots that rewrite decision-time facts', async () => {
  const source = createHarnessEventStore();
  const writer = new AgentDecisionTrace({ eventStore: source });
  const decision = await writer.propose(input());
  await writer.commit(decision.decisionId);
  const events = await source.list();
  for (const patch of [{ featureSnapshotId: 'different-feature' }, { createdAtMs: 1 }]) {
    const destination = createHarnessEventStore();
    for (const [index, event] of events.entries()) {
      const payload = structuredClone(event.payload);
      if (index === 1) {
        Object.assign(payload.decisionSnapshot, patch);
        const { status, createdAtMs, updatedAtMs, committedAtMs, lifecycleReasonCode, recordDigest, ...immutable } = payload.decisionSnapshot;
        payload.decisionSnapshot.recordDigest = decisionTraceDigest(immutable);
      }
      await destination.append({ runId: event.runId, kind: event.kind, payload });
    }
    const reader = new AgentDecisionTrace({ eventStore: destination });
    await assert.rejects(reader.load(), /DECISION_STORE_REPLAY_INVALID/);
    assert.deepEqual(reader.list(), []);
  }
});

test('replay requires proposal before commit and rejects repeated commit transitions', async () => {
  const source = createHarnessEventStore();
  const writer = new AgentDecisionTrace({ eventStore: source });
  const decision = await writer.propose(input());
  await writer.commit(decision.decisionId);
  const [proposed, committed] = await source.list();
  const repeat = structuredClone(committed.payload);
  repeat.traceEvent.eventId = 'repeat-commit';
  const { eventDigest, ...unsigned } = repeat.traceEvent;
  repeat.traceEvent.eventDigest = decisionTraceDigest(unsigned);
  repeat.decisionTraceEventId = repeat.traceEvent.eventId;
  repeat.traceEventDigest = repeat.traceEvent.eventDigest;
  for (const payloads of [[committed.payload], [proposed.payload, committed.payload, repeat]]) {
    const destination = createHarnessEventStore();
    for (const payload of payloads) await destination.append({ runId: decision.runId, kind: 'DecisionTraceEvent', payload });
    await assert.rejects(new AgentDecisionTrace({ eventStore: destination }).load(), /DECISION_STORE_REPLAY_INVALID/);
  }
});

test('SQLite replay preserves rejection, abstention, invalidation and revision lifecycles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-lifecycles-'));
  const storagePath = join(directory, 'hmcodex.db');
  const writer = new AgentDecisionTrace({ eventStore: createHarnessEventStore({ storagePath }) });
  const expected = new Map();
  for (const operation of ['reject', 'abstain', 'invalidate']) {
    const decision = await writer.propose(input());
    const result = await writer[operation](decision.decisionId);
    expected.set(decision.decisionId, result.status);
  }
  const committed = await writer.propose(input());
  await writer.commit(committed.decisionId);
  await writer.invalidate(committed.decisionId);
  expected.set(committed.decisionId, 'INVALIDATED');
  const original = await writer.propose(input());
  expected.set(original.decisionId, 'PROPOSED');
  const revised = await writer.revise(original.decisionId, input({ featureSnapshotId: 'revised-feature' }));
  await writer.commit(revised.decisionId);
  expected.set(revised.decisionId, 'COMMITTED');
  const reader = new AgentDecisionTrace({ eventStore: createHarnessEventStore({ storagePath }) });
  await reader.load();
  for (const [id, status] of expected) assert.equal(reader.get(id).status, status);
  assert.equal(reader.get(revised.decisionId).supersedesDecisionId, original.decisionId);
  assert.equal(reader.get(revised.decisionId).featureSnapshotId, 'revised-feature');
  assert.equal(reader.listEvents().length, writer.listEvents().length);
});

test('decision proposal is not exposed without a matching durable receipt', async () => {
  for (const corrupt of [
    () => undefined,
    (result) => ({ ...result, receipt: { ...result.receipt, status: 'PENDING' } }),
    (result) => ({ ...result, receipt: { ...result.receipt, commandId: 'wrong' } }),
    (result) => ({ ...result, receipt: { ...result.receipt, eventIds: [] } }),
    (result) => ({ ...result, event: { ...result.event, payload: {} } })
  ]) {
    const backing = createHarnessEventStore();
    const trace = new AgentDecisionTrace({ eventStore: {
      list: async () => [], append: async (request) => corrupt(await backing.append(request))
    } });
    await assert.rejects(trace.propose(input()), /DURABLE_COMMIT_REQUIRED/);
    assert.deepEqual(trace.list(), []);
    assert.deepEqual(trace.listEvents(), []);
  }
});

test('failed commit and outcome receipts do not advance visible decision state', async () => {
  const backing = createHarnessEventStore();
  let failKind;
  const trace = new AgentDecisionTrace({ eventStore: {
    list: (...args) => backing.list(...args),
    append: async (request) => request.payload.traceKind === failKind
      ? { receipt: { status: 'PENDING' } } : backing.append(request)
  } });
  const decision = await trace.propose(input());
  failKind = 'DecisionCommitted';
  await assert.rejects(trace.commit(decision.decisionId), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(trace.get(decision.decisionId).status, 'PROPOSED');
  assert.equal(trace.listEvents().length, 1);
  assert.throws(() => trace.assertCommitted(decision.decisionId), /DECISION_NOT_COMMITTED/);
  failKind = undefined;
  await trace.commit(decision.decisionId);
  failKind = 'DecisionOutcomeLinked';
  const outcome = { status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1' };
  await assert.rejects(trace.linkOutcome(decision.decisionId, outcome), /DURABLE_COMMIT_REQUIRED/);
  assert.deepEqual(trace.listOutcomes(), []);
  assert.equal(trace.listEvents().length, 2);
  failKind = undefined;
  await trace.linkOutcome(decision.decisionId, outcome);
  assert.equal(trace.listOutcomes().length, 1);
  assert.equal((await backing.list()).length, 3);
});

test('enforces commit-before-effect and same-run acyclic parent/revision references', async () => {
  const trace = new AgentDecisionTrace({ now: () => 200 });
  const first = await trace.propose(input());
  await assert.rejects(trace.commit((await trace.propose(input({ stepId: 'step-2', selectedOptionId: undefined }))).decisionId), /DECISION_SELECTION_REQUIRED/);
  const child = await trace.propose(input({ stepId: 'step-2', parentDecisionIds: [first.decisionId] }));
  assert.deepEqual(child.parentDecisionIds, [first.decisionId]);
  await assert.rejects(trace.propose(input({ runId: 'run-2', parentDecisionIds: [first.decisionId] })), /DECISION_INVALID_PARENTS/);
  const revision = await trace.revise(first.decisionId, input({ stepId: 'step-3', decisionSummary: 'Use the revised evidence check.' }));
  assert.equal(revision.supersedesDecisionId, first.decisionId);
  assert.equal(trace.listEvents({ decisionId: revision.decisionId }).at(-1).kind, 'DecisionRevised');
  assert.equal(decisionTraceDigest({ a: 1, b: 2 }), decisionTraceDigest({ b: 2, a: 1 }));
});

test('links an outcome idempotently and rejects a conflicting digest', async () => {
  const trace = new AgentDecisionTrace();
  const decision = await trace.propose(input());
  await trace.commit(decision.decisionId);
  const first = await trace.linkOutcome(decision.decisionId, { outcomeId: 'outcome-fixed', status: 'SUCCEEDED', sourceType: 'coordinator', sourceId: 'coord-1' });
  const duplicate = await trace.linkOutcome(decision.decisionId, { outcomeId: 'outcome-fixed', status: 'SUCCEEDED', sourceType: 'coordinator', sourceId: 'coord-1' });
  assert.deepEqual(duplicate, first);
  await assert.rejects(trace.linkOutcome(decision.decisionId, { outcomeId: 'outcome-fixed', status: 'FAILED', sourceType: 'coordinator', sourceId: 'coord-1' }), /DECISION_OUTCOME_ID_CONFLICT/);
});

test('fails closed on a tampered persisted decision digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-trace-tamper-'));
  const storagePath = join(directory, 'decision-trace.json');
  const trace = new AgentDecisionTrace({ storagePath });
  await trace.propose(input());
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  persisted.decisions[0].decisionSummary = 'tampered';
  await writeFile(storagePath, JSON.stringify(persisted));
  await assert.rejects(new AgentDecisionTrace({ storagePath }).load(), /DECISION_STORE_INVALID/);
});

test('fails closed when a persisted outcome is re-signed by an unsupported actor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-decision-outcome-tamper-'));
  const storagePath = join(directory, 'decision-trace.json');
  const trace = new AgentDecisionTrace({ storagePath });
  const decision = await trace.propose(input());
  await trace.commit(decision.decisionId);
  await trace.linkOutcome(decision.decisionId, { outcomeId: 'outcome-1', status: 'SUCCEEDED', sourceType: 'verifier', sourceId: 'verifier-1' });
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  persisted.outcomes[0].sourceType = 'agent';
  persisted.outcomes[0].outcomeDigest = decisionTraceDigest(Object.fromEntries(Object.entries(persisted.outcomes[0]).filter(([key]) => key !== 'outcomeDigest')));
  await writeFile(storagePath, JSON.stringify(persisted));
  await assert.rejects(new AgentDecisionTrace({ storagePath }).load(), /DECISION_(OUTCOME_ACTOR_FORBIDDEN|STORE_INVALID)/);
});
