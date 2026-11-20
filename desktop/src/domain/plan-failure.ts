const buildTestReasons: Record<string, string> = {
  BUILD_TEST_CLAIM_EVIDENCE_MISSING: '执行证据不足以核对以下声明。',
  BUILD_TEST_CONCLUSION_CONFLICT: '以下声明与执行记录不一致。',
  BUILD_TEST_VERIFIER_UNAVAILABLE: '验证服务未能完成以下声明的核验。',
  BUILD_TEST_CLAIM_LIMIT: '构建与测试声明超出单次核验上限。',
  BUILD_COMMAND_RECORD_MISSING: '缺少构建命令记录。',
  TEST_COMMAND_RECORD_MISSING: '缺少测试命令记录。',
  PROCESS_EXIT_RECORD_MISSING: '缺少进程退出状态。',
  TEST_RESULT_RECORD_MISSING: '缺少测试结果记录。',
  BUILD_ARTIFACT_RECORD_MISSING: '缺少本次构建的产物记录。'
};

export function buildTestVerificationFailure(payload: Record<string, unknown>) {
  const codes = [...(Array.isArray(payload.failureCodes) ? payload.failureCodes : []), payload.stepErrorCode]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const reason = codes.find(code => Object.hasOwn(buildTestReasons, code));
  if (!reason && payload.nextAction !== 'REVIEW_BUILD_TEST_CONCLUSIONS') return undefined;
  const code = reason ?? codes[0] ?? 'BUILD_TEST_VERIFICATION';
  const headline = reason ? buildTestReasons[reason] : '构建与测试结论待核对。';
  const checks = Array.isArray(payload.checks) ? payload.checks : [];
  const issues = checks.filter(check => typeof check?.id === 'string' && check.id.startsWith('build-test-claim-')
    && ['FAIL', 'UNKNOWN', 'UNCERTAIN'].includes(check.status) && typeof check.message === 'string');
  const items = (payload.buildTest as { items?: unknown } | undefined)?.items;
  const receipts = (Array.isArray(items) ? items : []).filter(item =>
    typeof item?.label === 'string' && typeof item.detail === 'string' && item.status !== 'NOT_REQUESTED');
  const explanations = new Set<string>();
  if (typeof payload.summary === 'string' && payload.summary.trim()) explanations.add(payload.summary);
  for (const issue of issues) explanations.add(issue.message);
  const details = [code];
  for (const check of checks) {
    if (typeof check?.id !== 'string' || typeof check.message !== 'string') continue;
    const refs = Array.isArray(check.evidence) ? check.evidence.filter((ref: unknown) => typeof ref === 'string') : [];
    details.push([check.id, check.message, ...refs].join(' · '));
  }
  return {
    code, text: [headline, ...explanations, ...receipts.map(item => `${item.label} · ${item.detail}`)].join('\n'),
    details
  };
}

export function planFailureMessage(payload: Record<string, unknown>, verdict: string, reasonCode?: string): string {
  if (payload.code !== 'PLAN_STEP_FAILED' || typeof payload.stepId !== 'string' || payload.stepId === 'unknown') return verdict;
  const stepFacts = payload.stepFacts as {
    actionKind?: string;
    blockedTool?: { errorCode?: string; name?: string; command?: string };
    blockedStepIds?: string[];
  } | undefined;
  const blocked = stepFacts?.blockedTool;
  const readOnly = ['READ', 'REPORT'].includes(stepFacts?.actionKind ?? '');
  const lines = [`步骤 ${payload.stepId} ${payload.reportStatus === 'UNCERTAIN' ? '验收结果待确认' : '验收失败'}。`];
  if (blocked?.errorCode === 'TOOL_OUTSIDE_EXECUTION_SCOPE') {
    const name = blocked.command || blocked.name || '工具';
    lines.push(`首次范围拦截：${name} 超出${readOnly ? '只读步骤' : '本步骤'}允许的范围，该调用未执行。`);
  }
  if (!blocked || reasonCode !== 'JEV_CHOICE') lines.push(verdict);
  if (Array.isArray(stepFacts?.blockedStepIds) && stepFacts.blockedStepIds.length) {
    lines.push(`前置步骤失败，以下步骤未运行：${stepFacts.blockedStepIds.join('、')}。`);
  }
  return lines.join('\n');
}
