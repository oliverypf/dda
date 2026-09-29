import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { createMemoryJournal } from '../src/memory-journal.mjs';
import { createPluginGovernance } from '../src/plugin-governance.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { pluginManifest } from '../src/plugins/registry.mjs';
import { createModelEgressLedger, normalizeEgressTarget } from '../src/model-egress-ledger.mjs';

test('dashboard reads plugin and evolution state from the Harness Event Store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-dashboard-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const harness = join(directory, 'events.db');
  const eventStore = createHarnessEventStore({ storagePath: harness });
  await eventStore.load();
  const governance = createPluginGovernance({ eventStore });
  await governance.load();
  const plugin = await governance.discoverDurably(
    pluginManifest('event-sourced-plugin', 'Event Sourced Plugin', 'skill', ['test.capability'], ['trajectory.read.redacted']),
    { source: 'LOCAL_DEVELOPMENT' }
  );
  const evolution = new EvolutionRegistry({ eventStore });
  await evolution.load();
  const proposal = await evolution.propose({ candidateType: 'OUTCOME_DERIVED', sourceOutcomeIds: ['outcome-1'] });
  const evaluator = new EvolutionEvaluator({ registry: evolution, eventStore });
  const report = await evaluator.replay({
    proposalId: proposal.proposalId,
    fixtures: [{ caseId: 'case-1', baseline: { status: 'SUCCEEDED' }, candidate: { status: 'SUCCEEDED' } }]
  });
  const execution = createExecutionStateStore({ eventStore });
  await execution.load();
  const intent = await execution.createIntent({
    runId: 'run-exec',
    capability: 'shell.execute',
    request: { command: 'node -v' },
    snapshotDigest: `sha256:${'a'.repeat(64)}`,
    operationId: 'operation-exec'
  });
  await execution.transition(intent.recordId, 'SAFETY_EVALUATING');
  const threads = createThreadStore({ eventStore });
  await threads.load();
  const thread = await threads.create({ cwd: directory, title: 'Event thread' });
  await threads.appendTurn(thread.id, { runId: 'run-thread', summary: 'fixture turn', state: 'SUCCEEDED' });
  await threads.setCheckpoint(thread.id, {
    runId: 'run-thread',
    phase: 'EXECUTING',
    state: 'RUNNING',
    pendingActions: ['continue']
  });
  const memory = createMemoryJournal({ eventStore });
  await memory.load();
  const memoryRecord = await memory.proposeDurably({
    runId: 'run-memory',
    statement: 'Verified task outcome: class=inspect; verifier=PASS; outputDigest=sha256:event',
    sourceEventIds: ['event-1'],
    scope: 'workspace',
    kind: 'TASK_OUTCOME',
    confidence: 0.9
  });
  await eventStore.append({
    runId: 'run-decision',
    kind: 'DecisionTraceEvent',
    payload: {
      decisionTraceEventId: 'dte-root',
      decisionId: 'decision-root',
      traceKind: 'DecisionCommitted',
      decisionSnapshot: { decisionId: 'decision-root', runId: 'run-decision', status: 'COMMITTED', decisionType: 'plan', role: 'planner', stepId: 'step-1', options: [{}] }
    }
  });
  await eventStore.append({
    runId: 'run-decision',
    kind: 'DecisionTraceEvent',
    payload: {
      decisionTraceEventId: 'dte-child',
      decisionId: 'decision-child',
      traceKind: 'DecisionCommitted',
      decisionSnapshot: {
        decisionId: 'decision-child',
        runId: 'run-decision',
        status: 'COMMITTED',
        decisionType: 'route',
        role: 'router',
        stepId: 'step-2',
        parentDecisionIds: ['decision-root'],
        options: [{}, {}]
      }
    }
  });
  const egressLedger = createModelEgressLedger({ eventStore, now: () => 3000 });
  await egressLedger.recordDurably([{
    phase: 'CANDIDATE_DRAFT',
    status: 'SUCCEEDED',
    runId: 'run-decision',
    candidateId: 'binding-a',
    modelId: 'model-a',
    provider: 'openai',
    egress: normalizeEgressTarget('https://api.example.com/v1/responses'),
    promptDigest: `sha256:${'c'.repeat(64)}`,
    latencyMs: 75,
    expectedCost: 0.4
  }]);
  await eventStore.append({
    runId: 'run-decision',
    aggregateType: 'ModelUsage',
    aggregateId: 'run-decision',
    kind: 'ModelUsageRecorded',
    payload: {
      provider: 'openai', protocol: 'responses', model: 'model-a', status: 'SUCCEEDED',
      inputTokens: 100, outputTokens: 10, cachedInputTokens: 80, uncachedInputTokens: 20,
      cacheReported: true, usageReported: true, prefixChanged: false
    }
  });

  const result = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../src/index.mjs', import.meta.url)),
    'dashboard'
  ], {
    env: {
      ...process.env,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_TRAJECTORY_STORE: trajectory,
      HMCODEX_HARNESS_EVENT_STORE: harness
    },
    windowsHide: true
  });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.ok(payload.plugins.some((item) => item.pluginId === plugin.pluginId));
  assert.ok(payload.evolution.proposals.some((item) => item.proposalId === proposal.proposalId));
  assert.ok(payload.evolution.reports.some((item) => item.reportId === report.reportId));
  assert.ok(payload.execution.records.some((record) => record.recordId === intent.recordId && record.state === 'SAFETY_EVALUATING'));
  const projectedThread = payload.threads.find((item) => item.id === thread.id);
  assert.equal(projectedThread?.title, `Thread ${thread.id.slice(-8)}`);
  assert.equal(projectedThread?.turnCount, 1);
  assert.equal(projectedThread?.turns, undefined);
  assert.equal(projectedThread?.checkpoint, undefined);
  assert.equal(projectedThread?.state, 'RUNNING');
  assert.equal(projectedThread?.resumable, false);
  assert.ok(payload.memories.some((item) => item.memoryId === memoryRecord.memoryId && item.statement === memoryRecord.statement));
  // The Decision DAG the desktop renders must come from the same durable facts.
  const dagNodes = Object.fromEntries((payload.projection?.decisions ?? []).map((node) => [node.decisionId, node]));
  assert.equal(dagNodes['decision-root']?.stepId, 'step-1');
  assert.deepEqual(dagNodes['decision-child']?.parentDecisionIds, ['decision-root']);
  assert.equal(dagNodes['decision-child']?.optionCount, 2);
  // Support Bundle readiness is scanned with the same privacy rules as the real export.
  assert.equal(payload.supportBundle?.ok, true);
  assert.equal(payload.supportBundle?.privacy.scan.ok, true);
  assert.deepEqual(payload.supportBundle?.privacy.scan.violations, []);
  assert.equal(payload.supportBundle?.privacy.rawPromptIncluded, false);
  assert.equal(payload.supportBundle?.stores.decisions.count, 2);
  // Candidate-granularity egress reaches both the dashboard and the bundle view.
  assert.equal(payload.modelEgress?.recordCount, 1);
  assert.equal(payload.modelEgress?.byCandidate['binding-a'].modelId, 'model-a');
  assert.equal(payload.supportBundle?.stores.modelEgress.recordCount, 1);
  assert.equal(payload.modelUsage?.status, 'REPORTED');
  assert.equal(payload.modelUsage?.cacheHitRate, 0.8);
  assert.equal(payload.modelUsage?.cacheCoverage, 1);
  assert.equal(payload.supportBundle?.stores.modelUsage.cachedInputTokens, 80);
  assert.equal(payload.supportBundle?.privacy.scan.ok, true);
  assert.equal(JSON.stringify(await eventStore.list()).includes('Event thread'), false);
});
