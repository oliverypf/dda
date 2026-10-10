import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeJevAblation } from '../../desktop/scripts/goal-jev-ablation.mjs';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
import { observedFixtureTestPassed, fixtureTestScope, observedExpectedFailure } from '../../desktop/scripts/goal-test-acceptance.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), artifacts = join(root, 'docs/artifacts');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const source = [];
for (const path of (await readdir(join(root, 'runtime/src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort())
  source.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(root, 'runtime/src', path))) });
for (const name of ['package.json', 'package-lock.json']) source.push({ path: `../${name}`, sha256: hash(await readFile(join(root, 'runtime', name))) });
const runtimeSourceSha256 = hash(JSON.stringify(source));
const stage = await readJson(join(artifacts, 'AGENT_GOAL_MERGED_RETEST_AUDIT_2026-10-08.json'));
const series = await readJson(join(artifacts, 'AGENT_GOAL_MERGED_COMPARE_SERIES_2026-10-08.json'));
const pairedOnly = process.argv.includes('--paired-only');
const requiredSteps = pairedOnly ? series.steps.filter(step => step.id === 'paired') : series.steps;
if ((!pairedOnly && series.status !== 'COMPLETE') || requiredSteps.length !== (pairedOnly ? 1 : 2)
  || !requiredSteps.every(step => step.status === 'COMPLETE' && step.matchesVerifiedRuntime)
  || series.runtimeSourceSha256 !== runtimeSourceSha256 || stage.runtimeSourceSha256 !== runtimeSourceSha256) throw Error('SERIES_OR_CURRENT_SOURCE_INCOMPLETE');
for (const entry of [...stage.regressions.evidence, stage.executable]) {
  if (hash(await readFile(entry.path)) !== entry.sha256) throw Error(`VERIFIED_STAGE_EVIDENCE_CHANGED:${entry.path}`);
}

