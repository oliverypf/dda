import { stampJevEvidenceRequired } from './task-recovery-controller.mjs';

// Verdict policy: report-claim checks and unexplained Jev rejections are
// advisory evidence, not vetoes. Only the deterministic host checks below may
// block a step.
export const SPECIFIC_REJECTION_REASONS = Object.freeze(new Set([
  'RESULT_CONTRADICTS_EVIDENCE',
  'GOAL_CONFLICT',
  'UNSAFE_BEHAVIOR',
  'JEV_WORKSPACE_READ_REJECTED'
]));

const PASS_STATUS = 'PASS';

export const adviseReportClaimChecks = (checks) => (Array.isArray(checks) ? checks : []).map((check) => {
  if (!check || check.status === PASS_STATUS) return check;
  return { ...check, status: 'UNKNOWN', advisory: true, reportedStatus: check.status };
});

export const isAdvisoryCheck = (check) => check?.advisory === true;

export const settleBehaviorDecision = (decision) => {
  if (decision?.source === 'jev' && decision.decision === 'FAIL'
    && !SPECIFIC_REJECTION_REASONS.has(decision.reasonCode)) {
    return { ...decision, decision: 'UNCERTAIN', vetoWithheld: true };
  }
  return decision;
};

export const HOST_EXECUTION_CHECK_ID = 'host.execution';

export const hostExecutionCheck = () => ({
  id: HOST_EXECUTION_CHECK_ID,
  status: PASS_STATUS,
  message: '执行器完成本步骤，主机回执未记录失败'
});

const isJevBehaviorJudgeCheck = (check) => {
  const id = String(check?.id ?? '');
  return id === 'jev-behavior-judge' || id.endsWith('.jev-behavior-judge');
};

const cleanMessage = (check) => String(check?.message ?? '').replace(/[\r\n]+/gu, ' ').slice(0, 300);

export const formatAdvisoryNotes = (checks) => {
  const lines = [];
  const seen = new Set();
  for (const check of Array.isArray(checks) ? checks : []) {
    if (lines.length >= 8) break;
    const advisory = check?.advisory === true;
    const jevJudge = !advisory && isJevBehaviorJudgeCheck(check) && String(check?.status ?? '').toUpperCase() === 'UNKNOWN';
    if (!advisory && !jevJudge) continue;
    const message = cleanMessage(check);
    if (seen.has(message)) continue;
    seen.add(message);
    lines.push(advisory
      ? `- 报告中的表述未能与执行记录对上，以运行时核验为准：${message}`
      : `- 语义校验未能确认本步骤（${message}）`);
  }
  return lines.length ? `**未经核对的内容**\n${lines.join('\n')}` : '';
};

