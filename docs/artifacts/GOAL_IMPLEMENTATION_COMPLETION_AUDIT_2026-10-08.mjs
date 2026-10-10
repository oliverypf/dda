import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)), artifacts = join(root, 'docs/artifacts');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const command = await json(join(artifacts, 'AGENT_GOAL_MERGED_ONE_COMMAND_2026-10-08.json'));
const fixed = await json(command.comparison);
const live = await json(join(artifacts, 'AGENT_GOAL_MERGED_COMPARE_COMPLETION_AUDIT_2026-10-08.json'));
const upgrade = await json(join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_UPGRADE_2026-10-08.json'));
const automatic = await json(join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_AUTOMATIC_2026-10-08.json'));
const expectedSteps = ['build', 'recovery-jev-runtime', 'fixed-task-acceptance', 'native-resume-retry', 'paired-fixed-tasks'];
if (command.passed !== true || command.mode !== 'LOCAL_FIXTURE' || command.steps.length !== 5
  || !command.steps.every((step, index) => step.id === expectedSteps[index] && step.passed && step.exitCode === 0 && !step.timedOut)) throw Error('ONE_COMMAND_NOT_COMPLETE');
const sourceFiles = [];
for (const path of (await readdir(join(root, 'runtime/src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort())
  sourceFiles.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(root, 'runtime/src', path))) });
for (const path of ['package.json', 'package-lock.json']) sourceFiles.push({ path: `../${path}`, sha256: hash(await readFile(join(root, 'runtime', path))) });
const sourceSha256 = hash(JSON.stringify(sourceFiles));
if (![fixed, live, upgrade, automatic].every(report => report.runtimeSourceSha256 === sourceSha256)) throw Error('FINAL_SOURCE_MISMATCH');
if (!upgrade.passed || !automatic.passed || !upgrade.checks.checkpointRestored || !upgrade.checks.actualStrongExecutor
  || !automatic.checks.actualInitialMissingRead || !automatic.checks.realJevRecoveryDecision || !automatic.checks.finalSuccess) throw Error('LIVE_RECOVERY_NOT_VERIFIED');
if (fixed.rows.length !== 24 || fixed.rows.some(row => row.status !== 'SUCCEEDED' || !row.grade.passed)
  || fixed.contentAudit.passed !== true || live.scope !== '48-RUN_PAIRED_AND_JEV_ABLATION' || !live.complete) throw Error('FIXED_COMPARISONS_INCOMPLETE');
const nativeLog = command.steps.find(step => step.id === 'native-resume-retry').log;
const native = await readFile(nativeLog, 'utf8');
if (!native.includes('Summary: 28 passed, 0 failed, 0 skipped')
  || !/PASS\s+T07R/u.test(native) || !/PASS\s+T15/u.test(native) || !/PASS\s+T01C/u.test(native)) throw Error('NATIVE_RECOVERY_OR_SCROLL_NOT_VERIFIED');
const history = (await readFile(join(artifacts, 'agent-goal-runs/history.jsonl'), 'utf8')).trim().split(/\r?\n/u).map(JSON.parse);
let verifiedPersistedRealRows = 0;
for (const name of ['PAIRED', 'JEV_ABLATION']) {
  const report = await json(join(artifacts, `AGENT_GOAL_MERGED_${name}_2026-10-08.json`));
  for (const row of report.rows) {
    const stored = history.filter(item => item.runKey === row.runKey);
    if (stored.length !== 1 || ['status', 'recovered', 'modelCalls', 'toolRounds', 'wallMs', 'totalTokens', 'actualCost', 'manualInterventionMinutes']
      .some(field => stored[0][field] !== row[field])) throw Error(`CONTINUOUS_RECORD_NOT_VERIFIED:${row.runKey}`);
    if (!Number.isFinite(row.modelCalls) || !Number.isFinite(row.toolRounds) || !Number.isFinite(row.wallMs)
      || !row.usageCoverage || !row.billing || !row.manualMeasurement) throw Error('METRIC_SOURCE_MISSING');
    if (row.actualCost === null && row.billing.coverage !== 'UNKNOWN') throw Error('UNKNOWN_COST_WITHOUT_REASON');
    if (row.manualMeasurement === 'NO_HUMAN_CHANNEL' && row.manualInterventionMinutes !== 0) throw Error('SYNTHETIC_HUMAN_MEASUREMENT');
    verifiedPersistedRealRows++;
  }
}
const evidence = await Promise.all([nativeLog, ...command.steps.map(step => step.log),
  join(artifacts, 'AGENT_GOAL_MERGED_ONE_COMMAND_2026-10-08.json'),
  join(artifacts, 'AGENT_GOAL_MERGED_COMPARE_COMPLETION_AUDIT_2026-10-08.json'),
  join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_UPGRADE_2026-10-08.json'),
  join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_AUTOMATIC_2026-10-08.json')]
  .map(async path => ({ path, sha256: hash(await readFile(path)) })));
const report = { generatedAt: new Date().toISOString(), scope: 'IMPLEMENT_THE_THREE_REQUESTED_AUTOMATED_TESTS', sourceSha256,
  requestedTestAutomationVerified: true, oneCommandPassed: true, verifiedPersistedRealRows,
  requirements: [
    { requirement: 'Preset interrupted task; resume from checkpoint.', verdict: 'VERIFIED', evidence: 'Native T07R and actual process-interruption runtime checks; restored checkpoints preserve completed work.' },
    { requirement: 'Preset definite failure; retry/model upgrade/Jev decision until success.', verdict: 'VERIFIED', evidence: 'Native T15; actual Flash missing-file failure and same-checkpoint explicit Pro success; separate actual Jev automatic recovery success.' },
    { requirement: 'Fixed tasks; continuously record success/recovery/human minutes/token/cost/tool rounds and compare ordinary Codex with the same model.', verdict: 'VERIFIED_AUTOMATION_AND_RECORDED_AVAILABLE_DATA', evidence: '48 actual frozen-source runs, 24 matched pairs, append-only records and independently rechecked native success evidence. Missing usage/invoices remain explicitly unknown; headless human minutes are zero with NO_HUMAN_CHANNEL.' },
  ],
  productAdvantageProven: false, cashSavingsProven: false, humanSavingsProven: false,
  automaticJevStrongSelectionProven: automatic.automaticJevStrongSelectionProven,
  remainingProductValidation: ['Provide actual invoices and genuine human activity to measure cash/labor savings.', 'Real automatic stronger-model selection is not yet observed.', 'Use larger representative workloads before claiming general engineering superiority.'],
  limitations: ['Local fixture success verifies test machinery and real tool execution, not production inference quality.', 'Implementing these tests does not mean proving that the product is worth paying for.', 'Failed actual tasks remain failed; missing measurement values are not filled with zero.'], evidence };
await writeFile(join(artifacts, 'AGENT_GOAL_IMPLEMENTATION_COMPLETION_AUDIT_2026-10-08.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ requestedTestAutomationVerified: true, sourceSha256, oneCommandPassed: true, verifiedPersistedRealRows }));
