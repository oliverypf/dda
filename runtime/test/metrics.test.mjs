import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createMeteredHarnessEventStore } from '../src/commit-metrics.mjs';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';

test('metrics reports event, projection, replay, storage, and decision counters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-metrics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const decisionTracePath = join(directory, 'decision-trace.json');
  const eventStore = createMeteredHarnessEventStore({
    store: createHarnessEventStore({ storagePath: harness }),
    metricsPath: `${harness}.commit-metrics.json`
  });
  await eventStore.load();
  await eventStore.append({ runId: 'run-metrics', kind: 'TaskRunCreated', commandId: 'created', payload: { title: 'metrics' } });
  await eventStore.append({ runId: 'run-metrics', kind: 'RunStateChanged', commandId: 'planning', payload: { to: 'PLANNING' } });
  await eventStore.append({ runId: 'run-metrics', kind: 'TaskRunCompleted', commandId: 'completed', payload: { outcomeStatus: 'SUCCEEDED' } });
  const trace = new AgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  const decision = await trace.propose({
    runId: 'run-metrics',
    stepId: 'metrics-step',
    agentInstanceId: 'agent-metrics',
    role: 'coordinator',
    roleContextId: 'context-metrics',
    bindingSnapshotId: 'snapshot-binding',
    decisionType: 'CLASSIFY_TASK',
    objectiveRef: 'objective-metrics',
    constraintSnapshotId: 'snapshot-constraints',
    featureSnapshotId: 'snapshot-features',
    evidenceRefs: [],
    assumptions: [],
    options: [
      {
        optionId: 'option-a',
        actionKind: 'CLASSIFY',
        summary: 'A',
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: [],
        rejectionReasonCodes: []
      },
      {
        optionId: 'option-b',
        actionKind: 'CLASSIFY',
        summary: 'B',
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: [],
        rejectionReasonCodes: ['NOT_SELECTED']
      }
    ],
    selectedOptionId: 'option-a',
    decisionSummary: 'metrics',
    selectionCriteria: ['rule'],
    reasonCodes: ['RULE'],
    uncertaintyCodes: [],
    expectedOutcome: { successCriteriaRefs: ['criterion'], predictedOutcomeCode: 'DONE', predictedRiskCodes: [] },
    outputRefs: [],
    sensitivity: 'INTERNAL'
  });
  await trace.commit(decision.decisionId);
  await trace.linkOutcome(decision.decisionId, {
    status: 'SUCCEEDED',
    sourceType: 'coordinator',
    sourceId: 'coordinator-metrics',
    executionEventIds: ['execution-metrics']
  });

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'metrics'
  ], {
    env: {
      ...process.env,
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness,
      HMCODEX_DECISION_TRACE_STORE: decisionTracePath
    },
    windowsHide: true
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.metrics.eventCount >= 6);
  assert.ok(payload.metrics.receiptCount >= 3);
  assert.equal(payload.metrics.commitBasis, 'METERED_COMMITS');
  assert.ok(payload.metrics.commitAttempts >= 6);
  assert.equal(payload.metrics.commitFailures, 0);
  assert.equal(payload.metrics.commitSuccessRate, 1);
  assert.equal(payload.metrics.projectionLag['run-metrics'], 0);
  assert.equal(payload.metrics.nonTerminalRuns, 0);
  assert.ok(payload.metrics.replayDurationMs >= 0);
  assert.ok(payload.metrics.storageBytes > 0);
  assert.equal(payload.metrics.decisionCount, 1);
  assert.equal(payload.metrics.outcomeCount, 1);
  assert.equal(payload.metrics.unlinkedOutcomeCount, 0);
  assert.equal(payload.metrics.runCount, 1);
});
