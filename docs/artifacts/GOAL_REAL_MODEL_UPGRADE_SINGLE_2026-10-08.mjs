import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGoalLiveGateway } from '../../desktop/scripts/goal-live-gateway.mjs';
import { startGoalLiveJev } from '../../desktop/scripts/goal-live-jev.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';
import { runtimeNativeOutcomes } from '../../desktop/scripts/goal-evidence-audit.mjs';
const root = 'C:/Users/User/hmCodex-local';
const runRoot = join(root, 'docs/artifacts/goal-real-model-upgrade-single-20261008');
await mkdir(runRoot);
const upstream = JSON.parse(await readFile('C:/Users/User/AppData/Local/hmCodex/model-config.json', 'utf8'));
const flashPricing = JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go-flash.json'), 'utf8'));
const proPricing = JSON.parse(await readFile(join(root, 'desktop/scripts/goal-pricing-opencode-go.json'), 'utf8'));
const flash = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-flash' }, flashPricing);
const pro = await startGoalLiveGateway({ ...upstream, model: 'mimo-v2.6-pro' }, proPricing);
const jev = await startGoalLiveJev();
const task = { taskId: 'actual-flash-to-pro-recovery', recoverable: true };
const flashContext = flash.begin(task), proContext = pro.begin(task), jevContext = jev.begin();
const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-real-model-upgrade-'));
const marker = 'GOAL_ACTUAL_TWO_MODEL_RECOVERY_20261008';
await writeFile(join(workspace, 'README.md'), `${marker}\n`);
const localKeyName = 'HMCODEX_REAL_UPGRADE_LOCAL_KEY';
const configPath = join(runRoot, 'model-config.json');
const binding = gateway => ({ id: gateway.model, provider: 'openai', protocol: 'responses', model: gateway.model,
  endpoint: gateway.endpoint, apiKeyEnv: localKeyName });
