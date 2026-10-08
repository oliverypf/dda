#!/usr/bin/env node
// One command builds the app, checks recovery/Jev, drives the native window,
// and runs a paired fixed-task comparison. Live inference is opt-in by config.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvidenceProcess } from './goal-evidence-process.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(desktop, '..');
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const liveConfig = option('--live-config', undefined);
const liveJev = process.argv.includes('--live-jev');
const jevAblation = process.argv.includes('--jev-ablation');
const upgradeModel = option('--upgrade-model', undefined);
if (upgradeModel && !liveConfig) throw Error('LIVE_UPGRADE_REQUIRES_LIVE_MODEL_CONFIG');
if ((liveJev || jevAblation) && !liveConfig) throw Error('LIVE_JEV_REQUIRES_LIVE_MODEL_CONFIG');
if (liveJev && jevAblation) throw Error('INVALID_JEV_ABLATION_CONDITIONS');
const output = resolve(option('--output', join(repo, 'docs/artifacts/AGENT_GOAL_VALIDATION.json')));
const logRoot = join(dirname(output), `goal-validation-${new Date().toISOString().replace(/[-:.]/gu, '')}`);
const executable = join(desktop, 'src-tauri/target/x86_64-pc-windows-msvc/debug/dda-desktop.exe');
const repeat = option('--repeat', '2');
if (!/^([1-9]|1[0-9]|20)$/u.test(repeat)) throw Error('INVALID_GOAL_REPEAT');
await mkdir(logRoot, { recursive: true });
await mkdir(dirname(output), { recursive: true });
const steps = [
  { id: 'build', cwd: desktop, args: ['scripts/build-full-local.mjs', '--fast'], timeoutMs: 600000 },
  { id: 'recovery-jev-runtime', cwd: join(repo, 'runtime'), args: ['--test', 'test/goal-evidence-runtime.test.mjs',
    'test/recovery-continuation.test.mjs', 'test/task-recovery-controller.test.mjs',
    'test/decision-layer.test.mjs', 'test/decision-evidence-claim.test.mjs', 'test/decision-workspace-context.test.mjs',
    'test/readonly-registry-observation.test.mjs', 'test/process-intent.test.mjs',
    'test/readonly-resume-observations.test.mjs', 'test/node-command-normalization.test.mjs',
    'test/node-preview-runtime.test.mjs', 'test/workspace-io-timeout.test.mjs',
    'test/verification-only-recovery-runtime.test.mjs',
    'test/rule-verifier.test.mjs', 'test/jev-tool-evidence.test.mjs',
    'test/process-interruption-runtime.test.mjs', 'test/crash-recovery-runtime.test.mjs'], timeoutMs: 180000 },
  { id: 'fixed-task-acceptance', cwd: desktop, args: ['--test', 'scripts/goal-test-acceptance.test.mjs',
    'scripts/goal-evidence-audit.test.mjs', 'scripts/goal-evidence-harness.test.mjs',
    'scripts/goal-upgrade-models.test.mjs', 'scripts/goal-upgrade-harness.test.mjs'], timeoutMs: 60000 },
  { id: 'native-resume-retry', cwd: desktop, args: ['scripts/ui-functional-test.mjs', '--exe', executable,
    '--port', option('--ui-port', '9333'), '--resume-fixture', '--retry-fixture', '--crowded-fixture',
    ...[['--ui-viewport-width', '--viewport-width'], ['--ui-viewport-height', '--viewport-height']]
      .flatMap(([input, target]) => option(input, undefined) ? [target, option(input)] : []),
    '--scroll-screenshot', join(logRoot, 'native-sidebar.png'), '--close'], timeoutMs: 240000 },
  ...(upgradeModel ? [{ id: 'live-checkpoint-model-upgrade', cwd: desktop,
    args: ['scripts/goal-upgrade-harness.mjs', '--live-config', resolve(liveConfig), '--strong-model', upgradeModel,
      '--output', join(logRoot, 'checkpoint-upgrade.json')], timeoutMs: 540000 },
    { id: 'live-jev-automatic-recovery', cwd: desktop,
      args: ['scripts/goal-upgrade-harness.mjs', '--live-config', resolve(liveConfig), '--strong-model', upgradeModel,
        '--automatic-recovery', '--output', join(logRoot, 'automatic-recovery.json')], timeoutMs: 300000 }] : []),
  { id: 'paired-fixed-tasks', cwd: desktop, args: ['scripts/goal-evidence-harness.mjs', '--suite', 'all', '--repeat', repeat,
    '--output', join(logRoot, 'comparison.json'), ...(liveConfig ? ['--live-config', resolve(liveConfig)] : []),
    ...(liveJev ? ['--live-jev'] : []),
    ...(jevAblation ? ['--jev-ablation'] : []),
    ...['--pricing-config', '--billing-ledger', '--interventions-ledger'].flatMap(name => option(name, undefined) ? [name, resolve(option(name))] : [])],
    timeoutMs: 2 * Number(repeat) * 6 * 300000 + 120000 }
];
const report = { schemaVersion: '1.0', startedAt: new Date().toISOString(),
  mode: liveConfig ? jevAblation ? 'LIVE_JEV_ON_OFF_ABLATION' : liveJev ? 'LIVE_SAME_MODEL_PLUS_JEV' : 'LIVE_SAME_MODEL' : 'LOCAL_FIXTURE', steps: [],
  realModelUpgrade: upgradeModel ? 'REQUESTED' : 'NOT_REQUESTED',
  limitations: ['Fixture inference verifies the recovery and test machinery, not production model quality.',
    'Published quota value is not an invoice. Missing cash charges and human activity remain unknown.',
    'This command covers the three agent goals; it does not certify every product feature.'] };
for (const step of steps) {
  if (step.id === 'native-resume-retry' && report.steps.find(item => item.id === 'build')?.passed !== true) {
    report.steps.push({ id: step.id, passed: false, skipped: 'CURRENT_BUILD_FAILED' });
    continue;
  }
  console.log(`START ${step.id}`);
  const heartbeat = setInterval(() => console.log(`RUNNING ${step.id}`), 30000);
  try {
    const result = await runEvidenceProcess(process.execPath, step.args, { cwd: step.cwd, timeoutMs: step.timeoutMs });
    const log = join(logRoot, `${step.id}.log`);
    await writeFile(log, `${result.stdout}\n${result.stderr}`);
    report.steps.push({ id: step.id, passed: result.code === 0 && !result.timedOut, exitCode: result.code,
      timedOut: result.timedOut, wallMs: result.wallMs, log });
    console.log(`${result.code === 0 && !result.timedOut ? 'PASS' : 'FAIL'} ${step.id} ${log}`);
  } finally { clearInterval(heartbeat); }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}
report.completedAt = new Date().toISOString();
report.passed = report.steps.length === steps.length && report.steps.every(step => step.passed);
report.comparison = join(logRoot, 'comparison.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: report.passed, mode: report.mode, output, comparison: report.comparison }));
if (!report.passed) process.exitCode = 1;
