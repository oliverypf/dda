import test from 'node:test';
import assert from 'node:assert/strict';
import { readonlyResumeObservations } from '../src/decision/readonly-resume-observations.mjs';
const sha = value => `sha256:${value.repeat(64)}`;
const creation = (runId, extra = {}) => ({ runId, kind: 'TaskRunCreated', eventId: `${runId}-created`, payload: { requestedMode: 'READ_ONLY', promptDigest: sha('a'), ...extra } });
const checkpoint = (runId, checkpointDigest) => ({ runId, kind: 'ThreadCheckpointCommitted', eventId: `${runId}-checkpoint`, payload: { threadId: 'thread', checkpointDigest, checkpoint: { runId } } });
const missing = { runId: 'prior', kind: 'ToolInvocationCompleted', eventId: 'actual-missing', payload: {
  name: 'workspace.read', ok: false, inputDigest: sha('c'), errorCode: 'WORKSPACE_NOT_FOUND', message: 'missing-evidence.txt', durationMs: 2 } };
const facts = { mode: 'READ_ONLY', sourceRunId: 'prior', checkpointDigest: sha('b'), threadId: 'thread', promptDigest: sha('a'),
  events: [creation('prior'), missing, checkpoint('prior', sha('b'))] };
test('checkpoint lineage carries actual prior read failure without copying arbitrary messages or commands', () => {
  const actual = readonlyResumeObservations(facts);
  assert.equal(actual.length, 1); assert.equal(actual[0].state, 'FAILED'); assert.equal(actual[0].errorCode, 'WORKSPACE_NOT_FOUND');
  assert.equal(actual[0].path, 'missing-evidence.txt'); assert.equal(actual[0].sourceEventId, 'actual-missing');
  assert.equal(readonlyResumeObservations({ ...facts, events: [...facts.events, { ...missing, eventId: 'private-message', payload: { ...missing.payload, message: '../private-secret.txt' } }] }).at(-1).path, undefined);
});
test('unknown modes, changed goals, wrong checkpoints, metadata refusals and any actual side effects do not become resume facts', () => {
  for (const change of [{ mode: 'CONTROLLED' }, { checkpointDigest: sha('d') }, { threadId: 'another' }, { promptDigest: sha('d') },
    { events: [creation('prior', { requestedMode: 'CONTROLLED' }), missing, checkpoint('prior', sha('b'))] },
    { events: [missing, checkpoint('prior', sha('b'))] },
    { events: [creation('prior'), { ...missing, payload: { ...missing.payload, durationMs: undefined } }, checkpoint('prior', sha('b'))] },
    { events: [creation('prior'), { ...missing, payload: { ...missing.payload, invocationAttempted: false } }, checkpoint('prior', sha('b'))] },
    { events: [...facts.events, { ...missing, eventId: 'actual-write', payload: { ...missing.payload, name: 'file.write', ok: true } }] }]) {
    assert.deepEqual(readonlyResumeObservations({ ...facts, ...change }), []);
  }
});
test('later checkpoints preserve validated earlier read observations across the same thread lineage', () => {
  const events = [...facts.events, creation('next', { sourceRunId: 'prior', sourceCheckpointDigest: sha('b') }),
    { ...missing, runId: 'next', eventId: 'actual-success', payload: { name: 'workspace.read', ok: true, inputDigest: sha('e'), outputDigest: sha('f'), durationMs: 1 } }, checkpoint('next', sha('d'))];
  const actual = readonlyResumeObservations({ ...facts, events, sourceRunId: 'next', checkpointDigest: sha('d') });
  assert.deepEqual(actual.map(action => action.sourceEventId), ['actual-missing', 'actual-success']);
  const unsafe = events.map(event => event.eventId === 'prior-created' ? creation('prior', { requestedMode: 'CONTROLLED' }) : event);
  assert.deepEqual(readonlyResumeObservations({ ...facts, events: unsafe, sourceRunId: 'next', checkpointDigest: sha('d') }), []);
});
