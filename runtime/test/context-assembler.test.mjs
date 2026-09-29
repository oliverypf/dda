import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleCheckpointContext, assembleMemoryContext, assembleTrajectoryContext } from '../src/context-assembler.mjs';

const event = (runId, sequence, kind, payload, emittedAtMs) => ({
  runId,
  sequence,
  kind,
  payload,
  emittedAtMs
});

test('assembles bounded redacted state from prior runs', () => {
  const events = [
    event('run-old', 1, 'TaskRunCreated', { promptDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, 10),
    event('run-old', 2, 'ModelRouteResolved', { provider: 'openai', protocol: 'responses', model: 'gpt-4.1-mini' }, 11),
    event('run-old', 3, 'WorkspaceSnapshotCreated', { snapshotDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', entryCount: 4 }, 12),
    event('run-old', 4, 'TaskRunCompleted', { outputDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }, 13),
    event('run-current', 1, 'TaskRunCreated', { promptDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }, 20)
  ];
  const result = assembleTrajectoryContext({ events, currentRunId: 'run-current' });
  assert.equal(result.runCount, 1);
  assert.match(result.text, /Previous dda run summaries/);
  assert.match(result.text, /state=SUCCEEDED/);
  assert.match(result.text, /openai\/responses\/gpt-4\.1-mini/);
  assert.match(result.text, /entries=4/);
  assert.equal(result.text.includes('run-current'), false);
  assert.equal(result.text.includes('private prompt'), false);
});

test('keeps only the newest runs and never includes raw output text', () => {
  const events = [];
  for (let index = 0; index < 5; index += 1) {
    const runId = `run-${index}`;
    events.push(event(runId, 1, 'TaskRunCreated', { promptDigest: `not-a-digest-${index}` }, index));
    events.push(event(runId, 2, 'TaskRunFailed', { code: 'MODEL_HTTP_ERROR', messageDigest: `sha256:${'a'.repeat(64)}`, messageLength: 20 }, index + 1));
  }
  const result = assembleTrajectoryContext({ events, maxRuns: 2, maxChars: 500 });
  assert.equal(result.runCount, 2);
  assert.match(result.text, /run-4/);
  assert.match(result.text, /run-3/);
  assert.equal(result.text.includes('run-2'), false);
  assert.equal(result.text.includes('MODEL_HTTP_ERROR'), true);
  assert.equal(result.text.length <= 500, true);
});

test('returns an empty context when there are no prior runs', () => {
  assert.deepEqual(assembleTrajectoryContext({ events: [], currentRunId: 'run-current' }), {
    text: '',
    runCount: 0,
    chars: 0
  });
});

test('restores only active bounded memory as advisory context', () => {
  const result = assembleMemoryContext({ memories: [
    { memoryId: 'inactive', status: 'PROPOSED', statement: 'do not restore' },
    { memoryId: 'active', status: 'ACTIVE', scope: 'project', confidence: 0.875, statement: 'Use the checked build command\nwhen validating changes.' }
  ] });
  assert.equal(result.memoryCount, 1);
  assert.match(result.text, /Active dda memories/);
  assert.match(result.text, /confidence=0\.88/);
  assert.match(result.text, /Use the checked build command when validating changes/);
  assert.equal(result.text.includes('do not restore'), false);
  assert.equal(result.text.includes('treat as instructions'), true);
});

test('restores only bounded checkpoint summaries and never raw prompt fields', () => {
  const result = assembleCheckpointContext({ checkpoint: {
    runId: 'run-1',
    phase: 'RECOVERING',
    plan: [{ id: 'probe', status: 'PENDING', actionDigest: 'sha256:abc' }],
    blockers: ['TESTS_FAILED'],
    pendingActions: ['run bounded probe'],
    prompt: 'must not be present'
  } });
  assert.equal(result.present, true);
  assert.match(result.text, /phase=RECOVERING/);
  assert.match(result.text, /TESTS_FAILED/);
  assert.equal(result.text.includes('must not be present'), false);
});
