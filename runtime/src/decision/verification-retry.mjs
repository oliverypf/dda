const TRANSIENT_PROVIDER_FAILURES = new Set(['JEV_TIMEOUT', 'JEV_REQUEST_FAILED', 'JEV_HTTP_500', 'JEV_HTTP_502', 'JEV_HTTP_503', 'JEV_HTTP_504', 'JEV_HTTP_529']);
TRANSIENT_PROVIDER_FAILURES.add('JEV_HTTP_429');

// A host transport/service error is not evidence that implementation needs
// changing. Permanent failures (including 451) stop; transient failures may
// reverify the same execution only when all other checks passed.
export const verificationProviderFailure = ({ behaviorDecision, report } = {}) => {
  const code = behaviorDecision?.reasonCode;
  if (behaviorDecision?.source !== 'rule' || behaviorDecision.fallbackUsed !== true
    || !/^JEV_(?:HTTP_\d+|TIMEOUT|NETWORK|REQUEST_FAILED)$/.test(code ?? '')
    || report?.status !== 'UNCERTAIN'
    || !(report.checks ?? []).some(c => c.id === 'jev-behavior-judge' && c.status === 'UNKNOWN' && c.message === code)) return undefined;
  return code;
};

// Only the host's known transport failure can reuse completed execution.
// Actual semantic refusals, permission failures and missing evidence still
// require the existing failed/uncertain handling; no answer is substituted.
export const canRetryVerificationOnly = ({ ruleStatus, behaviorDecision, report } = {}) => ruleStatus === 'PASS'
  && report?.status === 'UNCERTAIN' && !(report.failureCodes?.length)
  && behaviorDecision?.source === 'rule' && behaviorDecision.fallbackUsed === true
  && TRANSIENT_PROVIDER_FAILURES.has(behaviorDecision.reasonCode)
  && !(report.checks ?? []).some(check => ['FAIL', 'UNKNOWN'].includes(check.status)
    && !(check.id === 'jev-behavior-judge' && check.status === 'UNKNOWN' && check.message === behaviorDecision.reasonCode));
