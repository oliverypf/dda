import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { normalizePlannerPlan } from '../src/agent-turns.mjs';
import { createThreadStore } from '../src/thread-store.mjs';

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

test('resume enters recovery and blocks an interrupted side effect', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-crash-recovery-'));
  const threadStorePath = join(workspace, 'threads.json');
  const trajectoryPath = join(workspace, 'trajectory.jsonl');
  const plan = normalizePlannerPlan({
    planId: 'interrupted-plan',
    steps: [{ stepId: 'unknown-side-effect', summary: 'recover unknown side effect', actionKind: 'EXECUTE' }]
  }, { objectiveDigest: 'sha256:objective' });
  const threads = createThreadStore({ storagePath: threadStorePath });
  const thread = await threads.create({ cwd: workspace, title: 'interrupted task' });
  await threads.setCheckpoint(thread.id, {
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

  const result = await run([
    'task', '--agent-mode', 'multi', '--provider', 'openai', '--model', 'crash-recovery-model',
    '--endpoint', 'http://127.0.0.1:1/responses', '--api-key-env', 'HMCODEX_CRASH_RECOVERY_KEY',
    '--prompt', 'resume interrupted task', '--workspace', workspace,
    '--trajectory-store', trajectoryPath, '--thread-store', threadStorePath,
    '--resume', '--thread-id', thread.id
  ], { HMCODEX_CRASH_RECOVERY_KEY: 'crash-recovery-key' });
  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  const events = (await readFile(trajectoryPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const created = events.find((event) => event.kind === 'TaskRunCreated');
  assert.equal(created.payload.sourceRunId, 'run-before-crash');
  assert.match(created.payload.sourceCheckpointDigest, /^sha256:[0-9a-f]{64}$/);
  const stateChanges = events.filter((event) => event.kind === 'RunStateChanged').map((event) => event.payload);
  assert.ok(stateChanges.some((event) => event.to === 'RECOVERING' && event.reason === 'THREAD_RESUME_RECONCILIATION'));
  assert.equal(events.some((event) => event.kind === 'ToolCallRequested'), false);
  assert.equal(events.some((event) => event.kind === 'RoleTurnCompleted' && event.payload?.role === 'executor'), false);
  assert.equal(events.some((event) => event.kind === 'RoleTurnCompleted' && event.payload?.role === 'semanticVerifier'), false);
  const persisted = JSON.parse(await readFile(threadStorePath, 'utf8'));
  const checkpoint = persisted.threads.find((item) => item.id === thread.id)?.checkpoint;
  assert.equal(checkpoint.phase, 'RECOVERING');
  assert.equal(checkpoint.state, 'FAILED');
  assert.equal(checkpoint.plan.steps[0].status, 'BLOCKED');
  assert.equal(checkpoint.plan.steps[0].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
});
