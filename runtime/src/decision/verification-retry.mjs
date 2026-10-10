// One shared classifier for host-observation failure codes. Keeping the
// transport, tool and verification classes in one place means the transient
// set below and the Stop-gate predicate can never drift apart, and a permanent
// service status is never mistaken for a retryable transport failure.
const HTTP_STATUS_CLASSES = Object.freeze({
  408: 'TRANSIENT', 425: 'TRANSIENT', 429: 'TRANSIENT', 500: 'TRANSIENT',
  502: 'TRANSIENT', 503: 'TRANSIENT', 504: 'TRANSIENT', 529: 'TRANSIENT',
  400: 'PERMANENT', 401: 'PERMANENT', 403: 'PERMANENT', 404: 'PERMANENT',
  405: 'PERMANENT', 409: 'PERMANENT', 410: 'PERMANENT', 422: 'PERMANENT',
  451: 'PERMANENT'
});
const CLASS_TRANSPORT = 'transport';
const CLASS_TOOL = 'tool';
const CLASS_VERIFICATION = 'verification';

// Classify a host failure code without deciding recovery. Returns
// { code, class, transient } for a recognized code, else undefined. `transient`
// is true only for codes that may be retried; a permanent status such as 451
// reports transient:false so the caller stops instead of looping.
export const classifyHostFailure = (code) => {
  const value = typeof code === 'string' ? code : '';
  const http = /^JEV_HTTP_(\d{3})$/.exec(value);
  if (http) return { code: value, class: CLASS_VERIFICATION, transient: HTTP_STATUS_CLASSES[Number(http[1])] === 'TRANSIENT' };
  if (value === 'JEV_TIMEOUT' || value === 'JEV_NETWORK' || value === 'JEV_REQUEST_FAILED') return { code: value, class: CLASS_TRANSPORT, transient: true };
  const toolHttp = /^(?:TOOL|EXECUTOR)_(\d{3})$/.exec(value);
  if (toolHttp) return { code: value, class: CLASS_TOOL, transient: HTTP_STATUS_CLASSES[Number(toolHttp[1])] === 'TRANSIENT' };
  if (/^(?:TOOL|EXECUTOR)_/.test(value)) return { code: value, class: CLASS_TOOL, transient: /(?:TIMEOUT|REQUEST_FAILED|NETWORK)/.test(value) };
  return undefined;
};

// Derived from the classifier so it can never drift from the transport class.
const TRANSIENT_PROVIDER_FAILURES = new Set([
  'JEV_TIMEOUT', 'JEV_REQUEST_FAILED', 'JEV_NETWORK',
  ...Object.entries(HTTP_STATUS_CLASSES).filter(([, kind]) => kind === 'TRANSIENT').map(([status]) => `JEV_HTTP_${status}`)
]);

// A host transport/service error is not evidence that implementation needs
// changing. Permanent failures (including 451) stop; transient failures may
// reverify the same execution only when all other checks passed.
export const verificationProviderFailure = ({ behaviorDecision, report } = {}) => {
  const code = behaviorDecision?.reasonCode;
  // A recognized transport or verification-service failure justifies a stop; a
  // permanent status such as 451 is still a providerError (the run stops and
  // preserves successful execution evidence) but is never treated as transient
  // by canRetryVerificationOnly below.
  const classified = classifyHostFailure(code);
  if (behaviorDecision?.source !== 'rule' || behaviorDecision.fallbackUsed !== true
    || !classified || classified.class === CLASS_TOOL
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
