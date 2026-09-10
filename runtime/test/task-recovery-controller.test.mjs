import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryContext, runVerifierRecovery } from '../src/task-recovery-controller.mjs';

test('recovers CONTINUE reports and stops after a successful verification', async () => {
  const phases = [];
  const attempts = [];
  const result = await runVerifierRecovery({
    maxAttempts: 3,
    execute: async ({ attempt, recovery, previousActions }) => {
      attempts.push({ attempt, recovery, previousActions });
      return {
        text: attempt === 1 ? 'partial' : 'complete',
        actions: [{ argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }]
      };
    },
    verify: async ({ attempt }) => attempt === 1
      ? { status: 'CONTINUE', summary: 'more evidence required', nextAction: 'CONTINUE_EXECUTION', progress: 0.5 }
      : { status: 'PASS', summary: 'verified', progress: 1 },
    onPhase: ({ phase, attempt }) => phases.push(`${phase}:${attempt}`)
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.history.map((item) => item.status), ['CONTINUE', 'PASS']);
  assert.deepEqual(phases, ['EXECUTING:1', 'DIAGNOSING:1', 'RECOVERING:1', 'EXECUTING:2']);
  assert.equal(attempts[1].previousActions.length, 1);
  assert.equal(attempts[1].recovery.verifierStatus, 'CONTINUE');
});

test('does not recover hard failures or exceed the configured budget', async () => {
  let executions = 0;
  const hardFailure = await runVerifierRecovery({
    execute: async () => { executions += 1; return {}; },
    verify: async () => ({ status: 'FAIL', failureCodes: ['PATH_OUT_OF_SCOPE'] })
  });
  assert.equal(hardFailure.ok, false);
  assert.equal(hardFailure.attempts, 1);
  assert.equal(executions, 1);

  const stalled = await runVerifierRecovery({
    maxAttempts: 2,
    execute: async ({ attempt }) => ({ actions: [{ actionDigest: `action-${attempt}` }] }),
    verify: async () => ({ status: 'STALLED', summary: 'no new evidence' })
  });
  assert.equal(stalled.ok, false);
  assert.equal(stalled.exhausted, true);
  assert.equal(stalled.attempts, 2);
});

test('recovery context contains only bounded verifier facts and action digests', () => {
  const context = createRecoveryContext({
    status: 'UNCERTAIN',
    summary: 'line\nnoise',
    nextAction: 'REQUEST_EVIDENCE',
    failureCodes: ['UNKNOWN'],
    progress: 0.25
  }, {
    attempt: 2,
    previousActions: [{ argumentsDigest: 'sha256:abc' }, { command: 'secret command' }]
  });
  assert.deepEqual(context, {
    attempt: 2,
    verifierStatus: 'UNCERTAIN',
    summary: 'line noise',
    nextAction: 'REQUEST_EVIDENCE',
    failureCodes: ['UNKNOWN'],
    progress: 0.25,
    previousActionDigests: ['sha256:abc']
  });
  assert.equal('command' in context, false);
});
