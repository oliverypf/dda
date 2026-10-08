// Independently bind the answer evidence to a successful native tool result.
// Workspace snapshots or an unrelated successful command cannot satisfy it.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../runtime/src/model-tool-calls.mjs';
import { decodeToolName } from '../../runtime/src/plugins/model-openai.mjs';
import { executedNodeTestPassed, observedFixtureTestPassed, fixtureTestScope } from './goal-test-acceptance.mjs';

const parseLines = text => text.split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
export const runtimeNativeOutcomes = (events, requests) => {
  const outputs = new Map();
  const inputs = new Map();
  for (const call of requests.flatMap(request => [...(Array.isArray(request.output) ? request.output : request.output ? [request.output] : []), ...(Array.isArray(request.body?.input) ? request.body.input : [])])
    .filter(item => item?.type === 'function_call')) {
    try {
      const input = JSON.parse(call.arguments);
      const hash = `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
      inputs.set(`${decodeToolName(call.name)}:${hash}`, input);
    } catch { /* invalid tool arguments cannot supply acceptance evidence */ }
  }
  for (const output of new Set(requests.flatMap(request => (Array.isArray(request.body?.input) ? request.body.input : [])
    .filter(item => item.type === 'function_call_output').map(item => item.output)))) {
    try {
      const value = JSON.parse(output);
      outputs.set(`sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`, { output, value });
    } catch { /* no matching native JSON result */ }
  }
  return events.filter(event => event.kind === 'ToolInvocationCompleted').map(event => {
    const data = event.payload?.payload ?? event.payload;
    const matched = outputs.get(data.outputDigest);
    const input = inputs.get(`${data.name}:${data.inputDigest}`);
    return { ok: data.ok === true && matched?.value?.ok !== false, name: data.name,
      errorCode: data.errorCode ?? (matched?.value?.ok === false ? 'PROCESS_EXIT_FAILURE' : undefined),
      outputDigest: data.outputDigest, output: matched?.output, value: matched?.value, input };
  });
};
export const successfulNativeTest = executedNodeTestPassed;
export const verifiedRuntimeOutputs = (events, requests) => runtimeNativeOutcomes(events, requests)
  .filter(outcome => outcome.ok && outcome.output !== undefined).map(outcome => outcome.output);

export const auditGoalEvidence = async report => {
  const rows = [];
  for (const row of report.rows) {
    const root = row.evidenceDirectory;
    const requests = JSON.parse(await readFile(join(root, 'model-requests.json'), 'utf8'));
    let outputs;
    if ((row.client ?? row.condition) === 'hmcodex-runtime') {
      outputs = verifiedRuntimeOutputs(JSON.parse(await readFile(join(root, 'native-events.json'), 'utf8')), requests);
    } else {
      const events = parseLines(await readFile(join(root, 'stdout.jsonl'), 'utf8'));
      outputs = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution'
        && event.item.exit_code === 0 && event.item.status === 'completed').map(event => event.item.aggregated_output);
    }
    const marker = (await readFile(join(root, 'workspace-final/README.md'), 'utf8')).match(/GOAL_EVIDENCE_[a-z0-9]+/)?.[0];
    const text = outputs.join('\n');
    let passed = row.taskId === 'inspect-layout-001'
      ? ['README.md', 'package.json', 'name.mjs', 'name.test.mjs'].every(name => text.includes(name))
      : Boolean(marker && text.includes(marker));
    if (row.acceptance === 'code') {
      const verification = JSON.parse(await readFile(join(root, 'code-verification.json'), 'utf8'));
      const task = report.taskSet?.find(task => task.taskId === row.taskId);
      const outcomes = (row.client ?? row.condition) === 'hmcodex-runtime'
        ? runtimeNativeOutcomes(JSON.parse(await readFile(join(root, 'native-events.json'), 'utf8')), requests)
        : parseLines(await readFile(join(root, 'stdout.jsonl'), 'utf8')).filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
          .map(event => ({ name: 'exec_command', ok: event.item.exit_code === 0 && event.item.status === 'completed', exitCode: event.item.exit_code,
            command: event.item.command, output: event.item.aggregated_output }));
      const nativeTestPassed = task && outcomes.some(outcome => observedFixtureTestPassed(outcome, fixtureTestScope(task)));
      passed = verification.passed === true && nativeTestPassed;
    }
    rows.push({ iteration: row.iteration, taskId: row.taskId, condition: row.condition,
      verifiedSuccessfulToolResults: outputs.length, expectedContentInActualSuccessfulTool: passed });
  }
  const audit = { schemaVersion: '1.0', batchId: report.batchId, generatedAt: new Date().toISOString(),
    method: 'Native command output for Codex; canonical tool output digest matched against durable events for dda.',
    passed: rows.every(row => row.expectedContentInActualSuccessfulTool), rows };
  await writeFile(join(report.evidenceDirectory, 'content-audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
  return audit;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const audit = await auditGoalEvidence(report);
  console.log(JSON.stringify({ batchId: audit.batchId, passed: audit.passed, cases: audit.rows.length }, null, 2));
  if (!audit.passed) process.exitCode = 1;
}
