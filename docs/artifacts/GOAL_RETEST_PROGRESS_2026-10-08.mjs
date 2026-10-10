import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
const root = 'C:/Users/User/hmCodex-local', artifacts = join(root, 'docs/artifacts');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const batchId = '20261007T162508744Z-b72917fe', batchRoot = join(artifacts, 'agent-goal-runs', batchId);
const stage = await json(join(artifacts, 'AGENT_GOAL_TEST_ACCEPTANCE_STAGE_AUDIT_2026-10-08.json'));
const manifest = await json(join(batchRoot, 'runtime-source-manifest.json'));
const hash = value => createHash('sha256').update(value).digest('hex');
for (const item of manifest.files) if (hash(await readFile(join(root, 'runtime/src', item.path))) !== item.sha256) throw Error(`FROZEN_RUNTIME_CHANGED:${item.path}`);
const rows = [];
for (const entry of await readdir(batchRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d-/u.test(entry.name)) continue;
  try { rows.push(await json(join(batchRoot, entry.name, 'result.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
rows.sort((a, b) => a.startedAtMs - b.startedAtMs);
const lastLog = (await readFile(join(artifacts, 'GOAL_TEST_ACCEPTANCE_FLASH_PAIRED_2026-10-08.log'), 'utf8')).trim().split(/\r?\n/u).at(-1);
const summarize = condition => {
  const selected = rows.filter(row => row.condition === condition);
  return { completed: selected.length, succeeded: selected.filter(row => row.status === 'SUCCEEDED').length,
    failed: selected.filter(row => row.status === 'FAILED').length, timedOut: selected.filter(row => row.status === 'TIMED_OUT').length,
    actualCost: null, humanSavingsMinutes: null, note: 'Partial original protocol 2.0 grades include the independently reproduced command-line false rejection. Do not use this partial count to claim comparative advantage.' };
};
const upgradeRows = [];
for (const [name, eventFile, responseName] of [
  ['multi', 'goal-real-model-upgrade-20261008/durable-events.jsonl', 'GOAL_REAL_MODEL_UPGRADE_2026-10-08.json'],
  ['single', 'goal-real-model-upgrade-single-20261008/durable-events.json', 'GOAL_REAL_MODEL_UPGRADE_SINGLE_2026-10-08.json']
]) {
  const runDirectory = name === 'multi' ? 'goal-real-model-upgrade-20261008' : 'goal-real-model-upgrade-single-20261008';
  const raw = await json(join(artifacts, eventFile));
  const events = name === 'multi' ? raw.events : raw;
  const original = await json(join(artifacts, responseName));
  const requests = [...await json(join(artifacts, runDirectory, 'flash-requests.json')), ...await json(join(artifacts, runDirectory, 'pro-requests.json'))];
  const outcomes = runtimeNativeOutcomes(events, requests);
  const choices = new Map();
  for (const event of events.filter(event => event.kind === 'DecisionTraceEvent')) {
    const decision = event.payload?.decisionSnapshot;
    if (decision?.status === 'COMMITTED' && decision.decisionType === 'SELECT_SAFE_MODEL_FALLBACK') choices.set(decision.decisionId, { selectedOptionId: decision.selectedOptionId, reasonCodes: decision.reasonCodes });
  }
  upgradeRows.push({ agentMode: name, runtimeReportedSuccess: original.checks.runtimeSuccess,
    actualMissingFileFailure: outcomes.some(outcome => !outcome.ok && outcome.errorCode === 'WORKSPACE_NOT_FOUND'),
    actualMarkerRead: outcomes.some(outcome => outcome.ok && outcome.name === 'workspace.read' && String(outcome.output).includes('GOAL_ACTUAL_TWO_MODEL_RECOVERY_20261008')),
    recoveryStarted: events.some(event => event.kind === 'RecoveryStarted'),
    actualProRequests: original.modelsUsed.proRequests, modelSelections: [...choices.values()], upgradeAcceptance: 'FAILED',
    source: responseName, observationCorrection: name === 'multi' ? 'Original script read only a JSONL path; phase1 stored native events in SQLite. This audit uses the actual durable event export. Overall upgrade failure remains unchanged.' : null });
}
const payloadProbe = await json(join(artifacts, 'GOAL_JEV_VERIFICATION_PAYLOAD_PROBE_2026-10-08.json'));
const baseline = payloadProbe.rows.filter(row => row.condition === 'BASELINE_DUPLICATED');
const compact = payloadProbe.rows.filter(row => row.condition === 'SINGLE_COPY');
const sumInput = rows => rows.reduce((total, row) => total + row.response.usage.input_tokens, 0);
const report = { generatedAt: new Date().toISOString(), scope: 'Current compiled native goal flows, full runtime regression, frozen-source live comparison progress and independent failure diagnosis.',
  currentRuntimeSha256: stage.runtimeSourceSha256, currentDebugExeSha256: stage.debugExeSha256,
  runtimeRegression: stage.runtime, nativeGoalFlows: stage.native, benchmarkScriptRegression: stage.scripts,
  milestones: [
    { goal: 'Sidebar scroll and checkpoint continuation', status: 'VALIDATED_CURRENT_NATIVE_BUILD', evidence: stage.native.log, limitation: '80 task history, wheel and last-item reachability; resume planner unchanged and executor advanced. Defined scenarios only, not exhaustive UI coverage.' },
    { goal: 'Retry / model upgrade / Jev recovery', status: 'PARTIAL', localFlow: 'VALIDATED_MOCK_BOUND_STRONG_MODEL', realUpgrade: 'NOT_PROVEN', actualNegativeExperiments: upgradeRows },
    { goal: 'Fixed tasks, metrics and same-model Codex comparison', status: 'FRAMEWORK_IMPLEMENTED_LIVE_VALIDATION_RUNNING', economicAdvantage: 'NOT_PROVEN', actualCashCost: 'UNKNOWN', humanTimeSavings: 'UNMEASURED' }
  ],
  liveBatch: { batchId, state: 'RUNNING_CONFIRMED_BY_TOOL_SESSION_86924', planned: 24, completed: rows.length, incomplete: 24 - rows.length,
    model: 'mimo-v2.6-flash', gradingProtocolVersion: '2.0-NATIVE_FIXTURE_TEST_EXECUTION', taskSetVersion: '3.1', lastLog,
    originalCounts: { hmcodex: summarize('hmcodex-runtime'), codex: summarize('ordinary-codex') },
    rows: rows.map(row => ({ iteration: row.iteration, taskId: row.taskId, condition: row.condition, status: row.status,
      failedChecks: Object.entries(row.grade.checks).filter(([, value]) => !value).map(([key]) => key), toolCallCount: row.toolCallCount, wallMs: row.wallMs, source: row.evidenceDirectory })) },
  newFindings: [
    { issue: 'Benchmark and host process-intent recognition omit a supported complete Node command string.', diagnosis: 'GOAL_COMMAND_LINE_ACCEPTANCE_DRAFT_2026-10-08.json',
      draftNativeProof: 'GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08.log', testsPassed: 2, productionMerged: false },
    { issue: 'Jev verification transport timeouts trigger executor recovery even after deterministic checks pass; extra executor work can introduce a capability failure.',
      actualCases: ['2-inspect-readme-001-hmcodex-runtime', '1-code-feature-001-hmcodex-runtime'] },
    { issue: 'Verification sends the same complete evidence twice.', diagnosticProbe: 'GOAL_JEV_VERIFICATION_PAYLOAD_PROBE_2026-10-08.json',
      actualDiagnosticDecisions: payloadProbe.rows.map(row => ({ condition: row.condition, stateIndex: row.stateIndex, choice: row.response?.answers?.verification?.choice, inputTokens: row.response?.usage?.input_tokens, wallMs: row.wallMs })),
      baselineInputTokens: sumInput(baseline), compactInputTokens: sumInput(compact), inputReductionFraction: 1 - sumInput(compact) / sumInput(baseline),
      limitation: 'All four archived-state requests returned PASS. Small decision probe only; not end-to-end speed, recovery or cost advantage.' },
    { issue: 'Real upgrade tests skipped the prescribed initial failure, then selected active-model; Pro was never called.', acceptance: 'FAILED', correctionNeeded: 'Record and enforce actual preset failure evidence; route from real bound model metadata and observed failure facts.' }
  ],
  nextRequired: ['Complete and preserve the full current-source 24-run comparison.', 'Merge and verify exact executor command normalization and native digest-bound grading after the frozen batch ends.',
    'Remove duplicate Jev verification evidence and retry transport-only verification without replaying executor tools; retain real FAIL/BLOCK and uncertain results.',
    'Obtain actual recorded failure → recovery → distinct bound strong-model call → verified success with real Jev decisions.',
    'Run same-source Jev off/on ablation and matched client comparison; use complete provider usage, real billing and human activity evidence for economic claims.'],
  limitations: ['Tests passing is not a completion percentage for an unbounded product.', 'Current comparative batch is incomplete and contains a known grader defect; no overall product advantage is established.',
    'Published subscription quota/API price estimates are not invoices; headless zero interaction is not saved human time.'], goalStatus: 'active' };
await writeFile(join(artifacts, 'AGENT_GOAL_RETEST_PROGRESS_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: 'AGENT_GOAL_RETEST_PROGRESS_2026-10-08.json', runtime: stage.runtime.passed, native: stage.native.passed,
  comparisonCompleted: rows.length, comparisonPlanned: 24, actualUpgradeProRequests: upgradeRows.map(row => row.actualProRequests),
  diagnosticInputReductionFraction: report.newFindings[2].inputReductionFraction, goalStatus: report.goalStatus }));
