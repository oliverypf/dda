import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createEffectJournal } from '../src/kernel/effect-journal.mjs';
import { createExecutionStateStore } from '../src/execution-state-store.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { createTrajectoryStore, sha256Digest } from '../src/trajectory-store.mjs';

const runtimeRoot = new URL('..', import.meta.url);

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: runtimeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

const childEnv = (extra) => {
  const env = {
    ...process.env,
    ...extra,
    DDA_CRASH_RECOVERY_KEY: 'crash-recovery-key',
    DDA_KERNEL_CODE_CELLS: '1'
  };
  delete env.DDA_RESIDENT_KERNEL;
  delete env.DDA_KERNEL_EFFECTS;
  delete env.DDA_KERNEL_SANDBOX;
  return env;
};

// Seed the records and trajectory a controlled run leaves behind when the
// lease is issued and then fails before the effect journal records STARTED.
const seedPreStartFailure = async (workspace, { journalState = 'empty' } = {}) => {
  const threadStorePath = join(workspace, 'threads.json');
  const trajectoryPath = join(workspace, 'trajectory.jsonl');
  const executionPath = join(workspace, 'execution.json');
  const journalPath = join(workspace, 'effect-journal.json');
  const sourceRunId = 'run-before-crash';
  const plan = normalizePlannerPlan({
    planId: 'prestart-plan',
    steps: [
      { stepId: 'inspect', summary: 'inspect the workspace before writing', actionKind: 'EXECUTE' },
      { stepId: 'report', summary: 'report the inspection', actionKind: 'EXECUTE', dependencies: ['inspect'] }
    ]
  }, { objectiveDigest: sha256Digest('prestart objective') });
  const threads = createThreadStore({ storagePath: threadStorePath });
  const thread = await threads.create({ cwd: workspace, title: 'prestart failure' });
  const trajectory = createTrajectoryStore(trajectoryPath);
  const execution = createExecutionStateStore({ storagePath: executionPath });
  const intent = await execution.createIntent({
    runId: sourceRunId,
    capability: 'WRITE_FILE',
    request: { path: 'notes.txt' },
    operationId: 'operation-prestart'
  });
  await execution.transition(intent.recordId, 'SAFETY_EVALUATING');
  await execution.transition(intent.recordId, 'WAITING_APPROVAL');
  const approval = await execution.createApproval({
    runId: sourceRunId,
    intentId: intent.recordId,
    capability: 'WRITE_FILE',
    requestDigest: intent.requestDigest,
    displayedDigest: intent.requestDigest,
    operationId: intent.operationId
  });
  await execution.transition(approval.recordId, 'PRESENTED');
  await execution.transition(approval.recordId, 'APPROVED');
  await execution.transition(intent.recordId, 'APPROVED');
  await execution.transition(intent.recordId, 'EXECUTING');
  const lease = await execution.createLease({
    runId: sourceRunId,
    intentId: intent.recordId,
    approvalId: approval.recordId,
    capability: 'WRITE_FILE',
    requestDigest: intent.requestDigest,
    operationId: intent.operationId,
    commands: [],
    expiresAt: Date.now() + 10 * 60 * 1000
  });
  await execution.transition(lease.recordId, 'ACTIVE');
  await execution.revokeLease(lease.recordId, 'EXECUTION_OUTCOME_UNCERTAIN');
  await execution.transition(intent.recordId, 'FAILED', { reason: 'EXECUTION_OUTCOME_UNCERTAIN' });

  await trajectory.append({
    runId: sourceRunId,
    kind: 'TaskRunCreated',
    payload: { requestedMode: 'CONTROLLED', promptDigest: sha256Digest('previous controlled task') }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'PlanStepStateChanged',
    payload: {
      currentStepId: 'inspect',
      steps: [
        { stepId: 'inspect', status: 'RUNNING', attempt: 1 },
        { stepId: 'report', status: 'PENDING', attempt: 0 }
      ]
    }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'ExecutionStateChanged',
    payload: { recordType: 'intent', recordId: intent.recordId, state: 'PROPOSED', intentId: intent.recordId }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'ActionAuthorized',
    payload: { intentId: intent.recordId, leaseId: lease.recordId, operationId: intent.operationId, capability: 'WRITE_FILE' }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'ActionLeased',
    payload: { intentId: intent.recordId, leaseId: lease.recordId, operationId: intent.operationId, capability: 'WRITE_FILE' }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'LeaseExecutionFailed',
    payload: { intentId: intent.recordId, leaseId: lease.recordId, capability: 'WRITE_FILE', errorCode: 'JOURNAL_UNAVAILABLE' }
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'ActionFailed',
    payload: {
      intentId: intent.recordId,
      leaseId: lease.recordId,
      operationId: intent.operationId,
      capability: 'WRITE_FILE',
      errorCode: 'JOURNAL_UNAVAILABLE'
    }
  });

  const checkpoint = await threads.setCheckpoint(thread.id, {
    runId: sourceRunId,
    phase: 'EXECUTING',
    state: 'RUNNING',
    plan: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      steps: plan.steps.map((step) => ({
        stepId: step.stepId,
        summary: step.summary,
        actionKind: step.actionKind,
        dependencies: step.dependencies,
        status: step.stepId === 'inspect' ? 'RUNNING' : 'PENDING',
        ...(step.stepId === 'inspect' ? { attempt: 1 } : { attempt: 0 })
      }))
    },
    pendingActions: ['reconcile interrupted plan step']
  });
  await trajectory.append({
    runId: sourceRunId,
    kind: 'ThreadCheckpointCommitted',
    payload: {
      threadId: thread.id,
      runId: sourceRunId,
      checkpointDigest: checkpoint.checkpointDigest,
      checkpoint: { runId: sourceRunId }
    }
  });

  if (journalState === 'started') {
    const journal = createEffectJournal({ storagePath: journalPath });
    await journal.recordRequested({
      effectId: 'effect-prestart',
      kind: 'kernel.exec',
      bit: 1,
      runId: sourceRunId,
      toolCallId: 'tool-prestart'
    });
    await journal.recordStarted('effect-prestart', { leaseId: lease.recordId, capability: 'WRITE_FILE' });
  }

  return { thread, workspace, threadStorePath, trajectoryPath, executionPath, journalPath };
};

