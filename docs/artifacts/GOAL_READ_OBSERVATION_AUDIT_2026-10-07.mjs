import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runtimeNativeOutcomes, successfulNativeTest } from '../../desktop/scripts/goal-evidence-audit.mjs';

const root = 'C:/Users/User/hmCodex-local';
const artifacts = join(root, 'docs/artifacts');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const reportName = process.argv[2] ?? 'AGENT_GOAL_READ_OBSERVATION_LIVE_2026-10-07.json';
const outputStem = process.argv[3] ?? 'AGENT_GOAL_READ_OBSERVATION_CURRENT_AUDIT_2026-10-07';
const reportPath = join(artifacts, reportName);
const report = await json(reportPath);
const sourceRoot = join(root, 'runtime/src');
const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: sha(await readFile(join(sourceRoot, path))) })));
for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: sha(await readFile(join(root, 'runtime', name))) });
const currentSource = sha(JSON.stringify(files));
const cases = [];
for (const row of report.rows) {
  const requests = await json(join(row.evidenceDirectory, 'model-requests.json'));
  const jev = await json(join(row.evidenceDirectory, 'jev-requests.json'));
  const events = await json(join(row.evidenceDirectory, 'native-events.json'));
  const outcomes = runtimeNativeOutcomes(events, requests);
  const marker = (await readFile(join(row.evidenceDirectory, 'workspace-final/README.md'), 'utf8')).match(/GOAL_EVIDENCE_[a-z0-9]+/)?.[0];
  const firstError = outcomes.findIndex(outcome => !outcome.ok);
  const readRecovered = firstError >= 0 && outcomes[firstError].name === 'workspace.read'
    && outcomes[firstError].errorCode === 'WORKSPACE_NOT_FOUND'
    && outcomes.slice(firstError + 1).some(outcome => outcome.ok && outcome.name === 'workspace.read' && marker && outcome.output?.includes(marker));
  const actualPassedTest = outcomes.some(successfulNativeTest);
  const observedReadStates = jev.filter(request => request.body?.state?.observation?.checks?.some(check => check.id === 'previous-registry-invocation-observed' && check.status === 'PASS'))
    .map(request => ({ sequence: request.sequence, questionIds: Object.keys(request.body.questions ?? {}),
      status: request.body.state.observation.status, failureCodes: request.body.state.observation.failureCodes }));
  const terminalVerification = jev.findLast(request => request.body?.questions?.verification);
  const terminalObservation = terminalVerification?.body.state.observation;
  cases.push({ runKey: row.runKey, taskId: row.taskId, iteration: row.iteration, status: row.status,
    grade: row.grade, codeAcceptance: row.acceptance === 'code' ? (await json(join(row.evidenceDirectory, 'code-verification.json'))).passed : null,
    modelsMatch: requests.every(request => request.model === report.model && (!request.upstreamModel || request.upstreamModel === report.model)),
    firstActualFailure: firstError >= 0 ? { name: outcomes[firstError].name, errorCode: outcomes[firstError].errorCode,
      exitCode: outcomes[firstError].value?.exitCode, input: outcomes[firstError].input } : null,
    actualPassedTest, actualReadRecovered: row.taskId === 'recoverable-read-001' ? readRecovered : null,
    terminalVerification: terminalVerification ? { ruleStatus: terminalObservation?.status,
      failureCodes: terminalObservation?.failureCodes, actualJevAnswer: terminalVerification.response?.answers?.verification } : null,
    testGateEvidenceDeferrals: jev.filter(request => request.body?.state?.tool === 'test.execute'
      && request.response?.answers?.actionGate?.choice === 'REQUEST_EVIDENCE').length,
    actualTools: outcomes.map(outcome => ({ name: outcome.name, ok: outcome.ok, errorCode: outcome.errorCode, exitCode: outcome.value?.exitCode, input: outcome.input })),
    observedReadStates, decisionCalls: row.decisionProvider?.calls, decisionSucceededCalls: row.decisionProvider?.succeededCalls });
}
const parseTestLog = async name => {
  const text = await readFile(join(artifacts, name), 'utf8');
  return { passed: Number(text.match(/ℹ pass (\d+)/u)?.[1] ?? NaN), failed: Number(text.match(/ℹ fail (\d+)/u)?.[1] ?? NaN),
    skipped: Number(text.match(/ℹ skipped (\d+)/u)?.[1] ?? NaN), log: name };
};
const nativeLog = await readFile(join(artifacts, 'GOAL_READ_OBSERVATION_NATIVE_2026-10-07.log'), 'utf8');
const native = nativeLog.match(/Summary: (\d+) passed, (\d+) failed, (\d+) skipped/u);
const previous = await json(join(artifacts, 'AGENT_GOAL_LITERAL_GATE_PAIRED_2026-10-07.json'));
const sum = key => report.rows.every(row => Number.isFinite(row.decisionProvider?.[key]))
  ? report.rows.reduce((total, row) => total + row.decisionProvider[key], 0) : null;
