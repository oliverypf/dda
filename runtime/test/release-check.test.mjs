import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';

const proposeEligibleDecisions = async (trace, runId) => {
  for (const [index, decisionType] of [
    'CLASSIFY_TASK',
    'SELECT_ROUTE',
    'ALLOCATE_ROLE_CONTEXTS',
    'CREATE_PLAN',
    'VERIFY_TASK_RESULT'
  ].entries()) {
    const decision = await trace.propose({
      runId,
      stepId: `${runId}-step-${index}`,
      agentInstanceId: 'agent-release',
      role: 'coordinator',
      roleContextId: 'context-release',
      bindingSnapshotId: 'snapshot-binding',
      decisionType,
      objectiveRef: 'objective-release',
      constraintSnapshotId: 'snapshot-constraints',
      featureSnapshotId: 'snapshot-features',
      evidenceRefs: [],
      assumptions: [],
      options: [
        { optionId: 'option-a', actionKind: 'DECIDE', summary: 'A', requiredCapabilityIds: [], evidenceRefs: [], riskCodes: [], rejectionReasonCodes: [] },
        { optionId: 'option-b', actionKind: 'DECIDE', summary: 'B', requiredCapabilityIds: [], evidenceRefs: [], riskCodes: [], rejectionReasonCodes: ['NOT_SELECTED'] }
      ],
      selectedOptionId: 'option-a',
      decisionSummary: 'release',
      selectionCriteria: ['rule'],
      reasonCodes: ['RULE', 'NO_EVIDENCE_REQUIRED'],
      uncertaintyCodes: [],
      expectedOutcome: { successCriteriaRefs: ['criterion'], predictedOutcomeCode: 'DONE', predictedRiskCodes: [] },
      outputRefs: [],
      sensitivity: 'INTERNAL'
    });
    await trace.commit(decision.decisionId);
    await trace.linkOutcome(decision.decisionId, {
      status: 'SUCCEEDED',
      sourceType: 'coordinator',
      sourceId: `coordinator-${runId}-${index}`,
      executionEventIds: [`execution-${runId}-${index}`]
    });
  }
};

