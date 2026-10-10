// Isolated draft: the active paid cohort's runtime and harness remain frozen.
import { posix } from 'node:path';
import { nodeProcessIntent } from '../../runtime/src/decision/process-intent.mjs';
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export const orderedNodeTestRequest = (input, expectedTestFiles = []) => {
  const intent = nodeProcessIntent(input);
  if (intent?.kind !== 'NODE_TEST') return false;
  let sawTarget = false;
  for (const arg of input.args) {
    if (!arg.startsWith('--')) sawTarget = true;
    else if (sawTarget) return false; // Node options after entry-point are script arguments.
  }
  const targets = input.args.filter(arg => !arg.startsWith('--'))
    .map(path => posix.normalize(posix.join(intent.workingDirectory, path.replaceAll('\\', '/'))));
  if (!expectedTestFiles.length) return true; // Purpose classification only; not task acceptance.
  const expected = expectedTestFiles.map(path => path.replaceAll('\\', '/'));
  return targets.length === 0 ? intent.workingDirectory === '.'
    : expected.every(path => targets.includes(path)) && targets.every(path => expected.includes(path));
};

export const observedFixtureTestPassed = (outcome, { expectedTestFiles, expectedTestNames }) => {
  if (!expectedTestFiles?.length || !expectedTestNames?.length) return false;
  if (!outcome.ok || outcome.name !== 'test.execute' || outcome.value?.ok !== true || outcome.value.exitCode !== 0
    || !orderedNodeTestRequest(outcome.input, expectedTestFiles)) return false;
  const stdout = String(outcome.value.stdout ?? '').replace(/\x1b\[[0-9;]*m/gu, '');
  return expectedTestNames.every(name => new RegExp(`(?:^|\\n)(?:ok \\d+ - |[ \\t]*✔ )${escape(name)}(?:[ \\t]*\\r?\\n| \\()`, 'u').test(stdout));
};
