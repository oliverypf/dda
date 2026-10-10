// Shared by ordinary desktop/CLI tasks and the isolated supervision command.
// These helpers observe execution; none can grant a lease or accept a task.
export const MAX_TASK_PROMPT_CHARS = 8000;
export const MAX_INTERNAL_PROMPT_CHARS = 64 * 1024;
export function validateTaskPrompt(value, maxChars = MAX_TASK_PROMPT_CHARS) {
  const prompt = String(value ?? '').trim();
  if (!prompt) throw new Error('TASK_EMPTY');
  if (prompt.length > maxChars) throw new Error(`TASK_PROMPT_TOO_LONG:${prompt.length}:${maxChars}`);
  return prompt;
}

export function uniqueExcerptOffset(source, findText, offsetChars = 0) {
  if (typeof findText !== 'string' || !findText.length) throw new Error('EXCERPT_INVALID_LOCATOR');
  const offset = source.indexOf(findText, offsetChars);
  if (offset < 0) throw new Error('EXCERPT_NOT_FOUND');
  if (source.indexOf(findText, offset + 1) >= 0) throw new Error('EXCERPT_AMBIGUOUS');
  return offset;
}

const inspections = new Set(['workspace.read', 'workspace.list', 'workspace.focus']);
const writes = new Set(['file.patch', 'file.write']);

// Stable, non-masking diagnosis for the recovery-aware consumers (planner and
// supervisor). These describe what stopped the attempt without rewriting the
// observed counts, and never suggest replaying a possibly side-effecting write.
const RECOVERY_ADVICE = Object.freeze({
  TOOL_LOOP_LIMIT: {
    class: 'TOOL_LOOP_LIMIT',
    action: 'NARROW_SCOPE',
    advice: 'Execution hit the tool-round limit while inspecting or patching. Re-issue one small, scoped change with an explicit locator instead of re-scanning; rely on the excerpts supplied by the harness. Do not re-apply writes already recorded as successful.',
    replayWrites: false
  },
  APPROVAL_EXPIRED: {
    class: 'APPROVAL_EXPIRED',
    action: 'REQUEST_APPROVAL_AGAIN',
    advice: 'A write approval expired or was denied before execution. Re-request approval for the single affected path; do not assume the write landed.',
    replayWrites: false
  },
  WORKSPACE_HANDLER_REPEATED_FAILURE: {
    class: 'WORKSPACE_HANDLER_REPEATED_FAILURE',
    action: 'INSPECT_HANDLER_STATE',
    advice: 'The workspace handler failed repeatedly on the same operation. Inspect the handler/target state before retrying; the failing call did not succeed and its effect is unknown.',
    replayWrites: false
  }
});
export const FAILURE_CLASSES = Object.freeze(Object.keys(RECOVERY_ADVICE));

// A run-stop/failure code maps to exactly one recovery class. Only codes that
// are unambiguous here are classified; anything else stays unclassified so a
// real failure is never masked by a guessed suggestion.
const RUN_FAILURE_CODES = Object.freeze({
  TOOL_LOOP_LIMIT: 'TOOL_LOOP_LIMIT',
  TOOL_ROUND_LIMIT: 'TOOL_LOOP_LIMIT',
  MAX_TOOL_ROUNDS: 'TOOL_LOOP_LIMIT',
  APPROVAL_EXPIRED: 'APPROVAL_EXPIRED',
  APPROVAL_TIMEOUT: 'APPROVAL_EXPIRED',
  APPROVAL_DENIED: 'APPROVAL_EXPIRED'
});

// Consecutive failures on the same inspection tool before we treat the handler
// itself as the problem. Kept small so the signal is stable, not noisy.
const REPEATED_HANDLER_FAILURE_THRESHOLD = 3;

function recoveryAdvice(failureClass) {
  const entry = RECOVERY_ADVICE[failureClass];
  return { failureClass: entry.class, nextAction: entry.action, advice: entry.advice, replayWrites: entry.replayWrites };
}

