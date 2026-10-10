import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'C:/Users/User/hmCodex-local';
const artifacts = join(root, 'docs/artifacts');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = join(root, 'runtime/src');
const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: sha(await readFile(join(sourceRoot, path))) })));
for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: sha(await readFile(join(root, 'runtime', name))) });
const runtimeSourceSha256 = sha(JSON.stringify(files));
const parse = async log => {
  const text = await readFile(join(artifacts, log), 'utf8');
  const passed = text.match(/ℹ pass (\d+)/u), failed = text.match(/ℹ fail (\d+)/u), skipped = text.match(/ℹ skipped (\d+)/u);
  if (!passed || !failed || !skipped) throw Error(`INCOMPLETE_TEST_LOG:${log}`);
  return { passed: Number(passed[1]), failed: Number(failed[1]), skipped: Number(skipped[1]), log, sha256: sha(text) };
};
const runtime = await parse('GOAL_DIAGNOSTIC_RECOVERY_FULL_RUNTIME_VALIDATED_2026-10-07.log');
if (runtime.failed !== 0) throw Error('CURRENT_RUNTIME_REGRESSION_FAILED');
const nativeLogName = 'GOAL_DIAGNOSTIC_RECOVERY_NATIVE_2026-10-07.log';
const nativeLog = await readFile(join(artifacts, nativeLogName), 'utf8');
const native = nativeLog.match(/Summary: (\d+) passed, (\d+) failed, (\d+) skipped/u);
if (!native || Number(native[2]) !== 0) throw Error('NATIVE_REGRESSION_FAILED_OR_INCOMPLETE');
const replay = JSON.parse(await readFile(join(artifacts, 'GOAL_DIAGNOSTIC_RECOVERY_TRAJECTORY_REPLAY_2026-10-07.json'), 'utf8'));
if (runtimeSourceSha256 !== replay.currentRuntimeSourceSha256) throw Error('SOURCE_CHANGED_SINCE_VALIDATED_TRAJECTORY_REPLAY');
const old = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_READ_OBSERVATION_LIVE_2026-10-07.json'), 'utf8'));
const report = { generatedAt: new Date().toISOString(), stage: 'DIAGNOSTIC_RECOVERY_N', runtimeSourceSha256,
  debugExeSha256: sha(await readFile(join(root, 'desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe'))),
  runtime, scripts: await parse('GOAL_DIAGNOSTIC_RECOVERY_SCRIPTS_2026-10-07.log'),
  targeted: await parse('GOAL_DIAGNOSTIC_RECOVERY_CHECKS_FINAL_2026-10-07.log'),
  longerFixtureAfterDeadlineCorrection: await parse('GOAL_DIAGNOSTIC_RECOVERY_FIXTURE_DEADLINE_2026-10-07.log'),
  native: { passed: Number(native[1]), failed: Number(native[2]), skipped: Number(native[3]), log: nativeLogName, sha256: sha(nativeLog) },
  originalFailedRegressionLogs: [await parse('GOAL_DIAGNOSTIC_RECOVERY_FULL_RUNTIME_2026-10-07.log'),
    await parse('GOAL_DIAGNOSTIC_RECOVERY_FULL_RUNTIME_FINAL_2026-10-07.log')],
  originalFailures: ['A five-lease diagnostic fixture completed near its outer 30-second deadline; the parent killed the child before exit.',
    'An intermediate edit attached diagnosticRetry to the wrong test, producing ReferenceError and retaining the old diagnostic deadline. This was corrected before the current validated regression.'],
  changes: ['Known bounded Node request forms describe default cwd and automatic discovery before execution without granting a lease.',
    'Only actual RestrictedWindowsExecutor test results can carry observed Node purpose and actual process success.',
    'One repeated Node syntax diagnosis followed by a distinct actual full Node test with exit 0 can stop being classified as stalled; history remains recorded.',
    'Multiple repeats, absent or mismatched actual output digests, earlier or unsuccessful tests, arbitrary commands and repeated writes remain blocked by the original stall checks.'],
  archivedReplay: { path: 'GOAL_DIAGNOSTIC_RECOVERY_TRAJECTORY_REPLAY_2026-10-07.json', originalTaskStatus: 'FAILED',
    previousRuleStatus: replay.originalRuleObservation.status, currentRuleStatus: replay.currentRuleReport.status, originalGradeChanged: false },
  previousSourceLive: { report: 'AGENT_GOAL_READ_OBSERVATION_LIVE_2026-10-07.json', batchId: old.batchId,
    runtimeSourceSha256: old.runtimeSourceSha256, conditions: old.conditions, suppliesCurrentSourceEvidence: false },
  nextRequiredEvidence: ['Frozen-current-source full 24-run ordinary Codex comparison.', 'Current-source independent Jev off/on comparison.',
    'Actual cheap/strong model retry identities and per-model measurements.', 'Actual billing and human activity, plus broader engineering tasks.'],
  goalStatus: 'active', limitations: ['The archived trajectory replay is not a new live task success.',
    'Native desktop model upgrade uses local fixtures.', 'Green engineering regressions do not establish economic advantage.'] };
