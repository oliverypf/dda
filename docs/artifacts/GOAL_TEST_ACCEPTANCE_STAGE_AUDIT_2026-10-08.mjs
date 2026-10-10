import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'C:/Users/User/hmCodex-local';
const artifacts = join(root, 'docs/artifacts');
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceRoot = join(root, 'runtime/src');
const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: sha(await readFile(join(sourceRoot, path))) })));
for (const path of ['package.json', 'package-lock.json']) files.push({ path: `../${path}`, sha256: sha(await readFile(join(root, 'runtime', path))) });
const parse = async name => {
  const text = await readFile(join(artifacts, name), 'utf8');
  const pass = text.match(/ℹ pass (\d+)/u), fail = text.match(/ℹ fail (\d+)/u), skip = text.match(/ℹ skipped (\d+)/u);
  if (!pass || !fail || !skip) throw Error(`TEST_LOG_NOT_COMPLETE:${name}`);
  return { passed: Number(pass[1]), failed: Number(fail[1]), skipped: Number(skip[1]), log: name, sha256: sha(text) };
};
const nativeLog = await readFile(join(artifacts, 'GOAL_TEST_ACCEPTANCE_NATIVE_2026-10-08.log'), 'utf8');
const native = nativeLog.match(/Summary: (\d+) passed, (\d+) failed, (\d+) skipped/u);
if (!native || Number(native[2]) !== 0) throw Error('NATIVE_TESTS_INCOMPLETE_OR_FAILED');
const report = { generatedAt: new Date().toISOString(), stage: 'TEST_ACCEPTANCE_O', runtimeSourceSha256: sha(JSON.stringify(files)),
  debugExeSha256: sha(await readFile(join(root, 'desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe'))),
  runtime: await parse('GOAL_TEST_ACCEPTANCE_FULL_RUNTIME_2026-10-08.log'),
  scripts: await parse('GOAL_TEST_ACCEPTANCE_SCRIPTS_2026-10-08.log'), targeted: await parse('GOAL_TEST_ACCEPTANCE_CHECKS_2026-10-08.log'),
  native: { passed: Number(native[1]), failed: Number(native[2]), skipped: Number(native[3]), log: 'GOAL_TEST_ACCEPTANCE_NATIVE_2026-10-08.log', sha256: sha(nativeLog) },
  gradingProtocolVersion: '2.0-NATIVE_FIXTURE_TEST_EXECUTION',
  changes: ['Node flags must precede the script/test-file arguments; an entry-point receiving --test is not classified as Node test-runner execution.',
    'Goal grading now requires the actual immutable fixture test file scope, observed passing test names and actual process exit0, alongside independent behavior and file-scope checks.',
    'The seeded engineering failure must come from the requested actual Node diagnostic/test before the repair; an unrelated failed read cannot satisfy it.',
    'Ordinary Codex commands are parsed as simple actual Node invocations, not substring matches inside quoted text or shell scripts.'],
  previousBatch: { report: 'AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.json', status: 'ABORTED_PROVIDER_IMPAIRMENT', completeComparison: false },
  modelAvailability: 'GOAL_MODEL_AVAILABILITY_2026-10-08.json', nextComparison: { model: 'mimo-v2.6-flash', plannedRuns: 24,
    taskSetVersion: '3.1', decisionMode: 'LIVE_JEV_HMCODEX_ONLY', configuration: 'GOAL_FLASH_MODEL_CONFIG_2026-10-08.json' },
  pricing: JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go-flash.json'), 'utf8')),
  limitations: ['No actual cheap-to-Pro upgrade was proven by the minimal availability requests.',
    'The new source still needs a full matched client comparison and independent Jev off/on comparison.',
    'Published quota and Jev API-price estimates are not user invoices; real human savings remain unmeasured.'], goalStatus: 'active' };
if (report.runtime.failed || report.scripts.failed || report.targeted.failed) throw Error('CURRENT_REGRESSION_FAILED');
await writeFile(join(artifacts, 'AGENT_GOAL_TEST_ACCEPTANCE_STAGE_AUDIT_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(join(artifacts, 'AGENT_GOAL_TEST_ACCEPTANCE_STAGE_AUDIT_2026-10-08.md'), [
  '# 测试执行证据修复与验收：2026-10-08', '',
  `当前源码 ${report.runtimeSourceSha256} 已编译：运行时 **${report.runtime.passed} 通过、0 失败、${report.runtime.skipped} 跳过**；基准脚本 **${report.scripts.passed} 通过**；原生桌面 **${report.native.passed}/${report.native.passed}**。`, '',
  '新增负例验证了普通脚本接收 --test 后返回0、只跑语法检查、测试错误文件、只有口头成功和无关读取报错都不能通过工程恢复验收。现在同时检查实际 Node 调用、预置测试文件及其真实通过记录，并继续做独立断言和文件范围检查。验收协议版本为 2.0，固定任务的提示和初始文件仍为任务集 3.1。', '',
  'Pro 的上一批计划24次、完成10次后中止。双方均遭遇HTTP500，最小Pro请求超时；Flash最小请求成功。原始结果保留，未执行或中断项目不计通过，也不据此声称任何客户端优势。中止的是核实过的测试进程。', '',
  '后续同模型对照使用双方相同的真实 mimo-v2.6-flash、相同六任务及两轮重复，hmCodex另启用真实Jev。这个批次单独验收，不能混入Pro结果或改称真实Pro升级测试。', '',
  'Flash发布额度价格为每百万token输入USD0.14、输出USD0.28、缓存读取USD0.0028，来自当日核对的[OpenCode Go官方文档](https://opencode.ai/docs/go/#usage-limits)。这些数值表示订阅额度消耗，实际现金收费保持未知。', '',
  `[机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_TEST_ACCEPTANCE_STAGE_AUDIT_2026-10-08.json) · [中止批次](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.json) · [运行时回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_TEST_ACCEPTANCE_FULL_RUNTIME_2026-10-08.log)`, '',
  '完整对照、Jev开关效应、真实升级、实际费用与人工收益仍待验证，目标保持active。', ''
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ source: report.runtimeSourceSha256, exe: report.debugExeSha256, runtime: report.runtime, native: report.native, scripts: report.scripts }));
