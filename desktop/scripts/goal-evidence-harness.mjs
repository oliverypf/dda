#!/usr/bin/env node
// Paired tasks, actual ordinary Codex CLI, independent grading and
// append-only evidence. Fixture results validate the experiment, not ROI.
import { mkdir, mkdtemp, readFile, writeFile, appendFile, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { startGoalFixture, GOAL_TASKS, TASK_SET_VERSION } from './goal-model-fixture.mjs';
import { findCodexCli, runEvidenceProcess, codexEvidenceArgs } from './goal-evidence-process.mjs';
import { startGoalLiveGateway } from './goal-live-gateway.mjs';
import { startGoalLiveJev } from './goal-live-jev.mjs';
import { auditGoalEvidence, runtimeNativeOutcomes, successfulNativeTest } from './goal-evidence-audit.mjs';
import { goalTaskFiles, verifyCodeTask } from './goal-task-set.mjs';
import { measureInterventions, readInterventionLedger, validateGoalPricing, reconcileGoalBilling } from './goal-measurements.mjs';
import { summarizeJevAblation } from './goal-jev-ablation.mjs';
import { observedFixtureTestPassed, fixtureTestScope, observedExpectedFailure } from './goal-test-acceptance.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GRADING_PROTOCOL_VERSION = '2.1-NATIVE_COMMAND_DIGEST_AND_FIXTURE_TEST';
const option = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const RUNTIME = resolve(option('--runtime-root', join(ROOT, 'runtime')));
const repeat = Number(option('--repeat', '1'));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw Error('--repeat must be an integer from 1 to 20');
const output = resolve(option('--output', join(ROOT, 'docs/artifacts/AGENT_GOAL_EVIDENCE_BENCHMARK.json')));
const evidenceBase = resolve(option('--evidence-dir', join(ROOT, 'docs/artifacts/agent-goal-runs')));
const history = resolve(option('--history', join(evidenceBase, 'history.jsonl')));
const batchId = `${new Date().toISOString().replace(/[-:.]/gu, '')}-${randomUUID().slice(0, 8)}`;
const batchRoot = join(evidenceBase, batchId);
const suite = option('--suite', 'all');
if (!['all', 'inspect', 'engineering'].includes(suite)) throw Error('INVALID_GOAL_SUITE');
const selectedIds = option('--task-ids', '').split(',').filter(Boolean);
const jevAblation = process.argv.includes('--jev-ablation');
const selectedConditions = option('--conditions', jevAblation ? 'hmcodex-runtime' : 'ordinary-codex,hmcodex-runtime').split(',');
if (!selectedConditions.length || new Set(selectedConditions).size !== selectedConditions.length
  || selectedConditions.some(condition => !['ordinary-codex', 'hmcodex-runtime'].includes(condition))) throw Error('INVALID_GOAL_CONDITIONS');
const tasks = GOAL_TASKS.filter(task => (suite === 'all' || (task.suite ?? 'inspect') === suite) && (!selectedIds.length || selectedIds.includes(task.taskId)));
if (!tasks.length || selectedIds.some(id => !tasks.some(task => task.taskId === id))) throw Error('INVALID_GOAL_TASK_SELECTION');
const interventionLedger = option('--interventions-ledger', undefined);
const billingLedger = option('--billing-ledger', undefined);
const liveJev = process.argv.includes('--live-jev');
if (jevAblation && (liveJev || selectedConditions.length !== 1 || selectedConditions[0] !== 'hmcodex-runtime')) throw Error('INVALID_JEV_ABLATION_CONDITIONS');
const reportConditions = jevAblation ? ['hmcodex-jev-off', 'hmcodex-jev-on'] : selectedConditions;
const digest = value => createHash('sha256').update(value).digest('hex');
const jsonLines = text => String(text).split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const lastJson = text => jsonLines(text).at(-1);
const readOptional = async path => { try { return await readFile(path, 'utf8'); } catch { return ''; } };
const saveJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
const unwrap = event => event.payload?.payload ?? event.payload ?? {};
const runtimeSourceManifest = async () => {
  const sourceRoot = join(RUNTIME, 'src');
  const paths = (await readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.mjs')).sort();
  const files = await Promise.all(paths.map(async path => ({ path: path.replaceAll('\\', '/'), sha256: digest(await readFile(join(sourceRoot, path))) })));
  for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: digest(await readFile(join(RUNTIME, name))) });
  return { scope: 'RUNTIME_MJS_SOURCES_AND_PACKAGE_LOCK', sha256: digest(JSON.stringify(files)), files };
};

