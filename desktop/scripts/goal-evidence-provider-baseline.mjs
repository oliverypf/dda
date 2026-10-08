#!/usr/bin/env node
// Reproducible product-evidence harness.
//
// It runs a fixed task set against one local OpenAI-compatible model fixture in
// two conditions: a raw same-model baseline and the dda runtime.  The
// output is deliberately explicit about unknown billing and about the fact
// that the baseline is a provider-only control, so a local run cannot be
// mistaken for a production Codex comparison.

import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RUNTIME = join(ROOT, 'runtime');
const outputArg = process.argv.indexOf('--output');
const outputPath = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
const repeatArg = process.argv.indexOf('--repeat');
const repeat = Math.max(1, Math.min(20, Number(repeatArg >= 0 ? process.argv[repeatArg + 1] : 1) || 1));
const PRICE_PER_1K = 0.001;

const TASKS = Object.freeze([
  { taskId: 'inspect-readme-001', prompt: 'TASK inspect-readme-001: inspect the README and report one bounded finding.', recoverable: false },
  { taskId: 'inspect-layout-001', prompt: 'TASK inspect-layout-001: inspect the project layout and report one bounded finding.', recoverable: false },
  { taskId: 'recoverable-read-001', prompt: 'TASK recoverable-read-001: read the fixture README; recover from one missing-file tool error.', recoverable: true }
]);

const json = (value) => JSON.stringify(value);
const sse = (response, events) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  response.end(events.map((event) => `data: ${json(event)}`).join('\n\n') + '\n\ndata: [DONE]\n\n');
};
const textResponse = (text, inputTokens = 12, outputTokens = 4) => [
  { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens } }
];
const toolResponse = (path, callId) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'hmc_workspace_x2e_read', arguments: json({ path }) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 16, completion_tokens: 8 } }
];

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
};

const startFixture = async () => {
  const calls = new Map();
  const server = createServer(async (request, response) => {
    const payload = await readBody(request);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const content = messages.map((message) => typeof message?.content === 'string' ? message.content : json(message?.content ?? '')).join(' ');
    const task = TASKS.find((candidate) => content.includes(candidate.taskId));
    const taskId = task?.taskId ?? 'unknown-task';
    const count = (calls.get(taskId) ?? 0) + 1;
    calls.set(taskId, count);
    const hasToolResult = messages.some((message) => message?.role === 'tool');
    if (task?.recoverable && count === 1) {
      sse(response, toolResponse('missing-fixture-file.md', `call-${taskId}-${count}`));
      return;
    }
    if (task?.recoverable && count === 2) {
      sse(response, toolResponse('README.md', `call-${taskId}-${count}`));
      return;
    }
    sse(response, textResponse(`fixture completed ${taskId}`, task?.recoverable ? 18 : 12, task?.recoverable ? 6 : 4));
  });
  await new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveServer);
  });
  return {
    server,
    endpoint: `http://127.0.0.1:${server.address().port}/chat/completions`,
    calls,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  };
};

const runProcess = (args, env, { cwd = RUNTIME, timeoutMs = 120000 } = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', rejectRun);
  child.once('close', (code) => {
    clearTimeout(timer);
    resolveRun({ code, stdout, stderr });
  });
});

const parseJsonLine = (text) => {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* logger/event line; keep looking */ }
  }
  return undefined;
};

