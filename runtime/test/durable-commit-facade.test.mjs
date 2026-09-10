import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableCommitFacade } from '../src/durable-commit-facade.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const makeStore = () => createHarnessEventStore({ idFactory: (() => { let count = 0; return () => `id-${++count}`; })() });

test('commits intent before effect and commits a success outcome', async () => {
  const store = makeStore();
  const facade = createDurableCommitFacade({ eventStore: store, now: () => 10 });
  let observedIntent;
  const result = await facade.commitBeforeEffect({ runId: 'run-1', intentPayload: { capability: 'READ_ONLY' }, effect: async ({ intent }) => {
    observedIntent = intent;
    return { ok: true };
  } });
  assert.equal(observedIntent.kind, 'EffectIntent');
  assert.equal(result.outcome.event.kind, 'EffectCompleted');
  assert.equal(result.outcome.receipt.commandId, result.intent.event.eventId + ':success-outcome');
  assert.deepEqual((await store.list()).map((event) => event.kind), ['EffectIntent', 'EffectCompleted']);
});

test('duplicate intents never execute an effect again, including an unsettled intent', async () => {
  for (const settled of [false, true]) {
    const store = makeStore();
    const facade = createDurableCommitFacade({ eventStore: store });
    let effectCalls = 0;
    const request = { runId: 'repeat', commandId: 'same-command', effect: async () => { effectCalls += 1; return 'done'; } };
    if (settled) await facade.commitBeforeEffect(request);
    else await store.append({ runId: 'repeat', aggregateType: 'TaskRun', aggregateId: 'repeat', kind: 'EffectIntent', payload: {}, commandId: 'same-command' });
    const before = await store.list();
    await assert.rejects(facade.commitBeforeEffect(request), (error) =>
      error.message === 'DURABLE_EFFECT_RECOVERY_REQUIRED' && error.intentEventId === before[0].eventId);
    assert.equal(effectCalls, settled ? 1 : 0);
    assert.deepEqual(await store.list(), before);
  }
});

test('records a failed effect after the intent and rethrows the original error', async () => {
  const store = makeStore();
  const facade = createDurableCommitFacade({ eventStore: store, now: () => 20 });
  const failure = await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-2', effect: async () => {
    const error = new Error('blocked');
    error.code = 'POLICY_DENIED';
    throw error;
  } }), (error) => error.code === 'POLICY_DENIED' && error.outcome.event.kind === 'EffectFailed' && error.outcome.receipt.commandId === error.outcome.event.payload.intentEventId + ':failure-outcome');
  assert.deepEqual((await store.list()).map((event) => event.kind), ['EffectIntent', 'EffectFailed']);
});

test('fails closed before effect when the intent is not durably committed', async () => {
  let effectCalled = false;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => { throw new Error('disk-full'); } } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-3', effect: async () => { effectCalled = true; } }), /disk-full/);
  assert.equal(effectCalled, false);
});

test('does not synthesize a failure outcome when success durability fails', async () => {
  let calls = 0;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => {
    calls += 1;
    if (calls === 1) return { event: { eventId: 'intent-1' }, receipt: { status: 'COMMITTED', eventIds: ['intent-1'] } };
    throw new Error('outcome-disk-full');
  } } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-4', effect: async () => 'done' }), /outcome-disk-full/);
  assert.equal(calls, 2);
});

test('rejects a committed receipt that has no durable event', async () => {
  let effectCalled = false;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => ({ receipt: { status: 'COMMITTED', eventIds: [] } }) } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-missing-event', effect: async () => { effectCalled = true; } }), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(effectCalled, false);
});

test('does not report success when the committed outcome has no event', async () => {
  let calls = 0;
  let effectCalls = 0;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => {
    calls += 1;
    if (calls === 1) return { event: { eventId: 'intent-6' }, receipt: { status: 'COMMITTED', eventIds: ['intent-6'] } };
    return { receipt: { status: 'COMMITTED', eventIds: [] } };
  } } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-6', effect: async () => { effectCalls += 1; return 'done'; } }), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(effectCalls, 1);
  assert.equal(calls, 2);
});

test('rejects a failed outcome receipt with the wrong command identity', async () => {
  let calls = 0;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => {
    calls += 1;
    const id = calls === 1 ? 'intent-8' : 'outcome-8';
    return { event: { eventId: id }, receipt: { status: 'COMMITTED', commandId: calls === 1 ? 'intent-8' : 'wrong-command', eventIds: [id] } };
  } } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-8', effect: async () => { throw new Error('effect-failed'); } }), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(calls, 2);
});

test('rejects an outcome receipt with the wrong command identity', async () => {
  let effectCalled = false;
  let calls = 0;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => {
    calls += 1;
    const id = calls === 1 ? 'intent-7' : 'outcome-7';
    return { event: { eventId: id }, receipt: { status: 'COMMITTED', commandId: calls === 1 ? 'intent-7' : 'wrong-command', eventIds: [id] } };
  } } });
  await assert.rejects(() => facade.commitBeforeEffect({ runId: 'run-7', effect: async () => { effectCalled = true; return 'done'; } }), /DURABLE_COMMIT_REQUIRED/);
  assert.equal(effectCalled, true);
});

test('rejects an intent receipt for a different explicit command before effect', async () => {
  let effectCalls = 0;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => ({
    event: { eventId: 'intent-wrong-command' },
    receipt: { status: 'COMMITTED', eventIds: ['intent-wrong-command'], commandId: 'other-command' }
  }) } });
  await assert.rejects(facade.commitBeforeEffect({
    runId: 'run-command', commandId: 'requested-command', effect: async () => { effectCalls += 1; }
  }), (error) => error.message === 'DURABLE_COMMIT_REQUIRED' && error.phase === 'intent');
  assert.equal(effectCalls, 0);
});

test('rejects an event not bound to its committed receipt before effect', async () => {
  let effectCalled = false;
  const facade = createDurableCommitFacade({ eventStore: { append: async () => ({
    event: { eventId: 'intent-1' },
    receipt: { status: 'COMMITTED', eventIds: ['different-event'] }
  }) } });
  await assert.rejects(
    () => facade.commitBeforeEffect({ runId: 'run-5', effect: async () => { effectCalled = true; } }),
    /DURABLE_COMMIT_REQUIRED/
  );
  assert.equal(effectCalled, false);
});
