/**
 * freeze-harness-promote-align-after-tip-path-r1
 *
 * After tip-path / DGR / DGU promote→PASS, the terminal aggregate
 * verification.completed (and harness.progress.verification) must remain PASS.
 * Historical pre-promote attempts stay in planExecution.results for audit, but
 * must not poison the aggregate into FAIL promoted:true as last_ver.
 */

export const DEFAULT_PROMOTE_VERIFICATION_CHECK_IDS = Object.freeze(new Set([
  'deterministic-green-jev-uncertain-promote',
  'deterministic-green-jev-uncertain-tip-path',
  'deterministic-green-jev-behavior-reject-promote'
]));

/** Last entry per stepId is the authoritative post-promote report. */
export function selectAuthoritativePlanStepEntries(entries) {
  const lastByStep = new Map();
  for (const entry of entries ?? []) {
    if (!entry) continue;
    const stepId = String(entry.result?.stepId ?? entry.stepId ?? 'step');
    lastByStep.set(stepId, entry);
  }
  return [...lastByStep.values()];
}

const reportOf = (entry) => entry?.report ?? entry?.result?.verification ?? null;

const checksOf = (entry) => {
  const report = reportOf(entry);
  return Array.isArray(report?.checks)
    ? report.checks
    : (Array.isArray(entry?.result?.verification?.checks) ? entry.result.verification.checks : []);
};

/**
 * Build the multi-step aggregate verification used as the terminal
 * verification.completed payload after planCoordinator.run succeeds.
 */
export function buildAggregatePlanVerification(entries, options = {}) {
  const promoteCheckIds = options.promoteCheckIds ?? DEFAULT_PROMOTE_VERIFICATION_CHECK_IDS;
  const authoritativeEntries = selectAuthoritativePlanStepEntries(entries);
  const stepReports = authoritativeEntries.map((entry) => reportOf(entry)).filter(Boolean);
  const allPass = stepReports.length > 0 && stepReports.every((report) => report.status === 'PASS');
  const hasPromotedVerification = authoritativeEntries.some((entry) =>
    checksOf(entry).some((check) => promoteCheckIds.has(check?.id))
  );

  // Contract: promote→PASS must not be followed by FAIL promoted:true last_ver.
  // Authoritative last-per-step already drops pre-promote UNCERTAIN/FAIL attempts.
  // If every authoritative report is PASS (including after promote), force PASS.
  let status = allPass ? 'PASS' : 'FAIL';
  if (hasPromotedVerification && stepReports.every((report) => report.status === 'PASS')) {
    status = 'PASS';
  }

  const checks = authoritativeEntries.flatMap((entry) => {
    const raw = entry.report?.checks ?? entry.result?.verification?.checks ?? [];
    const stepId = entry.result?.stepId ?? entry.stepId ?? 'step';
    return raw.map((check) => ({
      ...check,
      id: `${stepId}.${check.id}`
    }));
  });

  return {
    status,
    summary: `Verified ${stepReports.length} plan step(s)`,
    progress: stepReports.length
      ? stepReports.reduce((sum, report) => sum + Number(report.progress ?? 0), 0) / stepReports.length
      : 0,
    quality: stepReports.length
      ? Math.min(...stepReports.map((report) => Number(report.quality ?? 0)))
      : 0,
    safety: stepReports.length
      ? Math.min(...stepReports.map((report) => Number(report.safety ?? 0)))
      : 0,
    uncertainty: stepReports.length
      ? Math.max(...stepReports.map((report) => Number(report.uncertainty ?? 0)))
      : 0,
    evidence: [...new Set(stepReports.flatMap((report) => report.evidence ?? []))].slice(0, 64),
    failureCodes: [...new Set(stepReports.flatMap((report) => report.failureCodes ?? []))].slice(0, 32),
    nextAction: status === 'PASS' ? 'COMPLETE' : 'STOP_AND_REPORT',
    verifierVersion: [...new Set(stepReports.map((report) => report.verifierVersion).filter(Boolean))].join(',') || undefined,
    checks,
    hasPromotedVerification,
    authoritativeEntries,
    stepReports
  };
}