const readEvents = async (path) => {
  try {
    return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const usageFromEvents = (events) => {
  const samples = events.filter((event) => event.kind === 'ModelUsageRecorded').map((event) => event.payload ?? {});
  const inputTokens = samples.reduce((sum, sample) => sum + (Number.isFinite(sample.inputTokens) ? sample.inputTokens : 0), 0);
  const outputTokens = samples.reduce((sum, sample) => sum + (Number.isFinite(sample.outputTokens) ? sample.outputTokens : 0), 0);
  const known = samples.length > 0 && samples.every((sample) => Number.isFinite(sample.inputTokens) && Number.isFinite(sample.outputTokens));
  return { calls: samples.length, inputTokens: known ? inputTokens : null, outputTokens: known ? outputTokens : null, totalTokens: known ? inputTokens + outputTokens : null };
};

const parseDirectResult = async (fixture, task) => {
  const startedAt = Date.now();
  const response = await fetch(fixture.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json({ model: 'evidence-fixture', messages: [{ role: 'user', content: task.prompt }], stream: true, tools: task.recoverable ? [{ type: 'function', function: { name: 'hmc_workspace_x2e_read', parameters: {} } }] : undefined })
  });
  const body = await response.text();
  const hasToolCall = body.includes('tool_calls');
  const usageLine = body.split(/\r?\n/).find((line) => line.startsWith('data: {') && line.includes('usage'));
  let usage;
  try { usage = JSON.parse(usageLine.slice(6)).usage; } catch { usage = undefined; }
  return {
    condition: 'same-model-provider-baseline',
    taskId: task.taskId,
    status: response.ok && !hasToolCall ? 'SUCCEEDED' : 'FAILED',
    firstAttemptStatus: response.ok && !hasToolCall ? 'SUCCEEDED' : 'FAILED',
    recovered: false,
    manualInterventionMinutes: 0,
    inputTokens: Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : null,
    outputTokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : null,
    totalTokens: Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens) ? usage.prompt_tokens + usage.completion_tokens : null,
    estimatedCost: Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens) ? ((usage.prompt_tokens + usage.completion_tokens) / 1000) * PRICE_PER_1K : null,
    actualCost: null,
    toolRounds: 0,
    toolCallCount: 0,
    recoveryAttempts: 0,
    wallMs: Date.now() - startedAt,
    errorAttempts: hasToolCall ? 1 : 0,
    evidenceClass: 'LOCAL_PROVIDER_FIXTURE'
  };
};

