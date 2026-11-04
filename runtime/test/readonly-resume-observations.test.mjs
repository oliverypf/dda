import test from 'node:test';
import assert from 'node:assert/strict';
import { textDigest } from '../src/text-patch.mjs';
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
test('unknown modes, invalid prompt digests, wrong checkpoints, metadata refusals and any actual side effects do not become resume facts', () => {
  for (const change of [{ mode: 'CONTROLLED' }, { checkpointDigest: sha('d') }, { threadId: 'another' }, { promptDigest: 'sha256:bad' },
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

const kdsPrompts = ['编译exe', '继续', '继续', '继续'];
const resumeLineage = (prompts = kdsPrompts) => ({
  mode: 'READ_ONLY', threadId: 'thread', promptDigest: textDigest('继续'),
  sourceRunId: `r${prompts.length - 1}`, checkpointDigest: textDigest(`checkpoint-${prompts.length - 1}`),
  events: prompts.flatMap((prompt, index) => {
    const runId = `r${index}`;
    return [
      creation(runId, { promptDigest: textDigest(prompt), ...(index > 0 ? {
        sourceRunId: `r${index - 1}`, sourceCheckpointDigest: textDigest(`checkpoint-${index - 1}`)
      } : {}) }),
      { ...missing, runId, eventId: `read-${index}` },
      checkpoint(runId, textDigest(`checkpoint-${index}`))
    ];
  })
});

for (const [scenario, prompts, continuation] of [
  ['KDS root plus three resumed rounds', kdsPrompts, '继续'],
  ['KDS lineage with new continuation text', kdsPrompts, '帮我再看看'],
  ['first continuation from the root', ['编译exe'], '继续'],
  ['eight-run lineage', ['编译exe', ...Array(7).fill('继续')], '帮我再看看']
]) {
  test(`readonlyResumeObservations restores all observations: ${scenario}`, () => {
    const facts = resumeLineage(prompts);
    facts.promptDigest = textDigest(continuation);
    assert.deepEqual(readonlyResumeObservations(facts), prompts.map((_, index) => ({
      id: `read-${index}`, name: 'workspace.read', state: 'FAILED', argumentsDigest: sha('c'),
      errorCode: 'WORKSPACE_NOT_FOUND', path: 'missing-evidence.txt',
      sourceRunId: `r${index}`, sourceEventId: `read-${index}`
    })));
  });
}

test('readonlyResumeObservations rejects cross-thread checkpoints in the source or ancestors', () => {
  for (const runId of ['r3', 'r2', 'r1', 'r0']) {
    const facts = resumeLineage();
    facts.events.find(event => event.runId === runId && event.kind === 'ThreadCheckpointCommitted')
      .payload.threadId = 'another-thread';
    assert.deepEqual(readonlyResumeObservations(facts), []);
  }
});

test('readonlyResumeObservations rejects a tampered middle ancestor checkpoint digest or run id', () => {
  for (const tampered of [
    { checkpointDigest: textDigest('checkpoint-0') },
    { checkpoint: { runId: 'r0' } }
  ]) {
    const facts = resumeLineage();
    const middle = facts.events.find(event => event.runId === 'r1' && event.kind === 'ThreadCheckpointCommitted');
    Object.assign(middle.payload, tampered);
    assert.deepEqual(readonlyResumeObservations(facts), []);
  }
});

test('readonlyResumeObservations rejects invalid prompt digests in the source and every ancestor', () => {
  for (const runId of ['r3', 'r2', 'r1', 'r0']) {
    for (const promptDigest of [undefined, null, 42, '', 'sha256:bad', `sha256:${'g'.repeat(64)}`, 'a'.repeat(64)]) {
      const facts = resumeLineage();
      facts.events.find(event => event.runId === runId && event.kind === 'TaskRunCreated')
        .payload.promptDigest = promptDigest;
      assert.deepEqual(readonlyResumeObservations(facts), []);
    }
  }
});

test('readonlyResumeObservations rejects invalid current continuation prompt digests', () => {
  for (const promptDigest of [undefined, null, 42, '', 'sha256:bad', `sha256:${'g'.repeat(64)}`, 'a'.repeat(64)]) {
    assert.deepEqual(readonlyResumeObservations({ ...resumeLineage(), promptDigest }), []);
  }
});

test('readonlyResumeObservations validates creation count, mode and parent checkpoint digest at every round', () => {
  for (const runId of ['r3', 'r2', 'r1', 'r0']) {
    for (const scenario of ['missing creation', 'duplicate creation', 'wrong mode', 'invalid parent digest']) {
      const facts = resumeLineage();
      const created = facts.events.find(event => event.runId === runId && event.kind === 'TaskRunCreated');
      if (scenario === 'missing creation') facts.events = facts.events.filter(event => event !== created);
      if (scenario === 'duplicate creation') facts.events.push(structuredClone(created));
      if (scenario === 'wrong mode') created.payload.requestedMode = 'CONTROLLED';
      if (scenario === 'invalid parent digest') {
        if (runId === 'r0') continue;
        created.payload.sourceCheckpointDigest = 'sha256:bad';
      }
      assert.deepEqual(readonlyResumeObservations(facts), [], `${runId}: ${scenario}`);
    }
  }
});

test('readonlyResumeObservations rejects cycles and lineages deeper than eight runs', () => {
  const cycle = resumeLineage();
  Object.assign(cycle.events[0].payload, { sourceRunId: cycle.sourceRunId, sourceCheckpointDigest: cycle.checkpointDigest });
  for (const facts of [cycle, resumeLineage(['编译exe', ...Array(8).fill('继续')])]) {
    assert.deepEqual(readonlyResumeObservations(facts), []);
  }
});
