import { nodeProcessIntent, normalizedNodeProcessRequest } from './process-intent.mjs';
import { isRelativeWorkspacePath, READONLY_FAST_PATH_TOOLS } from './readonly-fast-path.mjs';

const workspaceReadTools = new Set([...READONLY_FAST_PATH_TOOLS, 'workspace.inspect_binary', 'kernel.workspace_inspect_binary']);

// These tools return the host-resolved path, relative only for in-workspace targets.
export const observedWorkspaceRead = (name, definition, result) => {
  if (!workspaceReadTools.has(name) || definition?.readOnly !== true || result?.found === false
    || typeof result?.path !== 'string' || !isRelativeWorkspacePath(result.path)) return undefined;
  return { path: result.path, scope: 'IN_WORKSPACE', readOnly: true };
};

const verifiedRead = action => action.state === 'SUCCEEDED' && workspaceReadTools.has(action.name)
  && action.invocationAttempted !== false && action.effectApplied !== true
  && action.verifiedResult?.workspaceRead?.scope === 'IN_WORKSPACE'
  && action.verifiedResult.workspaceRead.readOnly === true && action.outputDigest
  && action.verifiedResult.outputDigest === action.outputDigest;

export const verifiedWorkspaceReadEvidence = (actions, previousActions = []) => {
  if (!actions.length || !actions.every(verifiedRead)) return undefined;
  const priorLimits = [];
  for (const prior of previousActions) {
    if (verifiedRead(prior)) continue;
    if (prior.state !== 'FAILED' || prior.effectApplied === true) return undefined;
    if (prior.invocationAttempted === false && prior.gateDecision === 'BLOCK'
      && prior.errorCode === 'TOOL_OUTSIDE_EXECUTION_SCOPE') {
      priorLimits.push({ tool: prior.name, errorCode: prior.errorCode, invoked: false });
    } else if (prior.name === 'workspace.read' && prior.invocationAttempted !== false
      && prior.errorCode === 'WORKSPACE_BINARY_FILE' && prior.path
      && isRelativeWorkspacePath(prior.path) && prior.errorMessage === prior.path) {
      // workspace.read reports this after resolving the file and trying its
      // text decoder. Require the host-reported resolved path as well as the
      // request path, since FULL_ACCESS can resolve links outside the workspace.
      priorLimits.push({ tool: prior.name, errorCode: prior.errorCode, path: prior.path });
    } else return undefined;
  }
  return {
    completedInvocations: actions.length,
    inWorkspaceInvocations: actions.length,
    readOnlyInvocations: actions.length,
    ...(priorLimits.length ? { attemptScope: 'current read-only attempt', priorLimitCount: priorLimits.length,
      priorLimits: priorLimits.slice(-4) } : {}),
    recentResults: actions.slice(-4).map(({ name, verifiedResult }) => ({
      tool: name,
      path: verifiedResult.workspaceRead.path,
      outputDigest: verifiedResult.outputDigest
    }))
  };
};

// DecisionState limits each claim to 500 characters. Build a valid, bounded
// JSON envelope before that boundary; never cut serialized JSON afterwards.
const LIMIT = 500;
const encode = value => JSON.stringify(value)
  .replace(/ {2,}/gu, spaces => '\\u0020'.repeat(spaces.length))
  .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

const excerpt = (value, budget) => {
  const text = String(value ?? '');
  if (text.length <= budget) return { text, totalChars: text.length, truncated: false };
  const headSize = Math.ceil(budget / 2), tailSize = Math.floor(budget / 2);
  return { head: text.slice(0, headSize), tail: tailSize ? text.slice(-tailSize) : '',
    omittedChars: text.length - headSize - tailSize, totalChars: text.length, truncated: true };
};

const fit = create => {
  for (let budget = 320; budget >= 0; budget -= 8) {
    const claim = encode(create(budget));
    if (claim.length <= LIMIT) return claim;
  }
  // Callers supply only bounded metadata; unexpected future metadata must
  // remain explicitly unavailable, not produce a malformed evidence claim.
  return '{"truncated":true,"error":"EVIDENCE_METADATA_TOO_LARGE"}';
};

