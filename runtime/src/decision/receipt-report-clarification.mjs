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
