import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgentDecisionTrace } from '../src/decision-trace.mjs';
import { evaluateDecisionTrace, exportLearningSample } from '../src/decision-evaluation.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const decisionInput = (decisionType, stepId, withEvidence = false) => ({
  runId: 'run-evaluation',
  stepId,
  agentInstanceId: `agent-${stepId}`,
  role: 'coordinator',
  roleContextId: `context-${stepId}`,
  bindingSnapshotId: 'binding-1',
  decisionType,
  objectiveRef: 'objective-1',
  constraintSnapshotId: 'constraints-1',
  featureSnapshotId: 'features-1',
  evidenceRefs: withEvidence ? [{ evidenceId: `evidence-${stepId}`, eventId: `event-${stepId}`, evidenceType: 'verifier', stance: 'SUPPORTS', freshnessAtMs: 10 }] : [],
  assumptions: [],
  options: [
    { optionId: `option-${stepId}`, actionKind: 'CONTINUE', summary: 'Continue with the bounded operation', requiredCapabilityIds: [], evidenceRefs: withEvidence ? [`evidence-${stepId}`] : [], riskCodes: [], rejectionReasonCodes: [] },
    { optionId: `option-${stepId}-alternative`, actionKind: 'ABORT', summary: 'Abort the bounded operation', requiredCapabilityIds: [], evidenceRefs: [], riskCodes: ['HIGH_RISK'], rejectionReasonCodes: ['NOT_SELECTED'] }
  ],
  selectedOptionId: `option-${stepId}`,
  decisionSummary: 'A bounded decision for evaluation.',
  selectionCriteria: ['deterministic'],
  reasonCodes: ['REQUIRED'],
  uncertaintyCodes: [],
  expectedOutcome: { successCriteriaRefs: ['criterion-1'], predictedOutcomeCode: 'DONE', predictedRiskCodes: [] },
  outputRefs: [],
  sensitivity: 'INTERNAL'
});

const completeFixture = async (outcomeStatus = 'SUCCEEDED', storagePath, eventStore) => {
  const trace = new AgentDecisionTrace({ now: () => 100, ...(storagePath ? { storagePath } : {}), ...(eventStore ? { eventStore } : {}) });
  const types = [
    ['CLASSIFY_TASK', 'classify', false],
    ['SELECT_ROUTE', 'route', false],
    ['ALLOCATE_ROLE_CONTEXTS', 'allocate', false],
    ['CREATE_PLAN', 'plan', false],
    ['VERIFY_TASK_RESULT', 'verify', true]
  ];
  const decisions = [];
  for (const [type, step, evidence] of types) {
    const decision = await trace.propose(decisionInput(type, step, evidence));
    await trace.commit(decision.decisionId);
    await trace.linkOutcome(decision.decisionId, {
      status: outcomeStatus,
      sourceType: type === 'VERIFY_TASK_RESULT' ? 'verifier' : 'coordinator',
      sourceId: `source-${step}`,
      executionEventIds: [`execution-${step}`],
      verifierReportIds: type === 'VERIFY_TASK_RESULT' ? ['report-1'] : []
    });
    decisions.push(decision);
  }
  return { trace, decisions };
};

test('evaluates complete decision coverage and exports an eligible learning sample', async () => {
  const { trace } = await completeFixture();
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.decisionCoverage.percent, 100);
  assert.equal(evaluation.optionCoverage.percent, 100);
  assert.equal(evaluation.evidenceLinkRate.percent, 100);
  assert.equal(evaluation.decisionOutcomeLinkRate.percent, 100);
  assert.equal(evaluation.traceIntegrity.valid, true);
  assert.equal(evaluation.eligibleForLearning, true);
  assert.match(evaluation.replayChecksum, /^sha256:[0-9a-f]{64}$/u);
  const sample = exportLearningSample({ trace, runId: 'run-evaluation' });
  assert.equal(sample.decisions.length, 5);
  assert.equal(sample.outcomes.length, 5);
  assert.equal(sample.metrics.traceIntegrity, true);
  assert.doesNotMatch(JSON.stringify(sample), /prompt|reasoning|credential|secret/i);
});

test('rejects learning export when coverage or outcome eligibility is incomplete', async () => {
  const trace = new AgentDecisionTrace();
  const decision = await trace.propose(decisionInput('CLASSIFY_TASK', 'classify'));
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.eligibleForLearning, false);
  assert.ok(evaluation.learningExclusionReasons.includes('DECISION_NOT_COMMITTED'));
  assert.throws(() => exportLearningSample({ trace, runId: 'run-evaluation' }), /LEARNING_EXPORT_INCOMPLETE/);
  const incomplete = await completeFixture('UNKNOWN');
  assert.throws(() => exportLearningSample({ trace: incomplete.trace, runId: 'run-evaluation' }), /LEARNING_EXPORT_OUTCOME_INELIGIBLE/);
});

