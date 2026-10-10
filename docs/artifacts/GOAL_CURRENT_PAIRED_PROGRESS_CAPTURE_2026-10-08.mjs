import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'docs/artifacts');
const batchId = '20261007T180217856Z-3be656c2';
const audit = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-08.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(artifacts, 'agent-goal-runs', batchId, 'runtime-source-manifest.json'), 'utf8'));
if (manifest.sha256 !== audit.runtimeSourceSha256) throw Error('SOURCE_MISMATCH');
const rows = (await readFile(join(artifacts, 'agent-goal-runs/history.jsonl'), 'utf8')).trim().split(/\r?\n/u)
  .map(line => JSON.parse(line)).filter(row => row.batchId === batchId);
if (!rows.length || rows.length >= 24) throw Error('NOT_AN_INCOMPLETE_PROGRESS_SNAPSHOT');
for (const row of rows) if (row.model !== 'mimo-v2.6-flash' || row.gradingProtocolVersion !== '2.1-NATIVE_COMMAND_DIGEST_AND_FIXTURE_TEST'
  || row.client === 'hmcodex-runtime' && row.runtimeSourceSha256 !== manifest.sha256) throw Error('ROW_IDENTITY_MISMATCH');
const report = { generatedAt: new Date().toISOString(), batchId, runtimeSourceSha256: manifest.sha256,
  completedRuns: rows.length, plannedRuns: 24, fullBatch: false, overallAdvantageConclusion: 'NOT_ESTABLISHED',
  status: 'INCOMPLETE_PROGRESS_SNAPSHOT',
  rows: rows.map(row => ({ iteration: row.iteration, taskId: row.taskId, condition: row.condition, status: row.status,
    wallMs: row.wallMs, modelCalls: row.modelCalls, toolRounds: row.toolRounds, grade: row.grade,
    totalTokens: row.totalTokens, usageCoverage: row.usageCoverage, actualCost: row.actualCost,
    decisionProvider: row.decisionProvider, evidenceDirectory: row.evidenceDirectory })),
  limitations: ['Only completed cases are shown; unfinished cases have no outcome yet. Do not infer full-batch success rates or economic benefit.',
    'The ordinary Codex engineering control uses third-party model fallback tools; one completed timeout had repeated PowerShell patch failures.',
    'Known usage subtotals are not full usage. Actual billing and human savings remain unverified.'] };
const path = join(artifacts, `AGENT_GOAL_CURRENT_PAIRED_PROGRESS_${rows.length}_OF_24_2026-10-08.json`);
await writeFile(path, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ path, completedRuns: rows.length, fullBatch: false }));
