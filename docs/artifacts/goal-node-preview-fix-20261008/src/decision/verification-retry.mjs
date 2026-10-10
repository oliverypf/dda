const TRANSIENT_PROVIDER_FAILURES = new Set(['JEV_TIMEOUT', 'JEV_REQUEST_FAILED', 'JEV_HTTP_500', 'JEV_HTTP_502', 'JEV_HTTP_503', 'JEV_HTTP_504', 'JEV_HTTP_529']);

// Only the host's known transport failure can reuse completed execution.
// Actual semantic refusals, permission failures and missing evidence still
// require the existing failed/uncertain handling; no answer is substituted.
export const canRetryVerificationOnly = ({ ruleStatus, behaviorDecision, report } = {}) => ruleStatus === 'PASS'
  && report?.status === 'UNCERTAIN' && !(report.failureCodes?.length)
  && behaviorDecision?.source === 'rule' && behaviorDecision.fallbackUsed === true
  && TRANSIENT_PROVIDER_FAILURES.has(behaviorDecision.reasonCode)
  && !(report.checks ?? []).some(check => ['FAIL', 'UNKNOWN'].includes(check.status)
    && !(check.id === 'jev-behavior-judge' && check.status === 'UNKNOWN' && check.message === behaviorDecision.reasonCode));