const harnessSourceManifest = async () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const paths = (await readdir(root)).filter(path => path.startsWith('goal-') && /\.(?:mjs|json)$/u.test(path) && !path.endsWith('.test.mjs')).sort();
  const files = [];
  for (const path of paths) {
    const content = await readFile(join(root, path));
    files.push({ path, sha256: digest(content) });
    const target = join(batchRoot, 'test-harness-source-snapshot', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return { scope: 'DESKTOP_GOAL_SCRIPTS_AND_PRICING', sha256: digest(JSON.stringify(files)), files };
};

export const gradeGoalRun = ({ task, result, agentOk, text, marker, nativeResults, unchanged, codeVerification }) => {
  const successes = nativeResults.filter(item => item.ok);
  const errors = nativeResults.filter(item => !item.ok);
  const outputCorrect = task.acceptance === 'code' ? codeVerification?.passed === true : task.acceptance === 'layout'
    ? ['README.md', 'package.json', 'name.mjs', 'name.test.mjs'].every(name => text.includes(name))
    : text.includes(marker);
  const checks = { processCompleted: result.code === 0 && !result.timedOut, agentCompleted: agentOk,
    correctAnswer: outputCorrect, actualSuccessfulTool: successes.length > 0,
    actualSuccessfulTest: task.acceptance !== 'code' || successes.some(outcome => observedFixtureTestPassed(outcome, fixtureTestScope(task))),
    actualInjectedFailure: !task.recoverable || (task.acceptance === 'code' ? observedExpectedFailure(nativeResults, task) : errors.length > 0),
    successfulToolAfterFailure: !task.recoverable || nativeResults.some((item, index) => item.ok && nativeResults.slice(0, index).some(previous => !previous.ok)),
    workspaceScopeRespected: task.acceptance === 'code' ? codeVerification?.passed === true : unchanged };
  return { passed: Object.values(checks).every(Boolean), checks };
};

export const summarizeGoalRuns = (rows, condition) => {
  const selected = rows.filter(row => row.condition === condition);
  const successes = selected.filter(row => row.status === 'SUCCEEDED').length;
  const recoveries = selected.filter(row => row.recoveryOpportunity);
  const sumKnown = key => selected.every(row => Number.isFinite(row[key])) ? selected.reduce((sum, row) => sum + row[key], 0) : null;
  return { runs: selected.length, successes, successRate: selected.length ? successes / selected.length : null,
    recoveryOpportunities: recoveries.length, recoverySuccesses: recoveries.filter(row => row.recovered).length,
    recoverySuccessRate: recoveries.length ? recoveries.filter(row => row.recovered).length / recoveries.length : null,
    manualInterventionMinutes: sumKnown('manualInterventionMinutes'), totalTokens: sumKnown('totalTokens'),
    actualCost: sumKnown('actualCost'), estimatedCost: sumKnown('estimatedCost'), pricingBasis: selected[0]?.pricingBasis ?? null, toolRounds: sumKnown('toolRounds'),
    modelCalls: sumKnown('modelCalls'), usageCoverage: {
      reportedRequests: selected.reduce((sum, row) => sum + (row.usageCoverage?.reportedRequests ?? 0), 0),
      totalRequests: selected.reduce((sum, row) => sum + row.modelCalls, 0),
      knownTokenSubtotal: selected.reduce((sum, row) => sum + (row.usageCoverage?.knownTokenSubtotal ?? 0), 0),
      pricedRequests: selected.reduce((sum, row) => sum + (row.usageCoverage?.pricedRequests ?? 0), 0),
      knownPricedSubtotal: selected.reduce((sum, row) => sum + (row.usageCoverage?.knownPricedSubtotal ?? 0), 0)
    },
    toolCallCount: sumKnown('toolCallCount'), wallMs: sumKnown('wallMs') };
};

const runCase = async ({ fixture, jev, cli, task, iteration, condition, experimentCondition = condition, marker, version, sourceManifest }) => {
  const runRoot = join(batchRoot, `${iteration}-${task.taskId}-${experimentCondition}`);
  const runKey = `${batchId}/${iteration}-${task.taskId}-${experimentCondition}`;
  const caseStartedAtMs = Date.now();
  const mode = task.mode ?? 'READ_ONLY';
  const timeoutMs = Number(option('--case-timeout-ms', mode === 'CONTROLLED' ? '300000' : '180000'));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1200000) throw Error('CASE_TIMEOUT_INVALID');
  console.log(JSON.stringify({ event: 'CASE_START', runKey, mode, atMs: caseStartedAtMs }));
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-goal-task-'));
  await mkdir(runRoot, { recursive: true });
  const files = goalTaskFiles(task, marker);
  for (const [name, content] of Object.entries(files)) await writeFile(join(workspace, name), content);
  const initialDigest = digest(JSON.stringify(files));
  const env = { EVIDENCE_FIXTURE_KEY: 'local-fixture-key', HMCODEX_RELEASE_CHANNEL: mode === 'CONTROLLED' ? 'WINDOWS_FULL_LOCAL' : 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: mode, HMCODEX_CONTEXT_PROVIDER: 'journal',
    HMCODEX_DATA_DIR: runRoot, HMCODEX_MODEL_CONFIG: join(runRoot, 'model-config.json'),
    HMCODEX_TRAJECTORY_STORE: join(runRoot, 'trajectory.jsonl'), HMCODEX_THREAD_STORE: join(runRoot, 'threads.json'),
    HMCODEX_HARNESS_EVENT_STORE: join(runRoot, 'harness-events.db'),
    HMCODEX_JEV_ENABLED: '0', HMCODEX_JEV_ENFORCE: '0',
    CODEX_HOME: join(runRoot, 'codex-home') };
  const context = fixture.begin(task);
  const decisionContext = jev?.begin();
  let result, agentOk, finalText, nativeResults;
  try {
    let args, command, cwd;
    if (condition === 'ordinary-codex') {
      await mkdir(env.CODEX_HOME);
      command = cli.command; cwd = workspace;
      args = codexEvidenceArgs({ ...cli, endpoint: fixture.endpoint, workspace, model: fixture.model,
        prompt: `TASK ${task.taskId}: ${task.prompt}`, finalPath: join(runRoot, 'final.txt'), mode });
    } else {
      command = process.execPath; cwd = RUNTIME;
      const decision = jev ? { enabled: true, enforce: true, endpoint: jev.endpoint,
        apiKeyEnv: 'HMCODEX_GOAL_JEV_LOCAL_KEY', model: 'jev-latest', timeoutMs: 5000,
        diagnosisEnabled: true, recoveryDirectionEnabled: true } : { enabled: false, enforce: false };
      await saveJson(env.HMCODEX_MODEL_CONFIG, { schemaVersion: '1.0', provider: 'openai', protocol: 'responses',
        model: fixture.model, endpoint: fixture.endpoint, apiKeyEnv: 'EVIDENCE_FIXTURE_KEY', decision });
      if (jev) Object.assign(env, { HMCODEX_JEV_ENABLED: '1', HMCODEX_JEV_ENFORCE: '1', HMCODEX_GOAL_JEV_LOCAL_KEY: 'goal-jev-local-key' });
      args = ['src/index.mjs', 'task', '--config', env.HMCODEX_MODEL_CONFIG, '--prompt', `TASK ${task.taskId}: ${task.prompt}`,
        '--workspace', workspace, '--trajectory-store', env.HMCODEX_TRAJECTORY_STORE, '--thread-store', env.HMCODEX_THREAD_STORE,
        '--max-recovery-attempts', '2'];
      if (mode === 'CONTROLLED') args.push('--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write,test.execute', '--lease-commands', 'node');
    }
    await saveJson(join(runRoot, 'invocation.json'), { command, args, cwd, model: fixture.model, condition: experimentCondition, client: condition,
      codexVersion: condition === 'ordinary-codex' ? version : null,
      runtimeSourceSha256: condition === 'hmcodex-runtime' ? sourceManifest.sha256 : null,
      workspacePolicy: mode === 'CONTROLLED' ? 'WORKSPACE_WRITE_ONLY' : 'READ_ONLY', timeoutMs, initialDigest });
    result = await runEvidenceProcess(command, args, { env, cwd, dropEnv: [...(fixture.privateEnvKeys ?? []), ...(jev?.privateEnvKeys ?? ['JEV_API_KEY'])], timeoutMs });
    await writeFile(join(runRoot, 'stdout.jsonl'), result.stdout);
    await writeFile(join(runRoot, 'stderr.log'), result.stderr);
    await saveJson(join(runRoot, 'model-requests.json'), context.requests);
    if (decisionContext) await saveJson(join(runRoot, 'jev-requests.json'), decisionContext.requests);
    if (condition === 'ordinary-codex') {
      const events = jsonLines(result.stdout);
      agentOk = events.some(event => event.type === 'turn.completed') && !events.some(event => event.type === 'turn.failed');
      finalText = await readOptional(join(runRoot, 'final.txt'));
      nativeResults = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution')
        .map(event => ({ ok: event.item.exit_code === 0 && event.item.status === 'completed', exitCode: event.item.exit_code, name: 'exec_command', command: event.item.command, output: event.item.aggregated_output }));
    } else {
      const payload = lastJson(result.stdout);
      agentOk = payload?.ok === true;
      finalText = payload?.text ?? '';
      const eventsResult = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list',
        '--trajectory-store', env.HMCODEX_TRAJECTORY_STORE, '--run-id', payload?.runId ?? ''], { env, cwd: RUNTIME, timeoutMs: 30000 });
      const retrieved = lastJson(eventsResult.stdout)?.events;
      const events = retrieved?.length ? retrieved : jsonLines(await readOptional(env.HMCODEX_TRAJECTORY_STORE));
      await saveJson(join(runRoot, 'native-events.json'), events);
      nativeResults = runtimeNativeOutcomes(events, context.requests);
    }
    const codeVerification = await verifyCodeTask({ task, workspace, initialFiles: files });
    if (codeVerification) await saveJson(join(runRoot, 'code-verification.json'), codeVerification);
    const finalFiles = {};
    for (const name of Object.keys(files)) finalFiles[name] = await readOptional(join(workspace, name));
    const grade = gradeGoalRun({ task, result, agentOk, text: finalText, marker, nativeResults,
      unchanged: initialDigest === digest(JSON.stringify(finalFiles)), codeVerification });
    const successfulResponses = context.requests.filter(request => request.upstreamStatus === 200);
    const modelsMatch = context.requests.length > 0 && context.requests.every(request => request.body.model === fixture.model)
      && (fixture.mode !== 'live' || successfulResponses.length > 0 && successfulResponses.every(request => request.upstreamModel === fixture.model));
    const ok = grade.passed && modelsMatch;
    const sumReported = key => context.requests.length && context.requests.every(request => Number.isFinite(request.usage?.[key]))
      ? context.requests.reduce((sum, request) => sum + request.usage[key], 0) : null;
    const usage = { inputTokens: sumReported('input_tokens'), outputTokens: sumReported('output_tokens') };
    const sumCost = key => context.requests.length && context.requests.every(request => Number.isFinite(request[key]))
      ? context.requests.reduce((sum, request) => sum + request[key], 0) : null;
    const errors = nativeResults.filter(item => !item.ok).length;
    const interventions = await readInterventionLedger(interventionLedger);
    const endedAtMs = Date.now();
    const human = measureInterventions(interventions, { mode: interventionLedger ? 'OPERATOR' : 'HEADLESS', runKey, startedAtMs: caseStartedAtMs, endedAtMs });
    const billing = reconcileGoalBilling(await readInterventionLedger(billingLedger), { runKey, model: fixture.model, modelCalls: context.requests.length });
    const row = { schemaVersion: '3.0', gradingProtocolVersion: GRADING_PROTOCOL_VERSION, batchId, runKey, startedAtMs: caseStartedAtMs, endedAtMs, iteration, taskSetVersion: TASK_SET_VERSION, condition: experimentCondition, client: condition, taskId: task.taskId, acceptance: task.acceptance,
      model: fixture.model, evidenceClass: fixture.mode === 'live' ? 'ACTUAL_CLIENTS_ACTUAL_MODEL' : 'ACTUAL_CLIENTS_LOCAL_MODEL_FIXTURE', status: ok ? 'SUCCEEDED' : result.timedOut ? 'TIMED_OUT' : 'FAILED',
      runtimeSourceSha256: condition === 'hmcodex-runtime' ? sourceManifest.sha256 : null,
      firstAttemptStatus: errors ? 'FAILED' : ok ? 'SUCCEEDED' : 'FAILED', recoveryOpportunity: task.recoverable || errors > 0,
      recovered: ok && errors > 0, errorAttempts: errors, ...usage,
      totalTokens: usage.inputTokens === null || usage.outputTokens === null ? null : usage.inputTokens + usage.outputTokens,
      modelCalls: context.requests.length,
      usageCoverage: {
        reportedRequests: context.requests.filter(request => Number.isFinite(request.usage?.input_tokens) && Number.isFinite(request.usage?.output_tokens)).length,
        totalRequests: context.requests.length,
        knownTokenSubtotal: context.requests.reduce((sum, request) => sum + (Number.isFinite(request.usage?.input_tokens) && Number.isFinite(request.usage?.output_tokens)
          ? request.usage.input_tokens + request.usage.output_tokens : 0), 0),
        pricedRequests: context.requests.filter(request => Number.isFinite(request.estimatedCost)).length,
        knownPricedSubtotal: context.requests.reduce((sum, request) => sum + (Number.isFinite(request.estimatedCost) ? request.estimatedCost : 0), 0)
      },
      cachedInputTokens: fixture.mode === 'live'
        ? context.requests.every(request => Number.isFinite(request.cachedTokens)) ? context.requests.reduce((sum, request) => sum + request.cachedTokens, 0) : null
        : 0,
      actualCost: fixture.mode === 'live' ? billing.amount ?? sumCost('actualCost') : 0, billing,
      estimatedCost: fixture.mode === 'live' ? sumCost('estimatedCost') : 0, costCurrency: 'USD', costScope: jev ? 'LANGUAGE_MODEL_ONLY; JEV_CHARGE_UNKNOWN' : 'EXTERNAL_PROVIDER_ONLY',
      decisionProvider: jev && condition === 'hmcodex-runtime' ? { mode: 'LIVE_JEV', calls: decisionContext.requests.length,
        succeededCalls: decisionContext.requests.filter(request => request.status === 200).length,
        usageComplete: decisionContext.requests.every(request => Number.isInteger(request.rawUsage?.input_tokens) && Number.isInteger(request.rawUsage?.output_tokens)),
        inputTokens: decisionContext.requests.every(request => Number.isInteger(request.rawUsage?.input_tokens)) ? decisionContext.requests.reduce((sum, request) => sum + request.rawUsage.input_tokens, 0) : null,
        outputTokens: decisionContext.requests.every(request => Number.isInteger(request.rawUsage?.output_tokens)) ? decisionContext.requests.reduce((sum, request) => sum + request.rawUsage.output_tokens, 0) : null,
        estimatedCost: decisionContext.requests.length > 0 && decisionContext.requests.every(request => Number.isFinite(request.estimatedCost))
          ? decisionContext.requests.reduce((sum, request) => sum + request.estimatedCost, 0) : null,
        wallMs: decisionContext.requests.every(request => Number.isFinite(request.wallMs)) ? decisionContext.requests.reduce((sum, request) => sum + request.wallMs, 0) : null,
        latencyCoverage: { reportedRequests: decisionContext.requests.filter(request => Number.isFinite(request.wallMs)).length,
          knownWallMsSubtotal: decisionContext.requests.reduce((sum, request) => sum + (Number.isFinite(request.wallMs) ? request.wallMs : 0), 0) },
        pricingBasis: 'API_PRICE', actualCost: null, endpoint: jev.upstreamEndpoint } : { mode: 'OFF', calls: 0 },
      pricingBasis: fixture.pricing?.basis ?? null, pricing: fixture.pricing ?? null, providerSessionId: context.sessionId ?? null,
      tokenMeasurement: fixture.mode === 'live' ? 'UPSTREAM_PROVIDER_USAGE' : 'SYNTHETIC_FIXTURE_USAGE',
      modelIdentityMeasurement: fixture.mode === 'live' ? 'REQUEST_AND_SUCCESSFUL_UPSTREAM_RESPONSE' : 'LOCAL_FIXTURE_REQUEST',
      costMeasurement: fixture.mode === 'live' ? fixture.pricing ? 'PUBLISHED_RATES_WITH_CACHE; ACTUAL_INVOICE_UNKNOWN' : 'ACTUAL_BILLING_UNKNOWN; DECLARED_RATE_IF_PROVIDED' : 'LOCAL_SERVICE_NO_EXTERNAL_INFERENCE',
      manualInterventionMinutes: human.minutes, manualMeasurement: human.measurement, interventionMeasurement: human,
      interventions: interventions.filter(event => event.runKey === runKey),
      toolRounds: context.requests.filter(request => [request.output].flat().some(item => item?.type === 'function_call')).length,
      toolCallCount: nativeResults.length, wallMs: result.wallMs, timeoutOutputTruncated: result.outputTruncated === true, grade, modelsMatch, initialDigest,
      evidenceDirectory: runRoot, generatedAt: new Date().toISOString() };
    await cp(workspace, join(runRoot, 'workspace-final'), { recursive: true });
    await saveJson(join(runRoot, 'result.json'), row);
    await appendFile(history, `${JSON.stringify(row)}\n`);
    console.log(`${experimentCondition} ${task.taskId} ${row.status} tools=${row.toolCallCount} errors=${errors}`);
    return row;
  } finally { await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
};