export const modelAnswerDecisionClaim = value => {
  const text = String(value ?? '');
  // Literal quoted values often occur in the middle of a long answer. They
  // stay untrusted model data and never grant permissions or prove a tool ran.
  const quotes = [...new Set([...text.matchAll(/`([^`\r\n]{1,80})`/gu)].map(match => match[1]))].slice(-3);
  while (quotes.reduce((n, quote) => n + quote.length, 0) > 120) quotes.shift();
  return fit(budget => ({ untrustedModelAnswer: excerpt(text, budget), ...(quotes.length ? { quotedCode: quotes } : {}) }));
};

export const toolResultDecisionClaim = (name, value) => {
  const facts = { name: String(name ?? 'unknown').slice(0, 64),
    ...(typeof value?.ok === 'boolean' ? { ok: value.ok } : {}),
    ...(Number.isInteger(value?.exitCode) ? { exitCode: value.exitCode } : {}),
    ...(value?.truncated === true ? { sourceTruncated: true } : {}) };
  if (typeof value?.path === 'string' && encode(value.path.slice(0, 96)).length < 160) facts.path = value.path.slice(0, 96);
  const text = typeof value?.content === 'string' ? value.content
    : typeof value?.stdout === 'string' && value.stdout ? value.stdout
      : typeof value?.stderr === 'string' ? value.stderr
        : typeof value?.stdout === 'string' ? value.stdout : JSON.stringify(value ?? null);
  return fit(budget => ({ ...facts, outputData: excerpt(text, budget) }));
};

// Keep actual process failures and successes visible even after many reads or
// deferred proposals. These records come from the host invocation callback;
// proposal refusals and model assertions cannot enter this set.
export const verifiedToolDecisionEvidence = (actions = [], { idPrefix = 'verified-tool-result', limit = 8 } = {}) => {
  const actual = actions.map((action, index) => ({ action, index }))
    .filter(({ action }) => action?.invocationAttempted !== false
      && action?.verifiedResult?.decisionClaim && action.verifiedResult.outputDigest);
  const failedTests = actual.filter(({ action }) => action.name === 'test.execute' && action.state === 'FAILED');
  const successfulTests = actual.filter(({ action }) => action.name === 'test.execute' && action.state === 'SUCCEEDED');
  const writes = actual.filter(({ action }) => ['file.write', 'file.patch'].includes(action.name) && action.state === 'SUCCEEDED');
  const selected = new Map();
  for (const item of [failedTests[0], failedTests.at(-1), successfulTests.at(-1), writes.at(-1), ...actual.toReversed()]) {
    if (item && selected.size < limit) selected.set(item.index, item);
  }
  return [...selected.values()].sort((a, b) => a.index - b.index).map(({ action, index }) => ({
    id: `${idPrefix}-${index + 1}`, type: 'tool_result', claim: action.verifiedResult.decisionClaim,
    source: action.verifiedResult.outputDigest, confidence: 1
  }));
};

const relativePath = value => typeof value === 'string' && value.length <= 96
  && /^[A-Za-z0-9_.\\/ -]*$/u.test(value)
  && !value.replaceAll('\\', '/').startsWith('/')
  && !value.replaceAll('\\', '/').split('/').includes('..');

// Reveal the operation's shape, not raw command text, arbitrary positional
// values or process inline code. Workspace edits have a separate bounded,
// untrusted change preview so semantic review can inspect their intent.
// Neither preview proves approval or execution.
export const proposedToolDecisionClaim = (name, request = {}) => {
  // Use the executor parser for bounded Node forms. This describes only a
  // proposal: private overrides, opaque forms and host authorization remain
  // outside this claim; no lease or execution evidence is created.
  if (['test.execute', 'shell.execute'].includes(name) && nodeProcessIntent(request)) {
    request = normalizedNodeProcessRequest(request);
  }
  const input = {};
  for (const key of ['path', 'cwd']) if (typeof request[key] === 'string') {
    if (relativePath(request[key])) input[key] = request[key];
    else input[`${key}Class`] = 'OUTSIDE_OR_OPAQUE';
  }
  if (typeof request.command === 'string') {
    input.commandName = /^[A-Za-z][A-Za-z0-9_.+-]{0,63}$/u.test(request.command)
      ? request.command : 'OPAQUE_EXECUTABLE';
  }
  const args = Array.isArray(request.args) ? request.args : [];
  const flags = [], targets = [];
  let opaqueArgs = 0, opaqueNextValue = false;
  for (const arg of args) {
    if (opaqueNextValue) { opaqueArgs += 1; opaqueNextValue = false; continue; }
    // Values attached to flags are deliberately not disclosed.
    const flag = typeof arg === 'string' ? arg.split('=', 1)[0] : '';
    if (/^--?[A-Za-z][A-Za-z0-9-]{0,40}$/u.test(flag)) {
      flags.push(flag);
      opaqueNextValue = !arg.includes('=') && !/^(?:--check|--test|--version|--help|-v|-h)$/u.test(flag);
    }
    else if (relativePath(arg) && /\.(?:[cm]?js|jsx|tsx?|py|rs|go|java|cs|rb|sh)$/iu.test(arg)) targets.push(arg);
    else opaqueArgs += 1;
  }
  if (args.length) Object.assign(input, { flags: [...new Set(flags)].slice(0, 4),
    targets: [...new Set(targets)].slice(0, 2), opaqueArgs,
    inlineCode: flags.some(flag => /^(?:-e|--eval|-c|-command|--command)$/iu.test(flag)),
    totalArgs: args.length });
  const envelope = { name: String(name ?? 'unknown').slice(0, 64), untrustedProposedInput: input };
  while (encode(envelope).length > LIMIT && (input.targets?.length || input.flags?.length)) {
    if (input.targets?.length) input.targets.pop(); else input.flags.pop();
    input.previewTruncated = true;
  }
  const change = typeof request.content === 'string' ? { kind: 'WRITE', text: request.content }
    : Array.isArray(request.replacements) ? { kind: 'PATCH', text: request.replacements.map(item =>
      `OLD:\n${String(item?.oldText ?? '')}\nNEW:\n${String(item?.newText ?? '')}`).join('\n') } : undefined;
  return fit(budget => ({ ...envelope, ...(change ? { untrustedProposedChange: { kind: change.kind, data: excerpt(change.text, budget) } } : {}) }));
};

export const hostToolPolicyDecisionClaim = ({ name, registered, available, readOnly, capability, mode, configuredCapabilities = [], configuredCommands = [] }) => {
  const facts = { name: String(name ?? 'unknown').slice(0, 64), registered: registered === true,
    advertised: registered === true && available !== false, readOnly: readOnly === true,
    executionMode: mode ?? 'CONTROLLED',
    executionPolicy: readOnly === true ? 'HOST_WORKSPACE_CHECK_REQUIRED' : 'HOST_ONE_SHOT_LEASE_REQUIRED' };
  if (typeof capability === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(capability)) {
    facts.requiredCapability = capability;
    facts.capabilityConfigured = configuredCapabilities.includes(capability);
  }
  if (['shell.execute', 'test.execute'].includes(name)) {
    facts.configuredCommandNames = configuredCommands.filter(command => /^[A-Za-z][A-Za-z0-9_.+-]{0,31}$/u.test(command)).slice(0, 4);
  }
  return fit(() => ({ hostToolPolicy: facts }));
};

// Host fact for an executable that is not in the session command list.
// Jev chooses ALLOW or REQUIRE_APPROVAL; this claim does not authorize it.
export const sessionCommandLeaseDecisionClaim = ({ commandName } = {}) => {
  const name = typeof commandName === 'string' && /^[A-Za-z0-9_.+-]{1,64}$/u.test(commandName)
    ? commandName.slice(0, 64)
    : 'OPAQUE_EXECUTABLE';
  return fit(() => ({
    sessionCommandLease: {
      commandOutsideSessionLease: true,
      proposedCommandName: name,
      approvalJudgment: 'JEV',
      hostEffect: 'ONE_SHOT_IF_JEV_ALLOWS'
    }
  }));
};