const runDda = async (fixture, workspace, task, index) => {
  const runRoot = await mkdtemp(join(workspace, `run-${task.taskId}-${index}-`));
  const trajectory = join(runRoot, 'trajectory.jsonl');
  const threadStore = join(runRoot, 'threads.json');
  const startedAt = Date.now();
  const env = {
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
    HMCODEX_EXECUTION_MODE: 'READ_ONLY',
    HMCODEX_CONTEXT_PROVIDER: 'journal',
    HMCODEX_EVIDENCE_TASK_ID: task.taskId,
    EVIDENCE_FIXTURE_KEY: 'fixture-key',
    HMCODEX_TRAJECTORY_STORE: trajectory,
    HMCODEX_THREAD_STORE: threadStore
  };
  const result = await runProcess([
    'task', '--provider', 'openai-chat', '--protocol', 'chat-completions', '--model', 'evidence-fixture',
    '--endpoint', fixture.endpoint, '--api-key-env', 'EVIDENCE_FIXTURE_KEY', '--prompt', task.prompt,
    '--workspace', workspace, '--trajectory-store', trajectory, '--thread-store', threadStore,
    '--max-recovery-attempts', '2'
  ], env);
  const payload = parseJsonLine(result.stdout);
  let events = await readEvents(trajectory);
  const eventStoreResult = await runProcess(['harness-events', 'list', '--trajectory-store', trajectory, '--run-id', payload?.runId ?? ''], env, { timeoutMs: 30000 });
  const eventStorePayload = parseJsonLine(eventStoreResult.stdout);
  if (Array.isArray(eventStorePayload?.events) && eventStorePayload.events.length) events = eventStorePayload.events;
  const usage = usageFromEvents(events);
  let dashboardUsage;
  const dashboard = await runProcess(['dashboard', '--trajectory-store', trajectory, '--thread-store', threadStore], env, { timeoutMs: 30000 });
  const dashboardPayload = parseJsonLine(dashboard.stdout);
  dashboardUsage = dashboardPayload?.modelUsage ?? dashboardPayload?.stores?.modelUsage;
  if (dashboardUsage && Number.isFinite(dashboardUsage.inputTokens) && Number.isFinite(dashboardUsage.outputTokens)) {
    usage.inputTokens = dashboardUsage.inputTokens;
    usage.outputTokens = dashboardUsage.outputTokens;
    usage.totalTokens = dashboardUsage.inputTokens + dashboardUsage.outputTokens;
  }
  const unwrapEventPayload = (event) => event?.payload?.payload ?? event?.payload ?? {};
  const toolRequests = events.filter((event) => event.kind === 'ToolCallRequested').map(unwrapEventPayload);
  const toolRequestKeys = new Set(toolRequests.map((item) => JSON.stringify({
    attempt: item.attempt ?? 0,
    round: item.round ?? 0,
    name: item.name ?? '',
    argumentsDigest: item.argumentsDigest ?? ''
  })));
  const toolRoundKeys = new Set(toolRequests.map((item) => JSON.stringify({ attempt: item.attempt ?? 0, round: item.round ?? 0 })));
  const toolCompletions = events.filter((event) => event.kind === 'ToolInvocationCompleted').map(unwrapEventPayload);
  const toolCompletionKeys = new Set(toolCompletions.map((item) => JSON.stringify({
    name: item.name ?? '',
    inputDigest: item.inputDigest ?? item.argumentsDigest ?? '',
    outputDigest: item.outputDigest ?? '',
    errorCode: item.errorCode ?? ''
  })));
  const recoveryEvents = events.filter((event) => event.kind === 'RecoveryStarted');
  const recoveryAttempts = recoveryEvents.length || events.filter((event) => event.kind === 'DiagnosisRequested').length;
  const errorAttempts = events.filter((event) => event.kind === 'ToolInvocationCompleted' && unwrapEventPayload(event).ok === false).length;
  const ok = result.code === 0 && payload?.ok === true;
  const firstAttemptStatus = recoveryAttempts > 0 || errorAttempts > 0 ? 'FAILED' : ok ? 'SUCCEEDED' : 'FAILED';
  const runResult = {
    condition: 'hmcodex-runtime',
    taskId: task.taskId,
    status: ok ? 'SUCCEEDED' : 'FAILED',
    firstAttemptStatus,
    recovered: ok && (recoveryAttempts > 0 || errorAttempts > 0),
    manualInterventionMinutes: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    estimatedCost: usage.totalTokens === null ? null : (usage.totalTokens / 1000) * PRICE_PER_1K,
    actualCost: null,
    toolRounds: Number.isFinite(payload?.toolRounds) && payload.toolRounds > 0 ? payload.toolRounds : (toolRoundKeys.size || toolCompletionKeys.size),
    toolCallCount: Number.isFinite(payload?.toolCallCount) && payload.toolCallCount > 0 ? payload.toolCallCount : Math.max(toolRequestKeys.size, toolCompletionKeys.size),
    recoveryAttempts,
    wallMs: Date.now() - startedAt,
    errorAttempts,
    runId: payload?.runId,
    evidenceClass: 'LOCAL_RUNTIME_FIXTURE',
    ...(ok ? {} : { error: String(payload?.error ?? result.stderr).slice(0, 300), eventKinds: [...new Set(events.map((event) => event.kind))].slice(-24) })
  };
  await rm(runRoot, { recursive: true, force: true });
  return runResult;
};

const summarize = (rows, condition) => {
  const selected = rows.filter((row) => row.condition === condition);
  const successes = selected.filter((row) => row.status === 'SUCCEEDED').length;
  const firstSuccesses = selected.filter((row) => row.firstAttemptStatus === 'SUCCEEDED').length;
  const recoverable = selected.filter((row) => row.recoveryAttempts > 0 || row.errorAttempts > 0).length;
  const recovered = selected.filter((row) => row.recovered).length;
  const knownTokens = selected.filter((row) => Number.isFinite(row.totalTokens));
  return {
    runs: selected.length,
    successes,
    successRate: selected.length ? successes / selected.length : null,
    firstAttemptSuccesses: firstSuccesses,
    firstAttemptSuccessRate: selected.length ? firstSuccesses / selected.length : null,
    recoveryOpportunities: recoverable,
    recoverySuccesses: recovered,
    recoverySuccessRate: recoverable ? recovered / recoverable : null,
    manualInterventionMinutes: selected.reduce((sum, row) => sum + (Number(row.manualInterventionMinutes) || 0), 0),
    totalTokens: knownTokens.length === selected.length ? knownTokens.reduce((sum, row) => sum + row.totalTokens, 0) : null,
    estimatedCost: selected.every((row) => Number.isFinite(row.estimatedCost)) ? selected.reduce((sum, row) => sum + row.estimatedCost, 0) : null,
    actualCost: selected.every((row) => Number.isFinite(row.actualCost)) ? selected.reduce((sum, row) => sum + row.actualCost, 0) : null,
    toolRounds: selected.every((row) => Number.isFinite(row.toolRounds)) ? selected.reduce((sum, row) => sum + row.toolRounds, 0) : null,
    toolCallCount: selected.every((row) => Number.isFinite(row.toolCallCount)) ? selected.reduce((sum, row) => sum + row.toolCallCount, 0) : null
  };
};

