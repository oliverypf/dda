import { createHash } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { parseCommand, sanitizeOutput } from '../runtime-safety-monitor.mjs';

const MAX_CLAIMS = 16;
const ARTIFACT_EXTENSION = '(?:exe|msi|dll|zip|tar\\.gz|tgz|jar|whl|apk|aab|deb|rpm|dmg|pkg|appimage|pptx)';
const artifactFile = new RegExp(`\\.${ARTIFACT_EXTENSION}$`, 'iu');
const artifactNames = new RegExp(String.raw`[^\s\x60"'<>|()[\]：，。；]+\.${ARTIFACT_EXTENSION}\b`, 'giu');
const buildScripts = /^(?:build|compile|bundle|package)(?:$|[:-])/iu;
const testScripts = /^test(?:$|[:-])/iu;
const testRunners = /^(?:vitest|jest|mocha|pytest|ctest)$/iu;

const outputTextDigest = text => 'sha256:' + createHash('sha256').update(text.replace(/(?:\r?\n)+$/u, '')).digest('hex');
const emptyOutputDigest = outputTextDigest('');
const clean = (value, limit) => sanitizeOutput(value)
  .replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, limit);

// A successful compiler may write warnings to stderr.  Keep the explicit
// `stderr 为空` claim strict, while letting `无错误` describe the absence of
// error-level output instead of requiring an empty stream.
const stderrContainsError = text => text.split(/\r?\n/u).some(line =>
  /^\s*(?:error|fatal|panic)(?:\b|\s*[:：])|^\s*(?:错误|失败)(?:\b|\s*[:：])/iu.test(line));

const executableName = command => basename(command.replaceAll('\\', '/')).toLowerCase().replace(/\.(?:exe|cmd|bat)$/iu, '');

function operationKind(tool, executable, args) {
  const [subcommand, script] = args;
  if (/^(?:npm|pnpm|yarn|bun)$/iu.test(executable)) {
    const entry = ['run', 'run-script'].includes(subcommand) ? script : subcommand;
    if (testScripts.test(entry ?? '')) return 'TEST';
    if (buildScripts.test(entry ?? '')) return 'BUILD';
  }
  const wrapperTarget = ['npx', 'bunx'].includes(executable) ? subcommand
    : ['npm', 'pnpm', 'yarn', 'uv'].includes(executable) && ['exec', 'run'].includes(subcommand) ? script : '';
  if (testRunners.test(executable) || testRunners.test(wrapperTarget ?? '') || executable === 'node' && args.includes('--test')
    || ['cargo', 'go', 'dotnet'].includes(executable) && subcommand === 'test'
    || /^python(?:[\d.]+)?$/u.test(executable) && subcommand === '-m' && ['pytest', 'unittest'].includes(script)) return 'TEST';
  if (['cargo', 'go', 'dotnet', 'tauri', 'vite'].includes(executable) && subcommand === 'build'
    || executable === 'cmake' && subcommand === '--build'
    || executable === 'node' && /(?:^|[/\\])build(?:[-.][^/\\]+)?\.[cm]?js$/iu.test(subcommand ?? '')) return 'BUILD';
  return tool === 'test.execute' ? 'TEST' : undefined;
}

function structuredTestCounts(text) {
  const line = text.split(/\r?\n/u).findLast(value => value.startsWith('DDA_TEST_RESULT '));
  if (!line || line.length > 16384) return undefined;
  let report;
  try { report = JSON.parse(line.slice('DDA_TEST_RESULT '.length)); } catch { return undefined; }
  const { tests, pass, fail, skipped = 0, todo = 0 } = report ?? {};
  if (report?.version !== 1 || ![tests, pass, fail, skipped, todo].every(n => Number.isSafeInteger(n) && n >= 0)
    || tests !== pass + fail + skipped + todo) return undefined;
  const suites = Array.isArray(report.suites) ? report.suites.filter(value => typeof value === 'string').slice(0, 32).map(value => clean(value, 160)) : [];
  return { counts: { tests, pass, fail, skipped, todo }, suites };
}