test('release-check reports channel, versions, side-effect rejection, read model, decisions, privacy, and capacity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-release', kind: 'TaskRunCreated', commandId: 'created', payload: { title: 'release' } });
  await eventStore.append({ runId: 'run-release', kind: 'TaskRunCompleted', commandId: 'completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await proposeEligibleDecisions(trace, 'run-release');

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'release-check'
  ], {
    env: {
      ...process.env,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  const report = payload.report;
  assert.equal(report.releaseChannel, 'WINDOWS_PHASE1_READ_ONLY');
  assert.equal(report.versions.storageSchemaVersion, 1);
  assert.equal(report.versions.protocolVersion, '1.0');
  assert.equal(report.versions.policyVersion, 'runtime-safety-1');
  assert.equal(report.versions.producerVersion, 'hmcodex-runtime@0.1.0');
  assert.equal(report.sideEffectRejection.blocked, true);
  assert.equal(report.sideEffectRejection.errorCode, 'RELEASE_CHANNEL_READ_ONLY');
  assert.match(report.readModel.projectionChecksum, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(report.decisionTrace.minDecisionCoverage, 100);
  assert.equal(report.decisionTrace.minOptionCoverage, 100);
  assert.equal(report.decisionTrace.minEvidenceLinkRate, 100);
  assert.equal(report.decisionTrace.minDecisionOutcomeLinkRate, 100);
  assert.deepEqual(report.privacy, { ok: true, violations: [] });
  assert.equal(report.capacity.level, 'OK');
  assert.equal(report.checks.hasRuns, true);
  assert.equal(report.passed, true);
});

test('release-check excludes incomplete runs from learning instead of failing the gate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-check-ineligible-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-eligible', kind: 'TaskRunCreated', commandId: 'eligible-created', payload: { title: 'eligible' } });
  await eventStore.append({ runId: 'run-eligible', kind: 'TaskRunCompleted', commandId: 'eligible-completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  await eventStore.append({ runId: 'run-ineligible', kind: 'TaskRunCreated', commandId: 'ineligible-created', payload: { title: 'ineligible' } });
  await eventStore.append({ runId: 'run-ineligible', kind: 'TaskRunFailed', commandId: 'ineligible-failed', payload: { outcomeStatus: 'FAILED', code: 'PROVIDER_UNREACHABLE' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await proposeEligibleDecisions(trace, 'run-eligible');
  const incomplete = await trace.propose({
    runId: 'run-ineligible',
    stepId: 'ineligible-step-0',
    agentInstanceId: 'agent-release',
    role: 'coordinator',
    roleContextId: 'context-release',
    bindingSnapshotId: 'snapshot-binding',
    decisionType: 'CLASSIFY_TASK',
    objectiveRef: 'objective-release',
    constraintSnapshotId: 'snapshot-constraints',
    featureSnapshotId: 'snapshot-features',
    evidenceRefs: [],
    assumptions: [],
    options: [
      { optionId: 'option-a', actionKind: 'DECIDE', summary: 'A', requiredCapabilityIds: [], evidenceRefs: [], riskCodes: [], rejectionReasonCodes: [] },
      { optionId: 'option-b', actionKind: 'DECIDE', summary: 'B', requiredCapabilityIds: [], evidenceRefs: [], riskCodes: [], rejectionReasonCodes: ['NOT_SELECTED'] }
    ],
    selectedOptionId: 'option-a',
    decisionSummary: 'incomplete',
    selectionCriteria: ['rule'],
    reasonCodes: ['RULE', 'NO_EVIDENCE_REQUIRED'],
    uncertaintyCodes: [],
    expectedOutcome: { successCriteriaRefs: ['criterion'], predictedOutcomeCode: 'DONE', predictedRiskCodes: [] },
    outputRefs: [],
    sensitivity: 'INTERNAL'
  });
  await trace.commit(incomplete.decisionId);

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'release-check'
  ], {
    env: {
      ...process.env,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const report = JSON.parse(result.stdout).report;
  assert.equal(report.passed, true);
  assert.equal(report.checks.decisionMetrics, true);
  assert.equal(report.decisionTrace.eligibleRunCount, 1);
  assert.equal(report.decisionTrace.ineligibleRunCount, 1);
  assert.deepEqual(report.decisionTrace.ineligibleRunIds, ['run-ineligible']);
  assert.equal(report.decisionTrace.eligible.minDecisionCoverage, 100);
  assert.equal(report.decisionTrace.eligible.minDecisionOutcomeLinkRate, 100);
  assert.equal(report.decisionTrace.allIneligibleExcluded, true);
  assert.equal(report.decisionTrace.allEligibleComplete, true);
});

test('release-check accepts a controlled channel and does not claim side-effect rejection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-check-controlled-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-controlled', kind: 'TaskRunCreated', commandId: 'controlled-created', payload: { title: 'controlled' } });
  await eventStore.append({ runId: 'run-controlled', kind: 'TaskRunCompleted', commandId: 'controlled-completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await proposeEligibleDecisions(trace, 'run-controlled');

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'release-check'
  ], {
    env: {
      ...process.env,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const report = JSON.parse(result.stdout).report;
  assert.equal(report.releaseChannel, 'WINDOWS_PHASE1_5_CONTROLLED');
  assert.deepEqual(report.sideEffectRejection, { blocked: false });
  assert.equal(report.checks.releaseChannel, true);
  assert.equal(report.checks.sideEffectRejection, true);
  assert.equal(report.passed, true);
});

test('release-check accepts the phase-2 WINDOWS_FULL_LOCAL channel instead of failing on its own target', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-check-full-local-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-full-local', kind: 'TaskRunCreated', commandId: 'full-local-created', payload: { title: 'full-local' } });
  await eventStore.append({ runId: 'run-full-local', kind: 'TaskRunCompleted', commandId: 'full-local-completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await proposeEligibleDecisions(trace, 'run-full-local');

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'release-check'
  ], {
    env: {
      ...process.env,
      HMCODEX_BAKED_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const report = JSON.parse(result.stdout).report;
  assert.equal(report.releaseChannel, 'WINDOWS_FULL_LOCAL');
  assert.equal(report.checks.releaseChannel, true);
  assert.equal(report.checks.sideEffectRejection, true);
  assert.deepEqual(report.sideEffectRejection, { blocked: false });
  assert.equal(report.passed, true);
});

test('release-check still rejects an unapproved pre-phase-1 build', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-release-check-baseline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  await eventStore.append({ runId: 'run-baseline', kind: 'TaskRunCreated', commandId: 'baseline-created', payload: { title: 'baseline' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await proposeEligibleDecisions(trace, 'run-baseline');

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'release-check'
  ], {
    env: {
      ...process.env,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_MVP_PRE_PHASE1',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const report = JSON.parse(result.stdout).report;
  assert.equal(report.releaseChannel, 'WINDOWS_MVP_PRE_PHASE1');
  assert.equal(report.checks.releaseChannel, false);
  assert.equal(report.passed, false);
});