function classifyRecovery(state) {
  const runtimeError = state.runtimeResult && state.runtimeResult.ok === false
    ? String(state.runtimeResult.error ?? '')
    : '';
  const runtimeClass = RUN_FAILURE_CODES[runtimeError];
  if (runtimeClass) return recoveryAdvice(runtimeClass);

  // Repeated identical workspace-handler failures are recoverable guidance,
  // not a fabricated success: the underlying error count is left intact.
  const tail = state.inspectionFailures ?? [];
  if (tail.length >= REPEATED_HANDLER_FAILURE_THRESHOLD) {
    const last = tail[tail.length - 1];
    const sameName = tail.slice(-REPEATED_HANDLER_FAILURE_THRESHOLD).every(entry => entry.name === last.name);
    if (sameName && inspections.has(last.name)) {
      return { ...recoveryAdvice('WORKSPACE_HANDLER_REPEATED_FAILURE'), toolName: last.name };
    }
  }
  return null;
}

export function createTaskProgress() {
  const state = { heartbeats: 0, toolResults: 0, inspectionsSinceWrite: 0, successfulWrites: 0,
    latestActivity: null, runtimeResult: null, verification: null, errors: [], inspectionFailures: [] };
  return {
    observe(event) {
      if (!event || typeof event !== 'object') return;
      if (!event.kind && typeof event.ok === 'boolean') {
        state.runtimeResult = { ok: event.ok, ...(event.error ? { error: event.error } : {}) };
        return;
      }
      if (event.kind === 'runtime.heartbeat') { state.heartbeats++; return; }
      // Derived status events must never count as additional work.
      if (event.kind?.startsWith('harness.')) return;
      if (event.kind) state.latestActivity = { kind: event.kind, atMs: event.emittedAtMs };
      const p = event.payload ?? {};
      if (event.kind === 'run.failed') state.runtimeResult = { ok: false, error: p.code ?? p.errorCode ?? 'TASK_FAILED' };
      if (event.kind === 'run.completed') state.runtimeResult = { ok: true };
      if (event.kind === 'verification.completed') state.verification = {
        status: p.status,
        providerErrors: (p.checks ?? []).filter(c => c.status === 'UNKNOWN'
          && /^JEV_(?:HTTP_\d+|TIMEOUT|NETWORK|REQUEST_FAILED)$/.test(c.message ?? '')).map(c => c.message),
        ...(p.nextAction ? { nextAction: p.nextAction } : {})
      };
      if (event.kind !== 'tool.result') return;
      state.toolResults++;
      if (p.ok === true && writes.has(p.name)) { state.successfulWrites++; state.inspectionsSinceWrite = 0; }
      else if (p.ok === true && inspections.has(p.name)) state.inspectionsSinceWrite++;
      else if (p.ok === false) {
        state.errors.push({ name: p.name, errorCode: p.errorCode });
        state.errors = state.errors.slice(-32);
        // Track only consecutive failures of the same inspection handler so a
        // transient blip does not masquerade as a repeated handler failure.
        const last = state.inspectionFailures[state.inspectionFailures.length - 1];
        state.inspectionFailures = last && last.name === p.name
          ? [...state.inspectionFailures, { name: p.name, errorCode: p.errorCode }].slice(-REPEATED_HANDLER_FAILURE_THRESHOLD)
          : [{ name: p.name, errorCode: p.errorCode }];
      }
      // A successful tool result breaks any repeated-failure streak.
      if (p.ok === true) state.inspectionFailures = [];
    },
    snapshot: () => {
      const copied = structuredClone(state);
      const recovery = classifyRecovery(copied);
      return recovery ? { ...copied, recovery } : copied;
    }
  };
}

export function summarizeTaskEvents(text) {
  const progress = createTaskProgress();
  for (const line of String(text).split(/\r?\n/)) {
    try { progress.observe(JSON.parse(line)); } catch { /* partial/unrelated log line */ }
  }
  return progress.snapshot();
}