const main = async () => {
  await mkdir(batchRoot, { recursive: true });
  await mkdir(dirname(history), { recursive: true });
  await mkdir(dirname(output), { recursive: true });
  const cli = await findCodexCli(option('--codex', undefined));
  const versionResult = await runEvidenceProcess(cli.command, [...cli.prefix, '--version'], { cwd: ROOT, timeoutMs: 30000 });
  if (versionResult.code !== 0) throw Error('CODEX_CLI_VERSION_CHECK_FAILED');
  const version = versionResult.stdout.trim();
  const sourceManifest = await runtimeSourceManifest();
  const harnessManifest = await harnessSourceManifest();
  await saveJson(join(batchRoot, 'test-harness-source-manifest.json'), harnessManifest);
  await saveJson(join(batchRoot, 'runtime-source-manifest.json'), sourceManifest);
  for (const entry of sourceManifest.files) {
    const source = join(RUNTIME, 'src', entry.path);
    const content = await readFile(source);
    if (digest(content) !== entry.sha256) throw Error('RUNTIME_SOURCE_CHANGED_DURING_SNAPSHOT');
    const target = join(batchRoot, 'runtime-source-snapshot', entry.path.startsWith('../') ? entry.path.slice(3) : `src/${entry.path}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const liveConfigPath = option('--live-config', undefined);
  const liveConfig = liveConfigPath ? JSON.parse(await readFile(resolve(liveConfigPath), 'utf8')) : null;
  if ((liveJev || jevAblation) && !liveConfig) throw Error('LIVE_JEV_REQUIRES_LIVE_MODEL_CONFIG');
  const autoPricing = liveConfig?.model === 'mimo-v2.6-pro' && String(liveConfig.baseURL ?? liveConfig.endpoint).startsWith('https://opencode.ai/zen/go/');
  const pricingPath = option('--pricing-config', autoPricing ? fileURLToPath(new URL('./goal-pricing-opencode-go.json', import.meta.url)) : undefined);
  const pricing = pricingPath ? validateGoalPricing(JSON.parse(await readFile(resolve(pricingPath), 'utf8'))) : undefined;
  const fixture = liveConfig ? await startGoalLiveGateway(liveConfig, pricing ??
    { input: Number(option('--input-price-per-1m', NaN)), output: Number(option('--output-price-per-1m', NaN)) }) : await startGoalFixture();
  let jev;
  const rows = [];
  try {
    if (liveJev || jevAblation) jev = await startGoalLiveJev();
    for (let iteration = 1; iteration <= repeat; iteration++) {
      const marker = `GOAL_EVIDENCE_${randomUUID().replaceAll('-', '')}`;
      const conditions = jevAblation ? (iteration % 2 ? reportConditions : [...reportConditions].reverse())
        : (iteration % 2 ? ['ordinary-codex', 'hmcodex-runtime'] : ['hmcodex-runtime', 'ordinary-codex']).filter(condition => selectedConditions.includes(condition));
      for (const task of tasks) for (const experimentCondition of conditions) {
        if ((await runtimeSourceManifest()).sha256 !== sourceManifest.sha256) throw Error('RUNTIME_SOURCE_CHANGED_DURING_BATCH');
        const condition = jevAblation ? 'hmcodex-runtime' : experimentCondition;
        const decision = condition === 'ordinary-codex' || jevAblation && experimentCondition === 'hmcodex-jev-off' ? undefined : jev;
        rows.push(await runCase({ fixture, jev: decision, cli, task, iteration, condition, experimentCondition, marker, version, sourceManifest }));
      }
    }
    const report = { schemaVersion: '3.0', gradingProtocolVersion: GRADING_PROTOCOL_VERSION, batchId, generatedAt: new Date().toISOString(), taskSetVersion: TASK_SET_VERSION, suite, repeat,
      taskSet: tasks, codexVersion: version, runtimeRoot: RUNTIME, runtimeSourceSha256: sourceManifest.sha256, testHarnessSourceSha256: harnessManifest.sha256,
      model: fixture.model, mode: fixture.mode, decisionMode: jevAblation ? 'LIVE_JEV_ON_OFF_ABLATION' : liveJev ? 'LIVE_JEV_HMCODEX_ONLY' : 'OFF', evidenceDirectory: batchRoot, history,
      conditions: Object.fromEntries(reportConditions.map(condition => [condition, summarizeGoalRuns(rows, condition)])), rows,
      caveats: [jevAblation ? 'The same dda source and upstream model run paired Jev off/on tasks with identical initial files and alternating order. This is not a Codex client comparison.' : selectedConditions.length === 2 ? 'Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.' : 'This is a single-client diagnostic, not a paired comparison. Other batches cannot supply its control condition.',
        fixture.mode === 'live' ? 'Selected clients use the configured actual upstream model through the shared protocol adapter. Missing usage or billing stays UNKNOWN.' : 'The model and token usage are deterministic local fixtures; this validates the experiment, not production savings.',
        liveJev || jevAblation ? 'dda uses the real Jev service in its enabled condition; raw decision usage and latency are recorded separately. Priced usage covers the language model only; Jev cash charges remain unknown.' : 'Jev is explicitly disabled for this same-model client comparison.',
        fixture.mode === 'live' ? 'Published quota rates include separate cached-input prices. Quota consumption is not an invoice or per-task cash charge. Unknown billing stays unknown.' : 'Provider cost is zero only because no external inference is used; local compute is excluded.',
        interventionLedger ? 'Human minutes are the union of matched START/END activity intervals; incomplete activities stay unknown. Automation events are excluded.' : 'No humans are connected to this headless run; zero intervention time does not prove human time savings.',
        'Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.',
        'Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.'] };
    if (jevAblation) report.ablation = summarizeJevAblation(report);
    const contentAudit = await auditGoalEvidence(report);
    report.contentAudit = { passed: contentAudit.passed, cases: contentAudit.rows.length, path: join(batchRoot, 'content-audit.json') };
    await saveJson(join(batchRoot, 'report.json'), report);
    await saveJson(output, report);
    // Keep condition IDs stable for archived comparisons; display the current product name.
    const conditionLabels = { 'ordinary-codex': 'Codex CLI', 'hmcodex-runtime': 'dda', 'hmcodex-jev-off': 'dda (Jev off)', 'hmcodex-jev-on': 'dda (Jev on)' };
    const md = [jevAblation ? '# Fixed task Jev off/on comparison: same dda source and model' : selectedConditions.length === 2 ? '# Fixed task comparison: actual Codex CLI and dda' : '# Fixed task single-client diagnostic', '', `Batch: ${batchId}`, `Codex: ${version}`, `History: ${history}`, '',
      `Mode: ${fixture.mode}; model: ${fixture.model}; decision: ${report.decisionMode}`, '',
      '| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |', '|---|---:|---:|---:|---:|---|---:|---:|---:|',
      ...Object.entries(report.conditions).map(([name, summary]) => `| ${conditionLabels[name] ?? name} | ${summary.successes}/${summary.runs} | ${summary.recoverySuccesses}/${summary.recoveryOpportunities} | ${summary.totalTokens ?? 'UNKNOWN'} | ${summary.actualCost ?? 'UNKNOWN'} | ${summary.estimatedCost ?? 'UNKNOWN'} / ${summary.pricingBasis ?? 'LOCAL_FIXTURE'} | ${summary.manualInterventionMinutes ?? 'UNKNOWN'} | ${summary.toolRounds} | ${summary.wallMs} |`), '',
      ...report.caveats.map(text => `- ${text}`), '', ...(report.ablation ? [
        `Matched pairs: ${report.ablation.pairCount}; activated on runs: ${report.ablation.activatedOnRuns}/${report.ablation.assignedOnRuns}.`, '',
        '| Jev calls | Successful calls | Decision proxy wall ms | Decision input tokens | Decision API-price estimate USD | Actual Jev charge |',
        '|---:|---:|---|---|---|---|',
        `| ${report.ablation.decision.calls} | ${report.ablation.decision.succeededCalls} | ${report.ablation.decision.wallMs ?? 'UNKNOWN'} | ${report.ablation.decision.inputTokens ?? 'UNKNOWN'} | ${report.ablation.decision.estimatedApiCost ?? 'UNKNOWN'} | UNKNOWN |`, '',
        ...report.ablation.limitations.map(text => `- ${text}`), ''] : []), `Raw evidence: ${batchRoot}`].join('\n');
    await writeFile(output.replace(/\.json$/u, '.md'), `${md}\n`);
    console.log(JSON.stringify({ batchId, output, history, conditions: report.conditions }, null, 2));
    if (rows.some(row => row.status !== 'SUCCEEDED') || !contentAudit.passed) process.exitCode = 1;
  } finally { await jev?.close(); await fixture.close(); }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
