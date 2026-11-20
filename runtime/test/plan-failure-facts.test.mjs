import test from 'node:test';
import assert from 'node:assert/strict';
import { planFailureFacts } from '../src/plan-failure-facts.mjs';

test('terminal diagnostics retain the first scope refusal on the failing step through recovery and replay', () => {
  const event = (kind, payload, runId = 'run') => ({ runId, kind, payload });
  const refused = id => event('ToolActionNotExecuted', { id, name: 'shell.execute',
    invocationAttempted: false, errorCode: 'TOOL_OUTSIDE_EXECUTION_SCOPE' });
  const steps = [{ stepId: 'read', status: 'FAILED', actionKind: 'READ' },
    { stepId: 'generate', status: 'BLOCKED', errorCode: 'DEPENDENCY_FAILED' }];
  const events = [
    event('PlanStepStateChanged', { payload: { currentStepId: 'previous' } }), refused('old'),
    event('PlanStepStateChanged', { payload: { currentStepId: 'read' } }),
    event('PlanStepStateChanged', { payload: { currentStepId: null } }, 'other-run'),
    event('ToolCallRequested', { id: 'c1', command: 'node', args: ['-e', 'private argument'] }), refused('c1'),
    event('ToolCallRequested', { id: 'c2', command: 'git' }), refused('c2'),
    event('PlanStepStateChanged', { payload: { currentStepId: null, steps } })
  ];
  const facts = { blockedTool: { name: 'shell.execute', command: 'node', errorCode: 'TOOL_OUTSIDE_EXECUTION_SCOPE' },
    blockedStepIds: ['generate'] };
  assert.deepEqual(planFailureFacts(events, 'run', 'read', { steps }), { ...facts, actionKind: 'READ' });
  assert.deepEqual(planFailureFacts(events, 'run', 'read'), facts);
  assert.deepEqual(planFailureFacts(events.slice(4), 'run', 'read'), { blockedStepIds: ['generate'] });
});