export const settleStepVerification = ({ verification, failedDeliverable, deliveryGap,
  buildTestFailure, buildTestRepairContinuation, buildTestFailureCodes,
  missingExternalEvidence, externalEvidence, workspaceReadVerified,
  semanticStatus, behaviorReason, behaviorDecision, stopForBehaviorConflict,
  providerFailure, behaviorEvidenceRefs }) => {
  if (failedDeliverable) {
    return { ...verification, status: 'FAIL', nextAction: 'REPAIR_DELIVERABLE',
      summary: failedDeliverable.message, failureCodes: ['DELIVERABLE_UNVERIFIED'] };
  }
  if (deliveryGap) {
    return { ...verification, status: 'UNCERTAIN', stopRecovery: true,
      failureCodes: ['INSTALLATION_UNVERIFIED'], nextAction: 'REVIEW_INSTALLATION', summary: deliveryGap };
  }
  if (buildTestFailure) {
    return {
      ...verification,
      status: buildTestRepairContinuation ? 'CONTINUE' : semanticStatus,
      ...(buildTestRepairContinuation
        ? { stopRecovery: false, nextAction: 'CONTINUE_EXECUTION',
          summary: `第一次 ${buildTestFailure.message}。主机将把失败核对项和前次动作摘要交给下一次修复。` }
        : { stopRecovery: true, nextAction: 'REVIEW_BUILD_TEST_CONCLUSIONS', summary: buildTestFailure.message }),
      failureCodes: buildTestFailureCodes
    };
  }
  if (missingExternalEvidence) {
    return {
      ...verification, status: 'UNCERTAIN', stopRecovery: true, nextAction: 'PROVIDE_EXTERNAL_EVIDENCE',
      summary: 'External sources are needed to verify the answer. Available findings were preserved.',
      failureCodes: [...new Set(['EXTERNAL_EVIDENCE_MISSING', ...verification.failureCodes])],
      checks: [...verification.checks, {
        id: 'external-evidence', status: 'UNKNOWN',
        message: ['EXTERNAL_EVIDENCE_MISSING', ...new Set(externalEvidence.map(item => item.claim))].join(' · '),
        evidence: [...new Set([...externalEvidence.map(item => item.id), ...behaviorEvidenceRefs])].slice(0, 8)
      }]
    };
  }
  if (workspaceReadVerified) {
    const summary = 'Jev confirmed that the completed reads used read-only tools inside the authorized workspace';
    return { ...verification, summary, checks: [...verification.checks, {
      id: 'workspace-read-scope', status: 'PASS', message: summary,
      evidence: behaviorEvidenceRefs
    }] };
  }
  if (semanticStatus === 'FAIL') {
    return {
      ...verification, status: 'FAIL',
      nextAction: stopForBehaviorConflict ? 'REVIEW_BEHAVIOR' : 'REQUEST_EVIDENCE',
      ...(stopForBehaviorConflict ? { stopRecovery: true } : {}),
      summary: `Jev rejected the observed behavior: ${behaviorReason}`,
      failureCodes: [...new Set([...verification.failureCodes, 'JEV_BEHAVIOR_REJECTED',
        ...(['RESULT_CONTRADICTS_EVIDENCE', 'GOAL_CONFLICT', 'UNSAFE_BEHAVIOR'].includes(behaviorReason) ? [behaviorReason] : [])])],
      checks: [...verification.checks, { id: 'jev-behavior-judge', status: 'FAIL', message: behaviorReason, evidence: behaviorEvidenceRefs }]
    };
  }
  if (semanticStatus === 'UNCERTAIN' && verification.status === 'PASS') {
    // freeze-harness-uncertain-agent-miss-r1: stamp JEV_EVIDENCE_REQUIRED
    // (no summary-only path) for a genuine evidence-gap verdict. A
    // transient provider failure is not an evidence gap: keep the verdict
    // UNCERTAIN with only the jev-behavior-judge UNKNOWN check so
    // canRetryVerificationOnly re-verifies the same execution instead of
    // arming the reapproval gate and replaying side effects.
    return providerFailure
      ? {
          ...verification,
          status: 'UNCERTAIN',
          ...(behaviorReason === 'JEV_DISABLED_VERIFICATION_FALLBACK' ? { stopRecovery: true,
            failureCodes: [behaviorReason], nextAction: 'CONFIGURE_VERIFIER' } : {}),
          summary: `The semantic verifier is unavailable (${behaviorReason})`,
          checks: [
            ...(verification.checks ?? []),
            { id: 'jev-behavior-judge', status: 'UNKNOWN', message: behaviorReason, evidence: behaviorEvidenceRefs }
          ]
        }
      : stampJevEvidenceRequired({
          ...verification,
          checks: [...(verification.checks ?? []), hostExecutionCheck()]
        }, {
          reasonCode: behaviorDecision.vetoWithheld ? 'JEV_REJECTION_UNEXPLAINED' : behaviorDecision.reasonCode,
          evidenceIds: behaviorEvidenceRefs
        });
  }
  return verification;
};

export const runFailureReport = ({ planFailed, planReport, missingDeliverable, finalDeliverables, installGap, pendingBuildTest }) =>
  planFailed ? (planReport ?? { status: 'FAIL' })
    : missingDeliverable ? { status: 'FAIL', nextAction: 'REPAIR_DELIVERABLE', summary: missingDeliverable.message,
      failureCodes: ['DELIVERABLE_UNVERIFIED'], checks: finalDeliverables }
    : installGap ? { status: 'UNCERTAIN', nextAction: 'REVIEW_INSTALLATION',
      summary: installGap, failureCodes: ['INSTALLATION_UNVERIFIED'] } : {
    status: 'UNCERTAIN', nextAction: 'REVIEW_BUILD_TEST_CONCLUSIONS',
    summary: pendingBuildTest.map(item => `${item.label} ${item.detail}`).join('。'),
    failureCodes: pendingBuildTest.map(item => item.code)
  };