await writeFile(join(artifacts, 'AGENT_GOAL_DIAGNOSTIC_RECOVERY_STAGE_AUDIT_2026-10-07.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
const md = [
  '# hmCodex 诊断恢复修复验收：2026-10-07', '',
  `源码 ${runtimeSourceSha256} 已编译。完整运行时回归 **${runtime.passed} 通过、0 失败、${runtime.skipped} 项跳过**，新程序原生桌面 **${report.native.passed}/${report.native.passed}**；目标测试脚本 ${report.scripts.passed} 通过。`, '',
  '主机为受限 Node 命令提供默认工作目录、测试发现方式与实际执行结果。一次重复语法检查后，如果不同的完整测试确实执行且退出码为 0，停滞规则会记录诊断已恢复。重复写入、多次诊断重复、缺少实际结果、失败测试和只有模型声明的成功仍不通过。', '',
  '新回归在修复前返回 STALLED；修复后，真实子进程实际完成五次受控操作并消耗相应租约。该较长 fixture 在全量并发回归中撞上原 30 秒外层期限；调整为 60 秒后已通过。中间一次超时参数改错用例的失败也保留在原始日志，当前完整回归已重新验证。真实客户端的任务时限没有改变。', '',
  '上一轮失败的 14 次实际工具轨迹独立重放后，新规则能识别后来的实际完整测试成功。这个重放只验证规则，不改动旧任务 FAILED 状态，不计为新的真实恢复成功。', '',
  '上一源码 b972fad8 的真实模型加 Jev 仍为 7/8，新源码的完整客户端对照尚需完成；不能沿用旧通过率。后续还需 Jev 开／关实验、真实低价／强模型升级及实际账单和人工时间。收益目标保持 active。', '',
  'Node 默认测试发现与语法检查的含义依据 [Node v24.19.0 测试文档](https://nodejs.org/download/release/v24.19.0/docs/api/test.html#running-tests-from-the-command-line)与[命令行文档](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#-c---check)。这些事实不授权执行测试，受控工具仍须通过原有主机策略和单次租约。', '',
  `[机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_STAGE_AUDIT_2026-10-07.json) · [完整回归](C:/Users/User/hmCodex-local/docs/artifacts/${runtime.log}) · [原生桌面](C:/Users/User/hmCodex-local/docs/artifacts/${nativeLogName}) · [归档轨迹重放](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_DIAGNOSTIC_RECOVERY_TRAJECTORY_REPLAY_2026-10-07.json)`, ''
].join('\n');
await writeFile(join(artifacts, 'AGENT_GOAL_DIAGNOSTIC_RECOVERY_STAGE_AUDIT_2026-10-07.md'), md, { flag: 'wx' });
console.log(JSON.stringify({ source: runtimeSourceSha256, runtime, native: report.native, exe: report.debugExeSha256 }));
