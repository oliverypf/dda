import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCommand } from '../../runtime/src/runtime-safety-monitor.mjs';
import { nodeProcessIntent } from '../../runtime/src/decision/process-intent.mjs';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const nodeCommand = command => typeof command === 'string' && /(?:^|[\\/])node(?:\.exe)?$/iu.test(command);

// Only explicit simple Node invocations can prove execution. Quoted shell
// strings containing "node --test", compound scripts and unknown launchers
// do not grant evidence through a substring match.
export const ordinaryNodeRequest = command => {
  if (typeof command !== 'string') return undefined;
  let body = command.trim();
  const wrapper = body.match(/^(?:"[^"]*(?:powershell|pwsh)\.exe"|[^\s]*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-NoProfile\s+|-NonInteractive\s+)*-(?:Command|c)\s+(['"])([\s\S]*)\1$/iu);
  if (wrapper) body = wrapper[2].trim();
  if (/[;&|><\r\n$`]/u.test(body)) return undefined;
  const tokens = body.match(/"[^"]*"|'[^']*'|[^\s]+/gu)?.map(token => /^['"]/u.test(token) ? token.slice(1, -1) : token);
  if (!tokens?.length || !nodeCommand(tokens[0])) return undefined;
  return { command: tokens[0], args: tokens.slice(1) };
};

const requestOf = outcome => {
  if (outcome.name !== 'test.execute') return ordinaryNodeRequest(outcome.command);
  try {
    const command = parseCommand(outcome.input);
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify({ command: command.commandName, args: command.args })).digest('hex');
    if (outcome.value?.action !== 'test' || outcome.value?.commandDigest !== expected || typeof outcome.value.cwd !== 'string') return undefined;
    if (outcome.value.cwd !== (outcome.input.cwd ?? '.')) return undefined;
    return { ...outcome.input, command: command.command, args: command.args };
  } catch { return undefined; }
};
const processPassed = outcome => outcome.ok === true && (outcome.name === 'test.execute'
  ? outcome.value?.ok === true && outcome.value.exitCode === 0 : outcome.exitCode === 0);

export const executedNodeTestPassed = outcome => {
  const input = requestOf(outcome);
  return processPassed(outcome) && nodeCommand(input?.command)
    && nodeProcessIntent({ ...input, command: 'node' })?.kind === 'NODE_TEST';
};

export const observedFixtureTestPassed = (outcome, { expectedTestFiles, expectedTestNames }) => {
  if (!expectedTestFiles?.length || !expectedTestNames?.length || !executedNodeTestPassed(outcome)) return false;
  const request = requestOf(outcome);
  const intent = nodeProcessIntent({ ...request, command: 'node' });
  const targets = request.args.filter(arg => !arg.startsWith('--')).map(path => posix.normalize(posix.join(intent.workingDirectory, path.replaceAll('\\', '/'))));
  const expected = expectedTestFiles.map(path => path.replaceAll('\\', '/'));
  if (targets.length ? !expected.every(path => targets.includes(path)) || !targets.every(path => expected.includes(path)) : intent.workingDirectory !== '.') return false;
  const stdout = String(outcome.name === 'test.execute' ? outcome.value.stdout ?? '' : outcome.output ?? '').replace(/\x1b\[[0-9;]*m/gu, '');
  return expectedTestNames.every(name => new RegExp(`(?:^|\\n)(?:ok \\d+ - |[ \\t]*✔ )${escape(name)}(?:[ \\t]*\\r?\\n| \\()`, 'u').test(stdout));
};

export const fixtureTestScope = task => ({
  expectedTestFiles: [task.target === 'tags.mjs' ? 'tags.test.mjs' : 'name.test.mjs'],
  expectedTestNames: [...String(task.tests ?? '').matchAll(/\btest\(\s*(['"])([^'"]+)\1\s*,/gu)].map(match => match[2])
});

export const observedExpectedFailure = (outcomes, task) => {
  if (!task.initialCommand?.length) return false;
  const firstWrite = outcomes.findIndex(outcome => ['file.write', 'file.patch'].includes(outcome.name) && outcome.ok);
  return outcomes.some((outcome, index) => {
    if (outcome.name !== 'test.execute' && index !== 0) return false;
    if (firstWrite >= 0 && index > firstWrite) return false;
    const request = requestOf(outcome);
    const exitCode = outcome.name === 'test.execute' ? outcome.value?.exitCode : outcome.exitCode;
    if (outcome.ok || exitCode !== 1 || !nodeCommand(request?.command)) return false;
    if ((request.cwd ?? '.') !== '.') return false;
    const output = String(outcome.name === 'test.execute' ? `${outcome.value?.stdout ?? ''}\n${outcome.value?.stderr ?? ''}` : outcome.output ?? '');
    if (!output.includes(task.target)) return false;
    if (task.initialCommand[0] === '--check') return JSON.stringify(request.args) === JSON.stringify(task.initialCommand);
    return nodeProcessIntent({ ...request, command: 'node' })?.kind === 'NODE_TEST'
      && (request.args.filter(arg => !arg.startsWith('--')).length === 0
        || request.args.filter(arg => !arg.startsWith('--')).every(path => fixtureTestScope(task).expectedTestFiles.includes(path)));
  });
};
