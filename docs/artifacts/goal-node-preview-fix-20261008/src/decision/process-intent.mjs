import { parseCommand } from '../runtime-safety-monitor.mjs';

export const normalizedNodeProcessRequest = (request = {}) => {
  try {
    const parsed = parseCommand(request);
    if (!['node', 'node.exe'].includes(parsed.command)) return undefined;
    return { ...request, command: parsed.command, args: parsed.args };
  } catch { return undefined; }
};

const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 96
  && /^[A-Za-z0-9_.\\/ -]+$/u.test(value) && !value.startsWith('-')
  && !value.replaceAll('\\', '/').startsWith('/') && !value.replaceAll('\\', '/').split('/').includes('..');

// Describes only the bounded Node forms whose semantics the host knows.
// This does not authorize a command, classify test execution as read-only,
// or prove execution. Only the restricted executor may attach it to a result.
export const nodeProcessIntent = (request = {}) => {
  request = normalizedNodeProcessRequest(request);
  if (!request) return undefined;
  if (!['node', 'node.exe'].includes(request.command) || request.env !== undefined || request.input !== undefined) return undefined;
  const cwd = request.cwd ?? '.';
  if (!relative(cwd)) return undefined;
  const args = request.args;
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) return undefined;
  let kind, targets, testIsolation;
  if (args.length === 2 && args[0] === '--check' && relative(args[1]) && /\.[cm]?js$/iu.test(args[1])) {
    kind = 'NODE_SYNTAX_CHECK'; targets = [args[1]];
  } else if (args.includes('--test') && args.filter(arg => arg === '--test').length === 1
    && !args.some((arg, index) => arg.startsWith('--') && args.slice(0, index).some(previous => !previous.startsWith('--')))
    && args.every(arg => ['--test', '--test-isolation=none'].includes(arg) || relative(arg) && /\.[cm]?js$/iu.test(arg))) {
    kind = 'NODE_TEST'; targets = args.filter(arg => !arg.startsWith('--'));
    testIsolation = args.includes('--test-isolation=none') ? 'none' : 'default';
  } else return undefined;
  return { kind, workingDirectory: cwd.replaceAll('\\', '/'),
    workingDirectorySource: request.cwd === undefined ? 'DEFAULT_AUTHORIZED_WORKSPACE' : 'EXPLICIT_WORKSPACE_RELATIVE',
    targetCount: targets.length, targets: targets.slice(0, 1),
    ...(kind === 'NODE_TEST' ? { testIsolation, automaticDiscovery: targets.length === 0 } : {}) };
};

export const requestedProcessDecisionClaim = intent => {
  if (!intent) return undefined;
  const facts = { ...intent, actualExecution: 'NOT_YET_EXECUTED', executionPolicy: 'HOST_ONE_SHOT_LEASE_REQUIRED',
    ...(intent.automaticDiscovery ? { discovery: 'Node discovers matching test files recursively under the working directory.' } : {}) };
  const encode = value => JSON.stringify(value).replace(/ {2,}/gu, spaces => '\\u0020'.repeat(spaces.length));
  let claim = encode({ hostRequestedProcess: facts });
  if (claim.length > 500) { delete facts.targets; facts.targetsOmitted = true; claim = encode({ hostRequestedProcess: facts }); }
  return claim.length <= 500 ? claim : undefined;
};
