/**
 * Provider-neutral tool-call normalization.
 *
 * Adapters expose provider payloads, but the runtime must make one decision
 * about the identity and arguments it gives to a tool registry. Arguments are
 * deliberately kept as canonical JSON text: dsh-llm's ToolCallBlock uses the
 * raw JSON representation and the same representation can be hashed for an
 * ActionIntent later in the pipeline.
 */

const FUNCTION_CALL_TYPE = 'function_call';
const FUNCTION_TYPE = 'function';

export class ToolCallNormalizationError extends Error {
  constructor(code, message, path) {
    super(`${code}${path ? `:${path}` : ''}${message ? `:${message}` : ''}`);
    this.name = 'ToolCallNormalizationError';
    this.code = code;
    if (path) this.path = path;
  }
}

const fail = (code, path, message) => {
  throw new ToolCallNormalizationError(code, message, path);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const assertRecord = (value, code, path) => {
  if (!isRecord(value)) fail(code, path);
  return value;
};

const assertText = (value, code, path, { maxLength = 512 } = {}) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(code, path);
  }
  // Control characters make IDs/names ambiguous in logs and in tool-result
  // correlation. Do not trim provider data silently; reject it instead.
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(code, path);
  }
  return value;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  // JSON.parse cannot produce undefined, bigint, functions or symbols, but
  // retain a guard so this helper remains safe if reused independently.
  if (serialized === undefined) fail('TOOL_CALL_ARGUMENTS_INVALID_JSON');
  return serialized;
};

const normalizeArguments = (raw, path) => {
  if (typeof raw !== 'string' || raw.length === 0) fail('TOOL_CALL_INVALID_ARGUMENTS_TYPE', path);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('TOOL_CALL_ARGUMENTS_INVALID_JSON', path);
  }
  // Tool schemas describe an object of named parameters. Reject scalar and
  // array values instead of allowing an executor to interpret them loosely.
  if (!isRecord(parsed)) fail('TOOL_CALL_ARGUMENTS_NOT_OBJECT', path);
  return canonicalJson(parsed);
};

const normalizeOne = (item, path) => {
  const value = assertRecord(item, 'TOOL_CALL_INVALID_ITEM', path);
  const id = assertText(value.id, 'TOOL_CALL_INVALID_ID', `${path}.id`);
  const name = assertText(value.name, 'TOOL_CALL_INVALID_NAME', `${path}.name`);
  const args = normalizeArguments(value.arguments, `${path}.arguments`);
  return Object.freeze({ id, name, arguments: args });
};

const ensureUniqueIds = (calls) => {
  const seen = new Set();
  for (const call of calls) {
    if (seen.has(call.id)) fail('TOOL_CALL_DUPLICATE_ID', call.id);
    seen.add(call.id);
  }
  return calls;
};

const responseItems = (payload) => {
  if (Array.isArray(payload)) return payload;
  assertRecord(payload, 'TOOL_CALLS_INVALID_PAYLOAD');
  if (payload.output !== undefined) {
    if (!Array.isArray(payload.output)) fail('TOOL_CALLS_INVALID_OUTPUT', 'output');
    return payload.output;
  }
  if (payload.item !== undefined) return [payload.item];
  if (payload.type === FUNCTION_CALL_TYPE) return [payload];
  return [];
};

/**
 * Normalize function-call output items from the OpenAI Responses protocol.
 *
 * Responses uses `call_id` for tool-result correlation and also supplies an
 * output-item `id`. Prefer `call_id`, falling back to `id` for compatible
 * gateways that omit the former. Non-function output items are ignored.
 */
export const normalizeResponsesToolCalls = (payload) => {
  const items = responseItems(payload);
  const calls = [];
  items.forEach((item, index) => {
    const path = Array.isArray(payload) ? `output[${index}]` : `output[${index}]`;
    if (!isRecord(item)) fail('TOOL_CALL_INVALID_ITEM', path);
    if (item.type !== FUNCTION_CALL_TYPE) return;
    const candidate = {
      ...item,
      id: item.call_id ?? item.id
    };
    calls.push(normalizeOne(candidate, path));
  });
  return ensureUniqueIds(calls);
};

const chatChoices = (payload) => {
  if (Array.isArray(payload)) return payload;
  assertRecord(payload, 'TOOL_CALLS_INVALID_PAYLOAD');
  if (payload.choices !== undefined) {
    if (!Array.isArray(payload.choices)) fail('TOOL_CALLS_INVALID_CHOICES', 'choices');
    return payload.choices;
  }
  // A single choice/message is useful to callers assembling streamed chunks.
  if (payload.message !== undefined || payload.delta !== undefined) return [payload];
  return [];
};

const extractChatToolCalls = (choice, choicePath) => {
  assertRecord(choice, 'TOOL_CALL_INVALID_ITEM', choicePath);
  const message = choice.message ?? choice.delta ?? choice;
  assertRecord(message, 'TOOL_CALL_INVALID_ITEM', `${choicePath}.message`);
  if (message.tool_calls === undefined) return [];
  if (!Array.isArray(message.tool_calls)) fail('TOOL_CALLS_INVALID_LIST', `${choicePath}.message.tool_calls`);
  return message.tool_calls.map((item, index) => {
    const path = `${choicePath}.message.tool_calls[${index}]`;
    assertRecord(item, 'TOOL_CALL_INVALID_ITEM', path);
    // Chat Completions may include non-function tool types in future. This
    // runtime only knows how to execute function calls and rejects ambiguity.
    if (item.type !== undefined && item.type !== FUNCTION_TYPE) {
      fail('TOOL_CALL_UNSUPPORTED_TYPE', `${path}.type`);
    }
    const fn = assertRecord(item.function, 'TOOL_CALL_INVALID_FUNCTION', `${path}.function`);
    return normalizeOne({ id: item.id, name: fn.name, arguments: fn.arguments }, path);
  });
};

/** Normalize function tool calls from Chat Completions responses or deltas. */
export const normalizeChatCompletionsToolCalls = (payload) => {
  const choices = chatChoices(payload);
  const calls = choices.flatMap((choice, index) => extractChatToolCalls(choice, `choices[${index}]`));
  return ensureUniqueIds(calls);
};

/**
 * Dispatch normalization by protocol. The aliases make the function safe to
 * use with model-config values while keeping the canonical protocol names.
 */
export const normalizeToolCalls = (payload, protocol) => {
  if (protocol === 'responses') return normalizeResponsesToolCalls(payload);
  if (protocol === 'chat-completions' || protocol === 'chat_completions' || protocol === 'chat') {
    return normalizeChatCompletionsToolCalls(payload);
  }
  fail('TOOL_CALLS_UNKNOWN_PROTOCOL', 'protocol');
};

export { canonicalJson };
