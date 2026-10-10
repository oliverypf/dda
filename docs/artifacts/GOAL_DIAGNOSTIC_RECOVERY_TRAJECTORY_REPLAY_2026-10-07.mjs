import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
import { nodeProcessIntent } from '../../runtime/src/decision/process-intent.mjs';
import { RuleVerifier } from '../../runtime/src/rule-verifier.mjs';
const root = 'C:/Users/User/hmCodex-local';
const dir = join(root, 'docs/artifacts/agent-goal-runs/20261007T151628814Z-d02bc679/2-code-syntax-001-hmcodex-runtime');
const sha = value => createHash('sha256').update(value).digest('hex');
const requestsSource = await readFile(join(dir, 'model-requests.json'));
const eventsSource = await readFile(join(dir, 'native-events.json'));
const jev = JSON.parse(await readFile(join(dir, 'jev-requests.json'), 'utf8'));
const previous = jev.findLast(request => request.body?.questions?.verification)?.body.state.observation;
const outcomes = runtimeNativeOutcomes(JSON.parse(eventsSource), JSON.parse(requestsSource));
const actions = outcomes.map((outcome, index) => ({ id: `archived-actual-${index + 1}`, name: outcome.name,
  state: outcome.ok ? 'SUCCEEDED' : 'FAILED', outputDigest: outcome.ok ? outcome.outputDigest : undefined,
  argumentsDigest: `sha256:${sha(JSON.stringify(outcome.input))}`,
  errorCode: outcome.name === 'test.execute' && outcome.value?.exitCode === 1 ? 'TEST_CHECK_FAILED' : outcome.errorCode,
  ...(outcome.name === 'test.execute' && outcome.value?.action === 'test' ? { verifiedResult: {
    processIntent: nodeProcessIntent(outcome.input), executionOk: outcome.value.ok === true,
    exitCode: outcome.value.exitCode, outputDigest: outcome.outputDigest
  } } : {}) }));
const sourceRoot = join(root, 'runtime/src');
const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: sha(await readFile(join(sourceRoot, path))) })));
for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: sha(await readFile(join(root, 'runtime', name))) });
const current = new RuleVerifier().verify({ output: 'Offline archived action analysis, not a new completed model task.', workspace: { granted: true }, actions });
const report = { generatedAt: new Date().toISOString(), evidenceClass: 'ARCHIVED_ACTUAL_TOOL_TRAJECTORY_REPLAY_CURRENT_RULE',
  originalBatchId: '20261007T151628814Z-d02bc679', originalTaskStatus: 'FAILED', originalRuleObservation: { status: previous.status, failureCodes: previous.failureCodes },
  sourceRequestSha256: sha(requestsSource), sourceNativeEventsSha256: sha(eventsSource), currentRuntimeSourceSha256: sha(JSON.stringify(files)),
  method: 'Native outputs are digest matched to actual durable events and actual proposed inputs. Node purpose is derived from these archived exact inputs; no provider answer or original run grade is changed.',
  currentRuleReport: current, actualTools: actions, originalGradeChanged: false,
  limitation: 'This is a rule replay only. It does not prove a new live workflow completes or that Jev gate deferrals are eliminated.' };
await writeFile(join(root, 'docs/artifacts/GOAL_DIAGNOSTIC_RECOVERY_TRAJECTORY_REPLAY_2026-10-07.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ oldStatus: previous.status, currentStatus: current.status, nativeCount: outcomes.length,
  recoveredDiagnostic: current.checks.find(check => check.id === 'actions.recovered_diagnostics'), source: report.currentRuntimeSourceSha256 }));
if (current.status !== 'PASS' || previous.status !== 'STALLED') process.exitCode = 1;
