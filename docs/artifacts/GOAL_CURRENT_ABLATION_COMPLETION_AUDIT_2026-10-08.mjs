import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeJevAblation } from '../../desktop/scripts/goal-jev-ablation.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url)), artifacts = join(root, 'docs/artifacts');
const path = join(artifacts, 'AGENT_GOAL_CURRENT_JEV_ABLATION_2026-10-08.json');
const report = JSON.parse(await readFile(path, 'utf8'));
if (report.rows.length !== 24 || report.repeat !== 2 || report.taskSet.length !== 6) throw Error('ABLATION_PLAN_INCOMPLETE');
const paired = summarizeJevAblation(report);
const content = JSON.parse(await readFile(report.contentAudit.path, 'utf8'));
const successes = report.rows.filter(row => row.status === 'SUCCEEDED');
for (const row of successes) {
  const checked = content.rows.find(item => item.iteration === row.iteration && item.taskId === row.taskId && item.condition === row.condition);
  if (!row.grade.passed || !Object.values(row.grade.checks).every(Boolean) || checked?.expectedContentInActualSuccessfulTool !== true) throw Error('ACCEPTED_SUCCESS_NOT_BACKED_BY_TOOL');
}
const failures = [];
for (const row of report.rows.filter(row => row.status !== 'SUCCEEDED')) {
  const payloads = (await readFile(join(row.evidenceDirectory, 'stdout.jsonl'), 'utf8')).trim().split(/\r?\n/u).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const events = JSON.parse(await readFile(join(row.evidenceDirectory, 'native-events.json'), 'utf8'));
  const verification = events.filter(event => event.kind === 'VerificationCompleted').map(event => event.payload?.payload ?? event.payload).at(-1);
  failures.push({ iteration: row.iteration, taskId: row.taskId, condition: row.condition, status: row.status,
    error: payloads.at(-1)?.error, grade: row.grade, verificationStatus: verification?.status,
    failureCodes: verification?.failureCodes, issues: verification?.checks?.filter(check => ['FAIL', 'UNKNOWN'].includes(check.status)),
    evidenceDirectory: row.evidenceDirectory });
}
const off = report.conditions['hmcodex-jev-off'], on = report.conditions['hmcodex-jev-on'];
const audit = { generatedAt: new Date().toISOString(), report: path, batchId: report.batchId, sourceSha256: report.runtimeSourceSha256,
  complete: true, currentSourceAfterMerge: false, verifiedPairs: paired.pairCount,
  assignedOnRuns: paired.assignedOnRuns, activatedOnRuns: paired.activatedOnRuns, acceptedSuccessesWithNativeContent: successes.length,
  conditions: report.conditions, decision: paired.decision, failures,
  conclusions: [`This frozen source sample had ${off.successes}/${off.runs} successes off and ${on.successes}/${on.runs} on. It provides no acceleration or success-rate advantage for enabling Jev.`,
    'On-condition total wall time is higher; service failures and known metadata defects limit causal interpretation.',
    'Every failed run remains in its assigned condition. Actual rule failures, budget exhaustion and unresolved verification are distinct.',
    'Incomplete provider usage keeps total tokens and price estimates unknown. Published subscription quota and actual cash are different measures.',
    'The source has since received separately validated preview/context and timer-cleanup fixes. This batch cannot certify their comparative performance.'],
  remaining: ['Complete merged-source regression and desktop acceptance.', 'Retest the final source before claiming post-fix comparative benefit.',
    'Obtain genuine cash billing and human activity data before claiming cash or labor savings.'] };
await writeFile(join(artifacts, 'AGENT_GOAL_CURRENT_ABLATION_COMPLETION_AUDIT_2026-10-08.json'), JSON.stringify(audit, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ complete: true, pairs: paired.pairCount, off: `${off.successes}/${off.runs}`, on: `${on.successes}/${on.runs}`, acceptedNativeSuccesses: successes.length }));
