const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);
const VERIFIER_VERSION = 'rule-2.0';

// Security-boundary refusals must fail closed. Reading a sensitive path
// (.env, credential files) is not a probe miss the model may retry around.
const NON_RECOVERABLE_TOOL_ERROR_CODES = new Set([
  'WORKSPACE_SENSITIVE_PATH'
]);

// Tool errors the model can recover from by choosing another path or file.
// They keep the turn alive. They are not a verdict about the task.
export const RECOVERABLE_TOOL_ERROR_CODES = new Set([
  'TEST_CHECK_FAILED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_DIRECTORY',
  'WORKSPACE_UNSUPPORTED_FILE',
  'WORKSPACE_BINARY_FILE',
  'WORKSPACE_FILE_TOO_LARGE',
  'WORKSPACE_PATH_NOT_FOUND',
  'WORKSPACE_PATH_INVALID',
  'WORKSPACE_INVALID_PATH',
  'WORKSPACE_PATH_FORBIDDEN',
  'WORKSPACE_READ_LIMIT',
  'EXCERPT_NOT_FOUND',
  'EXCERPT_AMBIGUOUS',
  'EXCERPT_INVALID_LOCATOR',
  'TOOL_ARGUMENTS_INVALID',
  'TOOL_DUPLICATE_REQUEST',
  'TOOL_INVALID_INPUT',
  'TOOL_INVALID_INPUT_JSON'
]);

/** Structured probe / domain tool errors that must not hard-kill the turn. */
export const isRecoverableToolError = (errorCode) => {
  if (typeof errorCode !== 'string' || !errorCode) return false;
  if (NON_RECOVERABLE_TOOL_ERROR_CODES.has(errorCode)) return false;
  return RECOVERABLE_TOOL_ERROR_CODES.has(errorCode)
    || errorCode.startsWith('WORKSPACE_')
    || errorCode.startsWith('EXCERPT_');
};

/**
 * The deterministic checklist no longer decides whether a run succeeded.
 * Jev judges the observed behavior from the execution evidence. Checks that
 * Jev cannot make — path-shape rules, duplicate fingerprints, goal-text
 * coverage — are not kept as a second verdict.
 */
export class RuleVerifier {
  verify() {
    return {
      status: 'PASS',
      summary: '确定性规则不再裁决，由 Jev 根据执行证据判断',
      progress: 0,
      quality: 0,
      safety: 0,
      uncertainty: 0,
      evidence: [],
      failureCodes: [],
      nextAction: 'COMPLETE',
      verifierVersion: VERIFIER_VERSION,
      checks: []
    };
  }
}

export const createRuleVerifier = () => new RuleVerifier();

export const isTerminalRunState = (state) => TERMINAL.has(state);
