import { readFile, readdir, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startGoalLiveGateway } from '../../desktop/scripts/goal-live-gateway.mjs';
import { startGoalLiveJev } from '../../desktop/scripts/goal-live-jev.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
const root = 'C:/Users/User/hmCodex-local';
const runtimeRoot = join(root, 'runtime');
const runRoot = join(root, 'docs/artifacts/goal-actual-checkpoint-upgrade-retest-20261008');
await mkdir(runRoot);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = [];
for (const path of (await readdir(join(runtimeRoot, 'src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort()) sourceFiles.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(runtimeRoot, 'src', path))) });
for (const path of ['package.json', 'package-lock.json']) sourceFiles.push({ path: `../${path}`, sha256: hash(await readFile(join(runtimeRoot, path))) });
const runtimeSourceSha256 = hash(JSON.stringify(sourceFiles));
const upstream = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));
const flash = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-flash' }, JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go-flash.json'), 'utf8')));
const pro = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-pro' }, JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go.json'), 'utf8')));
const jev = await startGoalLiveJev();
const marker = 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_20261008';
const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-actual-checkpoint-upgrade-'));
await writeFile(join(workspace, 'README.md'), `${marker}\n`);
const trajectory = join(runRoot, 'trajectory.jsonl'), threadStore = join(runRoot, 'threads.json'), store = join(runRoot, 'harness.db');
const configPath = join(runRoot, 'config.json');
const binding = gateway => ({ id: gateway.model, provider: 'openai', protocol: 'responses', model: gateway.model, endpoint: gateway.endpoint, apiKeyEnv: 'GOAL_CHECKPOINT_UPGRADE_LOCAL_KEY' });
await writeFile(configPath, JSON.stringify({ schemaVersion: '1.0', provider: 'openai', protocol: 'responses', model: flash.model, endpoint: flash.endpoint, apiKeyEnv: 'GOAL_CHECKPOINT_UPGRADE_LOCAL_KEY',
  models: [binding(flash), binding(pro)], roleBindings: { planner: { selector: 'PINNED', modelId: flash.model }, executor: { selector: 'PINNED', modelId: flash.model }, critic: { selector: 'PINNED', modelId: pro.model } },
  decision: { enabled: true, enforce: true, endpoint: jev.endpoint, apiKeyEnv: 'GOAL_CHECKPOINT_UPGRADE_JEV_KEY', model: 'jev-latest', timeoutMs: 5000, diagnosisEnabled: true, recoveryDirectionEnabled: true } }, null, 2));
const prompt = 'This is a preset read-only recovery test. Success requires a real workspace.read of README.md and reporting its exact evidence marker. In the initial executor attempt, invoke only workspace.read of missing-evidence.txt as the first tool, receive its actual missing-file error, then end the attempt reporting the failure without reading README.md. If the host restores a checkpoint or starts verifier recovery with previously observed failure facts, continue the remaining goal by reading README.md and reporting its marker. Do not treat absent or merely proposed failures as observed. The workspace remains read-only in both attempts.';
const env = { GOAL_CHECKPOINT_UPGRADE_LOCAL_KEY: 'local-fixture-key', GOAL_CHECKPOINT_UPGRADE_JEV_KEY: 'goal-jev-local-key', HMCODEX_DATA_DIR: runRoot,
  HMCODEX_HARNESS_EVENT_STORE: store, HMCODEX_CONTEXT_PROVIDER: 'journal', HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
  HMCODEX_EXECUTION_MODE: 'READ_ONLY', HMCODEX_JEV_ENABLED: '1', HMCODEX_JEV_ENFORCE: '1' };
const parse = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const common = ['src/index.mjs', 'task', '--agent-mode', 'single', '--config', configPath, '--workspace', workspace, '--prompt', prompt,
  '--trajectory-store', trajectory, '--thread-store', threadStore, '--max-tool-rounds', '4'];