await writeFile(configPath, JSON.stringify({ schemaVersion: '1.0', provider: 'openai', protocol: 'responses',
  model: flash.model, endpoint: flash.endpoint, apiKeyEnv: localKeyName, models: [binding(flash), binding(pro)],
  roleBindings: { planner: { selector: 'PINNED', modelId: flash.model }, executor: { selector: 'PINNED', modelId: flash.model }, critic: { selector: 'PINNED', modelId: pro.model } },
  decision: { enabled: true, enforce: true, endpoint: jev.endpoint, apiKeyEnv: 'HMCODEX_REAL_UPGRADE_JEV_LOCAL_KEY', model: 'jev-latest', timeoutMs: 5000, diagnosisEnabled: true, recoveryDirectionEnabled: true }
}, null, 2));
const trajectory = join(runRoot, 'trajectory.jsonl');
const prompt = 'This is a preset recovery acceptance task in an authorized read-only workspace. The final goal is to read README.md with a real tool and report its exact evidence marker. Planner: produce one bounded READ step for this whole goal. Initial executor attempt: first invoke only workspace.read for missing-evidence.txt, receive its actual error, then end that attempt reporting the failure without reading README.md. A reported error alone does not complete the final goal. If the host starts verifier recovery and provides prior terminal failure facts, do not repeat the missing-file step; read README.md and report its marker. The host has a separately bound stronger executor available for recovery; let actual Jev decisions choose the recovery path.';
let result;
try {
  result = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'task', '--agent-mode', 'single', '--config', configPath,
    '--workspace', workspace, '--prompt', prompt, '--trajectory-store', trajectory, '--thread-store', join(runRoot, 'threads.json'),
    '--max-recovery-attempts', '2', '--max-tool-rounds', '4'], { cwd: join(root, 'runtime'), timeoutMs: 300000,
    env: { [localKeyName]: 'local-fixture-key', HMCODEX_REAL_UPGRADE_JEV_LOCAL_KEY: 'goal-jev-local-key',
      HMCODEX_DATA_DIR: runRoot, HMCODEX_HARNESS_EVENT_STORE: join(runRoot, 'harness.db'), HMCODEX_CONTEXT_PROVIDER: 'journal',
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY', HMCODEX_EXECUTION_MODE: 'READ_ONLY', HMCODEX_JEV_ENABLED: '1', HMCODEX_JEV_ENFORCE: '1' },
    dropEnv: [...flash.privateEnvKeys, ...pro.privateEnvKeys, ...jev.privateEnvKeys] });
  await writeFile(join(runRoot, 'stdout.jsonl'), result.stdout);
  await writeFile(join(runRoot, 'stderr.log'), result.stderr);
  const parseLines = text => text.split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const payload = parseLines(result.stdout).at(-1);
  
  const eventResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list',
    '--trajectory-store', trajectory, '--harness-event-store', join(runRoot, 'harness.db'), '--run-id', payload?.runId ?? '', '--limit', '500'],
    { cwd: join(root, 'runtime'), timeoutMs: 30000 });
  const events = parseLines(eventResult.stdout).at(-1)?.events ?? [];
  await writeFile(join(runRoot, 'durable-events.json'), JSON.stringify(events, null, 2));
  const requests = [...flashContext.requests, ...proContext.requests];
  const outcomes = runtimeNativeOutcomes(events, requests);
  
  const decisionMap = new Map();
  for (const event of events.filter(event => event.kind === 'DecisionTraceEvent')) {
    const decision = event.payload?.decisionSnapshot;
    if (decision?.status === 'COMMITTED') decisionMap.set(decision.decisionId, decision);
  }
  const decisions = [...decisionMap.values()].map(decision => ({ decisionId: decision.decisionId, decisionType: decision.decisionType,
    selectedOptionId: decision.selectedOptionId, reasonCodes: decision.reasonCodes }));
  const strongExecutors = proContext.requests.filter(request => !/Planner role/iu.test(String(request.body.instructions ?? '')));
  const checks = { childCompleted: result.code === 0 && !result.timedOut, runtimeSuccess: payload?.ok === true,
    actualMissingRead: outcomes.some(outcome => !outcome.ok && outcome.name === 'workspace.read' && outcome.errorCode === 'WORKSPACE_NOT_FOUND'),
    recoveryStarted: events.some(event => event.kind === 'RecoveryStarted'),
    actualStrongExecutor: strongExecutors.some(request => request.upstreamModel === pro.model && request.output?.length),
    distinctActualModels: [flash.model, pro.model].every(model => requests.some(request => request.upstreamModel === model && request.output?.length)),
    actualJevUsed: jevContext.requests.some(request => request.status === 200 && request.response?.answers),
    jevSelectedStrongModel: decisions.some(decision => decision.decisionType === 'SELECT_SAFE_MODEL_FALLBACK'
      && decision.selectedOptionId === 'strong-model' && decision.reasonCodes?.includes('JEV_DECISION')),
    actualMarkerRead: outcomes.some(outcome => outcome.ok && outcome.name === 'workspace.read' && String(outcome.output).includes(marker)) };
  const report = { generatedAt: new Date().toISOString(), taskId: task.taskId, models: [flash.model, pro.model], frozenRuntimeSource: '5186ceb599c120d765faf1bfc3150294064ab64504620a214f6d5e185e1638bc',
    method: 'Actual registered Flash/Pro providers and untouched real Jev answers. Prompt seeds a missing-file failure; no inference response is fabricated. Independent experiment during fixed-task batch; excluded from its comparison and timing.',
    passed: Object.values(checks).every(Boolean), checks, result: { code: result.code, timedOut: result.timedOut, wallMs: result.wallMs, outputTruncated: result.outputTruncated },
    modelsUsed: { flashRequests: flashContext.requests.length, proRequests: proContext.requests.length, strongExecutorRequests: strongExecutors.length, jevRequests: jevContext.requests.length },
    decisions, actualCost: null, manualInterventionMinutes: null, limitation: 'A preset recovery smoke test cannot establish a cost-effective model escalation policy, success rates or human savings.' };
  for (const [name, data] of [['flash-requests.json', flashContext.requests], ['pro-requests.json', proContext.requests], ['jev-requests.json', jevContext.requests], ['native-outcomes.json', outcomes]]) await writeFile(join(runRoot, name), JSON.stringify(data, null, 2));
  await writeFile(join(root, 'docs/artifacts/GOAL_REAL_MODEL_UPGRADE_SINGLE_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: report.passed, checks, modelsUsed: report.modelsUsed, result: report.result }));
  if (!report.passed) process.exitCode = 1;
} finally { await Promise.allSettled([flash.close(), pro.close(), jev.close()]); }
