import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = dirname(fileURLToPath(import.meta.url));
const json = async name => JSON.parse(await readFile(join(artifacts, name), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const path of (await readdir(join(root, 'runtime/src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort())
  files.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(root, 'runtime/src', path))) });
for (const path of ['package.json', 'package-lock.json']) files.push({ path: `../${path}`, sha256: hash(await readFile(join(root, 'runtime', path))) });
const runtimeSourceSha256 = hash(JSON.stringify(files));
const evidence = [
  'GOAL_VERIFICATION_FIX_FULL_RUNTIME_FINAL_2026-10-08.log',
  'GOAL_VERIFICATION_FIX_BUILD_FINAL_2026-10-08.log',
  'GOAL_VERIFICATION_FINAL_NATIVE_2026-10-08.log',
  'GOAL_VERIFICATION_COMPLETE_SCRIPT_SUITE_2026-10-08.log'
];
const logs = await Promise.all(evidence.map(async name => ({ path: join(artifacts, name), sha256: hash(await readFile(join(artifacts, name))) })));
const runtimeLog = await readFile(logs[0].path, 'utf8'), nativeLog = await readFile(logs[2].path, 'utf8'), scriptLog = await readFile(logs[3].path, 'utf8');
if (!/pass 666\r?\nℹ fail 0/u.test(runtimeLog) || !/27 passed, 0 failed, 0 skipped/u.test(nativeLog)
  || !/pass 38\r?\nℹ fail 0/u.test(scriptLog)) throw Error('FINAL_COUNTS_NOT_VERIFIED');
const upgrade = await json('AGENT_GOAL_UPGRADE_ENTRY_LIVE_2026-10-08.json');
const automatic = await json('AGENT_GOAL_AUTOMATIC_RECOVERY_LIVE_2026-10-08.json');
if (!upgrade.passed || !automatic.passed || [upgrade, automatic].some(report => report.runtimeSourceSha256 !== runtimeSourceSha256)) throw Error('CURRENT_LIVE_FLOW_NOT_VERIFIED');
const historical = await json('AGENT_GOAL_TEST_ACCEPTANCE_ARCHIVED_REGRADE_2026-10-08.json');
const executable = join(root, 'desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe');
const exeStat = await stat(executable);
const series = await json('AGENT_GOAL_CURRENT_COMPARE_SERIES_2026-10-08.json');
const report = { generatedAt: new Date().toISOString(), runtimeSourceSha256,
  executable: { path: executable, sha256: hash(await readFile(executable)), modifiedAt: exeStat.mtime.toISOString() },
  regressions: { runtime: { passed: 666, failed: 0, optionalSkipped: 1 }, nativeDesktop: { passed: 27, failed: 0 },
    goalScripts: { passed: 38, failed: 0 }, build: { succeeded: true }, evidence: logs },
  sourceChanges: ['Native Node command normalization and digest-bound test acceptance',
    'Single-copy verification evidence and transport-only verification retry without executor replay',
    'Verified read-only checkpoint lineage observations passed into resumed recovery',
    'Reusable live checkpoint/model-upgrade and automatic Jev-recovery tests integrated into the validation entry'],
  goals: [
    { id: 'checkpoint-continuation', status: 'VERIFIED', evidence: logs[2].path,
      scope: 'Native desktop and actual interrupted child-process recovery; prior durable checkpoints and read-only observations remain verified.' },
    { id: 'preset-failure-recovery-upgrade-jev', status: 'VERIFIED_FLOW',
      manualUpgradeEvidence: join(artifacts, 'AGENT_GOAL_UPGRADE_ENTRY_LIVE_2026-10-08.json'),
      automaticRecoveryEvidence: join(artifacts, 'AGENT_GOAL_AUTOMATIC_RECOVERY_LIVE_2026-10-08.json'),
      manualUpgradePassed: true, realAutomaticRecoveryPassed: true, automaticStrongModelSelectionProven: false,
      scope: 'Actual Flash missing-file failure; same-checkpoint explicit Pro continuation passed. Separate real Jev recovery stayed on Flash and succeeded. Local fixture covers automatic strong-model routing.' },
    { id: 'continuous-fixed-task-comparison-and-economics', status: 'AUTOMATION_READY_CURRENT_COMPARISON_RUNNING',
      plannedCurrentRuns: 48, series: join(artifacts, 'AGENT_GOAL_CURRENT_COMPARE_SERIES_2026-10-08.json'), seriesStatusAtAudit: series.status,
      metrics: ['successRate', 'recoverySuccessRate', 'manualInterventionMinutes', 'token', 'actualCost', 'estimatedQuotaOrApiPrice', 'toolRounds', 'modelCalls', 'wallMs'],
      productAdvantageProven: false, actualCashSavings: null, humanSavingsMinutes: null }
  ],
  historicalFullComparison: { source: historical.originalRuntimeSourceSha256, gradingProtocol: historical.gradingProtocol,
    hmCodexSuccesses: historical.conditions.hmcodex.regradedSuccesses, ordinaryCodexSuccesses: historical.conditions.codex.regradedSuccesses,
    runsPerCondition: 12, evidence: join(artifacts, 'AGENT_GOAL_TEST_ACCEPTANCE_ARCHIVED_REGRADE_2026-10-08.json'),
    currentSourceExperiment: false },
  remaining: ['Complete the frozen-current-source 24-run ordinary Codex comparison and separate 24-run Jev on/off ablation.',
    'Assess all failures and timeouts, complete usage coverage and success-conditioned resource results before drawing an advantage conclusion.',
    'Real automatic selection of the stronger model remains unobserved; do not substitute explicit user selection or local fixture routing.',
    'Import actual billing and measured human activity if a cash or labor savings conclusion is required.'],
  limitations: ['Small preset tasks and two repeats per task do not establish general engineering superiority.',
    'Third-party model fallback tools in the installed Codex CLI differ from native GPT Codex.',
    'Subscription quota price is not cash billing; absent usage and human evidence stay unknown.'] };
await writeFile(join(artifacts, 'AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ runtimeSourceSha256, regressions: report.regressions, seriesStatus: series.status }));
