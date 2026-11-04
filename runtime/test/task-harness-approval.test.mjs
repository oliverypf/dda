import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskProgress, FAILURE_CLASSES } from '../src/task-harness.mjs';

for (const code of ['APPROVAL_EXPIRED', 'APPROVAL_TIMEOUT', 'APPROVAL_DENIED']) {
  const events = {
    'runtime result': { ok: false, error: code },
    'runtime result with detail': { ok: false, error: `${code}:approval-123` },
    'run.failed code': { kind: 'run.failed', payload: { code } },
    'run.failed errorCode': { kind: 'run.failed', payload: { errorCode: code } }
  };
  for (const [source, event] of Object.entries(events)) {
    test(`${code} from ${source} preserves failure counts and gives the correct approval hint`, () => {
      const progress = createTaskProgress();
      // A prior applied write must remain recorded when a later approval fails.
      progress.observe({ kind: 'lease.consumed', payload: { capability: 'file.write', ok: true } });
      progress.observe({ kind: 'tool.result', payload: { name: 'file.write', ok: false, errorCode: code } });
      progress.observe(event);

      const snapshot = progress.snapshot();
      assert.deepEqual(snapshot.runtimeResult, { ok: false, error: event.error ?? code });
      assert.deepEqual(snapshot.errors, [{ name: 'file.write', errorCode: code }]);
      assert.equal(snapshot.toolResults, 1);
      assert.equal(snapshot.successfulWrites, 0);
      assert.equal(snapshot.writesApplied, 1);
      assert.equal(snapshot.writesAppliedUnverified, 0);
      assert.equal(snapshot.idempotentReplays, 0);

      const { recovery } = snapshot;
      assert.equal(recovery.replayWrites, false);
      if (code === 'APPROVAL_DENIED') {
        assert.ok(FAILURE_CLASSES.includes('APPROVAL_DENIED'));
        assert.equal(recovery.failureClass, 'APPROVAL_DENIED');
        assert.equal(recovery.nextAction, 'STOP_OR_OFFER_ALTERNATIVE');
        assert.match(recovery.advice, /user declined/i);
        assert.match(recovery.advice, /must not re-request approval for the same effect/i);
        assert.match(recovery.advice, /stop or offer an alternative/i);
      } else {
        assert.ok(FAILURE_CLASSES.includes('APPROVAL_EXPIRED'));
        assert.equal(recovery.failureClass, 'APPROVAL_EXPIRED');
        assert.equal(recovery.nextAction, 'REQUEST_APPROVAL_AGAIN');
        assert.match(recovery.advice, /approval expired/i);
        assert.match(recovery.advice, /Re-request approval for the single affected path/);
        assert.match(recovery.advice, /do not assume the write landed/);
        assert.doesNotMatch(recovery.advice, /denied|declined/i);
      }
    });
  }
}
