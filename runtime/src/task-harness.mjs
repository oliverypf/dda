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
export function createTaskProgress() {
  const state = { heartbeats: 0, toolResults: 0, inspectionsSinceWrite: 0, successfulWrites: 0,
    latestActivity: null, runtimeResult: null, verification: null, errors: [] };
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
      }
    },
    snapshot: () => structuredClone(state)
  };
}

export function summarizeTaskEvents(text) {
  const progress = createTaskProgress();
  for (const line of String(text).split(/\r?\n/)) {
    try { progress.observe(JSON.parse(line)); } catch { /* partial/unrelated log line */ }
  }
  return progress.snapshot();
}
