const VALUE_FLAGS = new Set([
  '--format', '--config', '--data-dir', '--workspace', '--timeout-ms', '--prompt',
  '--execution-mode', '--agent-mode', '--approval-mode', '--model', '--thread-id',
  '--title', '--tool', '--input', '--output', '--from', '--strategy'
]);
const BOOLEAN_FLAGS = new Set(['--help', '--version', '--quiet', '--verbose', '--resume', '--apply']);

const camel = (flag) => flag.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());

export function parseCli(argv) {
  if (!Array.isArray(argv)) throw Object.assign(new Error('ARGUMENT_INVALID'), { code: 'ARGUMENT_INVALID' });
  const options = { events: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    if (name === '--events') {
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (value !== 'stdout') throw Object.assign(new Error('EVENTS_TARGET_INVALID'), { code: 'EVENTS_TARGET_INVALID' });
      options.events = true;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw Object.assign(new Error('ARGUMENT_INVALID'), { code: 'ARGUMENT_INVALID' });
      options[camel(name)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw Object.assign(new Error('UNKNOWN_ARGUMENT'), { code: 'UNKNOWN_ARGUMENT' });
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw Object.assign(new Error('ARGUMENT_INVALID'), { code: 'ARGUMENT_INVALID' });
    if (inline === undefined) index += 1;
    options[camel(name)] = value;
  }
  if (positionals.length > 2) throw Object.assign(new Error('ARGUMENT_INVALID'), { code: 'ARGUMENT_INVALID' });
  if (options.format !== undefined && !['human', 'jsonl'].includes(options.format)) {
    throw Object.assign(new Error('FORMAT_INVALID'), { code: 'FORMAT_INVALID' });
  }
  if (options.executionMode !== undefined && !['READ_ONLY', 'CONTROLLED'].includes(options.executionMode)) {
    throw Object.assign(new Error('EXECUTION_MODE_INVALID'), { code: 'EXECUTION_MODE_INVALID' });
  }
  if (options.approvalMode !== undefined && !['prompt', 'deny', 'jsonl'].includes(options.approvalMode)) {
    throw Object.assign(new Error('APPROVAL_MODE_INVALID'), { code: 'APPROVAL_MODE_INVALID' });
  }
  if (options.agentMode !== undefined && !['single', 'multi'].includes(options.agentMode)) {
    throw Object.assign(new Error('AGENT_MODE_INVALID'), { code: 'AGENT_MODE_INVALID' });
  }
  if (options.timeoutMs !== undefined && !/^[1-9][0-9]*$/u.test(options.timeoutMs)) {
    throw Object.assign(new Error('TIMEOUT_INVALID'), { code: 'TIMEOUT_INVALID' });
  }
  return {
    command: positionals[0],
    subcommand: positionals[1],
    options
  };
}