const phases = [];
async function runPhase(id, args) {
  const task = { taskId: 'actual-checkpoint-upgrade', phase: id };
  const flashContext = flash.begin(task), proContext = pro.begin(task), decisionContext = jev.begin();
  const result = await runEvidenceProcess(process.execPath, args, { cwd: runtimeRoot, env, timeoutMs: 240000,
    dropEnv: [...flash.privateEnvKeys, ...pro.privateEnvKeys, ...jev.privateEnvKeys] });
  await writeFile(join(runRoot, `${id}-stdout.jsonl`), result.stdout);
  await writeFile(join(runRoot, `${id}-stderr.log`), result.stderr);
  const payload = parse(result.stdout).at(-1);
  const eventResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list', '--trajectory-store', trajectory,
    '--harness-event-store', store, '--run-id', payload?.runId ?? '', '--limit', '500'], { cwd: runtimeRoot, env, timeoutMs: 30000 });
  const events = parse(eventResult.stdout).at(-1)?.events ?? [];
  const requests = [...flashContext.requests, ...proContext.requests];
  const outcomes = runtimeNativeOutcomes(events, requests);
  for (const [name, value] of [['model-requests', requests], ['jev-requests', decisionContext.requests], ['events', events], ['native-outcomes', outcomes]]) await writeFile(join(runRoot, `${id}-${name}.json`), JSON.stringify(value, null, 2));
  const phase = { id, result: { code: result.code, timedOut: result.timedOut, wallMs: result.wallMs }, payload, events, outcomes, requests,
    decisionRequests: decisionContext.requests };
  phases.push(phase);
  console.log(JSON.stringify({ phase: id, code: result.code, ok: payload?.ok, flashRequests: flashContext.requests.length, proRequests: proContext.requests.length, actualMissingRead: outcomes.some(item => !item.ok && item.errorCode === 'WORKSPACE_NOT_FOUND') }));
  return phase;
}
try {
  const first = await runPhase('initial-failed-flash', [...common, '--max-recovery-attempts', '1']);
  const actualFailure = first.outcomes.some(item => !item.ok && item.name === 'workspace.read' && item.errorCode === 'WORKSPACE_NOT_FOUND');
  const threadsResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'threads', 'list', '--thread-store', threadStore,
    '--trajectory-store', trajectory], { cwd: runtimeRoot, env, timeoutMs: 30000 });
  const threads = parse(threadsResult.stdout).at(-1)?.threads ?? [];
  const thread = threads.find(thread => thread.id === first.payload?.threadId) ?? threads.at(-1);
  let second;
  if (first.payload?.ok === false && actualFailure && thread?.id) second = await runPhase('resume-with-bound-pro', [...common,
    '--max-recovery-attempts', '2', '--thread-id', thread.id, '--resume', '--executor-model', pro.model]);
  const checks = { realInitialFlash: first.requests.some(request => request.upstreamModel === flash.model && request.output?.length),
    initialTaskFailed: first.payload?.ok === false && first.result.code !== 0, actualInitialMissingRead: actualFailure,
    resumedSameThread: Boolean(thread?.id) && second?.events.some(event => event.kind === 'ThreadCheckpointCommitted' && (event.payload?.payload ?? event.payload)?.threadId === thread.id),
    checkpointRestored: second?.events.some(event => event.kind === 'TaskRunCreated' && (event.payload?.payload ?? event.payload)?.sourceRunId === first.payload?.runId),
    actualProExecutor: second?.requests.some(request => request.upstreamModel === pro.model && !/Planner role/iu.test(String(request.body.instructions ?? '')) && request.output?.length),
    successfulRead: second?.outcomes.some(outcome => outcome.ok && outcome.name === 'workspace.read' && String(outcome.output).includes(marker)),
    finalSuccess: second?.payload?.ok === true && second?.result.code === 0 && !second?.result.timedOut,
    actualJevUsed: phases.some(phase => phase.decisionRequests.some(request => request.status === 200 && request.response?.answers)) };
  const report = { generatedAt: new Date().toISOString(), method: 'Real Flash task with one recovery attempt to preserve its observed initial failure, then the existing explicit user-model override and checkpoint-resume CLI with real Pro. Same read-only workspace and prompt, real untouched Jev answers. No provider response is fabricated.',
    runtimeRoot, runtimeSourceSha256, currentWorkspaceBuild: true, manualModelUpgrade: true, automaticJevStrongSelectionProven: false,
    passed: Object.values(checks).every(Boolean), checks, phases: phases.map(phase => ({ id: phase.id, result: phase.result, ok: phase.payload?.ok,
      error: phase.payload?.error, runId: phase.payload?.runId, threadId: phase.payload?.threadId, models: phase.requests.map(request => request.upstreamModel).filter(Boolean), jevCalls: phase.decisionRequests.length })),
    limitation: 'One preset checkpoint/explicit-upgrade experiment is a flow test. Initial recovery budget1 versus retry budget2 is intentional fixture stimulation; it does not prove that Pro is needed, better, cheaper or selected automatically by Jev.', actualCost: null, humanSavingsMinutes: null };
  await writeFile(join(root, 'docs/artifacts/GOAL_ACTUAL_CHECKPOINT_UPGRADE_RETEST_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, checks, phases: report.phases }));
  if (!report.passed) process.exitCode = 1;
} finally { await Promise.allSettled([flash.close(), pro.close(), jev.close()]); }
