// Harness-side acceptance command recognition for rule3 verification gate.
// Match is plaintext whitespace-normalized join of shell.execute {command,args[]}
// against subject acceptance lines — never digest/hash compare (freeze rule3-r2).

const normalizeWs = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/** Join command + args[] the way freeze §1.2 requires. */
export function normalizeCommandJoin(command, args = []) {
  const parts = [command, ...(Array.isArray(args) ? args : [])]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return normalizeWs(parts.join(' '));
}

/** Strip a leading `cd <dir> &&` so prompt lines compare to cwd-scoped shell.execute. */
const stripCdPrefix = (text) => normalizeWs(text).replace(/^cd\s+\S+\s+&&\s+/iu, '');

const SHELL_ACCEPTANCE_HINT = /\b(vitest|npx\b|npm\s+(?:test|run)\b|pnpm\s+(?:test|run)\b|yarn\s+test\b|pytest\b|cargo\s+test\b|go\s+test\b|node\s+\S*vitest|mocha\b|jest\b)\b/iu;

export function looksLikeAcceptanceCommand(line) {
  const text = normalizeWs(line);
  if (!text || text.length < 4) return false;
  if (SHELL_ACCEPTANCE_HINT.test(text)) return true;
  if (/^cd\s+\S+\s+&&\s+\S+/iu.test(text)) return true;
  return false;
}

/**
 * Prefer explicit list (run option / env), else acceptanceCriteria that look like
 * shell commands, else prompt lines that embed a bench-style verify command.
 */
export function extractAcceptanceCommands({
  prompt = '',
  acceptanceCriteria = [],
  acceptanceCommands,
  envValue = process.env.DDA_ACCEPTANCE_COMMANDS
} = {}) {
  if (Array.isArray(acceptanceCommands) && acceptanceCommands.length) {
    return [...new Set(acceptanceCommands.map(normalizeWs).filter(Boolean))];
  }
  if (typeof acceptanceCommands === 'string' && acceptanceCommands.trim()) {
    return [...new Set(acceptanceCommands.split(/\r?\n|;/).map(normalizeWs).filter(Boolean))];
  }
  if (typeof envValue === 'string' && envValue.trim()) {
    return [...new Set(envValue.split(/\r?\n|;/).map(normalizeWs).filter(Boolean))];
  }
  const fromCriteria = (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : [])
    .map(normalizeWs)
    .filter(looksLikeAcceptanceCommand);
  const fromPrompt = [];
  for (const raw of String(prompt ?? '').split(/\r?\n/)) {
    let line = normalizeWs(raw);
    if (!line) continue;
    line = line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '');
    line = line.replace(/^(?:then\s+)?run(?:\s+exactly)?:\s*/iu, '');
    line = line.replace(/^`([^`]+)`$/, '$1');
    if (looksLikeAcceptanceCommand(line)) fromPrompt.push(normalizeWs(line));
  }
  return [...new Set([...fromCriteria, ...fromPrompt])];
}

export function commandMatchesAcceptance(commandJoin, acceptanceCommands = []) {
  const joined = normalizeWs(commandJoin);
  if (!joined || !acceptanceCommands?.length) return false;
  for (const acceptance of acceptanceCommands) {
    const full = normalizeWs(acceptance);
    const core = stripCdPrefix(full);
    if (!full && !core) continue;
    if (joined === full || joined === core) return true;
    // Substring either way: prompt may wrap `cd … && <join>` or extra flags.
    if (full.includes(joined) || core.includes(joined) || joined.includes(core)) return true;
  }
  return false;
}

export function shellCommandJoin(action) {
  if (!action || typeof action !== 'object') return '';
  if (typeof action.command === 'string' || Array.isArray(action.args)) {
    return normalizeCommandJoin(action.command, action.args);
  }
  return '';
}

export function isAcceptanceShellAction(action, acceptanceCommands = []) {
  if (action?.name !== 'shell.execute') return false;
  return commandMatchesAcceptance(shellCommandJoin(action), acceptanceCommands);
}

/** Same acceptance intent: equal normalized join, and/or same argumentsDigest. */
export function sameAcceptanceIntent(a, b) {
  if (a?.name !== 'shell.execute' || b?.name !== 'shell.execute') return false;
  const joinA = shellCommandJoin(a);
  const joinB = shellCommandJoin(b);
  if (joinA && joinB && joinA === joinB) return true;
  if (typeof a?.argumentsDigest === 'string' && a.argumentsDigest
    && a.argumentsDigest === b?.argumentsDigest) return true;
  return false;
}

/**
 * Acceptance green for this run: at least one successful acceptance shell.execute
 * (tool.result.ok / state SUCCEEDED) OR optional successful test.execute.
 * 「至少一次」— caller should accumulate across actions; a later red of the same
 * command does not clear a prior green when scanning the full action list.
 */
export function hasAcceptanceGreen(actions = [], acceptanceCommands = []) {
  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    if (action?.name === 'test.execute' && actionSucceededLite(action)) return true;
    if (isAcceptanceShellAction(action, acceptanceCommands) && actionSucceededLite(action)) return true;
  }
  return false;
}

function actionSucceededLite(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.ok === true || action.done === true) return true;
  const state = String(action.state ?? action.status ?? action.result ?? '').toUpperCase();
  return ['PASS', 'PASSED', 'SUCCESS', 'SUCCEEDED', 'OK', 'COMPLETE', 'COMPLETED', 'DONE'].includes(state);
}

function actionFailedLite(action) {
  if (!action || typeof action !== 'object') return false;
  if (action.ok === false || action.failed === true || action.error !== undefined) return true;
  const state = String(action.state ?? action.status ?? action.result ?? '').toUpperCase();
  return ['FAIL', 'FAILED', 'ERROR', 'REJECTED', 'CANCELLED', 'TIMEOUT'].includes(state);
}

/**
 * Process noise (freeze §1.2 / Q-r3-2):
 * - workspace.focus failures ALWAYS (never alone → PLAN_STEP_FAILED; never acceptance)
 * - other non-acceptance shell.execute failures ONLY when acceptance is already green
 */
export function isProcessNoiseFailure(action, { acceptanceGreen = false, acceptanceCommands = [] } = {}) {
  if (!actionFailedLite(action)) return false;
  if (action?.name === 'workspace.focus') return true;
  if (acceptanceGreen && action?.name === 'shell.execute'
    && !isAcceptanceShellAction(action, acceptanceCommands)) return true;
  return false;
}

export function needsVerificationGate(harness = {}, actions = []) {
  const writes = Number(harness.writesApplied ?? 0) > 0;
  const unverified = Number(harness.writesAppliedUnverified ?? 0) > 0;
  const appliedUnverified = (Array.isArray(actions) ? actions : [])
    .some((action) => action?.state === 'APPLIED_UNVERIFIED');
  return writes || unverified || appliedUnverified;
}

/**
 * §1.1: writes / APPLIED_UNVERIFIED without acceptance green → throw (unadorned).
 * Does not replace an already-thrown MODEL_TRANSPORT (caller must not catch-and-rewrite).
 */
export function assertVerificationGate({ harness, actions, acceptanceCommands } = {}) {
  if (!needsVerificationGate(harness, actions)) return;
  if (hasAcceptanceGreen(actions, acceptanceCommands)) return;
  throw new Error('VERIFICATION_REQUIRED');
}
