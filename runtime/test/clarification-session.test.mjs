import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry } from '../src/tool-registry.mjs';
import { plannerSystemPrompt, restorePlannerPlan } from '../src/agent-turns.mjs';
import { WORKSPACE_SYSTEM_INSTRUCTION } from '../src/access-mode-instructions.mjs';
import {
  USER_CLARIFICATION_NOTICE,
  createClarificationSession,
  registerUserClarificationTool
} from '../src/kernel/clarification-session.mjs';

const plan = (userAnswer) => ({
  planId: 'plan-1',
  planDigest: `sha256:${'ab'.repeat(32)}`,
  steps: [{
    stepId: 'ask-user',
    summary: 'Ask which product',
    actionKind: 'CLARIFY',
    dependencies: [],
    status: 'SUCCEEDED',
    ...(userAnswer === undefined ? {} : { userAnswer })
  }]
});

test('planner asks once when the goal is ambiguous and does not invent the fact', () => {
  const prompt = plannerSystemPrompt();
  assert.match(prompt, /CLARIFY/);
  assert.match(prompt, /do not invent the missing fact/i);
  assert.match(prompt, /follow the user's answer/i);
  assert.match(prompt, /reasoning text in the language the user requested/);
  assert.match(prompt, /Do not translate stepId, actionKind, or JSON keys/);
  assert.doesNotMatch(prompt, /applies only to summary/);
  assert.match(WORKSPACE_SYSTEM_INSTRUCTION, /user\.clarify/);
  assert.match(WORKSPACE_SYSTEM_INSTRUCTION, /Do not guess/);
});

test('a saved clarification answer survives plan restore', () => {
  const restored = restorePlannerPlan(plan('混元 4.0 API'));
  assert.equal(restored.steps[0].userAnswer, '混元 4.0 API');
  assert.equal(restored.steps[0].actionKind, 'CLARIFY');
  const dropped = restorePlannerPlan(plan('   '));
  assert.equal(dropped.steps[0].userAnswer, undefined);
});

test('clarification waits for the matching answer and ignores other lines', async () => {
  const events = [];
  const answers = [];
  const session = createClarificationSession({
    emitEvent: (kind, payload) => events.push({ kind, payload }),
    hasLiveUser: () => true,
    onAnswer: (item) => answers.push(item),
    ttlMs: 5000
  });
  const pending = session.request({
    question: ' hy 4 指哪一个？ ',
    options: ['混元 4.0 API', '云实例规格'],
    stepId: 'ask-user'
  });
  assert.equal(session.pendingCount(), 1);
  assert.equal(events[0].kind, 'clarification.requested');
  assert.equal(events[0].payload.question, 'hy 4 指哪一个？');
  assert.deepEqual(events[0].payload.options, [
    { optionId: 'option-1', label: '混元 4.0 API' },
    { optionId: 'option-2', label: '云实例规格' }
  ]);
  session.handleLine('{');
  session.handleLine(JSON.stringify({ type: 'approval_response', requestId: events[0].payload.requestId, answer: 'no' }));
  session.handleLine(JSON.stringify({ type: 'clarification_response', requestId: 'other', answer: 'no' }));
  session.handleLine(JSON.stringify({
    type: 'clarification_response',
    requestId: events[0].payload.requestId,
    selectedOptionId: 'option-9',
    answer: '伪造'
  }));
  assert.equal(session.pendingCount(), 1);
  session.handleLine(JSON.stringify({
    type: 'clarification_response',
    requestId: events[0].payload.requestId,
    selectedOptionId: 'option-1',
    answer: '伪造的长答案'
  }));
  const outcome = await pending;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.answer, '混元 4.0 API');
  assert.equal(outcome.selectedOptionId, 'option-1');
  assert.deepEqual(answers, [{ question: 'hy 4 指哪一个？', answer: '混元 4.0 API', stepId: 'ask-user' }]);
  assert.equal(events.at(-1).kind, 'clarification.resolved');
  assert.equal(events.at(-1).payload.state, 'ANSWERED');
  assert.equal(session.pendingCount(), 0);
});

test('a second question waits until the first one is finished', async () => {
  const session = createClarificationSession({
    emitEvent: () => {},
    hasLiveUser: () => true,
    ttlMs: 5000
  });
  const first = session.request({ question: '哪一个？' });
  const second = await session.request({ question: '另一个？' });
  assert.equal(second.code, 'CLARIFICATION_BUSY');
  session.handleLine(JSON.stringify({ type: 'clarification_response', requestId: 'missing', answer: 'x' }));
  session.failAll();
  const outcome = await first;
  assert.equal(outcome.code, 'CLARIFICATION_CANCELLED');
});

test('no live user, expiry, and cancel do not invent an answer', async () => {
  const absent = createClarificationSession({ emitEvent: () => {}, hasLiveUser: () => false });
  assert.equal((await absent.request({ question: '哪一个？' })).code, 'CLARIFICATION_NO_LIVE_USER');

  const expiring = createClarificationSession({ emitEvent: () => {}, hasLiveUser: () => true, ttlMs: 20 });
  const expired = await expiring.request({ question: '哪一个？' });
  assert.equal(expired.code, 'CLARIFICATION_EXPIRED');

  const controller = new AbortController();
  const cancelling = createClarificationSession({ emitEvent: () => {}, hasLiveUser: () => true, ttlMs: 5000 });
  const pending = cancelling.request({ question: '哪一个？', signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, 'CLARIFICATION_CANCELLED');
});

test('the clarify tool returns the user answer as untrusted data and then stops asking', async () => {
  const captured = [];
  const session = createClarificationSession({
    emitEvent: (_kind, payload) => captured.push(payload),
    hasLiveUser: () => true,
    ttlMs: 5000,
    maxAsks: 1
  });
  const registry = createToolRegistry();
  registerUserClarificationTool(registry, session);
  const listed = registry.list().find((tool) => tool.name === 'user.clarify');
  assert.equal(listed.readOnly, true);
  const pending = registry.invoke('user.clarify', { question: '指哪一个？', options: ['API', '实例'] });
  assert.equal(captured.length, 1);
  session.handleLine(JSON.stringify({
    type: 'clarification_response',
    requestId: captured[0].requestId,
    selectedOptionId: 'option-1',
    answer: '伪造'
  }));
  const toolResult = await pending;
  assert.equal(toolResult.ok, true);
  assert.equal(toolResult.answer, 'API');
  assert.equal(toolResult.notice, USER_CLARIFICATION_NOTICE);
  const again = await registry.invoke('user.clarify', { question: '还要问吗？' });
  assert.equal(again.ok, false);
  assert.equal(again.errorCode, 'CLARIFICATION_LIMIT');
});
