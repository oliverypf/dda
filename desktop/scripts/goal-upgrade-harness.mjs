import { readFile, readdir, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUpgradeModels, automaticStrongSelectionProven } from './goal-upgrade-models.mjs';
import { createHash } from 'node:crypto';
import { startGoalLiveGateway } from './goal-live-gateway.mjs';
import { startGoalLiveJev } from './goal-live-jev.mjs';
import { runEvidenceProcess } from './goal-evidence-process.mjs';
import { runtimeNativeOutcomes } from './goal-evidence-audit.mjs';
export const runGoalUpgradeHarness = async ({ argv = process.argv.slice(2) } = {}) => {
const root = fileURLToPath(new URL('../../', import.meta.url));
const option = (name, fallback) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback;
const automaticRecovery = argv.includes('--automatic-recovery');
const liveConfig = option('--live-config');
if (!liveConfig) throw Error('UPGRADE_LIVE_CONFIG_REQUIRED');
const upstream = JSON.parse(await readFile(resolve(liveConfig), 'utf8'));
const { active, strong } = resolveUpgradeModels(upstream, { activeModel: option('--active-model'), strongModel: option('--strong-model') });
for (const config of [active, strong]) if (!process.env[config.apiKeyEnv]?.trim()) throw Error(`LIVE_MODEL_KEY_MISSING:${config.apiKeyEnv}`);
if (!process.env.JEV_API_KEY?.trim()) throw Error('LIVE_JEV_KEY_MISSING');
const output = resolve(option('--output', join(root, 'docs/artifacts/AGENT_GOAL_UPGRADE_VALIDATION.json')));
await mkdir(dirname(output), { recursive: true });
const runtimeRoot = resolve(option('--runtime-root', join(root, 'runtime')));
const runRoot = join(dirname(output), 'goal-upgrade-' + new Date().toISOString().replace(/[-:.]/gu, ''));
await mkdir(runRoot);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = [];
for (const path of (await readdir(join(runtimeRoot, 'src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort()) sourceFiles.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(runtimeRoot, 'src', path))) });
for (const path of ['package.json', 'package-lock.json']) sourceFiles.push({ path: `../${path}`, sha256: hash(await readFile(join(runtimeRoot, path))) });
const runtimeSourceSha256 = hash(JSON.stringify(sourceFiles));
const pricing = async (config, path) => {
  if (path) return JSON.parse(await readFile(resolve(path), 'utf8'));
  const isGo = /opencode\.ai\/zen\/go\//u.test(config.endpoint ?? config.baseURL ?? '');
  const file = config.model === 'mimo-v2.6-flash' ? 'goal-pricing-opencode-go-flash.json' : config.model === 'mimo-v2.6-pro' ? 'goal-pricing-opencode-go.json' : null;
  return isGo && file ? JSON.parse(await readFile(join(root, 'desktop/scripts', file), 'utf8')) : {};
};
const resources = [];
try {
const flash = await startGoalLiveGateway(active, await pricing(active, option('--active-pricing-config')));
resources.push(flash);
const pro = await startGoalLiveGateway(strong, await pricing(strong, option('--strong-pricing-config')));
resources.push(pro);
const jev = await startGoalLiveJev();
resources.push(jev);
const marker = 'GOAL_ACTUAL_CHECKPOINT_UPGRADE_' + Date.now().toString(16);
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
  let decisions = [];
  try { decisions = (JSON.parse(await readFile(`${trajectory}.decision-trace.json`, 'utf8')).decisions ?? [])
    .filter(decision => decision.runId === payload?.runId); } catch { /* missing trace cannot prove automatic selection */ }
  const requests = [...flashContext.requests, ...proContext.requests];
  const outcomes = runtimeNativeOutcomes(events, requests);
  for (const [name, value] of [['model-requests', requests], ['jev-requests', decisionContext.requests], ['events', events], ['decisions', decisions], ['native-outcomes', outcomes]]) await writeFile(join(runRoot, `${id}-${name}.json`), JSON.stringify(value, null, 2));
  const phase = { id, result: { code: result.code, timedOut: result.timedOut, wallMs: result.wallMs }, payload, events, outcomes, requests,
    decisions, decisionRequests: decisionContext.requests };
  phases.push(phase);
  console.log(JSON.stringify({ phase: id, code: result.code, ok: payload?.ok, activeModelRequests: flashContext.requests.length, strongModelRequests: proContext.requests.length, actualMissingRead: outcomes.some(item => !item.ok && item.errorCode === 'WORKSPACE_NOT_FOUND') }));
  return phase;
}
  const first = await runPhase(automaticRecovery ? 'automatic-failure-recovery' : 'initial-failed-active',
    [...common, '--max-recovery-attempts', automaticRecovery ? '3' : '1']);
  const actualFailure = first.outcomes.some(item => !item.ok && item.name === 'workspace.read' && item.errorCode === 'WORKSPACE_NOT_FOUND');
  const threadsResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'threads', 'list', '--thread-store', threadStore,
    '--trajectory-store', trajectory], { cwd: runtimeRoot, env, timeoutMs: 30000 });
  const threads = parse(threadsResult.stdout).at(-1)?.threads ?? [];
  const thread = threads.find(thread => thread.id === first.payload?.threadId) ?? threads.at(-1);
  let second;
  if (!automaticRecovery && first.payload?.ok === false && actualFailure && thread?.id) second = await runPhase('resume-with-bound-strong', [...common,
    '--max-recovery-attempts', '2', '--thread-id', thread.id, '--resume', '--executor-model', pro.model]);
  const completed = automaticRecovery ? first : second;
  const unwrap = event => event.payload?.payload ?? event.payload ?? {};
  const actualStrongExecutor = phases.some(phase => phase.requests.some(request => request.upstreamModel === pro.model
    && !/Planner role/iu.test(String(request.body.instructions ?? '')) && request.output?.length));
  const checks = { realInitialActive: first.requests.some(request => request.upstreamModel === flash.model && request.output?.length),
    actualInitialMissingRead: actualFailure,
    ...(automaticRecovery ? {
      automaticRecoveryStarted: first.events.some(event => event.kind === 'RecoveryStarted'),
      realJevRecoveryDecision: first.events.some(event => event.kind === 'DecisionLayerEvaluated' && unwrap(event).source === 'jev'),
      successfulToolAfterFailure: first.outcomes.some((outcome, index) => outcome.ok
        && String(outcome.output).includes(marker) && first.outcomes.slice(0, index).some(prior => !prior.ok && prior.errorCode === 'WORKSPACE_NOT_FOUND'))
    } : {
    initialTaskFailed: first.payload?.ok === false && first.result.code !== 0,
    resumedSameThread: Boolean(thread?.id) && second?.events.some(event => event.kind === 'ThreadCheckpointCommitted' && (event.payload?.payload ?? event.payload)?.threadId === thread.id),
    checkpointRestored: second?.events.some(event => event.kind === 'TaskRunCreated' && (event.payload?.payload ?? event.payload)?.sourceRunId === first.payload?.runId),
    actualStrongExecutor }),
    successfulRead: completed?.outcomes.some(outcome => outcome.ok && outcome.name === 'workspace.read' && String(outcome.output).includes(marker)),
    finalSuccess: completed?.payload?.ok === true && completed?.result.code === 0 && !completed?.result.timedOut,
    actualJevUsed: phases.some(phase => phase.decisionRequests.some(request => request.status === 200 && request.response?.answers)) };
  const report = { generatedAt: new Date().toISOString(), method: automaticRecovery
    ? 'Real active-model task with an actual preset missing-file failure and three host recovery attempts. Real Jev chooses the recovery action; a distinct bound model is available but its selection is not forced. Same read-only workspace and prompt, untouched provider answers.'
    : 'Real active-model task with one recovery attempt to preserve its observed initial failure, then the existing explicit user-model override and checkpoint-resume CLI with the distinct configured upgrade model. Same read-only workspace and prompt, real untouched Jev answers. No provider response is fabricated.',
    activeModel: flash.model, strongModel: pro.model,
    runtimeRoot, runtimeSourceSha256, currentWorkspaceBuild: runtimeRoot === join(root, 'runtime'),
    manualModelUpgrade: !automaticRecovery, automaticRecovery, actualStrongExecutor,
    automaticJevStrongSelectionProven: automaticRecovery && automaticStrongSelectionProven({ events: first.events,
      decisions: first.decisions, actualStrongExecutor, finalSuccess: checks.finalSuccess }),
    passed: Object.values(checks).every(Boolean), checks, phases: phases.map(phase => ({ id: phase.id, result: phase.result, ok: phase.payload?.ok,
      error: phase.payload?.error, runId: phase.payload?.runId, threadId: phase.payload?.threadId, models: phase.requests.map(request => request.upstreamModel).filter(Boolean), jevCalls: phase.decisionRequests.length })),
    limitation: automaticRecovery
      ? 'One preset automatic-recovery experiment does not prove overall quality, economic benefit or that a stronger model is required. A same-model successful retry is reported as recovery, not model upgrade.'
      : 'One preset checkpoint/explicit-upgrade experiment is a flow test. Initial recovery budget1 versus retry budget2 is intentional fixture stimulation; it does not prove that the upgrade model is needed, better, cheaper or selected automatically by Jev.', actualCost: null, humanSavingsMinutes: null };
  await writeFile(output, JSON.stringify({ ...report, evidenceDirectory: runRoot }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, checks, phases: report.phases }));
  if (!report.passed) process.exitCode = 1;
} finally { await Promise.allSettled(resources.map(resource => resource.close())); }

};
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runGoalUpgradeHarness().catch(error => { console.error(error.message); process.exitCode = 1; });
