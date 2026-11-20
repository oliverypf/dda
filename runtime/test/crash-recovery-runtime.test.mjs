import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createThreadStore } from '../src/thread-store.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

import { saveRunGoal, readRunGoal, deleteRunResponse } from '../src/run-response-store.mjs';

const run = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

test('resume records an interrupted side effect and continues the task', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-crash-recovery-'));
  const threadStorePath = join(workspace, 'threads.json');
  const trajectoryPath = join(workspace, 'trajectory.jsonl');
  const plan = normalizePlannerPlan({
    planId: 'interrupted-plan',
    steps: [{ stepId: 'unknown-side-effect', summary: 'recover unknown side effect', actionKind: 'EXECUTE' }]
  }, { objectiveDigest: 'sha256:objective' });
  const threads = createThreadStore({ storagePath: threadStorePath });
  const thread = await threads.create({ cwd: workspace, title: 'interrupted task' });
  const goal = 'Create the presentation. '.repeat(16) + 'End with a slide listing the source data.';
  const db = trajectoryPath + '.db';
  const goalDigest = await saveRunGoal(db, 'run-before-crash', goal);
  const seededCheckpoint = await threads.setCheckpoint(thread.id, {
    goalDigest,
    runId: 'run-before-crash',
    phase: 'EXECUTING',
    state: 'RUNNING',
    plan: {
      planId: plan.planId,
      planDigest: plan.planDigest,
      steps: plan.steps.map((step) => ({
        ...step,
        status: 'RUNNING',
        attempt: 1,
        actionDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }))
    },
    pendingActions: ['reconcile interrupted plan step']
  });
  // Controlled resume validates the lineage against the scoped SQLite store,
  // so seed the source run's creation and checkpoint-commit events there.
  const sourceEvents = createHarnessEventStore({ storagePath: `${trajectoryPath}.db` });
  await sourceEvents.append({
    runId: 'run-before-crash', kind: 'TaskRunCreated',
    payload: { requestedMode: 'CONTROLLED', promptDigest: `sha256:${'0'.repeat(64)}` }
  });
  await sourceEvents.append({
    runId: 'run-before-crash', kind: 'ThreadCheckpointCommitted',
    payload: {
      threadId: thread.id, runId: 'run-before-crash',
      checkpointDigest: seededCheckpoint.checkpointDigest, checkpoint: { runId: 'run-before-crash' }
    }
  });

  const result = await run([
    'task', '--agent-mode', 'multi', '--provider', 'openai', '--model', 'crash-recovery-model',
    '--endpoint', 'http://127.0.0.1:1/responses', '--api-key-env', 'DDA_CRASH_RECOVERY_KEY',
    '--prompt', '继续', '--workspace', workspace,
    '--trajectory-store', trajectoryPath, '--thread-store', threadStorePath,
    '--resume', '--thread-id', thread.id
  ], { DDA_CRASH_RECOVERY_KEY: 'crash-recovery-key' });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  // Controlled channels persist authoritative events in the scoped SQLite
  // store; the JSONL path is no longer written. Read through the event list.
  const listed = await run(['harness-events', 'list', '--trajectory-store', trajectoryPath], {});
  assert.equal(listed.code, 0, `${listed.stderr}\n${listed.stdout}`);
  const events = JSON.parse(listed.stdout.trim()).events;
  const created = events.find((event) => event.kind === 'TaskRunCreated' && event.payload?.sourceRunId);
  assert.equal(created.payload.sourceRunId, 'run-before-crash');
  assert.equal(created.payload.promptDigest, goalDigest);
  assert.equal(await readRunGoal(db, created.runId, goalDigest), goal);
  assert.equal(await readRunGoal(db, created.runId, 'wrong-digest'), undefined);
  await deleteRunResponse(db, created.runId);
  assert.equal(await readRunGoal(db, created.runId, goalDigest), undefined);
  assert.match(created.payload.sourceCheckpointDigest, /^sha256:[0-9a-f]{64}$/);
  const stateChanges = events.filter((event) => event.kind === 'RunStateChanged').map((event) => event.payload);
  assert.ok(stateChanges.some((event) => event.to === 'RECOVERING' && event.reason === 'THREAD_RESUME_RECONCILIATION'));
  assert.equal(events.some((event) => event.kind === 'TaskContinuationStarted'
    && event.payload?.stepIds?.includes('unknown-side-effect')), true, `${result.stderr}\n${result.stdout}`);
  const reconciled = events.filter((event) => event.kind === 'PlanStepStateChanged')
    .flatMap((event) => event.payload?.steps ?? []);
  assert.ok(reconciled.some((step) => step.stepId === 'unknown-side-effect' && step.errorCode === 'SIDE_EFFECT_OUTCOME_UNCERTAIN'));
  assert.equal(events.some((event) => event.kind === 'ToolCallRequested'), false);
  const persisted = JSON.parse(await readFile(threadStorePath, 'utf8'));
  const checkpoint = persisted.threads.find((item) => item.id === thread.id)?.checkpoint;
  assert.equal(checkpoint.goalDigest, goalDigest);
  assert.equal(checkpoint.plan.steps[0].stepId, 'continue-task');
  const missing = await run(['task', '--provider', 'openai', '--model', 'crash-recovery-model',
    '--endpoint', 'http://127.0.0.1:1/responses', '--api-key-env', 'DDA_CRASH_RECOVERY_KEY',
    '--workspace', workspace, '--trajectory-store', trajectoryPath, '--thread-store', threadStorePath,
    '--resume', '--thread-id', thread.id], { DDA_CRASH_RECOVERY_KEY: 'crash-recovery-key' });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /THREAD_RESUME_GOAL_REQUIRED/);
  assert.notEqual(checkpoint.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});
