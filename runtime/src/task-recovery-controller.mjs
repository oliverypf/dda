/**
 * Bounded recovery policy for verifier-driven task execution.
 *
 * The controller is deliberately provider-neutral: it does not inspect model
 * output or grant permissions. The caller supplies execution and verification
 * functions, while every recovery attempt remains visible to the Coordinator.
 */
export const RECOVERABLE_VERIFIER_STATUSES = Object.freeze(new Set([
  'CONTINUE',
  'STALLED',
  'UNCERTAIN'
]));

const MAX_ATTEMPTS = 8;
const clone = (value) => structuredClone(value);
const boundedText = (value, max = 500) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const normalizeStatus = (value) => boundedText(value, 32).toUpperCase();

const safeReport = (report) => ({
  status: normalizeStatus(report?.status),
  summary: boundedText(report?.summary),
  nextAction: boundedText(report?.nextAction, 120),
  failureCodes: Array.isArray(report?.failureCodes)
    ? report.failureCodes.map((code) => boundedText(code, 80)).filter(Boolean).slice(0, 16)
    : [],
  progress: Number.isFinite(Number(report?.progress))
    ? Math.max(0, Math.min(1, Number(report.progress)))
    : undefined
});

const recoveryContext = (report, { attempt, previousActions = [] } = {}) => {
  const actionDigests = previousActions
    .map((action) => action?.argumentsDigest ?? action?.actionDigest ?? action?.fingerprint)
    .filter((value) => typeof value === 'string' && value.trim())
    .slice(-32);
  return {
    attempt,
    verifierStatus: normalizeStatus(report.status),
    summary: boundedText(report.summary),
    nextAction: boundedText(report.nextAction, 120),
    failureCodes: Array.isArray(report.failureCodes)
      ? report.failureCodes.map((code) => boundedText(code, 80)).filter(Boolean).slice(0, 16)
      : [],
    ...(report.progress === undefined ? {} : { progress: report.progress }),
    previousActionDigests: actionDigests
  };
};

/**
 * Execute and verify a bounded sequence of attempts.
 *
 * `execute({ attempt, recovery, previousActions })` returns an arbitrary task
 * result. `verify({ attempt, result, previousActions })` returns a verifier
 * report. A non-PASS report is returned to the caller when it is hard-failed,
 * non-recoverable, or the attempt budget is exhausted.
 */
export const runVerifierRecovery = async ({
  execute,
  verify,
  diagnose,
  onPhase,
  maxAttempts = 3,
  initialContext = undefined,
  startAttempt = 1
} = {}) => {
  if (typeof execute !== 'function' || typeof verify !== 'function') {
    throw new Error('RECOVERY_CALLBACKS_REQUIRED');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new Error('RECOVERY_ATTEMPT_LIMIT_INVALID');
  }
  if (!Number.isInteger(startAttempt) || startAttempt < 1 || startAttempt > maxAttempts) {
    throw new Error('RECOVERY_START_ATTEMPT_INVALID');
  }

  const history = [];
  let previousActions = [];
  let recovery = initialContext === undefined ? undefined : clone(initialContext);

  for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
    await onPhase?.({ phase: 'EXECUTING', attempt, recovery: recovery === undefined ? undefined : clone(recovery) });
    const result = await execute({
      attempt,
      recovery: recovery === undefined ? undefined : clone(recovery),
      previousActions: clone(previousActions)
    });
    const report = safeReport(await verify({
      attempt,
      result,
      previousActions: clone(previousActions)
    }));
    const attemptRecord = {
      attempt,
      status: report.status,
      ...(report.progress === undefined ? {} : { progress: report.progress }),
      failureCodes: [...report.failureCodes]
    };
    history.push(attemptRecord);

    const resultActions = Array.isArray(result?.actions) ? result.actions : [];
    previousActions = [...previousActions, ...resultActions].slice(-256);
    if (report.status === 'PASS') {
      return { ok: true, attempts: attempt, result, report, history };
    }

    const recoverable = RECOVERABLE_VERIFIER_STATUSES.has(report.status);
    if (!recoverable || attempt >= maxAttempts) {
      return {
        ok: false,
        attempts: attempt,
        result,
        report,
        history,
        exhausted: recoverable && attempt >= maxAttempts
      };
    }

    await onPhase?.({ phase: 'DIAGNOSING', attempt, report: clone(report) });
    const diagnosed = typeof diagnose === 'function'
      ? await diagnose({ attempt, report: clone(report), result, previousActions: clone(previousActions) })
      : recoveryContext(report, { attempt, previousActions });
    recovery = clone(diagnosed ?? recoveryContext(report, { attempt, previousActions }));
    await onPhase?.({ phase: 'RECOVERING', attempt, report: clone(report), recovery: clone(recovery) });
  }

  // The loop always returns before this point, but keep a fail-closed guard in
  // case the implementation is changed in the future.
  throw new Error('RECOVERY_LOOP_INVARIANT');
};

export const createRecoveryContext = recoveryContext;
