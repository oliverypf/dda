import test from 'node:test';
import assert from 'node:assert/strict';
import { readonlyRegistryObservation } from '../src/decision/registry-observation.mjs';

const event = (name, ok, extra = {}) => ({ eventId: 'native-event', kind: 'ToolInvocationCompleted',
  payload: { name, ok, durationMs: 2, ...extra } });

test('a durable readonly registry failure is an observed error, never a missing future result', () => {
  const failed = event('workspace.read', false, { errorCode: 'WORKSPACE_NOT_FOUND', message: 'missing-evidence.txt' });
  const observed = readonlyRegistryObservation([failed]);
  assert.equal(observed.status, 'FAILED');
  assert.equal(observed.ok, false);
  assert.deepEqual(observed.failureCodes, ['WORKSPACE_NOT_FOUND']);
  assert.match(observed.summary, /completed and returned WORKSPACE_NOT_FOUND: missing-evidence.txt/);
  assert.equal(observed.checks[0].status, 'PASS');
  assert.deepEqual(observed.checks[0].evidence, ['native-event']);
  assert.equal(readonlyRegistryObservation([failed, event('workspace.read', true)]).status, 'SUCCEEDED');
});

test('proposals, pre-registry refusals and other tool outcomes cannot masquerade as readonly execution', () => {
  assert.equal(readonlyRegistryObservation([]), undefined);
  assert.equal(readonlyRegistryObservation([{ ...event('workspace.read', false), kind: 'ToolCallRequested' }]), undefined);
  assert.equal(readonlyRegistryObservation([event('workspace.read', false, { errorCode: 'TOOL_ACTION_REQUIRES_EVIDENCE', invocationAttempted: false })]), undefined);
  assert.equal(readonlyRegistryObservation([event('workspace.read', false, { errorCode: 'TOOL_DUPLICATE_REQUEST' })]), undefined);
  assert.equal(readonlyRegistryObservation([{ eventId: 'refusal', kind: 'ToolInvocationCompleted', payload: { name: 'workspace.read', ok: false, errorCode: 'TOOL_NOT_ALLOWED_IN_MODE' } }]), undefined);
  assert.equal(readonlyRegistryObservation([event('workspace.read', false), event('test.execute', true)]), undefined, 'a returned process value may itself be failed; the registry status cannot prove a successful test');
  const observed = readonlyRegistryObservation([event('workspace.read', false, { errorCode: 'WORKSPACE_PATH_FORBIDDEN', message: 'C:/private/credential.txt' })]);
  assert.equal(JSON.stringify(observed).includes('C:/private'), false);
});
