// Stable CLI exit-code contract (see docs/LINUX_CLI_CONTRACT.md §5).
//
// linux-cli and the HarnessFacade both map a runtime result object to one of
// these codes. Keeping the table here — rather than re-deriving it inside each
// client — is the platform-agnostic half of the architecture split: the exit
// semantics are part of the product contract, not of any one platform shell.
//
// The runtime monolith still owns *when* it fails and which error token it
// throws; this module only translates those tokens into the frozen shell codes.

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  USAGE_ERROR: 2,
  CONFIG_ERROR: 3,
  WORKSPACE_ERROR: 4,
  APPROVAL_DENIED: 5,
  SAFETY_BLOCKED: 6,
  CANCELLED: 7,
  PROTOCOL_ERROR: 8,
  STORAGE_ERROR: 9,
  DEPENDENCY_ERROR: 10,
  SIGINT: 130
});

// Ordered list of [matcher, exitCodeName]. The first matching rule wins, so more
// specific rules must precede broader ones. Matchers run against an uppercased
// error token (e.g. the prefix before ':' in `TASK_PRECHECK_BLOCKED:...`).
const ERROR_TOKEN_RULES = Object.freeze([
  [/^APPROVAL/, 'APPROVAL_DENIED'],
  [/CANCELL?ED$|^TASK_CANCEL|^SIGINT$|^SIGTERM$/, 'CANCELLED'],
  [/^SCOPE_VIOLATION$|^WORKSPACE|_WORKSPACE_|^EVIDENCE_PATH_MISSING$|NOT_FOUND$/, 'WORKSPACE_ERROR'],
  [/BLOCKED$|^SAFETY|^LEASE|^ROLE_BINDING|^POLICY/, 'SAFETY_BLOCKED'],
  [/^PROTOCOL|^UNSUPPORTED_EVENT|^SCHEMA_/, 'PROTOCOL_ERROR'],
  [/DEPENDENC|UNAVAILABLE$/, 'DEPENDENCY_ERROR'],
  [/^STORAGE|^HARNESS_|^READ_MODEL|^RETENTION|^GIT_AUDIT|MIGRAT|^CAPACITY/, 'STORAGE_ERROR'],
  [/^CONFIG|MODEL_CONFIG|PROVIDER|^EXECUTION_MODE_INVALID$|^AGENT_MODE_INVALID$/, 'CONFIG_ERROR'],
  [/_REQUIRED$|_INVALID$|_JSON$|^BOOLEAN_ARGUMENT|^USAGE/, 'USAGE_ERROR'],
  [/^TASK_TIMEOUT$/, 'RUNTIME_ERROR']
]);

// WORKSPACE_ERROR rules must not steal plain *_NOT_FOUND tokens that are really
// usage/storage problems. We special-case the handful of workspace tokens that
// the runtime actually throws so the broad NOT_FOUND rule stays conservative.
const WORKSPACE_NOT_FOUND_TOKENS = new Set([
  'WORKSPACE_NOT_FOUND',
  'THREAD_WORKSPACE_MISMATCH'
]);

const normalizeToken = (value) => {
  if (typeof value !== 'string') return '';
  const head = value.split(':', 1)[0] ?? value;
  return head.trim().toUpperCase();
};

/**
 * Translate an error token/code into one of the frozen exit codes.
 * Unknown tokens fall back to RUNTIME_ERROR so a shell never silently reports
 * success for an unmapped failure.
 */
export const exitCodeForError = (errorToken) => {
  const token = normalizeToken(errorToken);
  if (!token) return EXIT_CODES.RUNTIME_ERROR;
  if (WORKSPACE_NOT_FOUND_TOKENS.has(token)) return EXIT_CODES.WORKSPACE_ERROR;
  for (const [matcher, codeName] of ERROR_TOKEN_RULES) {
    if (matcher.test(token)) return EXIT_CODES[codeName];
  }
  return EXIT_CODES.RUNTIME_ERROR;
};

/**
 * Map a parsed runtime result object (the final JSONL line a runtime command
 * prints) to a stable process exit code.
 *
 * Fail-closed: anything that is not an explicit `{ ok: true }` resolves to a
 * non-zero code. A missing/garbled result is a PROTOCOL_ERROR, never SUCCESS.
 */
export const exitCodeForResult = (result) => {
  if (result === null || typeof result !== 'object') return EXIT_CODES.PROTOCOL_ERROR;
  if (result.ok === true) return EXIT_CODES.SUCCESS;
  const token = result?.error?.code ?? result?.error?.message ?? result?.error ?? result?.harness?.reason;
  return exitCodeForError(token);
};

export const EXIT_CODE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(EXIT_CODES).map(([name, code]) => [code, name]))
);
