import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)), artifacts = join(root, 'docs/artifacts');
const report = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_CURRENT_PAIRED_2026-10-08.json'), 'utf8'));
const prior = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-08.json'), 'utf8'));
const content = JSON.parse(await readFile(report.contentAudit.path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const source = [];
for (const path of (await readdir(join(root, 'runtime/src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort())
  source.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(root, 'runtime/src', path))) });
for (const name of ['package.json', 'package-lock.json']) source.push({ path: `../${name}`, sha256: hash(await readFile(join(root, 'runtime', name))) });
if (hash(JSON.stringify(source)) !== prior.runtimeSourceSha256 || report.runtimeSourceSha256 !== prior.runtimeSourceSha256) throw Error('CURRENT_SOURCE_MISMATCH');
if (report.rows.length !== 24 || report.taskSet.length !== 6 || report.repeat !== 2 || report.mode !== 'live') throw Error('COMPLETE_PLAN_MISSING');
const taskIds = new Set(report.taskSet.map(task => task.taskId));
const pairs = [];
for (let iteration = 1; iteration <= 2; iteration++) for (const taskId of taskIds) {
  const rows = report.rows.filter(row => row.iteration === iteration && row.taskId === taskId);
  if (rows.length !== 2 || new Set(rows.map(row => row.condition)).size !== 2 || rows.some(row => row.model !== report.model || !row.modelsMatch)
    || !rows[0].initialDigest || rows[0].initialDigest !== rows[1].initialDigest) throw Error('PAIR_NOT_VERIFIED');
  pairs.push({ iteration, taskId, initialDigest: rows[0].initialDigest, outcomes: Object.fromEntries(rows.map(row => [row.condition, row.status])) });
}
const successes = report.rows.filter(row => row.status === 'SUCCEEDED');
for (const row of successes) {
  const inspected = content.rows.find(item => item.iteration === row.iteration && item.taskId === row.taskId && item.condition === row.condition);
  if (!row.grade.passed || !Object.values(row.grade.checks).every(Boolean) || inspected?.expectedContentInActualSuccessfulTool !== true) throw Error('SUCCESS_WITHOUT_NATIVE_CONTENT');
}
const hm = report.conditions['hmcodex-runtime'], codex = report.conditions['ordinary-codex'];
const audit = { generatedAt: new Date().toISOString(), batchId: report.batchId, runtimeSourceSha256: report.runtimeSourceSha256,
  completed: true, actualClientComparison: true, model: report.model, codexVersion: report.codexVersion,
  matchedPairs: pairs.length, acceptedSuccessesWithVerifiedNativeContent: successes.length,
  allRowsSucceeded: false, rawAllCaseContentAuditPassed: report.contentAudit.passed,
  contentAuditInterpretation: 'The raw audit requires expected successful content in every case. Failed and timed-out cases make it false; all19 accepted successes separately have verified native content. No failed outcome is relabeled.',
  conditions: report.conditions, pairs,
  stageResult: { hmSuccess: `${hm.successes}/${hm.runs}`, codexSuccess: `${codex.successes}/${codex.runs}`,
    hmRecovery: `${hm.recoverySuccesses}/${hm.recoveryOpportunities}`, codexRecovery: `${codex.recoverySuccesses}/${codex.recoveryOpportunities}` },
  conclusions: ['This complete small sample has one additional hmCodex success and recovery. It does not establish general superiority.',
    'Observed total wall time includes failures, timeouts and provider/network variation; it is not a controlled causal speed estimate.',
    'Known token and quota subtotals have unequal incomplete coverage. Total usage, cash charges and cash savings remain unknown.',
    'Headless human minutes are zero for both conditions; this does not measure human time savings.',
    'Ordinary Codex uses third-party model fallback tools. PowerShell patch failures constrain the interpretation.'],
  remaining: ['Complete the separately running same-source Jev on/off ablation.',
    'Finish validating and merge the isolated Node preview/context and workspace timeout cleanup after the frozen series ends.',
    'Rebuild and verify the merged source; do not use isolated runtime diagnostics as current desktop acceptance.',
    'Import genuine billing and human activity records before claiming cash or labor benefits.'],
  report: join(artifacts, 'AGENT_GOAL_CURRENT_PAIRED_2026-10-08.json') };
await writeFile(join(artifacts, 'AGENT_GOAL_CURRENT_PAIRED_COMPLETION_AUDIT_2026-10-08.json'), JSON.stringify(audit, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ completed: true, matchedPairs: pairs.length, acceptedSuccesses: successes.length, stageResult: audit.stageResult }));
