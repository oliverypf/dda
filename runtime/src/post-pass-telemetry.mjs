/**
 * Post-pass telemetry soft-fail (freeze-harness-idempotency-r2 §1.1).
 *
 * After verification PASS+COMPLETE and durable TaskRunCompleted, selected
 * telemetry writes may warn+skip on idempotency / limited concurrent conflicts
 * instead of flipping the run to failed.
 */

export const POST_PASS_SOFT_FAIL_CODES = Object.freeze([
  'HARNESS_COMMAND_IDEMPOTENCY_CONFLICT',
  'HARNESS_STORE_CONCURRENT_CONFLICT'
]);

export const isPostPassTelemetryError = (error) => {
  const code = error instanceof Error ? error.message : String(error ?? '');
  // Exact codes only — do not soft-fail prefixed / wrapped messages.
  return POST_PASS_SOFT_FAIL_CODES.includes(code);
};

export const isPostPassGateOpen = ({ verification, taskRunCompleted } = {}) =>
  Boolean(
    taskRunCompleted
    && verification
    && verification.status === 'PASS'
    && verification.nextAction === 'COMPLETE'
  );

/**
 * When the post-pass gate is open, soft-fail allowed telemetry errors.
 * When the gate is closed, rethrow everything (including soft-fail codes).
 */
export const softFailPostPassTelemetry = async (gateOpen, label, fn, { warn } = {}) => {
  try {
    return await fn();
  } catch (error) {
    if (gateOpen && isPostPassTelemetryError(error)) {
      const code = error instanceof Error ? error.message : String(error);
      warn?.(`post-pass telemetry soft-fail | label=${label} | code=${code}`);
      return { softFailed: true, code, label };
    }
    throw error;
  }
};
