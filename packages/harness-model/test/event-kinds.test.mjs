import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_EVENT_TYPE,
  RUNTIME_EVENT_SCHEMA_VERSION,
  isKnownEventKind,
  isTerminalRunState,
  humanLabelForEventKind,
  isRuntimeEventEnvelope
} from '../src/event-kinds.mjs';

test('envelope constants match contracts/v1/runtime-event.schema.json', () => {
  assert.equal(RUNTIME_EVENT_TYPE, 'runtime_event');
  assert.equal(RUNTIME_EVENT_SCHEMA_VERSION, '1.0');
});

test('known vs unknown event kinds', () => {
  assert.ok(isKnownEventKind('run.started'));
  assert.ok(isKnownEventKind('approval.requested'));
  assert.equal(isKnownEventKind('vendor.custom.kind'), false);
});

test('human label falls back to the raw kind for unknown events', () => {
  assert.equal(humanLabelForEventKind('run.started'), 'task started');
  // Unknown kinds must be preserved, not dropped (LINUX_CLI_CONTRACT §10).
  assert.equal(humanLabelForEventKind('vendor.custom.kind'), 'vendor.custom.kind');
});

test('terminal run-state detection', () => {
  assert.ok(isTerminalRunState('SUCCEEDED'));
  assert.ok(isTerminalRunState('PAUSED_UNSUPPORTED'));
  assert.equal(isTerminalRunState('RUNNING'), false);
});

test('runtime event envelope validation accepts unknown kinds', () => {
  const envelope = {
    type: 'runtime_event',
    schemaVersion: '1.0',
    runId: 'run-123',
    sequence: 1,
    kind: 'vendor.custom.kind',
    payload: {},
    emittedAtMs: 0
  };
  assert.ok(isRuntimeEventEnvelope(envelope));
  assert.equal(isRuntimeEventEnvelope({ ...envelope, type: 'other' }), false);
  assert.equal(isRuntimeEventEnvelope({ ...envelope, sequence: 'x' }), false);
  assert.equal(isRuntimeEventEnvelope(null), false);
});