const resumeArgs = (seed) => [
  'task', '--provider', 'openai', '--model', 'crash-recovery-model',
  '--endpoint', 'http://127.0.0.1:1/responses', '--api-key-env', 'DDA_CRASH_RECOVERY_KEY',
  '--prompt', 'resume the interrupted inspect step', '--workspace', seed.workspace,
  '--execution-mode', 'CONTROLLED',
  '--trajectory-store', seed.trajectoryPath,
  '--thread-store', seed.threadStorePath,
  '--execution-state-store', seed.executionPath,
  '--kernel-effect-journal', seed.journalPath,
  '--resume', '--thread-id', seed.thread.id
];

const readEvents = async (trajectoryPath) => (await readFile(trajectoryPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

const stepErrorCodes = (events) => events
  .filter((event) => event.kind === 'PlanStepStateChanged')
  .flatMap((event) => (event.payload?.steps ?? []).map((step) => step.errorCode).filter(Boolean));

test('controlled resume retries a FAILED intent that the effect journal never started', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-prestart-retry-'));
  const seed = await seedPreStartFailure(workspace);
  const result = await run(resumeArgs(seed), childEnv());
  const events = await readEvents(seed.trajectoryPath);
  const codes = stepErrorCodes(events);
  assert.ok(codes.includes('RECONCILED_SAFE_TO_RETRY'), `${result.stderr}\n${result.stdout}\ncodes=${codes.join(',')}`);
  const persisted = JSON.parse(await readFile(seed.threadStorePath, 'utf8'));
  const inspect = persisted.threads.find((item) => item.id === seed.thread.id)?.checkpoint?.plan?.steps
    ?.find((step) => step.stepId === 'inspect');
  assert.notEqual(inspect?.errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});

test('controlled resume stays uncertain when the journal had already started the effect', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dda-prestart-started-'));
  const seed = await seedPreStartFailure(workspace, { journalState: 'started' });
  const result = await run(resumeArgs(seed), childEnv());
  const events = await readEvents(seed.trajectoryPath);
  const codes = stepErrorCodes(events);
  assert.ok(!codes.includes('RECONCILED_SAFE_TO_RETRY'), `${result.stderr}\n${result.stdout}\ncodes=${codes.join(',')}`);
  const persisted = JSON.parse(await readFile(seed.threadStorePath, 'utf8'));
  const inspect = persisted.threads.find((item) => item.id === seed.thread.id)?.checkpoint?.plan?.steps
    ?.find((step) => step.stepId === 'inspect');
  assert.equal(inspect?.status, 'BLOCKED', `${result.stderr}\n${result.stdout}`);
  assert.equal(inspect?.errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
  const journal = JSON.parse(await readFile(seed.journalPath, 'utf8'));
  assert.equal(journal.effects.find((effect) => effect.effectId === 'effect-prestart')?.state, 'UNKNOWN');
});
