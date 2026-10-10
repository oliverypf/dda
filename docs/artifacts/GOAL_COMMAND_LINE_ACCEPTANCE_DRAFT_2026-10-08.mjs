import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseCommand } from '../../runtime/src/runtime-safety-monitor.mjs';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
import { GOAL_TASKS } from '../../desktop/scripts/goal-task-set.mjs';
import * as original from '../../desktop/scripts/goal-test-acceptance.mjs';
const root = 'C:/Users/User/hmCodex-local';
const source = await readFile(`${root}/desktop/scripts/goal-test-acceptance.mjs`, 'utf8');
const runtimeIntentUrl = pathToFileURL(`${root}/runtime/src/decision/process-intent.mjs`).href;
const monitorUrl = pathToFileURL(`${root}/runtime/src/runtime-safety-monitor.mjs`).href;
const draftSource = source.replace("from '../../runtime/src/decision/process-intent.mjs'", `from '${runtimeIntentUrl}'`)
  .replace("const requestOf = outcome => outcome.name === 'test.execute' ? outcome.input : ordinaryNodeRequest(outcome.command);", `
const requestOf = outcome => {
  if (outcome.name !== 'test.execute') return ordinaryNodeRequest(outcome.command);
  try {
    const command = parseCommand(outcome.input);
    const expected = 'sha256:' + createHash('sha256').update(JSON.stringify({ command: command.commandName, args: command.args })).digest('hex');
    if (outcome.value?.action !== 'test' || outcome.value?.commandDigest !== expected) return undefined;
    if ((outcome.value.cwd ?? '.') !== (outcome.input.cwd ?? '.')) return undefined;
    return { ...outcome.input, command: command.command, args: command.args };
  } catch { return undefined; }
};`);
const prefix = `import { createHash } from 'node:crypto';\nimport { parseCommand } from '${monitorUrl}';\n`;
if (draftSource === source || !draftSource.includes('command.commandName')) throw Error('DRAFT_TRANSFORM_FAILED');
const draft = await import(`data:text/javascript;base64,${Buffer.from(prefix + draftSource).toString('base64')}`);
const caseRoot = `${root}/docs/artifacts/agent-goal-runs/20261007T162508744Z-b72917fe/1-code-normalize-001-hmcodex-runtime`;
const readJson = async name => JSON.parse(await readFile(`${caseRoot}/${name}`, 'utf8'));
const task = GOAL_TASKS.find(task => task.taskId === 'code-normalize-001');
const outcomes = runtimeNativeOutcomes(await readJson('native-events.json'), await readJson('model-requests.json'));
const rows = outcomes.filter(item => item.name === 'test.execute').map(item => {
  let command; try { command = parseCommand(item.input); } catch { }
  return { input: item.input, exitCode: item.value?.exitCode, nativeOutputBound: item.output !== undefined,
    normalizedRequest: command, originalPass: original.observedFixtureTestPassed(item, original.fixtureTestScope(task)),
    draftPass: draft.observedFixtureTestPassed(item, draft.fixtureTestScope(task)),
    missingDigestRejected: !draft.observedFixtureTestPassed({ ...item, value: { ...item.value, commandDigest: undefined } }, draft.fixtureTestScope(task)),
    forgedCommandRejected: !draft.observedFixtureTestPassed({ ...item, input: { command: 'node name.mjs --test' } }, draft.fixtureTestScope(task)) };
});
const report = { generatedAt: new Date().toISOString(), method: 'Read-only replay of completed actual native records. Original batch and grading remain unchanged. Draft requires exact normalized host command digest and cwd before accepting command-line input.',
  originalStatus: (await readJson('result.json')).status, rows,
  originalInjectedFailure: original.observedExpectedFailure(outcomes, task), draftInjectedFailure: draft.observedExpectedFailure(outcomes, task),
  actualCodeVerified: (await readJson('code-verification.json')).passed,
  replayOnly: true, productionChanged: false, sourceSha256: createHash('sha256').update(source).digest('hex') };
if (!report.draftInjectedFailure || !rows.some(row => row.draftPass) || !rows.every(row => row.missingDigestRejected && row.forgedCommandRejected)) throw Error('DRAFT_PROOF_OR_NEGATIVE_CHECK_FAILED');
await writeFile('docs/artifacts/GOAL_COMMAND_LINE_ACCEPTANCE_DRAFT_2026-10-08.json', JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
