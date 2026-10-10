import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'docs/artifacts');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = join(root, 'runtime/src');
const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: digest(await readFile(join(sourceRoot, path))) })));
for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: digest(await readFile(join(root, 'runtime', name))) });
const runtimeSourceSha256 = digest(JSON.stringify(files));
const manual = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_UPGRADE_2026-10-08.json'), 'utf8'));
const automatic = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_NODE_PREVIEW_MERGED_AUTOMATIC_2026-10-08.json'), 'utf8'));
if (![manual, automatic].every(report => report.passed && report.runtimeSourceSha256 === runtimeSourceSha256)) throw Error('CURRENT_LIVE_RECOVERY_NOT_VERIFIED');
const logs = {
  runtime: 'GOAL_NODE_PREVIEW_MERGED_FULL_RUNTIME_VALIDATED_2026-10-08.log',
  scripts: 'GOAL_NODE_PREVIEW_MERGED_SCRIPTS_VALIDATED_2026-10-08.log',
  native: 'GOAL_NODE_PREVIEW_MERGED_NATIVE_2026-10-08.log',
  build: 'GOAL_NODE_PREVIEW_MERGED_BUILD_2026-10-08.log',
};
const contents = Object.fromEntries(await Promise.all(Object.entries(logs).map(async ([key, name]) => [key, await readFile(join(artifacts, name), 'utf8')])));
if (!/pass 673\s*\r?\n.*fail 0/u.test(contents.runtime) || !/skipped 1/u.test(contents.runtime)
  || !/pass 38\s*\r?\n.*fail 0/u.test(contents.scripts)
  || !contents.native.includes('Summary: 28 passed, 0 failed, 0 skipped')
  || !contents.build.includes('Built application at:')) throw Error('REGRESSION_FOOTER_NOT_VERIFIED');
const executable = join(root, 'desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe');
const evidence = await Promise.all([...Object.values(logs), 'AGENT_GOAL_NODE_PREVIEW_MERGED_UPGRADE_2026-10-08.json', 'AGENT_GOAL_NODE_PREVIEW_MERGED_AUTOMATIC_2026-10-08.json', 'GOAL_NODE_PREVIEW_MERGED_NATIVE_2026-10-08.png'].map(async name => ({ path: join(artifacts, name), sha256: digest(await readFile(join(artifacts, name))) })));
const report = {
  generatedAt: new Date().toISOString(), runtimeSourceSha256,
  executable: { path: executable, sha256: digest(await readFile(executable)), modifiedAt: (await stat(executable)).mtime.toISOString() },
  regressions: { runtime: { passed: 673, failed: 0, optionalSkipped: 1 }, goalScripts: { passed: 38, failed: 0 }, nativeDesktop: { passed: 28, failed: 0, cssViewport: { width: 1280, height: 474 }, nativeWindowChromeResized: false }, build: { succeeded: true }, evidence },
  sourceChanges: ['Bounded known Node preview uses the same parser as execution; current authorized file context is collected.', 'Node.exe receives the same bounded file context.', 'Workspace I/O timeout timers are cleared on resolve/reject without changing deadlines or filesystem scope.'],
  goals: [
    { id: 'checkpoint-continuation', status: 'VERIFIED', scope: 'Native desktop continuation and actual interrupted-process checkpoint recovery.' },
    { id: 'preset-failure-recovery-upgrade-jev', status: 'VERIFIED_FLOW', manualUpgradePassed: true, realAutomaticRecoveryPassed: true, automaticStrongModelSelectionProven: automatic.automaticJevStrongSelectionProven, scope: 'Actual Flash failure; same-checkpoint explicit Pro success; separate real Jev automatic recovery succeeded on Flash.' },
    { id: 'continuous-fixed-task-comparison-and-economics', status: 'AUTOMATION_READY_CURRENT_COMPARISON_RUNNING', plannedCurrentRuns: 48, series: join(artifacts, 'AGENT_GOAL_MERGED_COMPARE_SERIES_2026-10-08.json'), productAdvantageProven: false, actualCashSavings: null, humanSavingsMinutes: null },
  ],
  completedPreviousSource: {
    runtimeSourceSha256: '81a07cf9915c7950ba5c45ada4f5f4c865a5194218d69edad3020a6554fb05f3', currentSourceExperiment: false,
    paired: { hmCodex: { successes: 10, runs: 12, recoveries: 6, opportunities: 8 }, ordinaryCodex: { successes: 9, runs: 12, recoveries: 5, opportunities: 8 }, evidence: join(artifacts, 'AGENT_GOAL_CURRENT_PAIRED_COMPLETION_AUDIT_2026-10-08.json') },
    jevAblation: { off: { successes: 12, runs: 12, recoveries: 8, opportunities: 8 }, on: { successes: 8, runs: 12, recoveries: 5, opportunities: 8 }, evidence: join(artifacts, 'AGENT_GOAL_CURRENT_ABLATION_COMPLETION_AUDIT_2026-10-08.json') },
  },
  remaining: ['Complete the frozen merged-source paired comparison and separate Jev on/off ablation; preserve failures and timeouts.', 'Real automatic stronger-model selection remains unobserved.', 'Actual invoices and measured human activities are needed to verify cash or labor savings; missing usage stays unknown.'],
  limitations: ['Small preset task samples do not establish general engineering superiority.', 'Installed Codex uses third-party fallback tool configuration; this is not native GPT Codex.', 'A successful fixture is not real-provider or economic evidence.'],
};
await writeFile(join(artifacts, 'AGENT_GOAL_MERGED_RETEST_AUDIT_2026-10-08.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ runtimeSourceSha256, regressions: report.regressions, goals: report.goals }));