test('fails decision coverage when a required decision type is missing', async () => {
  const trace = new AgentDecisionTrace();
  for (const [type, step, evidence] of [
    ['CLASSIFY_TASK', 'classify', false],
    ['SELECT_ROUTE', 'route', false],
    ['ALLOCATE_ROLE_CONTEXTS', 'allocate', false],
    ['VERIFY_TASK_RESULT', 'verify', true]
  ]) {
    const decision = await trace.propose(decisionInput(type, step, evidence));
    await trace.commit(decision.decisionId);
    await trace.linkOutcome(decision.decisionId, {
      status: 'SUCCEEDED',
      sourceType: type === 'VERIFY_TASK_RESULT' ? 'verifier' : 'coordinator',
      sourceId: `source-${step}`,
      executionEventIds: [`execution-${step}`]
    });
  }
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.decisionCoverage.percent, 80);
  assert.deepEqual(evaluation.decisionCoverage.missingRequiredTypes, ['CREATE_PLAN']);
  assert.equal(evaluation.decisionCoverage.allRequiredTypesCommitted, false);
  assert.equal(evaluation.eligibleForLearning, false);
  assert.ok(evaluation.learningExclusionReasons.includes('DECISION_REQUIRED_TYPE_MISSING'));
  assert.throws(() => exportLearningSample({ trace, runId: 'run-evaluation' }), /DECISION_REQUIRED_TYPE_MISSING/);
});

test('fails option coverage when no decision has real branches', async () => {
  const trace = new AgentDecisionTrace();
  const input = decisionInput('CLASSIFY_TASK', 'classify');
  input.options = [input.options[0]];
  const decision = await trace.propose(input);
  await trace.commit(decision.decisionId);
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.optionCoverage.vacuous, true);
  assert.equal(evaluation.optionCoverage.percent, 0);
  assert.equal(evaluation.optionCoverage.allSelected, false);
  assert.ok(evaluation.learningExclusionReasons.includes('DECISION_OPTION_COVERAGE_VACUOUS'));
});

test('fails option coverage when eliminated options have no structured rejection reason', async () => {
  const trace = new AgentDecisionTrace();
  const input = decisionInput('CLASSIFY_TASK', 'classify');
  input.options[1].rejectionReasonCodes = [];
  const decision = await trace.propose(input);
  await trace.commit(decision.decisionId);
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.optionCoverage.percent, 0);
  assert.equal(evaluation.optionCoverage.allSelected, false);
  assert.deepEqual(evaluation.optionCoverage.missingEliminationReasonDecisionIds, [decision.decisionId]);
  assert.ok(evaluation.learningExclusionReasons.includes('DECISION_ELIMINATION_REASON_MISSING'));
});

test('exempts explicit no-evidence rule decisions from evidence link rate', async () => {
  const trace = new AgentDecisionTrace();
  const input = decisionInput('SELECT_TOOL_ACTION', 'tool');
  input.reasonCodes = ['DETERMINISTIC_RULE', 'NO_EVIDENCE_REQUIRED'];
  const decision = await trace.propose(input);
  await trace.commit(decision.decisionId);
  const evaluation = evaluateDecisionTrace({ trace, runId: 'run-evaluation' });
  assert.equal(evaluation.evidenceLinkRate.total, 0);
  assert.equal(evaluation.evidenceLinkRate.vacuous, true);
  assert.equal(evaluation.evidenceLinkRate.allLinked, true);
  assert.equal(evaluation.evidenceLinkRate.exemptDecisionIds.length, 1);
});


test('CLI replays a decision trace from the Harness Event Store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-harness-cli-'));
  const harnessPath = join(root, 'harness-events.json');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await completeFixture('SUCCEEDED', undefined, eventStore);
  const invoke = promisify(execFile);
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const evaluated = JSON.parse((await invoke(process.execPath, [entry, 'evaluate', '--run-id', 'run-evaluation', '--harness-event-store', harnessPath, '--decision-trace-store', join(root, 'missing-decision-trace.json')])).stdout);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.evaluation.decisionCount, 5);
  assert.equal(evaluated.evaluation.decisionOutcomeLinkRate.percent, 100);
});

test('CLI evaluates and exports a persisted decision trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-cli-'));
  const tracePath = join(root, 'decision-trace.json');
  await completeFixture('SUCCEEDED', tracePath);
  const invoke = promisify(execFile);
  const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const evaluated = JSON.parse((await invoke(process.execPath, [entry, 'evaluate', '--run-id', 'run-evaluation', '--metric', 'decision-coverage', '--decision-trace-store', tracePath])).stdout);
  assert.equal(evaluated.ok, true);
  assert.equal(evaluated.result.percent, 100);
  const exported = JSON.parse((await invoke(process.execPath, [entry, 'export-learning', '--run-id', 'run-evaluation', '--decision-trace-store', tracePath])).stdout);
  assert.equal(exported.ok, true);
  assert.equal(exported.sample.decisions.length, 5);
});
