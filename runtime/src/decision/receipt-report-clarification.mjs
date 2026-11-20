import { createHash } from 'node:crypto';

// A filename in prose may be unquoted. Check token boundaries so that a
// different directory, a longer extension or a command flag cannot match.
function referencesLiteral(text, value, command = false) {
  for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + value.length)) {
    const before = text[start - 1] ?? '';
    const after = text.slice(start + value.length);
    if (/[A-Za-z0-9_./\\:@%~-]/u.test(before) || /^[A-Za-z0-9_./\\:@%~-]/u.test(after)) continue;
    if (command && /^\s+[A-Za-z0-9_./\\:@%~-]/u.test(after)) continue;
    return true;
  }
  return false;
}

// Propose edits to receipt-backed sentences only. The report must still pass
// its ordinary claim checks, rule verification and goal-level review.
export function receiptReportClarification({ text, step, plan, completedSteps, claims, checks, receipts, ruleStatus, declaredCommand }) {
  if (ruleStatus !== 'PASS' || text.length > 12000 || !['BUILD', 'TEST', 'VERIFY', 'REPORT', 'EXECUTE'].includes(step.actionKind)) return;
  const missing = checks.filter(check => check.status !== 'PASS');
  if (!missing.length || missing.some(check => check.status !== 'UNKNOWN' || check.code !== 'BUILD_TEST_CLAIM_EVIDENCE_MISSING')) return;
  const changes = new Map();
  const receiptIds = new Set();
  const planSteps = new Map(plan.steps.map(item => [item.stepId, item]));
  const relevant = new Set([step.stepId]);
  for (const id of relevant) {
    for (const dependency of planSteps.get(id)?.dependencies ?? []) {
      if (completedSteps.includes(dependency)) relevant.add(dependency);
    }
  }
  for (const check of missing) {
    const claim = claims.find(item => item.id === check.id);
    if (!claim || claim.possiblyTruncated || claim.evidence.length !== 1) return;
    const [receipt] = claim.evidence;
    if (!relevant.has(receipt.stepId) || !check.evidence.includes(receipt.id) || !receipt.outputDigest
      || receipt.timedOut || receipt.aborted || receipt.signal || receipt.exitCode !== 0) return;
    if (!receipt.invocationKey || receipts.findLast(item => item.invocationKey === receipt.invocationKey)?.id !== receipt.id) return;
    const task = planSteps.get(receipt.stepId)?.summary ?? '';
    const args = [receipt.command, ...receipt.args];
    if (args.some(arg => /[\s`]/u.test(arg) || arg === '[已隐藏]')) return;
    const command = args.join(' ');
    // Require a literal link between the planned operation, this draft and
    // the observed invocation or artifact. An unrelated successful command
    // elsewhere in the run cannot become a replacement conclusion.
    const quoted = '`' + command + '`';
    const plannedCommand = referencesLiteral(task, command, true) || (declaredCommand?.stepId === receipt.stepId
      && declaredCommand.command === receipt.command && (declaredCommand.cwd || '.') === (receipt.cwd || '.')
      && JSON.stringify(declaredCommand.args) === JSON.stringify(receipt.args));
    let replacement;
    if (receipt.kind === 'TEST') {
      const counts = receipt.testCounts;
      if (!plannedCommand || !referencesLiteral(claim.statement, command, true) || !counts?.tests || counts.pass !== counts.tests || counts.fail !== 0
        || receipt.outputTruncated && receipt.testReportKind !== 'STRUCTURED') return;
      replacement = `测试：执行 ${quoted}，退出码 0，${counts.pass} 项检查全部通过`;
    } else {
      const files = receipt.artifacts.filter(file => file.sha256 && file.sizeBytes > 0
        && ['GENERATED', 'REUSED'].includes(file.disposition)
        && (referencesLiteral(claim.statement, file.path) || referencesLiteral(claim.statement, command, true))
        && (plannedCommand || referencesLiteral(task, file.path)));
      if (files.length !== 1) return;
      const file = files[0];
      replacement = `构建：执行 ${quoted}，退出码 0。产物：\`${file.path}\`，${file.sizeBytes} 字节，SHA-256 ${file.sha256.slice(7)}`;
    }
    // A qualification cannot silently drop a path, quoted command, digest or
    // numeric claim. Such mismatches require the original verification path.
    const concrete = [...claim.paths, ...Array.from(claim.statement.matchAll(/`[^`]+`|[a-f0-9]{64}|\d+(?:\.\d+)?/giu), m => m[0])];
    if (concrete.some(token => !replacement.includes(token)) || text.split(claim.statement).length !== 2) return;
    const previous = changes.get(claim.statement);
    if (previous && previous !== replacement) return;
    changes.set(claim.statement, replacement);
    receiptIds.add(receipt.id);
  }
  let revised = text;
  for (const [original, replacement] of changes) {
    revised = revised.replace(original, () => replacement + '\n原稿中的完整说法尚待核实：“' + original + '”');
  }
  if (revised === text) return;
  return { revised, receiptIds: [...receiptIds], edits: [...changes].map(([original, replacement]) => ({ original, replacement })) };
}


// A process note can mention only the current invocation, its measured fields,
// its script and output. Free-form business, quality and other-file claims stay open.
const processNoteTerms = /标准输出|标准错误|输出|错误|报错|工作区根目录|工作目录|根目录|当前目录|退出码|耗时|运行时间|毫秒|字节|摘要|命令|脚本|文件|阶段|此前|先前|本次|当前|恢复|重新|重写|重放|写入|写到|写|保留|实际|执行|运行|剩余|动作|通过|工作区|前序|构建|生成|已完成|成功|主机|计时|超时|中止|没有|既有|采用|仅|未|无|这|一|并|且|已|了|为|是|的|按|在|与|相同|一致|\b(?:sha-?256|cwd|exit(?:\s+code)?|stdout|stderr|ms|bytes?|duration|file\.write|node)\b/giu;
const requestableFieldGroups = [ /耗时|运行时间|毫秒|duration|elapsed/iu, /stdout|标准输出/iu, /stderr|标准错误/iu,
  /sha-?256|摘要|哈希|digest/iu, /字节|bytes?/iu, /工作目录|cwd/iu, /退出码|exit code/iu,
  /指定命令|必须.{0,12}(?:命令|运行)|exact command/iu, /重写|重跑|重放|保留.{0,6}脚本/iu ];
function incidentalProcessNote(statement, { receipt, file, goal }) {
  if (requestableFieldGroups.some(pattern => pattern.test(goal) && pattern.test(statement))) return false;
  const invocation = [receipt.command, ...(receipt.args ?? [])].join(' ');
  if (invocation && goal.includes(invocation) && statement.includes(invocation)) return false;
  const literals = new Set([file.path, receipt.command, ...(receipt.args ?? []), invocation, receipt.cwd || '.']);
  let unknown = false;
  const prose = statement.replace(/`([^`]+)`|“([^”]*)”|"([^"]*)"/gu, (_, code, cn, en) => {
    const value = code ?? cn ?? en;
    const output = 'sha256:' + createHash('sha256').update(value).digest('hex');
    if (!literals.has(value) && !/^(?:sha256:)?[a-f0-9]{64}$/iu.test(value) && !/^\d+$/u.test(value)
      && output !== receipt.stdoutTextDigest && output !== receipt.stderrTextDigest) unknown = true;
    return ' ';
  });
  return !unknown && !prose.replace(processNoteTerms, '').replace(/[\s\d,，、:：.（）()=*—-]/gu, '');
}

// A correction is scoped to the original uncertain sentences. Its vocabulary
// comes entirely from a successful current-step receipt and a matching host read.
export function documentReportRepair({ text, goal = '', step, isDeliveryStep, requestedBuildTest, verifiedFiles, hostChecks,
  ruleStatus, checks, observedClaims, receipts }) {
  if (ruleStatus !== 'PASS' || isDeliveryStep || !['BUILD', 'EXECUTE'].includes(step.actionKind)
    || Object.values(requestedBuildTest).some(Boolean) || !text || text.length > 12000
    || verifiedFiles.length !== 1 || !hostChecks.length || hostChecks.some(c => c.status !== 'PASS')) return;
  const [file] = verifiedFiles;
  if (!/\.pptx$/iu.test(file.path)) return;
  const missing = checks.filter(c => c.status !== 'PASS');
  if (!missing.length || missing.some(c => c.status !== 'UNKNOWN' || !['BUILD_TEST_CLAIM_EVIDENCE_MISSING', 'BUILD_TEST_VERIFIER_UNAVAILABLE'].includes(c.code))) return;
  const statements = [...new Set(missing.map(check => {
    const claim = observedClaims.find(c => c.id === check.id);
    if (claim && ['BUILD', 'ARTIFACT'].includes(claim.kind) && !claim.possiblyTruncated && text.split(claim.statement).length === 2) return claim.statement;
  }))];
  if (statements.includes(undefined)) return;
  const receipt = receipts.findLast(r => r.kind === 'BUILD' && r.stepId === step.stepId);
  if (!receipt || receipt.exitCode !== 0 || receipt.aborted || receipt.timedOut || receipt.signal || !receipt.outputDigest) return;
  if (statements.some(s => !incidentalProcessNote(s, { receipt, file, goal }))) return;
  const artifact = receipt.artifacts.find(a => a.path === file.path && a.sha256 === file.digest && a.disposition === 'GENERATED');
  if (!artifact?.pptx?.slideCount || !artifact.sizeBytes || !/^sha256:[a-f0-9]{64}$/u.test(file.digest)) return;
  const facts = { artifact: `产物：\`${file.path}\`，${artifact.sizeBytes} 字节，SHA-256 ${file.digest.slice(7)}`,
    slides: `产物：\`${file.path}\`，${artifact.pptx.slideCount} 页` };
  return { facts, statements, receiptIds: [receipt.id], file };
}

export function applyDocumentReportRepair(text, repair, modelText) {
  let selections;
  try { selections = JSON.parse(modelText.trim()); } catch { return; }
  if (!Array.isArray(selections) || selections.length !== repair.statements.length
    || !selections.every(key => typeof key === 'string' && Object.hasOwn(repair.facts, key))) return;
  const edits = repair.statements.map((original, index) => ({ original, replacement: repair.facts[selections[index]] }));
  // All ranges refer to the original text, never to a previous replacement.
  const ranges = edits.map(edit => ({ ...edit, start: text.indexOf(edit.original) })).sort((a, b) => b.start - a.start);
  let end = text.length, revised = text;
  for (const { start, original, replacement } of ranges) {
    if (start < 0 || start + original.length > end) return;
    revised = revised.slice(0, start) + replacement + revised.slice(start + original.length);
    end = start;
  }
  if (revised !== text) return { revised: [revised, ...repair.statements.map(note => `原稿中的完整说法尚待核实：“${note}”`)].join('\n'), edits, receiptIds: repair.receiptIds };
}
