import test from 'node:test';import assert from 'node:assert/strict';import { createRecoveryContext, runVerifierRecovery } from '../src/task-recovery-controller.mjs';test('recovers CONTINUE reports and stops after a successful verification', async () => {  const phases = [];  const attempts = [];  const result = await runVerifierRecovery({    maxAttempts: 3,    execute: async ({ attempt, recovery, previousActions }) => {      attempts.push({ attempt, recovery, previousActions });      return {        text: attempt === 1 ? 'partial' : 'complete',        actions: [{ argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }]      };    },    verify: async ({ attempt }) => attempt === 1      ? { status: 'CONTINUE', summary: 'more evidence required', nextAction: 'CONTINUE_EXECUTION', progress: 0.5 }      : { status: 'PASS', summary: 'verified', progress: 1 },    onPhase: ({ phase, attempt }) => phases.push(`${phase}:${attempt}`)  });  assert.equal(result.ok, true);  assert.equal(result.attempts, 2);  assert.deepEqual(result.history.map((item) => item.status), ['CONTINUE', 'PASS']);  assert.deepEqual(phases, ['EXECUTING:1', 'DIAGNOSING:1', 'RECOVERING:1', 'EXECUTING:2']);  assert.equal(attempts[1].previousActions.length, 1);  assert.equal(attempts[1].recovery.verifierStatus, 'CONTINUE');});test('does not recover hard failures or exceed the configured budget', async () => {  let executions = 0;  const hardFailure = await runVerifierRecovery({    execute: async () => { executions += 1; return {}; },    verify: async () => ({ status: 'FAIL', failureCodes: ['PATH_OUT_OF_SCOPE'] })  });  assert.equal(hardFailure.ok, false);  assert.equal(hardFailure.attempts, 1);  assert.equal(executions, 1);  const stalled = await runVerifierRecovery({    maxAttempts: 2,    execute: async ({ attempt }) => ({ actions: [{ actionDigest: `action-${attempt}` }] }),    verify: async () => ({ status: 'STALLED', summary: 'no new evidence' })  });  assert.equal(stalled.ok, false);  assert.equal(stalled.exhausted, true);  assert.equal(stalled.attempts, 2);});test('recovery context contains only bounded verifier facts and action digests', () => {  const context = createRecoveryContext({    status: 'UNCERTAIN',    summary: 'line\nnoise',    nextAction: 'REQUEST_EVIDENCE',    failureCodes: ['UNKNOWN'],    progress: 0.25  }, {    attempt: 2,    previousActions: [{ argumentsDigest: 'sha256:abc' }, { command: 'secret command' }]  });  assert.deepEqual(context, {    attempt: 2,    verifierStatus: 'UNCERTAIN',    summary: 'line noise',    nextAction: 'REQUEST_EVIDENCE',    failureCodes: ['UNKNOWN'],    progress: 0.25,    previousActionDigests: ['sha256:abc'], previousActionObservations: [{ name: 'unknown', state: 'UNKNOWN', argumentsDigest: 'sha256:abc' }, { name: 'unknown', state: 'UNKNOWN' }]  });  assert.equal('command' in context, false);});

test('terminal FAIL report stops recovery without another execute', async () => {
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 3,
    execute: async () => { executions += 1; return { text: 'attempt' }; },
    verify: async () => ({ status: 'FAIL', failureCodes: ['RUN_TERMINATED'], summary: 'terminal' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(executions, 1);
  assert.deepEqual(result.report.failureCodes, ['RUN_TERMINATED']);
});

test('terminal CANCELLED report also stops recovery without retry', async () => {
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 2,
    execute: async () => { executions += 1; return {}; },
    verify: async () => ({ status: 'CANCELLED', failureCodes: ['RUN_TERMINATED'], summary: 'cancelled' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
  assert.equal(executions, 1);
});

test('stops before another execution when recovery selects stop and report', async () => {
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 3,
    execute: async () => { executions += 1; return { actions: [] }; },
    verify: async () => ({ status: 'UNCERTAIN', failureCodes: ['UNKNOWN'] }),
    diagnose: async () => ({ stopRecovery: true, recoveryDirection: 'stop-and-report' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.equal(result.stopReason, 'stop-and-report');
  assert.equal(executions, 1);
});

test('pauses before another execution when recovery requests user input', async () => {
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 3,
    execute: async () => { executions += 1; return { actions: [] }; },
    verify: async () => ({ status: 'UNCERTAIN', failureCodes: ['MISSING_SCOPE'] }),
    diagnose: async () => ({ requestUser: true, recoveryDirection: 'request-user' })
  });
  assert.equal(result.ok, false);
  assert.equal(result.requestUser, true);
  assert.equal(result.stopped, false);
  assert.equal(result.stopReason, 'request-user');
  assert.equal(executions, 1);
});
