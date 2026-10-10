import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const artifactRoot = dirname(fileURLToPath(import.meta.url));
const output = join(artifactRoot, 'AGENT_GOAL_CURRENT_COMPARE_SERIES_2026-10-08.json');
const modelConfig = join(artifactRoot, 'GOAL_FLASH_MODEL_CONFIG_2026-10-08.json');
const pricing = join(root, 'desktop/scripts/goal-pricing-opencode-go-flash.json');
const knownRuntime = JSON.parse(await readFile(join(artifactRoot, 'AGENT_GOAL_AUTOMATIC_RECOVERY_LIVE_2026-10-08.json'), 'utf8')).runtimeSourceSha256;
const report = { startedAt: new Date().toISOString(), runtimeSourceSha256: knownRuntime,
  model: 'mimo-v2.6-flash', repeat: 2, plannedRuns: 48, status: 'RUNNING', steps: [],
  limitations: ['Full paired comparison and separate Jev on/off ablation; neither is a cash invoice or human savings study.',
    'Provider failures and timeouts remain in their assigned conditions. No source edits are planned during the series.'] };
await writeFile(output, JSON.stringify(report, null, 2), { flag: 'wx' });
for (const [id, flags] of [['paired', ['--live-jev']], ['jev-ablation', ['--jev-ablation']]]) {
  const comparison = join(artifactRoot, `AGENT_GOAL_CURRENT_${id === 'paired' ? 'PAIRED' : 'JEV_ABLATION'}_2026-10-08.json`);
  const log = join(artifactRoot, `GOAL_CURRENT_${id === 'paired' ? 'PAIRED' : 'JEV_ABLATION'}_2026-10-08.log`);
  const step = { id, status: 'RUNNING', startedAt: new Date().toISOString(), comparison, log };
  report.steps.push(step);
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ event: 'START', ...step }));
  const heartbeat = setInterval(() => console.log(JSON.stringify({ event: 'RUNNING', id, at: new Date().toISOString() })), 30000);
  try {
    const result = await runEvidenceProcess(process.execPath, ['desktop/scripts/goal-evidence-harness.mjs', '--repeat', '2',
      '--live-config', modelConfig, '--pricing-config', pricing, ...flags, '--output', comparison],
    { cwd: root, timeoutMs: 24 * 300000 + 120000 });
    await writeFile(log, `${result.stdout}\n${result.stderr}`, { flag: 'wx' });
    let actual;
    try { actual = JSON.parse(await readFile(comparison, 'utf8')); } catch { /* failed or interrupted reports stay incomplete */ }
    Object.assign(step, { completedAt: new Date().toISOString(), exitCode: result.code, timedOut: result.timedOut,
      wallMs: result.wallMs, status: actual?.rows?.length === 24 && !result.timedOut ? 'COMPLETE' : 'INCOMPLETE',
      runtimeSourceSha256: actual?.runtimeSourceSha256 ?? null,
      matchesVerifiedRuntime: actual?.runtimeSourceSha256 === knownRuntime,
      completedRuns: actual?.rows?.length ?? 0 });
    console.log(JSON.stringify({ event: 'END', ...step }));
  } finally { clearInterval(heartbeat); }
  await writeFile(output, JSON.stringify(report, null, 2));
  if (step.status !== 'COMPLETE' || !step.matchesVerifiedRuntime) break;
}
report.completedAt = new Date().toISOString();
report.status = report.steps.length === 2 && report.steps.every(step => step.status === 'COMPLETE' && step.matchesVerifiedRuntime)
  ? 'COMPLETE' : 'INCOMPLETE';
await writeFile(output, JSON.stringify(report, null, 2));
if (report.status !== 'COMPLETE') process.exitCode = 1;