const audit = { schemaVersion: '1.0', generatedAt: new Date().toISOString(), report: reportName,
  reportSha256: sha(await readFile(reportPath)), batchId: report.batchId, runtimeSourceSha256: report.runtimeSourceSha256,
  currentRuntimeSourceSha256: currentSource, currentRuntimeMatchesBatch: currentSource === report.runtimeSourceSha256,
  debugExeSha256: sha(await readFile(join(root, 'desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe'))),
  mode: report.mode, model: report.model, decisionMode: report.decisionMode, conditions: report.conditions,
  batchProcessExitCode: report.rows.every(row => row.status === 'SUCCEEDED') && report.contentAudit?.passed ? 0 : 1,
  contentAudit: report.contentAudit, cases,
  actualChainsPassed: cases.every(row => row.status === 'SUCCEEDED' && row.grade.passed && row.modelsMatch
    && (row.taskId === 'recoverable-read-001' ? row.actualReadRecovered : row.actualPassedTest && row.codeAcceptance)),
  decision: { calls: sum('calls'), succeededCalls: sum('succeededCalls'), inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'), proxyWallMs: sum('wallMs'), estimatedApiPriceUsd: sum('estimatedCost'), actualCashCharge: null },
  engineering: { runtime: await parseTestLog('GOAL_READ_OBSERVATION_FULL_RUNTIME_2026-10-07.log'),
    scripts: await parseTestLog('GOAL_READ_OBSERVATION_SCRIPTS_2026-10-07.log'),
    native: { passed: Number(native?.[1]), failed: Number(native?.[2]), skipped: Number(native?.[3]), log: 'GOAL_READ_OBSERVATION_NATIVE_2026-10-07.log' },
    build: 'GOAL_READ_OBSERVATION_BUILD_2026-10-07.log' },
  previousSourceComparison: { report: 'AGENT_GOAL_LITERAL_GATE_PAIRED_2026-10-07.json', batchId: previous.batchId,
    runtimeSourceSha256: previous.runtimeSourceSha256, conditions: previous.conditions,
    failedHmTasks: previous.rows.filter(row => row.client === 'hmcodex-runtime' && row.status !== 'SUCCEEDED').map(row => ({ taskId: row.taskId, iteration: row.iteration, grade: row.grade })),
    suppliesCurrentSourceControl: false },
  limitations: ['This single-client diagnostic has no current-source Codex control or Jev off/on control.',
    'The native upgrade test uses local fixtures; real cheap-to-strong model routing remains unverified.',
    'Published language-model quota and Jev API-price values are not cash invoices.',
    'Headless zero human intervention is not evidence of saved human time.',
    'Small seeded tasks do not establish multi-file, real-repository or long-task performance.'], goalStatus: 'active' };
await writeFile(join(artifacts, `${outputStem}.json`), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' });
const summary = report.conditions['hmcodex-runtime'];
const rows = [...new Set(cases.map(row => row.taskId))].map(id => {
  const selected = cases.filter(row => row.taskId === id);
  return `| ${id} | ${selected.filter(row => row.status === 'SUCCEEDED').length}/${selected.length} |`;
});
const md = [
  '# hmCodex 再测试与目标验收：2026-10-07', '',
  `当前源码真实模型加真实 Jev 恢复：**${summary.successes}/${summary.runs}**。运行时回归 **${audit.engineering.runtime.passed} 通过、${audit.engineering.runtime.failed} 失败、${audit.engineering.runtime.skipped} 跳过**；新编译桌面检查 **${audit.engineering.native.passed}/${audit.engineering.native.passed + audit.engineering.native.failed}**。`, '',
  '| 真实恢复任务 | 成功 |', '|---|---:|', ...rows, '',
  `源码摘要：${report.runtimeSourceSha256}；批次：${report.batchId}。本批次只测 hmCodex，不能证明已经胜过普通 Codex。独立检查确认预置失败确实发生，恢复读取取得 README 正确标记，工程任务实际执行完整测试并通过独立断言和文件范围检查：${audit.actualChainsPassed ? '全部通过' : '仍有失败'}。`, '',
  '本次修复把上一项只读工具实际完成并返回成功或错误的事实放入 Jev 状态。它不把执行前拒绝当作已执行，也不把错误观察当作任务成功；实际 Jev 拒绝和主机准入限制继续生效。', '',
  '| 原始目标 | 当前验收 |', '|---|---|',
  '| 中断后从 checkpoint 继续 | 新进程恢复与原生桌面继续均有自动回归；本次桌面通过 |',
  '| 必失败任务重试、Jev 恢复与模型升级 | 真实模型恢复见本批次；桌面升级流程通过本地 fixture，真实低价模型到强模型升级仍待验收 |',
  '| 固定任务、持续记录和普通 Codex 同模型对照 | 测试与记录入口已实现；前版完整对照已完成，新源码仍需完整对照；实际费用与人工收益未知 |', '',
  '本轮仍有一次语法任务失败。该轮实际完整测试返回 0，独立验收也通过；此前 Jev 多次要求测试补证据，模型反复读取与执行语法检查，最终规则返回 STALLED／REPEATED_ACTION，Jev 最终验证返回 FAIL。失败原因是恢复流程和终态判定不稳定，不能改算任务成功。应先解决准入反复补证据与重复诊断的循环，再跑当前源码的完整对照。', '',
  '最近已完成的完整对照属于前版源码 9accbfdd：hmCodex 9/12，普通 Codex 10/12；恢复成功分别为 5/8、6/8。hmCodex 两轮读取恢复及一轮语法任务失败均保留。不能用更短总耗时或更少工具调用掩盖少完成的任务，也不能把旧控制组拼给当前源码。', '',
  `本批次语言模型 token：${summary.totalTokens ?? 'UNKNOWN'}；发布额度估值 USD ${summary.estimatedCost ?? 'UNKNOWN'}。Jev 请求 ${audit.decision.succeededCalls}/${audit.decision.calls} 成功，发布 API 价格估值 USD ${audit.decision.estimatedApiPriceUsd ?? 'UNKNOWN'}。两类估值独立记录，实际收费保持 UNKNOWN。`, '',
  '还需完成当前源码完整固定任务对照及独立 Jev 开／关实验；真实低价／强模型路由、失败后的升级；扩展多文件和真实仓库任务；接入实际账单与真实人工活动记录。验收重点是成功率不下降时，每个完成任务的时间、费用或人工介入出现可重复改善。', '',
  `新编译程序 SHA256：${audit.debugExeSha256}。原生覆盖包括 80 条历史任务滚动、checkpoint 继续、失败重试、六项价值入口、取消和导航；这些结果不等于所有窗口尺寸或全部产品功能都已穷尽测试。`, '',
  `[机器审计](C:/Users/User/hmCodex-local/docs/artifacts/${outputStem}.json) · [真实任务原始报告](C:/Users/User/hmCodex-local/docs/artifacts/${reportName}) · [完整前版对照](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_LITERAL_GATE_PAIRED_2026-10-07.json)`, '',
  '自动验收入口已齐备，收益证明尚未达成，目标保持 active。', ''
].join('\n');
await writeFile(join(artifacts, `${outputStem}.md`), md, { flag: 'wx' });
console.log(JSON.stringify({ batchId: audit.batchId, sourceMatches: audit.currentRuntimeMatchesBatch, actualChainsPassed: audit.actualChainsPassed,
  cases: cases.length, engineering: audit.engineering, conditions: audit.conditions, decision: audit.decision }, null, 2));
if (!audit.currentRuntimeMatchesBatch || !audit.actualChainsPassed) process.exitCode = 1;
