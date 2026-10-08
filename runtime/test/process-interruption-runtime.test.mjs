import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenOnFetchablePort } from './helpers/listen-loopback.mjs';
import { emitGoalResponse } from '../../desktop/scripts/goal-model-fixture.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';

const bounded = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`PROCESS_TEST_TIMEOUT:${label}`)), 20000);
    })]);
  } finally { clearTimeout(timer); }
};

const startRuntime = (args, env) => {
  const child = spawn(process.execPath, ['src/index.mjs', ...args], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
};

const inputText = body => JSON.stringify(body.input ?? []);
const emitText = (res, text) => emitGoalResponse(res, [{
  type: 'message', role: 'assistant', content: [{ type: 'output_text', text }]
}]);
const emitCall = (res, name, args, id) => emitGoalResponse(res, [{
  type: 'function_call', id, call_id: id, name, arguments: JSON.stringify(args)
}]);

const exerciseInterruption = async (t, { sideEffect = false, resumeMode = 'READ_ONLY', releaseChannel = 'WINDOWS_FULL_LOCAL' } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-process-interruption-'));
  t.diagnostic(`Evidence directory: ${root}`);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'first.txt'), 'FIRST_STEP_NATIVE_EVIDENCE');
  await writeFile(join(workspace, 'second.txt'), 'SECOND_STEP_NATIVE_EVIDENCE');
  const trajectory = join(root, 'trajectory.jsonl');
  const threads = join(root, 'threads.json');
  const requests = [];
  let phase = 'before-kill', heldResponse;
  let reachedInterruption;
  const interrupted = new Promise(resolve => { reachedInterruption = resolve; });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ phase, body });
      if (/Planner role/iu.test(String(body.instructions ?? ''))) {
        emitText(res, JSON.stringify({ planId: 'actual-process-interruption', steps: [
          { stepId: 'completed', summary: 'read first.txt', actionKind: 'READ' },
          { stepId: 'interrupted', summary: sideEffect ? 'write result.txt' : 'read second.txt',
            actionKind: sideEffect ? 'EXECUTE' : 'READ', dependencies: ['completed'] }
        ] }));
        return;
      }
      const second = inputText(body).includes('Current validated plan step: interrupted');
      const outputs = (body.input ?? []).filter(item => item.type === 'function_call_output');
      if (second && phase === 'before-kill' && (!sideEffect || outputs.length)) {
        // Hold a real model request only after the host has durably started
        // step two. In the write case its actual tool result is already here.
        heldResponse = res;
        reachedInterruption();
        return;
      }
      if (outputs.length) {
        emitText(res, second ? 'SECOND_STEP_NATIVE_EVIDENCE' : 'FIRST_STEP_NATIVE_EVIDENCE');
      } else if (second && sideEffect) {
        emitCall(res, 'file.write', { path: 'result.txt', content: 'ACTUAL_WRITE_BEFORE_KILL' }, 'write-once');
      } else {
        emitCall(res, 'workspace.read', { path: second ? 'second.txt' : 'first.txt' }, `read-${requests.length}`);
      }
    } catch (error) { res.destroy(error); }
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = await listenOnFetchablePort(server);
  const config = join(root, 'model.json');
  await writeFile(config, JSON.stringify({ provider: 'openai', protocol: 'responses',
    model: 'process-interruption-fixture', endpoint: `http://127.0.0.1:${port}/model`,
    apiKeyEnv: 'HMCODEX_PROCESS_TEST_KEY', decision: { enabled: false, enforce: false } }));
  const env = { HMCODEX_PROCESS_TEST_KEY: 'local-fixture', HMCODEX_JEV_ENABLED: '0',
    HMCODEX_JEV_ENFORCE: '0', HMCODEX_CONTEXT_PROVIDER: 'journal', HMCODEX_DATA_DIR: root,
    HMCODEX_RELEASE_CHANNEL: releaseChannel, HMCODEX_EXECUTION_MODE: 'READ_ONLY' };
  const common = ['task', '--agent-mode', 'multi', '--config', config, '--workspace', workspace,
    '--trajectory-store', trajectory, '--thread-store', threads, '--max-recovery-attempts', '1'];
  const first = startRuntime([...common, '--prompt', sideEffect ? 'Inspect first.txt then write result.txt.' : 'Read both files in order.',
    ...(sideEffect ? ['--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write'] : [])], env);
  t.after(async () => {
    if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL');
    await bounded(first.closed, 'cleanup');
  });
  await bounded(Promise.race([interrupted, first.closed.then(result => {
    throw Error(`RUNTIME_EXITED_BEFORE_INTERRUPTION:${result.code}:${result.stderr}:${result.stdout}`);
  })]), 'reach-durable-step');
  const before = JSON.parse(await readFile(threads, 'utf8')).threads[0];
  assert.equal(before.checkpoint.state, 'RUNNING');
  assert.deepEqual(before.checkpoint.plan.steps.map(step => step.status), ['SUCCEEDED', 'RUNNING']);
  const completed = before.checkpoint.plan.steps[0];
  assert.match(completed.outputDigest, /^sha256:[a-f0-9]{64}$/u);
  if (sideEffect) assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'ACTUAL_WRITE_BEFORE_KILL');

  assert.equal(first.child.kill('SIGKILL'), true, 'terminate only the owned live runtime');
  const killed = await bounded(first.closed, 'force-termination');
  assert.notEqual(killed.code, 0, 'the initial run never completed normally');
  assert.equal(first.child.killed, true);
  assert.deepEqual(JSON.parse(await readFile(threads, 'utf8')).threads[0].checkpoint.plan.steps.map(step => step.status),
    ['SUCCEEDED', 'RUNNING'], 'the checkpoint was not synthesized or rewritten after termination');
  heldResponse.destroy();
  phase = 'after-kill';
  const beforeResume = requests.length;
  const resumed = await runEvidenceProcess(process.execPath, ['src/index.mjs', ...common,
    '--resume', '--thread-id', before.id, '--execution-mode', resumeMode,
    ...(resumeMode === 'CONTROLLED' ? ['--lease-capabilities', 'file.write'] : []),
    '--prompt', 'Continue the interrupted task from its checkpoint.'], {
    cwd: new URL('..', import.meta.url), env, timeoutMs: 30000
  });
  let events;
  if (releaseChannel === 'WINDOWS_PHASE1_READ_ONLY') {
    const listed = await runEvidenceProcess(process.execPath, ['src/index.mjs', 'harness-events', 'list',
      '--trajectory-store', trajectory], { cwd: new URL('..', import.meta.url), env, timeoutMs: 30000 });
    assert.equal(listed.code, 0, listed.stderr + listed.stdout);
    events = JSON.parse(listed.stdout.trim()).events;
  } else {
    events = (await readFile(trajectory, 'utf8')).trim().split(/\r?\n/u).map(line => JSON.parse(line));
  }
  const resumedRun = events.find(event => event.kind === 'TaskRunCreated' && event.payload?.sourceRunId === before.checkpoint.runId);
  assert.ok(resumedRun, 'a new process resumes the actual source run');
  assert.equal(resumedRun.payload.sourceCheckpointDigest, before.checkpoint.checkpointDigest);
  const after = JSON.parse(await readFile(threads, 'utf8')).threads.find(x => x.id === before.id);
  const resumeRequests = requests.slice(beforeResume);
  assert.equal(resumeRequests.filter(x => /Planner role/iu.test(String(x.body.instructions ?? ''))).length, 0);
  assert.equal(resumeRequests.filter(x => inputText(x.body).includes('Current validated plan step: completed')).length, 0);
  const durablePlan = events.filter(event => event.runId === resumedRun.runId && event.kind === 'PlanStepStateChanged').at(-1)?.payload;
  const afterCompleted = durablePlan?.steps?.find(step => step.stepId === 'completed');
  assert.ok(afterCompleted, resumed.stderr + resumed.stdout);
  assert.equal(afterCompleted.outputDigest, completed.outputDigest);
  assert.equal(afterCompleted.attempt, completed.attempt);
  return { resumed, after, completed, durablePlan, requests: resumeRequests, events, resumedRun, workspace };
};