const main = async () => {
  const fixture = await startFixture();
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-goal-evidence-'));
  await writeFile(join(workspace, 'README.md'), '# evidence fixture\n', 'utf8');
  try {
    const rows = [];
    for (let index = 0; index < repeat; index += 1) {
      // Each repetition must inject the same failure for both conditions.
      // Otherwise the previous runtime run consumes the baseline sequence.
      fixture.calls.clear();
      for (const task of TASKS) rows.push(await parseDirectResult(fixture, task));
      // Baseline requests must not consume the fixture's deterministic
      // recovery sequence for the dda condition.
      fixture.calls.clear();
      for (const task of TASKS) rows.push(await runDda(fixture, workspace, task, index));
    }
    const report = {
      schemaVersion: '1.0',
      generatedAt: new Date().toISOString(),
      taskSet: TASKS.map(({ taskId, recoverable }) => ({ taskId, recoverable })),
      conditions: {
        'same-model-provider-baseline': summarize(rows, 'same-model-provider-baseline'),
        'hmcodex-runtime': summarize(rows, 'hmcodex-runtime')
      },
      rows,
      cost: { currency: 'USD', pricePer1kTokens: PRICE_PER_1K, actualCost: 'UNKNOWN', reason: 'fixture does not report provider billing; estimatedCost is derived from the declared local fixture price' },
      caveats: [
        'The baseline is a raw provider-only same-model control, not the full ordinary Codex product.',
        'Local fixture results establish repeatability and instrumentation, not production quality or savings.',
        'manualInterventionMinutes is zero because no human approval/input is used in this fixture.'
      ]
    };
    const markdown = [
      '# Goal evidence benchmark', '',
      `Generated: ${report.generatedAt}`, '',
      '| Condition | Success | First attempt | Recovery opportunities | Recovery success | Manual minutes | Total tokens | Estimated cost | Tool rounds |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
      ...Object.entries(report.conditions).map(([condition, summary]) => `| ${condition} | ${summary.successes}/${summary.runs} (${(summary.successRate * 100).toFixed(1)}%) | ${summary.firstAttemptSuccesses}/${summary.runs} (${(summary.firstAttemptSuccessRate * 100).toFixed(1)}%) | ${summary.recoveryOpportunities} | ${summary.recoverySuccesses} | ${summary.manualInterventionMinutes} | ${summary.totalTokens ?? 'UNKNOWN'} | ${summary.estimatedCost ?? 'UNKNOWN'} | ${summary.toolRounds ?? 'UNKNOWN'} |`),
      '', 'Actual provider cost is UNKNOWN; the estimated cost uses the local fixture price. The baseline is provider-only.'
    ].join('\n');
    const jsonOutput = outputPath ?? join(ROOT, 'docs', 'artifacts', 'AGENT_GOAL_EVIDENCE_BENCHMARK.json');
    const markdownOutput = jsonOutput.replace(/\.json$/u, '.md');
    await writeFile(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(markdownOutput, `${markdown}\n`, 'utf8');
    console.log(JSON.stringify({ json: jsonOutput, markdown: markdownOutput, conditions: report.conditions }, null, 2));
  } finally {
    await fixture.close();
    await rm(workspace, { recursive: true, force: true });
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