function reportTestCounts(text) {
  const counts = {};
  // Node's TAP and spec reporters put the run totals on separate lines.
  for (const match of text.matchAll(/^\s*(?:#|ℹ|info)\s+(tests|pass|fail|skipped|todo)\s+(\d+)\s*$/gimu)) {
    counts[match[1].toLowerCase()] = Number(match[2]);
  }
  if (counts.tests !== undefined && (counts.pass !== undefined || counts.fail !== undefined)) return counts;
  const lines = text.split(/\r?\n/u);
  const rustSummaries = lines.filter(line => /^\s*test result:/iu.test(line));
  // A cargo test command can report separate unit, integration and doc suites.
  const summary = lines.findLast(line =>
    /^\s*(?:Tests:\s*|Tests\s{2,}|=+.*=+\s*$)/iu.test(line)
    && /\d+\s+(?:passed|failed|skipped)/iu.test(line));
  const labels = { passed: 'pass', failed: 'fail', skipped: 'skipped', ignored: 'skipped' };
  const totals = {};
  for (const line of rustSummaries.length ? rustSummaries : summary ? [summary] : []) {
    for (const [, count, label] of line.matchAll(/(\d+)\s+(passed|failed|skipped|ignored)\b/giu)) {
      const key = labels[label.toLowerCase()];
      totals[key] = (totals[key] ?? 0) + Number(count);
    }
  }
  return Object.keys(totals).length ? totals : undefined;
}

function reportedArtifacts(text) {
  const paths = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (paths.size >= 12) break;
    if (line.startsWith('DDA_BUILD_ARTIFACT {') && line.length <= 2048) {
      let record;
      try { record = JSON.parse(line.slice('DDA_BUILD_ARTIFACT '.length)); } catch { continue; }
      const { path, disposition, sha256, installer } = record ?? {};
      if (record?.version === 1 && typeof path === 'string' && path.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(path)
        && artifactFile.test(path) && ['GENERATED', 'REUSED'].includes(disposition) && /^sha256:[a-f0-9]{64}$/u.test(sha256 ?? '')) {
        paths.set(path, { path, disposition, sha256, installer: installer === true || /\.msi$/iu.test(path) || paths.get(path)?.installer === true });
      }
      continue;
    }
    const marker = /^\s*(?:DDA_BUILD_ARTIFACT\s+|artifact=|(?:staged runnable desktop|built application at):\s*)(.+?)\s*$/iu.exec(line);
    const bundle = /^\s*Bundling\s+.+?\s+\((.+)\)\s*$/iu.exec(line);
    const path = (marker?.[1] ?? bundle?.[1])?.trim().replace(/^["']|["']$/gu, '');
    if (path && path.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(path) && artifactFile.test(path)) {
      const previous = paths.get(path);
      paths.set(path, { path, ...previous,
        installer: previous?.installer === true || Boolean(bundle) || /\.msi$/iu.test(path) || /(?:setup|installer)\.exe$/iu.test(path) });
    }
  }
  return [...paths.values()];
}

function commandArguments(args) {
  let hideNext = false;
  return args.slice(0, 32).map(arg => {
    if (hideNext) {
      hideNext = false;
      return '[已隐藏]';
    }
    if (/^(?:-e|-p|--eval|--print)$/u.test(arg) || /^--?[\w-]*(?:token|password|secret|api[-_]?key|authorization)[\w-]*$/iu.test(arg)) {
      hideNext = true;
      return arg;
    }
    if (/^(?:--(?:eval|print)=|-[ep].+)|(?:token|password|secret|api[-_]?key|authorization)[\w-]*=/iu.test(arg)) return '[已隐藏]';
    return clean(arg, 240);
  });
}

// Only call with the returned result of a real registry process invocation.
export function buildTestProcessReceipt({ tool, request, output, startedAtMs, endedAtMs, outputDigest }) {
  if (!['shell.execute', 'test.execute'].includes(tool) || !output || typeof output.ok !== 'boolean') return undefined;
  let command;
  try { command = parseCommand(request); } catch { return undefined; }
  const executable = executableName(command.command);
  const kind = operationKind(tool, executable, command.args);
  if (!kind) return undefined;
  const text = stripVTControlCharacters([output.stdout, output.stderr].filter(value => typeof value === 'string').join('\n'));
  const testReport = kind === 'TEST' ? structuredTestCounts(text) : undefined;
  const testCounts = testReport?.counts ?? (kind === 'TEST' ? reportTestCounts(text) : undefined);
  const cwd = output.cwd ?? request.cwd ?? '';
  const invocationKey = createHash('sha256').update(JSON.stringify([kind, cwd, command.command, command.args])).digest('hex');
  return {
    kind, tool, command: clean(command.command, 240), args: commandArguments(command.args),
    cwd, invocationKey,
    exitCode: Number.isInteger(output.exitCode) ? output.exitCode : null,
    ...(/^SIG[A-Z0-9]+$/u.test(output.signal ?? '') ? { signal: output.signal } : {}),
    ...(typeof output.timedOut === 'boolean' ? { timedOut: output.timedOut } : {}),
    ...(typeof output.aborted === 'boolean' ? { aborted: output.aborted } : {}),
    outputTruncated: output.truncated === true, outputDigest,
    startedAtMs, endedAtMs,
    ...(Number.isSafeInteger(output.durationMs) ? { durationMs: output.durationMs } : {}),
    ...(typeof output.stdout === 'string' && !output.truncated ? { stdoutTextDigest: outputTextDigest(output.stdout) } : {}),
    ...(typeof output.stderr === 'string' && !output.truncated ? {
      stderrEmpty: output.stderr.length === 0,
      stderrContainsError: stderrContainsError(output.stderr),
      stderrTextDigest: outputTextDigest(output.stderr)
    } : {}),
    ...(/^lease-[a-f0-9-]{8,64}$/iu.test(output.lease ?? '') ? { lease: output.lease } : {}),
    ...(testCounts ? { testCounts } : {}),
    ...(testReport ? { testReportKind: 'STRUCTURED' } : {}),
    ...(testReport?.suites.length ? { testSuites: testReport.suites } : {}),
    reportedArtifacts: kind === 'BUILD' ? reportedArtifacts(text) : []
  };
}

// The observation callback uses the same live path policy as ordinary workspace reads.
export async function recordBuildTestReceipt(process, id, observeFile) {
  const { reportedArtifacts: paths, ...receipt } = process;
  const observations = await Promise.all(paths.map(async ({ path, installer, disposition, sha256 }) => {
    const file = await observeFile(path, receipt.cwd, { sha256 }).catch(() => undefined);
    if (!file || (sha256 && file.sha256 !== sha256) || file.modifiedAtMs > receipt.endedAtMs) return undefined;
    if (file.modifiedAtMs < receipt.startedAtMs && !(disposition === 'REUSED' && receipt.exitCode === 0
      && !receipt.timedOut && !receipt.aborted)) return undefined;
    return { ...file, installer, disposition: disposition ?? 'OBSERVED' };
  }));
  return {
    ...receipt, id, reportedArtifactCount: paths.length,
    // Keep build-output hints private until path policy and freshness are confirmed.
    artifacts: observations.filter(Boolean).map((file, index) => ({ ...file, id: `${id}-artifact-${index + 1}` }))
  };
}

const buildTopic = /构建|编译|打包|\b(?:build|compil(?:e|ed|ation)|bundl(?:e|ing|ed))\b/iu;
const testTopic = /测试|单测|用例|核验|\d+\s*项检查|\b(?:tests?|vitest|jest|pytest|mocha|ctest)\b/iu;
const outcome = /成功|通过|失败|完成|退出码|超时|中止|\b(?:succeeded|passed|failed|completed|exit(?:ed| code)|timed out|aborted|[0-9]+\/[0-9]+)\b/iu;
const skipped = /(?:未|没有|尚未)(?:执行|运行|重跑)(?:任何)?(?:构建|编译|测试)|\b(?:did not|didn't|not)\s+run\b/iu;
const artifactTopic = /安装包|构建产物|可执行文件|\b(?:installer|artifacts?)\b/iu;
const artifactResult = /生成|产出|已存在|已输出|已打包|\b(?:generated|produced|created|available\s+at)\b/iu;
const artifactField = /^(?:\*\*)?(?:本次构建产物|本次产物|构建产物|产物(?:路径)?|安装包|(?:build\s+)?artifacts?|installer)(?:\*\*)?\s*[:：]/iu;
const prospective = /预计|预期|计划|将会|目标路径|预设|如果|尚待核实|\b(?:expected|planned|will|would|should|if)\b/iu;
const processOnly = /退出码|exit(?:ed| code)|超时|timed out|中止|aborted/iu;
const testConclusion = /(?:退出码|exit(?:ed| code)|超时|timed out|中止|aborted|(?:\d+\s*(?:个|项|条)?\s*(?:测试|用例|检查)\s*(?:全部\s*)?(?:通过|失败|跳过|全过|全通过|passed|failed|skipped))|\b(?:tests?|pass(?:ed)?|fail(?:ed)?|skipped?|todo)\s*(?:[:=]\s*|\s+)\d+\b|(?:所有|全部|all|every).{0,16}(?:相关)?(?:测试|用例|检查|tests?).{0,16}(?:通过|失败|跳过|全过|全通过|passed|failed|skipped)|(?:测试|用例|检查).{0,16}(?:全部|均).{0,16}(?:通过|失败|跳过|全过|全通过|passed|failed|skipped))/iu;
const testInvocation = /`[^`]*(?:node|npm|pnpm|yarn|pytest|python|go|cargo|mvn|gradle|test|测试)[^`]*`|\b(?:node|npm|pnpm|yarn|pytest|python|go|cargo|mvn|gradle)\b[^\r\n]{0,160}(?:--test|\btests?\b|测试)/iu;
const testCountConclusion = /(?:\b(?:tests?|pass(?:ed)?|fail(?:ed)?|skipped?|todo)\s*(?:[:=]\s*|\s+)\d+\b|(?:所有|全部|all|every)\s*\d+\s*(?:个|项|条)?\s*(?:测试|用例|检查|tests?)\s*(?:全部\s*)?(?:通过|失败|跳过|全过|全通过|passed|failed|skipped)|\d+\s*(?:个|项|条)?\s*(?:测试|用例|检查)\s*(?:全部\s*)?(?:通过|失败|跳过|全过|全通过|passed|failed|skipped)|(?:所有|全部|all|every).{0,16}(?:相关)?(?:测试|用例|检查|tests?).{0,16}(?:通过|失败|跳过|全过|全通过|passed|failed|skipped)|(?<![一二三四五六七八九十\d])(?:测试|用例|检查)\s*(?:全部|均)\s*(?:通过|失败|跳过|全过|全通过|passed|failed|skipped))$/iu;
const reportNote = /(?:尚未验证|未验证(?:的)?(?:部分|项)|未核实|未覆盖|没有专门(?:的)?(?:失败|测试)|证据链(?:中|的)|过程记录|中间过程记录|中途一次失败|(?:首次|第一次|第二次|第三次|第\s*\d+\s*次)(?:\s*`[^`]+`\s*)?(?:运行|执行|跑|测试|尝试|改动)?[^，。；]{0,160}(?:改|失败|退出码|覆盖|修订|据此)|(?:据此|因此)[^，。；]{0,80}(?:改动|修改)|(?:只|仅)改[^，。；]{0,80}(?:仍失败|失败))/iu;
// Explicitly deferred validation is process narration, not a current-step claim.
const deferredVerificationNote = /(?:核验|验证).{0,24}(?:留给|安排在|放到|由).{0,12}(?:后续|下一步)|(?:后续|下一步).{0,20}(?:核验|验证).{0,24}(?:留给|尚未|未(?:执行|进行|发生))/iu;
const installerClaim = /安装包|\b(?:installers?|msi)\b/iu;

// Use command intent and concrete task requirements. Executor prose is used
// only for the separate semantic review below.
export function requestedBuildTestItems(prompt, commands = []) {
  const kinds = new Set();
  for (const text of commands) {
    try {
      const { command, args } = parseCommand({ command: text });
      kinds.add(operationKind('shell.execute', executableName(command), args));
    } catch { /* An invalid command is not a task requirement. */ }
  }
  let artifact = false;
  let installer = false;
  for (const clause of String(prompt ?? '').split(/[。；;!?！？\n]+/u)) {
    if (/如何|怎么|为什么|示例|(?:查看|报告)(?:上次|上一轮|历史)|\b(?:how to|why|explain|example)\b/iu.test(clause)) continue;
    const buildCommand = /(?:^|[\s，,])(?:build|compile|package)(?:\s+(?:the\s+)?(?:app|project|exe|desktop)|\s+(?:and|then)\b|\s*$)/iu;
    const buildRequest = /(?:执行|运行|重新|请|帮我|先|再)(?:本次)?(?:构建|编译|打包)|(?:构建|编译|打包)\s*(?:项目|程序|应用|桌面|exe|安装包|结果|成)|^\s*(?:构建|编译|打包)\s*$/iu;
    const buildDeclined = /(?:不要|无需|别|不必)\s*(?:构建|编译|打包)|\b(?:do not|don['’]t|without)\s+(?:build|compile|package)/iu;
    const build = !buildDeclined.test(clause) && (buildCommand.test(clause) || buildRequest.test(clause)
      || /(?:run|execute|report)\b.{0,70}\b(?:build|compile)\b/iu.test(clause));
    const testRequest = /(?:运行|执行|跑|报告).{0,12}测试|测试一下|(?:run|execute|report)\b.{0,80}\btests?\b|^\s*(?:tests?|测试)\s*$/iu;
    const testDeclined = /(?:不要|无需|别|不必|不运行|不执行)\s*(?:运行|执行|跑)?\s*测试|\b(?:do not|don['’]t|without)\s+(?:running\s+|run\s+)?(?:the\s+)?tests?\b/iu;
    const test = testRequest.test(clause) && !testDeclined.test(clause);
    const skipInstaller = /(?:不|不用|不要|无需|不必)\s*(?:生成|打包|做)?\s*安装包|\bwithout\s+(?:an?\s+)?installers?\b/iu.test(clause);
    const asksForInstaller = !skipInstaller && installerClaim.test(clause)
      && (build || /生成|产出|打包|\b(?:generate|produce)\b/iu.test(clause));
    if (build || asksForInstaller) kinds.add('BUILD');
    if (test) kinds.add('TEST');
    if (asksForInstaller) installer = true;
    if (asksForInstaller || build && /产物|可执行|\b(?:exe|artifacts?|bundle)\b/iu.test(clause)) artifact = true;
  }
  return { build: kinds.has('BUILD'), test: kinds.has('TEST'), artifact, installer };
}

const executionStatus = receipt => receipt.timedOut ? 'TIMED_OUT' : receipt.aborted ? 'ABORTED'
  : receipt.exitCode === null ? (receipt.signal ? 'TERMINATED' : 'UNKNOWN') : receipt.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
const executionLabels = { TIMED_OUT: '超时', ABORTED: '已中止', UNKNOWN: '缺少退出状态', SUCCEEDED: '退出码 0', FAILED: '执行失败' };
const citation = receipt => [receipt.id, receipt.outputDigest];

function latestCommandReceipts(chronological) {
  const latestByCommand = new Map();
  for (const receipt of chronological) {
    const key = receipt.invocationKey ?? JSON.stringify([receipt.kind, receipt.cwd, receipt.command, receipt.args]);
    latestByCommand.set(key, receipt);
  }
  return [...latestByCommand.values()];
}

export function fixedBuildTestReport(receipts, required = {}) {
  const latest = latestCommandReceipts([...receipts].sort((a, b) => a.endedAtMs - b.endedAtMs));
  if (!latest.length && !required.build && !required.test && !required.artifact) return undefined;
  const builds = latest.filter(receipt => receipt.kind === 'BUILD');
  const tests = latest.filter(receipt => receipt.kind === 'TEST');
  const items = [
    ['BUILD', 'build-command-result', '构建命令', builds, required.build],
    ['TEST', 'test-result', '测试结果', tests, required.test]
  ].map(([kind, id, label, observed, requested]) => {
    const results = observed.map(receipt => ({
      command: receipt.command, args: receipt.args, cwd: receipt.cwd,
      execution: executionStatus(receipt), exitCode: receipt.exitCode,
      ...(receipt.signal ? { signal: receipt.signal } : {}),
      ...(receipt.testCounts ? { counts: receipt.testCounts } : {}),
      ...(receipt.testSuites?.length ? { suites: receipt.testSuites } : {}),
      evidence: citation(receipt)
    }));
    const code = !observed.length ? (requested ? `${kind}_COMMAND_RECORD_MISSING` : undefined)
      : observed.some(receipt => executionStatus(receipt) === 'UNKNOWN') ? 'PROCESS_EXIT_RECORD_MISSING'
        : kind === 'TEST' && observed.some(receipt => !receipt.testCounts || receipt.outputTruncated && receipt.testReportKind !== 'STRUCTURED')
          ? 'TEST_RESULT_RECORD_MISSING' : undefined;
    const reason = code?.endsWith('COMMAND_RECORD_MISSING') ? `缺少本次${kind === 'BUILD' ? '构建' : '测试'}命令记录`
      : code === 'PROCESS_EXIT_RECORD_MISSING' ? '缺少退出码或终止状态记录'
        : code === 'TEST_RESULT_RECORD_MISSING' ? '缺少完整的测试框架结果汇总记录' : undefined;
    const details = results.map(result => {
      const exit = result.execution === 'FAILED' ? `退出码 ${result.exitCode}`
        : result.execution === 'TERMINATED' ? `被 ${result.signal} 终止` : executionLabels[result.execution];
      const counts = result.counts ? `，通过 ${result.counts.pass ?? '未知'}，失败 ${result.counts.fail ?? '未知'}，跳过 ${result.counts.skipped ?? '未知'}` : '';
      return `${result.command}${result.args.length ? ` ${result.args.join(' ')}` : ''}，${exit}${counts}`;
    });
    return { id, label, status: code ? 'PENDING' : observed.length ? 'VERIFIED' : 'NOT_REQUESTED',
      ...(code ? { code } : {}), detail: [...details, ...(reason ? [`待核验，${reason}`] : [])].join('；') || '本次未要求', results };
  });
  const artifacts = builds.flatMap(receipt => (receipt.artifacts ?? []).map(file => ({
    path: file.path, disposition: file.disposition, installer: file.installer, sizeBytes: file.sizeBytes,
    ...(file.sha256 ? { sha256: file.sha256 } : {}), evidence: [...citation(receipt), file.id]
  })));
  const relevant = required.installer ? artifacts.filter(file => file.installer) : artifacts;
  const pendingArtifact = !relevant.length && (required.artifact || builds.some(receipt => receipt.reportedArtifactCount));
  const disposition = { GENERATED: '本次生成', REUSED: '本次复用', OBSERVED: '本次构建期间观测' };
  items.push({ id: 'build-artifact-origin', label: '产物归属',
    status: pendingArtifact ? 'PENDING' : relevant.length ? 'VERIFIED' : 'NOT_REQUESTED',
    ...(pendingArtifact ? { code: 'BUILD_ARTIFACT_RECORD_MISSING' } : {}),
    detail: pendingArtifact ? `待核验，缺少与本次构建关联的${required.installer ? '安装包' : '产物'}记录`
      : relevant.map(file => `${file.path}，${disposition[file.disposition] ?? disposition.OBSERVED}`).join('；') || '本次未要求', results: relevant });
  return { items, pending: items.filter(item => item.status === 'PENDING') };
}

export function fixedBuildTestChecks(report) {
  return report?.items.filter(item => item.status !== 'NOT_REQUESTED').map(item => ({
    id: item.id, status: item.status === 'VERIFIED' ? 'PASS' : 'UNKNOWN',
    message: `${item.label} ${item.detail}`,
    evidence: [...new Set(item.results.flatMap(result => result.evidence))]
  })) ?? [];
}

export const formatBuildTestReport = report => ['**运行时核验**', ...report.items.map(item =>
  `- **${item.label}** ${item.detail.replace(/[\r\n]/gu, ' ')}`)].join('\n');

const genericPresentation = /(?:生成|产出|输出|created?|generated?|produced?)\s*(?:一份|一个|an?\s+)?\s*pptx(?:\s*(?:文件|演示文稿|file|presentation))?(?![\w./\\-])/iu;
const genericPresentationClause = new RegExp(`^(?:已)?${genericPresentation.source}$`, 'iu');
const namedPresentation = new RegExp(genericPresentation.source + '\\s*(?:[:：为=]\\s*)?(?:[`"“]([^`"”]+)[`"”]|([\\w.:/\\\\-]+\\.[a-z0-9]{1,10})(?![\\w.-]))', 'iu');
const passStepHeader = /^`?([\w.:-]+)`?\s*[(（]\s*PASS\s*[)）]\s*[:：]\s*/iu;
const normalizedStatement = statement => statement.replace(/\*\*/gu, '').replace(/^\d+\.\s+/u, '');

function claimArtifacts(claim, receipt) {
  const files = (receipt.artifacts ?? []).filter(file => !claim.paths.length || claim.paths.some(path => matchesPath(file, path)));
  if (genericPresentation.test(claim.statement)) return files.filter(file => /\.pptx$/iu.test(file.path)
    && Number.isSafeInteger(file.pptx?.slideCount) && file.pptx.slideCount > 0
    && Number.isSafeInteger(file.pptx.entryCount) && file.pptx.entryCount >= file.pptx.slideCount);
  if (claim.paths.length) return files;
  if (claim.kind === 'ARTIFACT') return files.filter(file => !installerClaim.test(claim.statement) || file.installer);
  return claim.kind === 'BUILD' ? files : [];
}

function matchesInvocation(receipt, commandLine) {
  let parsed;
  try { parsed = parseCommand({ command: commandLine }); } catch { return false; }
  if (receipt.invocationKey && typeof receipt.cwd === 'string') {
    const key = createHash('sha256').update(JSON.stringify([receipt.kind, receipt.cwd, parsed.command, parsed.args])).digest('hex');
    return key === receipt.invocationKey;
  }
  return parsed.command === receipt.command && Array.isArray(receipt.args) && !receipt.args.includes('[已隐藏]') && JSON.stringify(parsed.args) === JSON.stringify(receipt.args);
}

function extractClaims(text) {
  const claims = new Map();
  for (const fragment of String(text ?? '').split(/[\r\n。！？；]+|(?<=[.!?;])\s+/u)) {
    const statement = clean(fragment.replace(/^\s*[-*#>]+\s*/u, ''), 400);
    if (!statement || skipped.test(statement) || prospective.test(statement) || deferredVerificationNote.test(statement)
      || reportNote.test(statement) && testTopic.test(statement) || /[?？]\s*$/u.test(fragment)) continue;
    const add = (kind, paths = []) => claims.set(`${kind}:${statement}`, { kind, statement, paths,
      ...(statement.length === 400 ? { possiblyTruncated: true } : {}) });
    const paths = [...new Set([...statement.matchAll(artifactNames)].map(([path]) => path))];
    const named = namedPresentation.exec(statement);
    const namedPath = named?.[1] ?? named?.[2];
    if (namedPath && !paths.includes(namedPath)) paths.push(namedPath);
    if ((artifactTopic.test(statement) || paths.length || genericPresentation.test(statement)) && artifactResult.test(statement)
      || paths.length && artifactField.test(statement)) {
      add('ARTIFACT', paths);
    }
    const topicText = statement.replace(/^`?[\w.-]+`?\s*(?=步骤)/u, '');
    if (buildTopic.test(topicText) && outcome.test(statement)) add('BUILD', paths);
    if (testTopic.test(statement) && outcome.test(statement) && testConclusion.test(statement)
      && (testInvocation.test(statement) || testCountConclusion.test(statement) || processOnly.test(statement))) {
      add(processOnly.test(statement) ? 'TEST_PROCESS' : 'TEST_RESULT');
    }
  }
  return [...claims.values()];
}

const missingCheck = (claim, code, message) => ({ id: claim.id, status: 'UNKNOWN', code,
  message: `${message}（${claim.statement}）`, evidence: [] });

const pathKey = value => {
  const path = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  return process.platform === 'win32' ? path.toLowerCase() : path;
};
const matchesPath = (artifact, requested) => {
  const name = pathKey(requested);
  const path = pathKey(artifact.path);
  if (isAbsolute(requested) || /^(?:[a-z]:\/|\/)/iu.test(name)) return pathKey(artifact.absolutePath ?? '') === name;
  return name.includes('/') ? path === name || path.endsWith(`/${name}`) : basename(path) === name;
};

const processLabels = new Map([
  ['命令', 'command'], ['执行命令', 'command'], ['运行命令', 'command'], ['command', 'command'],
  ['工作目录', 'cwd'], ['cwd', 'cwd'], ['退出码', 'exit'], ['exit code', 'exit'], ['exitcode', 'exit'], ['exit', 'exit'], ['exited with code', 'exit'],
  ['标准输出', 'stdout'], ['stdout', 'stdout'], ['输出', 'stdout'],
  ['标准错误', 'stderr'], ['stderr', 'stderr'], ['超时', 'timedOut'], ['timedout', 'timedOut'],
  ['中止', 'aborted'], ['aborted', 'aborted']
]);
const processField = new RegExp(`^(${[...processLabels.keys()].join('|')})(?:\\s*[:：=为是]\\s*|\\s+)(.+)$`, 'iu');

const normalizeReportedCwd = value => /^(?:work|workspace|workspace\s+root|工作区根(?:目录)?)$/iu.test(String(value).trim()) ? '.' : String(value).trim();

const incidentalTestNarrative = text => {
  const compact = text.replace(/[：:,，。；()（）`]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!compact || /失败|错误|未|没有|缺少|不|发布|公网|覆盖|无法|异常/iu.test(compact)) return false;
  if (/^(?:(?:结果|验证|证据|执行|运行|在|于|下|中|和|且|以|本次|本轮|通过|包含|包括)\s*)+$/u.test(compact)) return true;
  if (/^(?:已)?(?:修复|完成|重写|修改|更新)$/u.test(compact)) return true;
  if (/^(?:已修复|修复完成)(?:\s+[^ ]+)?$/iu.test(compact)
    || /^(?:本步|本次|验证|结果)\s*(?:完成|如下)?\s+.*(?:已修改|已修复|修改完成|重写完成|已更新)$/iu.test(compact)
    || /^(?:结果|修改|已修改|已修复)\s+.*(?:修改|修复|完成|重写|更新)$/iu.test(compact)
    || /(?:sha-?256|字节|摘要)/iu.test(compact) && /(?:修复|当前|新摘要|文件|产物)/iu.test(compact)) return true;
  return /(?:执行|修复|任务|文件|脚本|代码|步骤).*(?:完成|成功|重写|修改|更新|修复)/iu.test(compact);
};

const testReportNarrative = text => {
  const compact = text.replace(/[：:,，。；()（）`]/gu, ' ').replace(/\s+/gu, ' ').trim()
    .replace(/(?:超时|timeout)\s*(?:为|=|:)?\s*\d+\s*(?:ms|毫秒|s|秒)/giu, ' ');
  if (!compact) return true;
  if (/(?:不通过|未通过|失败|错误|超时|中止|缺少|无法|异常|发布到公网|用户验收)/iu.test(compact)) return false;
  if (/(?:退出码|exit(?:ed| code)|工作目录|测试命令|\bcwd\b|\b(?:tests?|pass(?:ed)?|fail(?:ed)?|skipped?|todo)\s*(?:[:=]|\s+)|\d+\s*(?:个|项|条)?\s*(?:测试|用例|检查))/iu.test(compact)) return false;
  return true;
};

const observedTestCount = (receipt, field) => {
  const counts = receipt.testCounts;
  if (!counts) return undefined;
  if (field === 'todo' && counts.todo === undefined
    && Number.isInteger(counts.tests) && Number.isInteger(counts.pass) && Number.isInteger(counts.fail)
    && Number.isInteger(counts.skipped) && counts.tests === counts.pass + counts.fail + counts.skipped) return 0;
  return counts[field];
};

function consumeEmbeddedTestFields(part, receipt, check) {
  let remaining = part;
  let consumed = false;
  const consume = (pattern, handler) => {
    remaining = remaining.replace(pattern, (full, ...args) => {
      const value = handler(full, ...args);
      if (value === undefined) return full;
      consumed = true;
      return value;
    });
  };
  consume(/`([^`]+)`/gu, (full, command) => {
    if (!matchesInvocation(receipt, command)) return undefined;
    check('命令匹配', true, true);
    return ' ';
  });
  consume(/`(?:工作目录|cwd)\s*(?:=|:|：)\s*([^`]+)`/giu, (full, value) => {
    check('工作目录', normalizeReportedCwd(value), receipt.cwd === '' ? '.' : receipt.cwd);
    return ' ';
  });
  consume(/(?:工作目录|cwd)\s*(?:=|:|：)\s*`([^`]+)`/giu, (full, value) => {
    check('工作目录', normalizeReportedCwd(value), receipt.cwd === '' ? '.' : receipt.cwd);
    return ' ';
  });
  consume(/(?:工作目录|cwd)\s*(?:=|:|：)\s*([^\s，,。)）]+)/giu, (full, value) => {
    check('工作目录', normalizeReportedCwd(value), receipt.cwd === '' ? '.' : receipt.cwd);
    return ' ';
  });
  consume(/(?:工作目录|cwd)\s*(?:为|是)\s*(?:工作区根目录|工作区根|根目录)/giu, () => {
    check('工作目录', '.', receipt.cwd === '' ? '.' : receipt.cwd);
    return ' ';
  });
  consume(/(?:退出码|exit(?:ed)?(?:\s+with\s+code)?|exit)\s*(?:为|是|=|:|：)?\s*(-?\d+)/giu, (full, value) => {
    check('退出码', Number(value), receipt.exitCode ?? undefined);
    return ' ';
  });
  consume(/\b(tests?|pass(?:ed)?|fail(?:ed)?|skipped?|todo)\s*(?:[:=]\s*|\s+)(\d+)\b/giu, (full, label, value) => {
    const key = label.toLowerCase();
    const labels = { tests: 'tests', test: 'tests', pass: 'pass', passed: 'pass', fail: 'fail', failed: 'fail', skipped: 'skipped', skip: 'skipped', todo: 'todo' };
    const field = labels[key];
    const names = { tests: '测试总数', pass: '通过', fail: '失败', skipped: '跳过', todo: '待办' };
    check(names[field], Number(value), observedTestCount(receipt, field));
    return ' ';
  });
  consume(/\b(\d+)\s+(tests?|passed|failed|skipped|todo)\b/giu, (full, value, label) => {
    const key = label.toLowerCase();
    const labels = { tests: 'tests', test: 'tests', passed: 'pass', failed: 'fail', skipped: 'skipped', todo: 'todo' };
    const field = labels[key];
    const names = { tests: '测试总数', pass: '通过', fail: '失败', skipped: '跳过', todo: '待办' };
    check(names[field], Number(value), observedTestCount(receipt, field));
    return ' ';
  });
  consume(/(?:全部|所有|all|every)\s*(\d+)\s*(?:项|个|条)?\s*(?:测试|检查|用例|tests?)\s*(?:全部\s*)?(通过|失败|跳过|全过|全通过|passed|failed|skipped)/giu,
    (full, value, label) => {
      const key = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped', 全过: 'pass', 全通过: 'pass', passed: 'pass', failed: 'fail', skipped: 'skipped' }[label.toLowerCase()];
      const names = { pass: '通过', fail: '失败', skipped: '跳过' };
      check(names[key], Number(value), observedTestCount(receipt, key));
      check('测试总数', Number(value), observedTestCount(receipt, 'tests'));
      return ' ';
    });
  consume(/(\d+)\s*(?:项|个|条)?\s*(?:测试|检查|用例)\s*(?:全部\s*)?(通过|失败|跳过|全过|全通过)/gu, (full, value, label) => {
    const key = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped', 全过: 'pass', 全通过: 'pass' }[label];
    const names = { pass: '通过', fail: '失败', skipped: '跳过' };
    check(names[key], Number(value), observedTestCount(receipt, key));
    return ' ';
  });
  consume(/(\d+)\s*(?:项|个|条)?\s*(?:(?:测试|检查|用例)\s*)?(通过|失败|跳过|全过|全通过)/gu, (full, value, label) => {
    const key = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped', 全过: 'pass', 全通过: 'pass' }[label];
    const names = { pass: '通过', fail: '失败', skipped: '跳过' };
    check(names[key], Number(value), observedTestCount(receipt, key));
    return ' ';
  });
  consume(/(通过|失败|跳过)\s*(?:为|是|[:：=])?\s*(\d+)/gu, (full, label, value) => {
    const key = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped' }[label];
    const names = { pass: '通过', fail: '失败', skipped: '跳过' };
    check(names[key], Number(value), observedTestCount(receipt, key));
    return ' ';
  });
  return consumed ? { remaining } : undefined;
}

function checkProcessField(part, receipt, check) {
  if (/^(?:无报错|无错误)$/u.test(part)) {
    check('退出码', 0, receipt.exitCode ?? undefined);
    const hasError = receipt.stderrEmpty === undefined
      ? undefined
      : receipt.stderrEmpty === false && receipt.stderrTextDigest === emptyOutputDigest
        ? true
        : typeof receipt.stderrContainsError === 'boolean'
          ? receipt.stderrContainsError
          : receipt.stderrEmpty === true
            ? false
            : undefined;
    check('标准错误无错误', false, hasError);
    check('进程中止', false, receipt.aborted);
    check('进程超时', false, receipt.timedOut);
    if (receipt.signal) check('终止信号', '无', receipt.signal);
    return true;
  }
  if (/^(?:无|未)(?:超时|中止)$/u.test(part)) {
    const timeout = part.endsWith('超时');
    check(timeout ? '进程超时' : '进程中止', false, timeout ? receipt.timedOut : receipt.aborted);
    return true;
  }
  // Reports often place the working-directory phrase immediately before the
  // exit-code clause, for example "在 cwd `.` 下退出码 0".  The command
  // receipt already provides the cwd, so consume this literal phrase before
  // handing the remainder to semantic verification.
  const inlineCwd = /^(?:在\s*)?cwd\s*`([^`]*)`\s*(?:下|中)?\s*[：:]?\s*$/iu.exec(part);
  if (inlineCwd) {
    check('工作目录', normalizeReportedCwd(inlineCwd[1]), receipt.cwd === '' ? '.' : receipt.cwd);
    return true;
  }
  const match = processField.exec(part);
  if (!match) return false;
  const field = processLabels.get(match[1].toLowerCase());
  const raw = match[2].trim();
  const wrapped = /^(?:`([^`]*)`|"([^"]*)"|“([^”]*)”)$/u.exec(raw);
  // A backticked path following 输出 denotes a delivered file in existing summaries.
  if (match[1] === '输出' && raw.startsWith('`')) return false;
  const value = wrapped ? wrapped.slice(1).find(text => text !== undefined) : raw;
  if (field === 'exit' && /^-?\d+$/u.test(value)) check('退出码', Number(value), receipt.exitCode ?? undefined);
  else if (field === 'command' && wrapped) {
    const comparable = (receipt.invocationKey && typeof receipt.cwd === 'string') || (receipt.command && Array.isArray(receipt.args) && !receipt.args.includes('[已隐藏]'));
    check('命令匹配', true, comparable ? matchesInvocation(receipt, value) : undefined);
  } else if (field === 'cwd' && wrapped) check('工作目录', normalizeReportedCwd(value), receipt.cwd === '' ? '.' : receipt.cwd);
  else if (field === 'stderr' && ((!wrapped && value === '空') || (wrapped && value === ''))) check('标准错误为空', true, receipt.stderrEmpty);
  else if ((field === 'stdout' || field === 'stderr') && wrapped) {
    check(field === 'stdout' ? '标准输出摘要' : '标准错误摘要', outputTextDigest(value), field === 'stdout' ? receipt.stdoutTextDigest : receipt.stderrTextDigest);
  } else if ((field === 'timedOut' || field === 'aborted') && /^(?:true|false|是|否)$/iu.test(value)) {
    check(field === 'timedOut' ? '进程超时' : '进程中止', /^(?:true|是)$/iu.test(value), receipt[field]);
  } else return false;
  return true;
}

// A receipt can settle a complete, literal statement. Free-form assertions,
// qualifiers and ambiguous invocations stay with the semantic verifier.
function literalReceiptCheck(claim, evidence, completedSteps, history) {
  if (evidence.length !== 1 || claim.possiblyTruncated) return undefined;
  const receipt = evidence[0];
  const fields = [];
  const citedFiles = new Set();
  let text = normalizedStatement(claim.statement)
    .replace(/^(?:生成|构建|测试|核验|产物|验证)\s*[:：]\s*/u, '')
    .replace(/[.:：]$/u, '');
  const stepLabel = passStepHeader.exec(text);
  if (stepLabel) {
    if (stepLabel[1] !== receipt.stepId || !completedSteps.includes(stepLabel[1])) return undefined;
    text = text.slice(stepLabel[0].length);
  }
  // Keep quoted paths and output intact. Commas inside grouped byte counts are numeric punctuation.
  text = text.replace(/\b\d{1,3}(?:,\d{3})+(?=\s*(?:字节|bytes?))/giu, number => number.replaceAll(',', ''));
  if ((text.match(/`/gu)?.length ?? 0) % 2 || (text.match(/"/gu)?.length ?? 0) % 2
    || (text.match(/“/gu)?.length ?? 0) !== (text.match(/”/gu)?.length ?? 0)) return undefined;
  const parts = (text.match(/(?:`[^`]*`|"[^"\n]*"|“[^”\n]*”|[^,，、()（）`"“])+/gu) ?? []).flatMap(
    part => part.trim().startsWith('`') || part.includes('"') || part.includes('“') ? [part] : part.split(/\s+\/\s+/u)).map(part => part.trim()).filter(Boolean);
  const remaining = [];
  // Bind file properties to a single, explicitly named artifact. A sibling
  // file in the same build can have different bytes or a different digest.
  const files = claimArtifacts(claim, receipt);
  const file = files.length === 1 && (claim.paths.length === 1 || genericPresentation.test(claim.statement)) ? files[0] : undefined;
  const counts = receipt.testCounts;
  const check = (label, claimed, observed) => fields.push({ label, claimed, observed });
  const checkFile = (label, claimed, observed) => {
    if (file) citedFiles.add(file.id);
    check(label, claimed, observed);
  };
  for (const original of parts) {
    let part = original.replace(/^(?:PPTX|ZIP)\s*结构检查(?:显示|结果为)\s*(?=\d)/iu, '');
    if (claim.kind.startsWith('TEST')) {
      if (incidentalTestNarrative(part)) continue;
      const embedded = consumeEmbeddedTestFields(part, receipt, check);
      if (embedded) {
        part = embedded.remaining.trim();
        if (!part || incidentalTestNarrative(part)) continue;
      }
    }
    let match;
    if (checkProcessField(part, receipt, check)) continue;
    if ((match = /^(?:大小\s*)?(\d+)\s*(?:字节|bytes?)$/iu.exec(part))) {
      if (claim.kind.startsWith('TEST')) continue;
      checkFile('字节数', Number(match[1]), file?.sizeBytes);
    } else if ((match = /^(\d+)\s*(?:页(?:幻灯片)?|张幻灯片|slides?)$/iu.exec(part))) {
      checkFile('幻灯片页数', Number(match[1]), file?.pptx?.slideCount);
    } else if ((match = /^(\d+)\s*(?:个\s*)?(?:zip\s*)?(?:条目|entries)$/iu.exec(part))) {
      checkFile('归档条目数', Number(match[1]), file?.pptx?.entryCount);
    } else if ((match = /^(?:(?:文件|内容)?摘要\s*)?sha-?256\s*[:=：]?\s*`?(?:sha256:)?([a-f\d]{64})`?$/iu.exec(part))) {
      if (claim.kind.startsWith('TEST')) continue;
      checkFile('SHA-256', `sha256:${match[1].toLowerCase()}`, file?.sha256);
    } else if ((match = /^(?:(?:全部|所有|all|every)\s*)?(\d+)\s*(?:项|个|条)?\s*(?:测试|检查|用例|tests?)?\s*(全部|均)?\s*(通过|失败|跳过|全过|全通过|passed|failed|skipped)$/iu.exec(part))) {
      const label = match[3].toLowerCase();
      const key = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped', 全过: 'pass', 全通过: 'pass', passed: 'pass', failed: 'fail', skipped: 'skipped' }[label];
      check(label, Number(match[1]), counts?.[key]);
      if (match[2]) check('测试总数', Number(match[1]), counts?.tests);
    } else if ((match = /^(\d+)\s*(?:项|个|条)?\s*(?:测试|检查|用例|tests?)$/iu.exec(part))) {
      check('测试总数', Number(match[1]), counts?.tests);
    } else if ((match = /^(?:(在工作区根目录)\s*)?(?:运行|执行)?\s*`([^`]+)`$/u.exec(part))
      && matchesInvocation(receipt, match[2])) {
      if (match[1]) check('工作目录', '.', receipt.cwd === '' ? '.' : receipt.cwd);
      check('命令', match[2], match[2]);
    } else if (/^lease-[a-f\d-]{8,64}$/iu.test(part)) {
      const actual = receipt.lease;
      check('租约', part, actual && (actual === part || actual.startsWith(part + '-') ? part : actual));
    } else if ((match = /^(?:耗时|duration)\s*[:：]?\s*(\d+)\s*(?:ms|毫秒)$/iu.exec(part))) {
      check('进程耗时（毫秒）', Number(match[1]), receipt.durationMs);
    } else if (part === '一次成功' && receipt.invocationKey && receipt.stepAttempt === 1) {
      check('调用次数', 1, history.filter(r => r.stepId === receipt.stepId && r.invocationKey === receipt.invocationKey).length);
      check('进程结果', 'SUCCEEDED', executionStatus(receipt));
    } else if (genericPresentationClause.test(part)) {
      if (file) citedFiles.add(file.id);
      check('PPTX 生成记录', 'GENERATED', file?.disposition === 'OBSERVED' ? undefined : file?.disposition);
    } else if (/^构建命令成功退出$/u.test(part)) {
      check('进程结果', 'SUCCEEDED', executionStatus(receipt));
    } else if (file) {
      const target = /^(?:(?:产物为|文件为|已输出|输出|已生成|生成|已重新生成|重新生成)\s*)?`?([^`]+?)`?$/u.exec(part);
      if (!target || !matchesPath(file, target[1].trim())) { remaining.push(original); continue; }
      checkFile('产物路径', file.path, file.path);
      if (/^(?:已)?(?:重新)?生成/u.test(part) || /^生成[:：]/u.test(claim.statement)) {
        // Older builders report a fresh observed path without explicitly
        // declaring its disposition. Preserve semantic review of that evidence.
        if (file.disposition === 'OBSERVED' && !/重新生成/u.test(part)) return undefined;
        checkFile('生成方式', 'GENERATED', file.disposition === 'OBSERVED' ? undefined : file.disposition);
      }
    } else remaining.push(part || original);
  }
  if (!fields.length) return undefined;
  const mismatch = fields.find(field => field.observed !== undefined && field.claimed !== field.observed);
  const missing = [...new Set(fields.filter(field => field.observed === undefined).map(field => field.label))];
  const reportRemaining = claim.kind.startsWith('TEST')
    && !mismatch && !missing.length && fields.length
    ? remaining.filter(part => !testReportNarrative(part)) : remaining;
  const refs = [...citation(receipt), ...citedFiles];
  if (mismatch) return { id: claim.id, status: 'FAIL', code: 'BUILD_TEST_CONCLUSION_CONFLICT',
    message: `${mismatch.label}实际记录为 ${mismatch.observed}（${claim.statement}）`, evidence: refs };
  if (missing.length) return { id: claim.id, status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING',
    message: `缺少${missing.join('、')}的执行证据（${claim.statement}）`, evidence: refs };
  return { id: claim.id, status: 'PASS', message: reportRemaining.length ? `已核对${fields.map(f => f.label).join('、')}` : `已通过执行记录核对（${claim.statement}）`, evidence: refs,
    ...(reportRemaining.length ? { remaining: reportRemaining } : {}) };
}

function exactClaimConflict(claim, evidence) {
  if (evidence.length !== 1) return undefined;
  const receipt = evidence[0];
  const exit = /(?:退出码\s*(?:为|是|[:：=])?|\bexit(?:ed)?\s+(?:with\s+)?code\s*[:=]?)\s*(-?\d+)/iu.exec(claim.statement);
  if (exit && Number.isInteger(receipt.exitCode) && Number(exit[1]) !== receipt.exitCode) {
    return { detail: `记录中的退出码为 ${receipt.exitCode}`, receipt };
  }
  if (claim.kind === 'TEST_RESULT' && receipt.testCounts) {
    const labels = { 通过: 'pass', 失败: 'fail', 跳过: 'skipped', 全过: 'pass', 全通过: 'pass', passed: 'pass', failed: 'fail', skipped: 'skipped' };
    for (const match of claim.statement.matchAll(/(\d+)\s*(?:项|个|条)?\s*(?:测试|用例|tests?\b)?\s*(?:全部\s*)?(通过|失败|跳过|全过|全通过|passed\b|failed\b|skipped\b)/giu)) {
      const prefix = claim.statement.slice(Math.max(0, match.index - 12), match.index);
      if (/(?:exit|退出码)[^，,；;（）()]{0,8}$/iu.test(prefix)) continue;
      const [, value, label] = match;
      const actual = receipt.testCounts[labels[label.toLowerCase()]];
      if (Number.isInteger(actual) && Number(value) !== actual) return { detail: `对应测试计数为 ${actual}`, receipt };
    }
  }
  if (claim.kind === 'ARTIFACT' && /新生成|重新生成|\bnewly (?:generated|produced|created)\b/iu.test(claim.statement)
    && receipt.artifacts.every(artifact => artifact.disposition === 'REUSED')) {
    return { detail: '本次构建记录确认复用了已有产物', receipt };
  }
  return undefined;
}

const verifiedDeliveryHeader = /^(?:✅\s*)?(?:目标达成\s*(?:[—–-]+|[:：])\s*)?`([^`]+\.pptx)`\s*已生成并验证\s*[:：]?$/iu;

export function prepareBuildTestVerification(text, receipts, { completedSteps = [], currentStepId, actions = [], verifiedFiles = [], previousGeneratedFiles = [], onClaim } = {}) {
  const commandKind = claim => claim.kind.startsWith('TEST') ? 'TEST' : 'BUILD';
  const receiptKinds = new Set(receipts.map(receipt => receipt.kind));
  // The task-level report checks for missing required commands. Step prose
  // only provides conclusions to compare with recorded invocations.
  const extracted = extractClaims(text).filter(claim => receiptKinds.has(commandKind(claim))
    || verifiedDeliveryHeader.test(normalizedStatement(claim.statement)));
  const checks = [];
  const claims = [];
  if (extracted.length > MAX_CLAIMS) {
    checks.push(missingCheck({ id: 'build-test-claim-limit', statement: `共 ${extracted.length} 条` },
      'BUILD_TEST_CLAIM_LIMIT', '构建和测试结论过多，请缩短单次报告'));
  }
  const chronological = [...receipts].sort((a, b) => a.endedAtMs - b.endedAtMs);
  for (const [index, entry] of extracted.slice(0, MAX_CLAIMS).entries()) {
    const claim = { ...entry, id: `build-test-claim-${index + 1}` };
    onClaim?.(claim);
    const statement = normalizedStatement(claim.statement);
    const verifiedPath = verifiedDeliveryHeader.exec(statement)?.[1];
    if (verifiedPath) {
      const host = verifiedFiles.find(file => pathKey(file.path) === pathKey(verifiedPath) && /^sha256:[a-f\d]{64}$/iu.test(file.digest));
      const generated = host && (receipts.some(r => r.kind === 'BUILD' && r.exitCode === 0 && !r.aborted && !r.timedOut && r.artifacts?.some(
        f => f.disposition === 'GENERATED' && pathKey(f.path) === pathKey(host.path) && f.sha256 === host.digest))
        || previousGeneratedFiles.some(f => pathKey(f.path) === pathKey(host.path) && f.digest === host.digest));
      checks.push(generated ? { id: claim.id, status: 'PASS', message: `已核对生成回执和当前文件（${verifiedPath}）`, evidence: [host.digest] }
        : missingCheck(claim, 'BUILD_TEST_CLAIM_EVIDENCE_MISSING', '缺少同一文件版本的生成与验收记录'));
      continue;
    }
    const header = /^`?([\w.-]+)`?\s*步骤已完成[，,]\s*证据如下\s*[:：]?$/u.exec(statement);
    if (header?.[1] === currentStepId && currentStepId && receipts.some(r => r.stepId === currentStepId && r.exitCode === 0
      && !r.aborted && !r.timedOut && r.artifacts?.some(f => f.disposition === 'GENERATED' && f.pptx?.slideCount && f.sha256))) continue;
    const write = /^生成脚本\s*[:：]\s*`([^`]+)`\s*[（(]\s*file\.write\s*成功[，,]\s*内容摘要\s*(sha256:[a-f\d]{64})\s*[）)]$/iu.exec(statement);
    if (write) {
      const action = actions.findLast(a => a.name === 'file.write' && a.state === 'SUCCEEDED' && a.invocationAttempted !== false
        && a.path && pathKey(a.path) === pathKey(write[1]) && a.contentDigest);
      if (action) {
        const matches = action.contentDigest === write[2];
        checks.push({ id: claim.id, status: matches ? 'PASS' : 'FAIL', message: `已核对脚本写入摘要（${claim.statement}）`,
          ...(!matches ? { code: 'BUILD_TEST_CONCLUSION_CONFLICT' } : {}), evidence: [action.contentDigest] });
        continue;
      }
    }
    const invoked = [...claim.statement.matchAll(/(?:执行|运行|\b(?:ran|run|executed))\s*`([^`]+)`/giu)].map(match => match[1]);
    const stepId = passStepHeader.exec(normalizedStatement(claim.statement))?.[1];
    const acceptedStep = stepId && completedSteps.includes(stepId);
    const scoped = chronological.filter(receipt => receipt.kind === commandKind(claim)
      && (!acceptedStep || receipt.stepId === stepId) && invoked.every(command => matchesInvocation(receipt, command)));
    const namedCommand = /(?:^|[，,(（])\s*(?:执行命令|运行命令|命令|command)\s*[:：=]\s*`([^`]+)`/iu.exec(normalizedStatement(claim.statement))?.[1];
    const selected = namedCommand ? scoped.filter(receipt => matchesInvocation(receipt, namedCommand)) : [];
    const allCandidates = selected.length ? selected : scoped;
    // A current build result refers to the final attempt of each distinct
    // invocation. Claims about previous attempts still need their history.
    const historical = /最初|第一次|首次|先前|之前|此前|历次|历史|每次|从未|从没|所有尝试|第\s*[\d一二三四五六七八九十]+\s*次|\b(?:first|initial(?:ly)?|earlier|previous(?:ly)?|history|every|always|never|all attempts)\b/iu;
    const candidates = !historical.test(claim.statement)
      ? latestCommandReceipts(allCandidates) : allCandidates;
    const observed = candidates.filter(receipt => executionStatus(receipt) !== 'UNKNOWN');
    if (!observed.length) {
      checks.push(missingCheck(claim, 'PROCESS_EXIT_RECORD_MISSING', '缺少命令的退出码或终止状态记录'));
      continue;
    }
    let evidence = observed;
    if (claim.kind === 'TEST_RESULT') {
      evidence = observed.filter(receipt => receipt.testCounts);
      if (!evidence.length) {
        checks.push(missingCheck(claim, 'TEST_RESULT_RECORD_MISSING', '缺少测试框架的结果汇总记录'));
        continue;
      }
    }
    if (claim.kind === 'ARTIFACT') {
      evidence = observed.flatMap(receipt => {
        if (!claim.paths.every(path => receipt.artifacts.some(file => matchesPath(file, path)))) return [];
        const artifacts = claimArtifacts(claim, receipt);
        return artifacts.length ? [{ ...receipt, artifacts }] : [];
      });
      if (!evidence.length) {
        checks.push(missingCheck(claim, 'BUILD_ARTIFACT_RECORD_MISSING', '缺少与本次构建关联的产物记录'));
        continue;
      }
    }
    const literal = literalReceiptCheck(claim, evidence, completedSteps, chronological);
    if (literal) {
      const { remaining, ...check } = literal;
      if (!remaining?.length) { checks.push(check); continue; }
      claim.verifiedFields = check.message;
      claim.remainingFields = remaining;
      // The complete assertion remains open until its remaining qualifiers are reviewed.
    }
    const conflict = exactClaimConflict(claim, evidence);
    if (conflict) {
      checks.push({ id: claim.id, status: 'FAIL', code: 'BUILD_TEST_CONCLUSION_CONFLICT',
        message: `${conflict.detail}（${claim.statement}）`, evidence: citation(conflict.receipt) });
      continue;
    }
    claims.push({ ...claim, evidence: evidence.slice(-8).map(({ artifacts, ...receipt }) => {
      const citedFiles = claimArtifacts(claim, { artifacts });
      return { ...receipt, artifacts: citedFiles.map(({ absolutePath, ...file }) => file) };
    }) });
  }
  return { claims, checks };
}
