import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
import { observedExpectedFailure, observedFixtureTestPassed, fixtureTestScope } from '../../desktop/scripts/goal-test-acceptance.mjs';
const root = 'C:/Users/User/hmCodex-local/docs/artifacts';
const originalPath = join(root, 'AGENT_GOAL_TEST_ACCEPTANCE_FLASH_PAIRED_2026-10-08.json');
const original = JSON.parse(await readFile(originalPath, 'utf8'));
const rows = [];
for (const row of original.rows) {
  const checks = { ...row.grade.checks };
  if (row.acceptance === 'code') {
    const task = original.taskSet.find(task => task.taskId === row.taskId);
    let outcomes;
    if (row.condition === 'hmcodex-runtime') outcomes = runtimeNativeOutcomes(
      JSON.parse(await readFile(join(row.evidenceDirectory, 'native-events.json'), 'utf8')),
      JSON.parse(await readFile(join(row.evidenceDirectory, 'model-requests.json'), 'utf8')));
    else outcomes = (await readFile(join(row.evidenceDirectory, 'stdout.jsonl'), 'utf8')).split(/\r?\n/u)
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
      .map(event => ({ name: 'exec_command', ok: event.item.exit_code === 0 && event.item.status === 'completed', exitCode: event.item.exit_code,
        command: event.item.command, output: event.item.aggregated_output }));
    checks.actualSuccessfulTest = outcomes.some(outcome => observedFixtureTestPassed(outcome, fixtureTestScope(task)));
    checks.actualInjectedFailure = observedExpectedFailure(outcomes, task);
  }
  const passed = Object.values(checks).every(Boolean);
  rows.push({ iteration: row.iteration, condition: row.condition, taskId: row.taskId, originalStatus: row.status,
    currentGradingPassed: passed, revisedStatus: passed ? 'SUCCEEDED' : row.status === 'SUCCEEDED' ? 'FAILED' : row.status,
    changedChecks: Object.keys(checks).filter(key => checks[key] !== row.grade.checks[key]), checks });
}
const summarize = condition => { const selected = rows.filter(row => row.condition === condition); return {
  runs: selected.length, originalSuccesses: selected.filter(row => row.originalStatus === 'SUCCEEDED').length,
  regradedSuccesses: selected.filter(row => row.currentGradingPassed).length }; };
const report = { generatedAt: new Date().toISOString(), batchId: original.batchId, originalRuntimeSourceSha256: original.runtimeSource?.sha256 ?? original.rows.find(row => row.runtimeSourceSha256)?.runtimeSourceSha256,
  gradingProtocol: '2.1-NATIVE_COMMAND_DIGEST_AND_FIXTURE_TEST', method: 'Read-only archival regrading of all24 original executions. Command digest and immutable fixture scope are checked; agent failures and timeouts remain authoritative. No source run, model request, raw grade, content-audit or history record is changed.',
  originalReport: originalPath, originalConditions: original.conditions, conditions: { hmcodex: summarize('hmcodex-runtime'), codex: summarize('ordinary-codex') }, rows,
  limitations: ['Not a fresh live comparison for current runtime source.', 'Neither original nor regraded success counts demonstrate an hmCodex advantage; cash and human savings remain unknown.'] };
await writeFile(join(root, 'AGENT_GOAL_TEST_ACCEPTANCE_ARCHIVED_REGRADE_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ conditions: report.conditions, changedRows: rows.filter(row => row.changedChecks.length).map(row => ({ taskId: row.taskId, iteration: row.iteration, condition: row.condition, originalStatus: row.originalStatus, revisedStatus: row.revisedStatus, changedChecks: row.changedChecks })) }));