test('a killed read-only runtime resumes pending work without repeating completed steps', { timeout: 60000 }, async t => {
  const { resumed, events, resumedRun, requests, durablePlan } = await exerciseInterruption(t);
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  const payload = JSON.parse(resumed.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.plan.steps.map(step => step.status), ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal(durablePlan.steps[1].attempt, 2, 'the second execution attempt is recorded in the durable host events');
  assert.equal(requests.length, 2, 'only the interrupted read and its observed result are sent');
  assert.ok(inputText(requests.at(-1).body).includes('SECOND_STEP_NATIVE_EVIDENCE'));
  const nativeReads = events.filter(event => event.runId === resumedRun.runId && event.kind === 'ToolInvocationCompleted');
  assert.equal(nativeReads.length, 1);
  assert.equal(nativeReads[0].payload.name, 'workspace.read');
  assert.equal(nativeReads[0].payload.ok, true);
  const states = events.filter(event => event.runId === resumedRun.runId && event.kind === 'RunStateChanged').map(x => x.payload);
  const reconciliation = states.findIndex(x => x.reason === 'THREAD_RESUME_RECONCILIATION');
  assert.ok(reconciliation >= 0);
  assert.equal(states[reconciliation + 1].to, 'EXECUTING');
  assert.equal(states[reconciliation + 1].reason, 'resume:interrupted');
});

test('a killed controlled write remains blocked when resumed in read-only mode', { timeout: 60000 }, async t => {
  const { resumed, after, requests, workspace } = await exerciseInterruption(t, { sideEffect: true });
  assert.notEqual(resumed.code, 0);
  assert.equal(after.checkpoint.plan.steps[1].status, 'BLOCKED');
  assert.equal(after.checkpoint.plan.steps[1].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
  assert.equal(requests.length, 0, 'changing the resume mode cannot turn an uncertain write into a retry');
  assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'ACTUAL_WRITE_BEFORE_KILL');
});

test('a read-only source does not authorize replay after upgrading the resume mode', { timeout: 60000 }, async t => {
  const { resumed, after, requests } = await exerciseInterruption(t, { resumeMode: 'CONTROLLED' });
  assert.notEqual(resumed.code, 0);
  assert.equal(after.checkpoint.plan.steps[1].errorCode, 'SIDE_EFFECT_OUTCOME_UNCERTAIN');
  assert.equal(requests.length, 0);
});

test('a killed read-only runtime resumes with the phase-one SQLite event store', { timeout: 60000 }, async t => {
  const { resumed, requests } = await exerciseInterruption(t, { releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' });
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  const payload = JSON.parse(resumed.stdout.trim());
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.plan.steps.map(step => step.status), ['SUCCEEDED', 'SUCCEEDED']);
  assert.equal(requests.length, 2);
});
