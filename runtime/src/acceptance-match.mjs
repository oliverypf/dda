// Harness-side acceptance command recognition for rule3 verification gate.
// Match is plaintext whitespace-normalized join of shell.execute {command,args[]}
// against subject acceptance lines — never digest/hash compare (freeze rule3-r2).
// C1: quote-strip flag values; recognize node --test; hard-ban same-intent
// acceptance re-run after green (ACCEPTANCE_ALREADY_GREEN).

const normalizeWs = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Strip paired quotes used to wrap shell flag values / tokens so
 * `--test-name-pattern='^x'` ≡ `--test-name-pattern=^x`.
 * Applied after whitespace normalize + stripCdPrefix (freeze C1 §1.1).
 */
export function stripShellQuotes(text) {
  let s = normalizeWs(text);
  if (!s) return s;
  // Flag values: --flag='value' / --flag="value"
  s = s.replace(/=(['"])([\s\S]*?)\1/gu, '=$2');
  // Whole-token wrapping quotes (residual)
  s = s.replace(/(^|\s)(['"])([^'"]*)\2(?=\s|$)/gu, '$1$3');
  return normalizeWs(s);
}

/** Join command + args[] the way freeze §1.2 requires. */
export function normalizeCommandJoin(command, args = []) {
  const parts = [command, ...(Array.isArray(args) ? args : [])]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean);
  return normalizeWs(parts.join(' '));
}

/** Strip a leading `cd <dir> &&` so prompt lines compare to cwd-scoped shell.execute. */
const stripCdPrefix = (text) => normalizeWs(text).replace(/^cd\s+\S+\s+&&\s+/iu, '');

/** Canonical form for acceptance compare: ws → strip cd → strip quotes. */
export function canonicalizeAcceptanceText(text) {
  return stripShellQuotes(stripCdPrefix(text));
}

const SHELL_ACCEPTANCE_HINT = /\b(vitest|npx\b|npm\s+(?:test|run)\b|pnpm\s+(?:test|run)\b|yarn\s+test\b|pytest\b|cargo\s+test\b|go\s+test\b|node\s+\S*vitest|mocha\b|jest\b)\b/iu;

/** Stable reject when acceptance already green and same intent re-submitted (C1 §1.3). */
export const ACCEPTANCE_ALREADY_GREEN = 'ACCEPTANCE_ALREADY_GREEN';

/**
 * C2 §1.1: schema precheck for shell.execute before registry/executor.
 * command must be a non-empty string; otherwise do not invoke the handler.
 */
export function precheckShellExecuteInput(input = {}) {
  const command = input?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      ok: false,
      errorCode: 'TOOL_INVALID_INPUT',
      message: 'input.command is required',
      nextAction: 'FIX_ARGS'
    };
  }
  return { ok: true };
}


export function looksLikeAcceptanceCommand(line) {
  const text = normalizeWs(line);
  if (!text || text.length < 4) return false;
  // Must look like an invocable command, not prose that merely mentions tools
  // (e.g. "Lease: … npx …" must not become a fake acceptance under C3 all-green).
  const startsLikeCmd = /^(?:cd\s+\S+\s+&&\s+)?(?:node|npm|npx|pnpm|yarn|vitest|pytest|cargo|go|mocha|jest)\b/iu;
  if (!startsLikeCmd.test(text)) return false;
  if (SHELL_ACCEPTANCE_HINT.test(text)) return true;
  // C1 §1.2: bare `node --test …` (optional name-pattern / path) counts like vitest
  if (/\bnode\b/iu.test(text) && /--test\b/iu.test(text)) return true;
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
    // Bench "Acceptance ONLY (cwd=…): <cmd>" so bare node --test lines extract
    line = line.replace(/^acceptance\s+only\s*(?:\([^)]*\))?\s*:\s*/iu, '');
    line = line.replace(/^`([^`]+)`$/, '$1');
    if (looksLikeAcceptanceCommand(line)) fromPrompt.push(normalizeWs(line));
  }
  return [...new Set([...fromCriteria, ...fromPrompt])];
}

export function commandMatchesAcceptance(commandJoin, acceptanceCommands = []) {
  const joined = canonicalizeAcceptanceText(commandJoin);
  if (!joined || !acceptanceCommands?.length) return false;
  for (const acceptance of acceptanceCommands) {
    const full = canonicalizeAcceptanceText(acceptance);
    // full already had cd stripped inside canonicalize; keep unstripped-core path
    // for substring against prompts that still mention cd in other forms.
    const withCd = stripShellQuotes(normalizeWs(acceptance));
    if (!full && !withCd) continue;
    if (joined === full || joined === withCd) return true;
    // Substring either way: prompt may wrap `cd … && <join>` or extra flags.
    if (withCd.includes(joined) || full.includes(joined) || joined.includes(full)) return true;
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

/** Same acceptance intent: equal quote-stripped join, and/or same argumentsDigest. */
export function sameAcceptanceIntent(a, b) {
  if (a?.name !== 'shell.execute' || b?.name !== 'shell.execute') return false;
  const joinA = canonicalizeAcceptanceText(shellCommandJoin(a));
  const joinB = canonicalizeAcceptanceText(shellCommandJoin(b));
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

/**
 * C3: every extracted acceptance command must have ≥1 successful matching
 * shell.execute (or a successful test.execute whose command/args match that
 * single command). Empty list → false (callers with length<=1 use hasAcceptanceGreen).
 */
export function hasAllAcceptanceCommandsGreen(actions = [], acceptanceCommands = []) {
  const cmds = (Array.isArray(acceptanceCommands) ? acceptanceCommands : [])
    .map(normalizeWs)
    .filter(Boolean);
  if (!cmds.length) return false;
  const list = Array.isArray(actions) ? actions : [];
  return cmds.every((cmd) => list.some((action) => {
    if (!actionSucceededLite(action)) return false;
    if (action?.name === 'shell.execute') {
      return commandMatchesAcceptance(shellCommandJoin(action), [cmd]);
    }
    if (action?.name === 'test.execute') {
      const join = normalizeCommandJoin(action.command, action.args);
      return Boolean(join) && commandMatchesAcceptance(join, [cmd]);
    }
    return false;
  }));
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
 * C1 §1.3 chosen behavior: Action-layer reject with stable
 * ACCEPTANCE_ALREADY_GREEN when acceptance is already green and the proposed
 * shell.execute shares sameAcceptanceIntent with a prior successful acceptance
 * shell. Callers must not execute the tool; verifier treats this code as noise
 * and excludes it from actions.duplicates FAIL (see rule-verifier).
 */
export function shouldBlockAcceptanceRerun(proposed, priorActions = [], acceptanceCommands = []) {
  if (proposed?.name !== 'shell.execute') {
    return { block: false };
  }
  const prior = Array.isArray(priorActions) ? priorActions : [];
  if (!hasAcceptanceGreen(prior, acceptanceCommands)) {
    return { block: false };
  }
  if (!isAcceptanceShellAction(proposed, acceptanceCommands)) {
    return { block: false };
  }
  const matchedPriorGreen = prior.some((action) => (
    isAcceptanceShellAction(action, acceptanceCommands)
    && actionSucceededLite(action)
    && sameAcceptanceIntent(action, proposed)
  ));
  if (!matchedPriorGreen) {
    return { block: false };
  }
  return {
    block: true,
    errorCode: ACCEPTANCE_ALREADY_GREEN,
    message: 'Acceptance already succeeded for this intent; do not re-run the same acceptance command.'
  };
}

/**
 * True when this action is a same-intent acceptance shell that appears after a
 * prior successful acceptance of the same intent (re-run / reject residue).
 */
export function isPostGreenAcceptanceRerun(action, allActions = [], acceptanceCommands = [], index = -1) {
  if (action?.name !== 'shell.execute') return false;
  if (!isAcceptanceShellAction(action, acceptanceCommands)) return false;
  const list = Array.isArray(allActions) ? allActions : [];
  const before = index >= 0 ? list.slice(0, index) : list;
  return before.some((prior) => (
    isAcceptanceShellAction(prior, acceptanceCommands)
    && actionSucceededLite(prior)
    && sameAcceptanceIntent(prior, action)
  ));
}

/**
 * Process noise (freeze §1.2 / Q-r3-2):
 * - workspace.focus failures ALWAYS (never alone → PLAN_STEP_FAILED; never acceptance)
 * - other non-acceptance shell.execute failures ONLY when acceptance is already green
 * - C1: ACCEPTANCE_ALREADY_GREEN rejects are always noise (do not hard-fail progress)
 */
export function isProcessNoiseFailure(action, { acceptanceGreen = false, acceptanceCommands = [] } = {}) {
  if (action?.errorCode === ACCEPTANCE_ALREADY_GREEN) return true;
  // C2 §1.3: after acceptance green, TOOL_INVALID_INPUT(+_JSON) is always noise
  if (acceptanceGreen && (action?.errorCode === 'TOOL_INVALID_INPUT'
    || action?.errorCode === 'TOOL_INVALID_INPUT_JSON')) return true;
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
 * C1 does NOT relax this when writes exist and acceptance never went green.
 *
 * freeze-harness-verification-required-after-pass-r1: when the *final*
 * verification status is PASS, the completion gate must not throw
 * VERIFICATION_REQUIRED (verifier already accepted the run; gate false-negatives
 * such as multi-cmd cd-equivalent extract vs digest-only test.execute must not
 * flip PASS → run.failed).
 */
export function assertVerificationGate({ harness, actions, acceptanceCommands, verification } = {}) {
  // Final PASS wins over acceptance-observation gate.
  if (verification && String(verification.status ?? '').toUpperCase() === 'PASS') return;
  if (!needsVerificationGate(harness, actions)) return;
  const cmds = Array.isArray(acceptanceCommands) ? acceptanceCommands : [];
  // C3: multi-acceptance requires every command green; single/empty keep any-green.
  if (cmds.length >= 2) {
    if (hasAllAcceptanceCommandsGreen(actions, cmds)) return;
    throw new Error('VERIFICATION_REQUIRED');
  }
  if (hasAcceptanceGreen(actions, acceptanceCommands)) return;
  throw new Error('VERIFICATION_REQUIRED');
}
