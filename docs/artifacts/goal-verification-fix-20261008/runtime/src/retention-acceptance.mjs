const DAY_MS = 24 * 60 * 60 * 1000;

/** Return PASS only after an actual 30-day window and complete worker evidence. */
export const evaluateThirtyDayRetention = ({ observationStartedAtMs, nowMs = Date.now(), workerProgress, expectedRunCount, failureCount = 0 } = {}) => {
  if (!Number.isFinite(observationStartedAtMs) || observationStartedAtMs < 0) return { status: 'UNKNOWN', reason: 'OBSERVATION_START_MISSING' };
  if (!Number.isFinite(nowMs) || nowMs < observationStartedAtMs) return { status: 'UNKNOWN', reason: 'OBSERVATION_CLOCK_INVALID' };
  const elapsedMs = Math.max(0, nowMs - observationStartedAtMs);
  const completed = Array.isArray(workerProgress?.completed) ? workerProgress.completed.length : 0;
  const failures = Array.isArray(workerProgress?.failed) ? workerProgress.failed.length : 0;
  if (elapsedMs < 30 * DAY_MS) return { status: 'PARTIAL', reason: 'THIRTY_DAY_WINDOW_INCOMPLETE', elapsedMs, requiredMs: 30 * DAY_MS, completed, failures };
  if (!Number.isSafeInteger(expectedRunCount) || expectedRunCount <= 0 || !Number.isSafeInteger(failureCount) || failureCount < 0) {
    return { status: 'UNKNOWN', reason: 'RETENTION_EXPECTATIONS_INVALID', elapsedMs };
  }
  const validIds = (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id.trim().length > 0) && new Set(ids).size === ids.length;
  if (!validIds(workerProgress?.completed) || !validIds(workerProgress?.failed)
    || workerProgress.failed.some((id) => workerProgress.completed.includes(id))) {
    return { status: 'UNKNOWN', reason: 'RETENTION_PROGRESS_INVALID', elapsedMs };
  }
  if (failures > failureCount || completed < expectedRunCount) return { status: 'FAIL', reason: 'RETENTION_PROGRESS_INCOMPLETE', elapsedMs, completed, failures };
  return { status: 'PASS', reason: 'THIRTY_DAY_WINDOW_COMPLETE', elapsedMs, completed, failures };
};