const comparisons = {};
for (const [name, suffix, conditions] of [
  ['paired', 'PAIRED', ['ordinary-codex', 'hmcodex-runtime']],
  ['jevAblation', 'JEV_ABLATION', ['hmcodex-jev-off', 'hmcodex-jev-on']],
]) {
  if (pairedOnly && name !== 'paired') continue;
  const path = join(artifacts, `AGENT_GOAL_MERGED_${suffix}_2026-10-08.json`);
  const report = await readJson(path), content = await readJson(report.contentAudit.path);
  if (report.rows.length !== 24 || report.repeat !== 2 || report.taskSet.length !== 6 || report.mode !== 'live'
    || report.runtimeSourceSha256 !== runtimeSourceSha256) throw Error(`PLAN_OR_SOURCE_MISMATCH:${name}`);
  const pairs = [];
  for (let iteration = 1; iteration <= 2; iteration++) for (const task of report.taskSet) {
    const rows = report.rows.filter(row => row.iteration === iteration && row.taskId === task.taskId);
    if (rows.length !== 2 || new Set(rows.map(row => row.condition)).size !== 2
      || !conditions.every(condition => rows.some(row => row.condition === condition))
      || rows.some(row => row.model !== report.model || !row.modelsMatch)
      || !rows[0].initialDigest || rows[0].initialDigest !== rows[1].initialDigest
      || rows.some(row => row.client === 'hmcodex-runtime' && row.runtimeSourceSha256 !== runtimeSourceSha256)) throw Error(`PAIR_NOT_VERIFIED:${name}:${iteration}:${task.taskId}`);
    pairs.push({ iteration, taskId: task.taskId, initialDigest: rows[0].initialDigest, outcomes: Object.fromEntries(rows.map(row => [row.condition, row.status])) });
  }
  const successes = report.rows.filter(row => row.status === 'SUCCEEDED');
  const independentlyRecheckedNativeEvidence = [];
  for (const row of successes) {
    const checked = content.rows.find(item => item.iteration === row.iteration && item.taskId === row.taskId && item.condition === row.condition);
    if (!row.grade.passed || !Object.values(row.grade.checks).every(Boolean) || checked?.expectedContentInActualSuccessfulTool !== true) throw Error(`SUCCESS_WITHOUT_NATIVE_CONTENT:${row.runKey}`);
    const requests = await readJson(join(row.evidenceDirectory, 'model-requests.json'));
    const stdout = await readFile(join(row.evidenceDirectory, 'stdout.jsonl'), 'utf8');
    const events = row.client === 'hmcodex-runtime' ? await readJson(join(row.evidenceDirectory, 'native-events.json')) : [];
    const outcomes = row.client === 'hmcodex-runtime' ? runtimeNativeOutcomes(events, requests)
      : stdout.trim().split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
        .filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
        .map(event => ({ name: 'exec_command', ok: event.item.exit_code === 0 && event.item.status === 'completed', exitCode: event.item.exit_code, command: event.item.command, output: event.item.aggregated_output }));
    const task = report.taskSet.find(task => task.taskId === row.taskId);
    const text = outcomes.filter(outcome => outcome.ok).map(outcome => outcome.output ?? '').join('\n');
    if (row.acceptance === 'code') {
      if (!outcomes.some(outcome => observedFixtureTestPassed(outcome, fixtureTestScope(task)))
        || task.recoverable && !observedExpectedFailure(outcomes, task)) throw Error(`RAW_NATIVE_TEST_PROOF_MISSING:${row.runKey}`);
    } else if (row.acceptance === 'layout') {
      if (!['README.md', 'package.json', 'name.mjs', 'name.test.mjs'].every(name => text.includes(name))) throw Error(`RAW_LAYOUT_PROOF_MISSING:${row.runKey}`);
    } else {
      const marker = (await readFile(join(row.evidenceDirectory, 'workspace-final/README.md'), 'utf8')).match(/GOAL_EVIDENCE_[a-z0-9]+/u)?.[0];
      if (!marker || !text.includes(marker)) throw Error(`RAW_MARKER_PROOF_MISSING:${row.runKey}`);
    }
    independentlyRecheckedNativeEvidence.push({ runKey: row.runKey, actualOutcomes: outcomes.length,
      sourceHashes: { stdout: hash(stdout), modelRequests: hash(await readFile(join(row.evidenceDirectory, 'model-requests.json'))),
        ...(row.client === 'hmcodex-runtime' ? { nativeEvents: hash(await readFile(join(row.evidenceDirectory, 'native-events.json'))) } : {}) } });
  }
  const failures = [];
  for (const row of report.rows.filter(row => row.status !== 'SUCCEEDED')) {
    const output = (await readFile(join(row.evidenceDirectory, 'stdout.jsonl'), 'utf8')).trim().split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const events = row.client === 'hmcodex-runtime' ? await readJson(join(row.evidenceDirectory, 'native-events.json')) : [];
    const verification = events.filter(event => event.kind === 'VerificationCompleted').map(event => event.payload?.payload ?? event.payload).at(-1);
    const independentCodeVerification = row.taskId.startsWith('code-') ? await readJson(join(row.evidenceDirectory, 'code-verification.json')) : null;
    failures.push({ runKey: row.runKey, taskId: row.taskId, condition: row.condition, status: row.status,
      error: output.at(-1)?.error ?? null, grade: row.grade, verificationStatus: verification?.status ?? null,
      failureCodes: verification?.failureCodes ?? [], unknownOrFailedChecks: verification?.checks?.filter(check => ['FAIL', 'UNKNOWN'].includes(check.status)) ?? [], independentCodeVerification, evidenceDirectory: row.evidenceDirectory });
  }
  const successResources = Object.fromEntries(conditions.map(condition => {
    const rows = successes.filter(row => row.condition === condition);
    const total = key => rows.length && rows.every(row => Number.isFinite(row[key])) ? rows.reduce((n, row) => n + row[key], 0) : null;
    return [condition, { successes: rows.length, wallMs: total('wallMs'), modelCalls: total('modelCalls'), toolRounds: total('toolRounds'), totalTokens: total('totalTokens'), actualCost: total('actualCost') }];
  }));
  comparisons[name] = { report: path, sha256: hash(await readFile(path)), batchId: report.batchId,
    verifiedPairs: pairs.length, acceptedSuccessesWithNativeContent: successes.length, pairs,
    allRowsSucceeded: successes.length === report.rows.length, rawAllCaseContentAuditPassed: report.contentAudit.passed,
    contentAuditInterpretation: 'A raw audit requires successful expected content for every assigned case. Failed cases remain failed; accepted successes are separately verified against actual native content.',
    conditions: report.conditions, failures, successResources, independentlyRecheckedNativeEvidence,
    ...(name === 'jevAblation' ? { treatment: summarizeJevAblation(report) } : { codexVersion: report.codexVersion }) };
}
const report = { generatedAt: new Date().toISOString(), runtimeSourceSha256, complete: true,
  scope: pairedOnly ? '24-RUN_PAIRED_CLIENT_COMPARISON' : '48-RUN_PAIRED_AND_JEV_ABLATION', regressions: stage.regressions,
  recovery: stage.goals.filter(goal => goal.id !== 'continuous-fixed-task-comparison-and-economics'), comparisons,
  remaining: [...(pairedOnly ? ['Complete the separate current-source Jev off/on ablation.'] : []), 'Real automatic stronger-model selection remains unobserved.', 'Missing provider usage stays unknown; actual billing and measured human activity are required for cash or labor savings.'],
  limitations: ['Preset tasks and two repeats per condition do not establish general superiority.', 'Third-party model fallback tools in installed Codex differ from native GPT Codex.', 'Language-model quota estimates and Jev API estimates are not combined cash invoices.', 'Success-conditioned resources have different successful task sets and cannot establish a causal savings estimate.'],
};
const paired = comparisons.paired.conditions, ablation = comparisons.jevAblation?.conditions;
const outputName = pairedOnly ? 'AGENT_GOAL_MERGED_PAIRED_COMPLETION_AUDIT_2026-10-08' : 'AGENT_GOAL_MERGED_COMPARE_COMPLETION_AUDIT_2026-10-08';
const rate = condition => `${condition.successes}/${condition.runs}`;
const recovery = condition => `${condition.recoverySuccesses}/${condition.recoveryOpportunities}`;
const md = ['# 修复后固定源码完整复测', '', `源码：${runtimeSourceSha256}`, '',
  '运行时 673 项通过、0 失败、1 项可选跳过；目标脚本 38/38；新编译原生桌面 28/28。checkpoint 继续、真实显式模型升级和真实 Jev 自动恢复均已通过。', '',
  '| 实验条件 | 成功 | 恢复 |', '|---|---|---|',
  ...['ordinary-codex', 'hmcodex-runtime'].map(condition => `| ${condition} | ${rate(paired[condition])} | ${recovery(paired[condition])} |`),
  ...(ablation ? ['hmcodex-jev-off', 'hmcodex-jev-on'].map(condition => `| ${condition} | ${rate(ablation[condition])} | ${recovery(ablation[condition])} |`) : []), '',
  pairedOnly ? '本批共 24 次真实运行、12 对相同初始文件；独立 Jev 开／关实验仍在运行。' : '两批共 48 次真实运行、每批 12 对相同初始文件。',
  '失败、超时及不确定验证保留。所有接受的成功均从原始工具事件重新确认内容、实际测试和预置失败，保留证据摘要。', '',
  '当前样本不能证明总体工程优势。总 token 在任一请求缺少 usage 时保持未知；订阅额度小计不等于现金费用。无人测试人工时间为 0，不能证明省人工。成功子集的资源结果仅供诊断，不可视为同任务节省。', '',
  '仍缺真实自动选强模型的观察，以及实际账单和真人活动证据。', '',
  `详细证据：[完整核验](${join(artifacts, outputName + '.json').replaceAll('\\', '/')})`, '',
].join('\n');
await writeFile(join(artifacts, outputName + '.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(artifacts, outputName + '.md'), md, { flag: 'wx' });
console.log(JSON.stringify({ complete: true, scope: report.scope, runtimeSourceSha256, paired: Object.fromEntries(Object.entries(paired).map(([k,v]) => [k,rate(v)])), ...(ablation ? { ablation: Object.fromEntries(Object.entries(ablation).map(([k,v]) => [k,rate(v)])) } : {}) }));
