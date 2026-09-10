import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolCallNormalizationError,
  normalizeChatCompletionsToolCalls,
  normalizeResponsesToolCalls,
  normalizeToolCalls
} from '../src/model-tool-calls.mjs';

const assertCode = (code, fn) => {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof ToolCallNormalizationError, true);
    assert.equal(error.code, code);
    return true;
  });
};

test('normalizes Responses function_call output and canonicalizes arguments', () => {
  const result = normalizeResponsesToolCalls({
    output: [
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Calling tool' }] },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_weather',
        name: 'get_weather',
        arguments: '{"units":"celsius","city":"Shanghai"}'
      }
    ]
  });
  assert.deepEqual(result, [{
    id: 'call_weather',
    name: 'get_weather',
    arguments: '{"city":"Shanghai","units":"celsius"}'
  }]);
});

test('falls back to Responses output id when compatible gateway omits call_id', () => {
  assert.deepEqual(normalizeResponsesToolCalls({
    type: 'function_call', id: 'fc_1', name: 'lookup', arguments: '{}'
  }), [{ id: 'fc_1', name: 'lookup', arguments: '{}' }]);
});

test('normalizes Chat Completions message tool calls', () => {
  const result = normalizeChatCompletionsToolCalls({
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'workspace.read', arguments: '{"path":"README.md"}' }
        }]
      }
    }]
  });
  assert.deepEqual(result, [{
    id: 'call_1', name: 'workspace.read', arguments: '{"path":"README.md"}'
  }]);
});

test('dispatches provider-neutral normalization by protocol', () => {
  assert.deepEqual(normalizeToolCalls({
    choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'noop', arguments: '{}' } }] } }]
  }, 'chat-completions'), [{ id: 'call_1', name: 'noop', arguments: '{}' }]);
  assertCode('TOOL_CALLS_UNKNOWN_PROTOCOL', () => normalizeToolCalls({}, 'deepseek-harness'));
});

test('rejects malformed arguments and fields instead of silently skipping calls', () => {
  assertCode('TOOL_CALL_ARGUMENTS_INVALID_JSON', () => normalizeResponsesToolCalls({
    output: [{ type: 'function_call', id: 'call_1', name: 'lookup', arguments: '{invalid' }]
  }));
  assertCode('TOOL_CALL_ARGUMENTS_NOT_OBJECT', () => normalizeResponsesToolCalls({
    output: [{ type: 'function_call', id: 'call_1', name: 'lookup', arguments: '[]' }]
  }));
  assertCode('TOOL_CALL_INVALID_NAME', () => normalizeResponsesToolCalls({
    output: [{ type: 'function_call', id: 'call_1', name: '', arguments: '{}' }]
  }));
  assertCode('TOOL_CALL_INVALID_ARGUMENTS_TYPE', () => normalizeChatCompletionsToolCalls({
    choices: [{ message: { tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: null } }] } }]
  }));
});

test('rejects unsupported tool types and duplicate call ids', () => {
  assertCode('TOOL_CALL_UNSUPPORTED_TYPE', () => normalizeChatCompletionsToolCalls({
    choices: [{ message: { tool_calls: [{ id: 'call_1', type: 'custom', function: { name: 'lookup', arguments: '{}' } }] } }]
  }));
  assertCode('TOOL_CALL_DUPLICATE_ID', () => normalizeResponsesToolCalls({
    output: [
      { type: 'function_call', id: 'call_1', name: 'first', arguments: '{}' },
      { type: 'function_call', id: 'call_1', name: 'second', arguments: '{}' }
    ]
  }));
});
