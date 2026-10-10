import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { stableToolDefinitions, cacheSessionId } from '../prompt-cache.mjs';
import { providerTokenUsage } from '../model-usage.mjs';
import { cordisPlugin } from './cordis-plugin.mjs';
import {
  ToolCallNormalizationError,
  normalizeChatCompletionsToolCalls,
  normalizeResponsesToolCalls
} from '../model-tool-calls.mjs';

const PROTOCOLS = Object.freeze(['responses', 'chat-completions']);
const DEFAULT_RESPONSES_MODEL = 'gpt-4.1-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
// Retry only before receiving a successful stream. Replaying a partial stream
// could duplicate tool calls or output, so streaming errors still propagate.
const fetchModelStream = async (endpoint, init, { retries, retryDelayMs }) => {
  for (let attempt = 0; ; attempt += 1) {
    init.signal?.throwIfAborted();
    let response;
    try {
      response = await fetch(endpoint, init);
    } catch (error) {
      if (init.signal?.aborted || error?.name === 'AbortError' || attempt >= retries
        || !(error instanceof TypeError)) throw error;
    }
    if (response && (!RETRYABLE_HTTP.has(response.status) || attempt >= retries)) return response;
    const retryAfter = response?.headers.get('retry-after');
    const retryAfterMs = retryAfter ? Math.max(0, Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    // A long quota wait belongs to the caller; do not ignore its Retry-After.
    if (response && retryAfterMs > 30_000) return response;
    await response?.body?.cancel().catch(() => {});
    await delay(Math.max(retryDelayMs * 2 ** attempt, Number.isFinite(retryAfterMs) ? retryAfterMs : 0), undefined,
      { signal: init.signal });
  }
};

const trimBaseUrl = (value) => String(value).replace(/\/+$/, '');

/* OpenAI-compatible APIs restrict function names to ASCII letters, digits,
 * underscores and hyphens.  Cordis tool ids are provider-neutral and may use
 * dots (for example `workspace.read`).  Encode only names that need it on the
 * wire and decode model-produced calls before they reach the local registry.
 * The `_xHEX_` form is deterministic, bounded and reversible. */
export const encodeToolName = (name) => {
  const value = String(name ?? '');
  if (/^[a-zA-Z0-9_-]+$/.test(value)) return value;
  return `hmc_${[...value].map((character) => /^[a-zA-Z0-9_-]$/.test(character)
    ? character
    : `_x${character.codePointAt(0).toString(16)}_`).join('')}`;
};

export const decodeToolName = (name) => {
  const value = String(name ?? '');
  if (!value.startsWith('hmc_')) return value;
  return value.slice(4).replace(/_x([0-9a-f]+)_/gi, (_match, code) => {
    try {
      return String.fromCodePoint(Number.parseInt(code, 16));
    } catch {
      return _match;
    }
  });
};

const textFromContent = (content) => (Array.isArray(content) ? content : [content])
  .map((block) => {
    if (typeof block === 'string') return block;
    if (block && typeof block.text === 'string') return block.text;
    return '';
  })
  .join('');

/* Translate provider-neutral history, including the assistant/tool pair that
 * precedes a follow-up tool round. Responses uses typed input items while
 * Chat Completions uses assistant tool_calls and standalone tool messages. */
const responseInput = (messages) => messages.flatMap((message) => {
  const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: textFromContent(message.content) }];
  const textBlocks = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  const toolCalls = blocks.filter((block) => block?.type === 'tool-call');
  const toolResults = blocks.filter((block) => block?.type === 'tool-result');
  const items = [];
  if (textBlocks.length) {
    items.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: textBlocks.map((block) => ({
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: block.text
      }))
    });
  }
  if (message.role === 'assistant') {
    for (const call of toolCalls) {
      items.push({ type: 'function_call', call_id: call.id, name: encodeToolName(call.name), arguments: call.arguments });
    }
  }
  for (const result of toolResults) {
    items.push({
      type: 'function_call_output',
      call_id: result.toolCallId,
      output: textFromContent(result.content)
    });
  }
  return items;
});

const chatMessages = (messages) => messages.flatMap((message) => {
  const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: textFromContent(message.content) }];
  const text = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
  const toolCalls = blocks.filter((block) => block?.type === 'tool-call');
  const toolResults = blocks.filter((block) => block?.type === 'tool-result');
  const wire = [];
  if (message.role === 'assistant') {
    if (text || toolCalls.length) {
      wire.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: encodeToolName(call.name), arguments: call.arguments }
          }))
        } : {})
      });
    }
  } else if (text) {
    wire.push({ role: message.role === 'tool' ? 'user' : message.role, content: text });
  }
  for (const result of toolResults) {
    wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: textFromContent(result.content) });
  }
  return wire;
});

/*
 * GenerateOptions uses dsh-llm's `parameters` spelling while the local tool
 * registry exposes the same schema as `inputSchema`. Accept both at this
 * boundary so callers can pass either provider-neutral representation.
 */
const toolDefinition = (tool) => {
  const value = tool && typeof tool === 'object' ? tool : {};
  return {
    name: encodeToolName(value.name ?? value.id),
    description: typeof value.description === 'string' ? value.description : '',
    parameters: value.parameters ?? value.inputSchema ?? value.input_schema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  };
};

const responsesTools = (tools) => Array.isArray(tools)
  ? tools.map((tool) => ({ type: 'function', ...toolDefinition(tool) }))
  : undefined;

const chatCompletionsTools = (tools) => Array.isArray(tools)
  ? tools.map((tool) => ({ type: 'function', function: toolDefinition(tool) }))
  : undefined;

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const failureMessage = (status, payload) => {
  const detail = payload?.error?.message ?? payload?.message ?? `HTTP_${status}`;
  return `${status}:${detail}`.slice(0, 1000);
};

const finishKind = (reason) => {
  if (reason === 'stop') return 'stop';
  if (reason === 'tool_calls' || reason === 'function_call' || reason === 'tool-calls') return 'tool-calls';
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max-tokens') return 'max-tokens';
  return reason;
};

const asToolCallChunk = (call) => ({ type: 'tool-call', ...call });

/*
 * Responses streams identify a function call with both an output-item id and
 * a call_id. Argument deltas are keyed by output item, so retain aliases for
 * both ids and output_index while the stream is in flight.
 */
const createResponsesToolState = () => {
  const states = [];
  const byItemId = new Map();
  const byIndex = new Map();
  const emitted = new Set();
  const emittedIds = new Set();

  const stateFor = (payload = {}, item = undefined) => {
    const itemId = item?.id ?? payload.item_id;
    const outputIndex = item?.output_index ?? payload.output_index;
    let state = (itemId !== undefined ? byItemId.get(String(itemId)) : undefined)
      ?? (outputIndex !== undefined ? byIndex.get(String(outputIndex)) : undefined);
    if (!state) {
      state = {
        itemId: itemId === undefined ? undefined : String(itemId),
        outputIndex,
        id: item?.call_id ?? payload.call_id,
        name: item?.name,
        arguments: ''
      };
      states.push(state);
    }
    if (itemId !== undefined) {
      state.itemId = String(itemId);
      byItemId.set(String(itemId), state);
    }
    if (outputIndex !== undefined) {
      state.outputIndex = outputIndex;
      byIndex.set(String(outputIndex), state);
    }
    if (item?.call_id !== undefined) state.id = item.call_id;
    else if (payload.call_id !== undefined) state.id = payload.call_id;
    if (item?.name !== undefined) state.name = item.name;
    return state;
  };

  const updateItem = (payload = {}, item = undefined) => {
    if (!item || item.type !== 'function_call') return undefined;
    const state = stateFor(payload, item);
    // An output-item event can arrive after argument deltas on a few
    // gateways. Its initial empty `arguments` value must not erase fragments
    // already collected for the same item.
    if (typeof item.arguments === 'string' && (item.arguments.length > 0 || state.arguments.length === 0)) {
      state.arguments = item.arguments;
    }
    return state;
  };

  const complete = (state) => {
    if (!state || emitted.has(state)) return undefined;
    const item = {
      type: 'function_call',
      id: state.itemId ?? state.id,
      ...(state.id === undefined ? {} : { call_id: state.id }),
      name: state.name,
      arguments: state.arguments
    };
    const [normalizedCall] = normalizeResponsesToolCalls(item);
    const call = { ...normalizedCall, name: decodeToolName(normalizedCall.name) };
    if (emittedIds.has(call.id)) {
      throw new ToolCallNormalizationError('TOOL_CALL_DUPLICATE_ID', '', call.id);
    }
    emitted.add(state);
    emittedIds.add(call.id);
    return asToolCallChunk(call);
  };

  const consume = (event, payload) => {
    // Prefer the SSE event name when present: compatible gateways sometimes
    // put the output item itself in `data` (whose `type` is `function_call`)
    // instead of wrapping it under an `item` field.
    const type = typeof event === 'string' && event.startsWith('response.')
      ? event
      : payload?.type ?? event;
    if (type === 'function_call') {
      updateItem(payload, payload);
      return [];
    }
    if (type === 'response.output_item.added') {
      updateItem(payload, payload?.item ?? payload?.output_item
        ?? (payload?.type === 'function_call' ? payload : undefined));
      return [];
    }
    if (type === 'response.function_call_arguments.delta') {
      const state = stateFor(payload);
      if (typeof payload?.delta === 'string') state.arguments += payload.delta;
      return [];
    }
    if (type === 'response.function_call_arguments.done') {
      const state = stateFor(payload);
      if (typeof payload?.arguments === 'string' && (payload.arguments.length > 0 || state.arguments.length === 0)) {
        state.arguments = payload.arguments;
      }
      const call = complete(state);
      return call ? [call] : [];
    }
    if (type === 'response.output_item.done') {
      const state = updateItem(payload, payload?.item ?? payload?.output_item
        ?? (payload?.type === 'function_call' ? payload : undefined));
      const call = complete(state);
      return call ? [call] : [];
    }
    if (type === 'response.completed' || type === 'response.done') {
      // Some gateways omit output_item events and put the completed output on
      // the response event itself. Seed those items before finalizing.
      const output = payload?.response?.output ?? payload?.output;
      if (Array.isArray(output)) {
        output.forEach((item, index) => updateItem({ output_index: index }, item));
      }
      return states.map(complete).filter(Boolean);
    }
    return [];
  };

  return {
    consume,
    flush: () => states.map(complete).filter(Boolean),
    get size() { return emitted.size; }
  };
};

/* Chat Completions sends argument fragments keyed by tool-call index. */
const createChatToolState = () => {
  const states = new Map();
  const emitted = new Set();
  const emittedIds = new Set();

  const stateFor = (choice, item, fallbackIndex) => {
    const choiceIndex = choice?.index ?? 0;
    const toolIndex = item?.index ?? fallbackIndex;
    const key = `${choiceIndex}:${toolIndex}`;
    let state = states.get(key);
    if (!state) {
      state = { id: undefined, name: undefined, type: undefined, arguments: '' };
      states.set(key, state);
    }
    // OpenAI-compatible gateways send the id/name only on the first tool-call
    // delta and `null` on later argument fragments. Treat null the same as
    // absent so a valid id/name is never overwritten.
    if (typeof item?.id === 'string' && item.id) state.id = item.id;
    if (typeof item?.type === 'string' && item.type) state.type = item.type;
    const fn = item?.function;
    if (fn && typeof fn === 'object') {
      if (typeof fn.name === 'string' && fn.name) state.name = fn.name;
      if (typeof fn.arguments === 'string') {
        if (item.__replaceArguments) state.arguments = fn.arguments;
        else state.arguments += fn.arguments;
      }
    }
    return state;
  };

  const consumeChoice = (choice) => {
    const delta = choice?.delta;
    if (Array.isArray(delta?.tool_calls)) {
      delta.tool_calls.forEach((item, index) => stateFor(choice, item, index));
    }
    // Older Chat Completions gateways use the singular `function_call` field
    // and do not provide a provider call id. Keep that route usable with a
    // deterministic per-choice fallback id.
    if (delta?.function_call && typeof delta.function_call === 'object') {
      stateFor(choice, {
        index: 0,
        id: choice?.id ?? `call-${choice?.index ?? 0}`,
        type: 'function',
        function: delta.function_call
      }, 0);
    }
    // A few compatible gateways send a completed message in the final chunk.
    if (Array.isArray(choice?.message?.tool_calls)) {
      choice.message.tool_calls.forEach((item, index) => stateFor(choice, { ...item, __replaceArguments: true }, index));
    }
    if (choice?.message?.function_call && typeof choice.message.function_call === 'object') {
      stateFor(choice, {
        index: 0,
        id: choice?.id ?? `call-${choice?.index ?? 0}`,
        type: 'function',
        function: choice.message.function_call,
        __replaceArguments: true
      }, 0);
    }
  };

  const complete = (state) => {
    if (!state || emitted.has(state)) return undefined;
    const [normalizedCall] = normalizeChatCompletionsToolCalls({
      choices: [{ message: {
        tool_calls: [{
          id: state.id,
          ...(state.type === undefined ? {} : { type: state.type }),
          function: { name: state.name, arguments: state.arguments }
        }]
      } }]
    });
    const call = { ...normalizedCall, name: decodeToolName(normalizedCall.name) };
    if (emittedIds.has(call.id)) {
      throw new ToolCallNormalizationError('TOOL_CALL_DUPLICATE_ID', '', call.id);
    }
    emitted.add(state);
    emittedIds.add(call.id);
    return asToolCallChunk(call);
  };

  const consume = (payload) => {
    const choices = Array.isArray(payload?.choices) ? payload.choices : [];
    choices.slice(0, 1).forEach(consumeChoice);
    const reason = choices[0]?.finish_reason;
    if (reason === 'tool_calls' || reason === 'function_call') {
      return [...states.values()].map(complete).filter(Boolean);
    }
    return [];
  };

  return {
    consume,
    flush: () => [...states.values()].map(complete).filter(Boolean),
    get size() { return emitted.size; }
  };
};

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];
  const flush = function* () {
    if (!dataLines.length) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n');
    dataLines = [];
    const currentEvent = eventName;
    eventName = '';
    yield { event: currentEvent, data, parsed: parseJson(data) };
  };
  const consume = function* (text) {
    buffer += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    while (true) {
      const separator = buffer.indexOf('\n\n');
      if (separator < 0) break;
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      yield* flush();
    }
  };

  for await (const chunk of body) yield* consume(decoder.decode(chunk, { stream: true }));
  yield* consume(decoder.decode());
  if (buffer.trim()) {
    const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const line of normalized.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    yield* flush();
  }
}

const responseDelta = (event, payload) => {
  const type = payload?.type ?? event;
  if (type === 'response.output_text.delta') return { type: 'text-delta', text: payload.delta ?? '' };
  if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
    return { type: 'reasoning-delta', text: payload.delta ?? '' };
  }
  if (type === 'response.failed' || type === 'error') {
    const error = payload.error ?? payload;
    return {
      type: 'finish',
      reason: { kind: 'error', failure: { code: error.code ?? 'MODEL_ERROR', message: error.message ?? 'Model request failed' } }
    };
  }
  if (type === 'response.completed' || type === 'response.done') {
    return { type: 'finish', reason: { kind: 'stop' } };
  }
  return undefined;
};

const chatDelta = (event, payload) => {
  if (event === 'error' || payload?.error) {
    const error = payload.error ?? payload;
    return {
      type: 'finish',
      reason: { kind: 'error', failure: { code: error.code ?? 'MODEL_ERROR', message: error.message ?? 'Model request failed' } }
    };
  }
  const choice = payload?.choices?.[0];
  if (choice?.delta?.content) return { type: 'text-delta', text: choice.delta.content };
  if (choice?.delta?.reasoning_content) return { type: 'reasoning-delta', text: choice.delta.reasoning_content };
  if (choice?.finish_reason) return { type: 'finish', reason: { kind: finishKind(choice.finish_reason) } };
  return undefined;
};

const createOpenAICompatiblePlugin = (options = {}) => cordisPlugin((ctx) => {
  const retries = options.transportRetries ?? 2;
  const retryDelayMs = options.transportRetryDelayMs ?? 500;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5000) throw new Error('MODEL_RETRY_CONFIG_INVALID');
  const protocol = options.protocol ?? 'responses';
  if (!PROTOCOLS.includes(protocol)) throw new Error(`UNKNOWN_MODEL_PROTOCOL:${protocol}`);
  const apiKeyEnv = options.apiKeyEnv ?? 'OPENAI_API_KEY';
  const baseUrl = trimBaseUrl(options.baseURL ?? DEFAULT_BASE_URL);
  const endpoint = options.endpoint ?? `${baseUrl}/${protocol === 'responses' ? 'responses' : 'chat/completions'}`;
  const model = options.model ?? DEFAULT_RESPONSES_MODEL;
  // Extra headers let a gateway require routing metadata (for example
  // OpenCode Go's `x-opencode-session`).  The session id is generated once per
  // provider instance so requests stay on one backend for prompt caching.
  const extraHeaders = options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
    ? Object.fromEntries(Object.entries(options.headers).filter(([name, value]) => typeof name === 'string' && name && typeof value === 'string'))
    : {};
  const sessionHeader = typeof options.sessionHeader === 'string' && options.sessionHeader ? options.sessionHeader : undefined;
  const sessionId = sessionHeader ? randomUUID() : undefined;

  ctx.provide('modelProvider', {
    provider: options.provider ?? 'openai',
    protocol,
    model,
    async *stream(request) {
      const apiKey = process.env[apiKeyEnv]?.trim();
      if (!apiKey) throw new Error(`MISSING_CREDENTIAL:${apiKeyEnv}`);
      const cacheEnabled = process.env.HMCODEX_PROMPT_CACHE !== 'off';
      const scopedSession = cacheEnabled && request.cacheScope ? cacheSessionId({
        scope: request.cacheScope, endpoint, model, role: request.cacheRole ?? 'executor',
        system: request.system ?? '', tools: request.tools
      }) : sessionId;
      const requestTools = cacheEnabled ? stableToolDefinitions(request.tools) : request.tools;
      const body = protocol === 'responses'
        ? (() => {
            const tools = responsesTools(requestTools);
            return {
              model,
              instructions: request.system,
              input: responseInput(request.messages),
              ...(request.logprobs === true ? { include: ['message.output_text.logprobs'], top_logprobs: 20 } : {}),
              ...(tools === undefined ? {} : { tools }),
              stream: true
            };
          })()
        : (() => {
            const tools = chatCompletionsTools(requestTools);
            return {
              model,
              messages: request.system
                ? [{ role: 'system', content: request.system }, ...chatMessages(request.messages)]
                : chatMessages(request.messages),
              ...(tools === undefined ? {} : { tools }),
              stream: true
            };
          })();
      if (protocol === 'chat-completions' && process.env.HMCODEX_STREAM_USAGE !== 'off') body.stream_options = { include_usage: true };
      // Only the official OpenAI host is assumed to support this routing field.
      // Compatible gateways still benefit from identical prefixes and their
      // configured session header, without being sent unsupported cache keys.
      if (cacheEnabled && request.cacheScope && new URL(endpoint).hostname === 'api.openai.com') {
        body.prompt_cache_key = cacheSessionId({ scope: request.cacheScope, endpoint, model,
          role: request.cacheRole ?? 'executor', system: request.system ?? '', tools: requestTools });
      }
      if (request.logprobs === true && protocol === 'chat-completions') {
        body.logprobs = true;
        body.top_logprobs = 20;
      }
      const response = await fetchModelStream(endpoint, {
        method: 'POST',
        headers: {
          ...extraHeaders,
          ...(sessionHeader ? { [sessionHeader]: scopedSession } : {}),
          accept: 'text/event-stream',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: request.signal
      }, { retries, retryDelayMs });
      if (!response.ok || !response.body) {
        const raw = await response.text().catch(() => '');
        throw new Error(`MODEL_HTTP_ERROR:${failureMessage(response.status, parseJson(raw))}`);
      }
      let finished = false;
      let usage;
      let pendingFinish;
      const toolState = protocol === 'responses' ? createResponsesToolState() : createChatToolState();
      for await (const event of sseEvents(response.body)) {
        if (event.data === '[DONE]') {
          if (!finished) {
            for (const toolCall of toolState.flush()) yield toolCall;
            if (usage) yield { type: 'usage', usage };
            yield pendingFinish ?? { type: 'finish', reason: { kind: toolState.size > 0 ? 'tool-calls' : 'stop' } };
          }
          finished = true;
          continue;
        }
        // Usage may arrive after finish_reason with choices=[], or on the
        // final Responses envelope. Keep the latest cumulative snapshot once.
        const rawUsage = protocol === 'responses' ? event.parsed?.response?.usage ?? event.parsed?.usage : event.parsed?.usage;
        const reportedUsage = providerTokenUsage(rawUsage, protocol);
        if (reportedUsage) usage = reportedUsage;
        const toolCalls = protocol === 'responses'
          ? toolState.consume(event.event, event.parsed)
          : toolState.consume(event.parsed);
        if (request.logprobs === true) {
          const positions = protocol === 'responses'
            ? (event.parsed?.type === 'response.output_text.delta' || event.event === 'response.output_text.delta' ? event.parsed?.logprobs : undefined)
            : event.parsed?.choices?.[0]?.logprobs?.content;
          if (Array.isArray(positions) && positions.length) yield { type: 'score-logprobs', positions };
        }
        for (const toolCall of toolCalls) yield toolCall;
        const chunk = protocol === 'responses'
          ? responseDelta(event.event, event.parsed)
          : chatDelta(event.event, event.parsed);
        if (!chunk) continue;
        if (chunk.type === 'finish' && !['error', 'aborted', 'max-tokens'].includes(chunk.reason.kind)) {
          // A gateway may report `stop` even when it streamed function-call
          // fragments. Complete pending calls before publishing the terminal
          // reason so consumers never observe a call after finish.
          for (const toolCall of toolState.flush()) yield toolCall;
        }
        if (chunk.type === 'finish' && chunk.reason.kind === 'stop' && toolState.size > 0) {
          chunk.reason = { kind: 'tool-calls' };
        }
        if (chunk.type === 'finish') {
          pendingFinish = chunk;
          continue;
        }
        yield chunk;
      }
      if (!finished) {
        for (const toolCall of toolState.flush()) yield toolCall;
        if (usage) yield { type: 'usage', usage };
        yield pendingFinish ?? { type: 'finish', reason: { kind: toolState.size > 0 ? 'tool-calls' : 'stop' } };
      }
    }
  });
}, 'model-openai-compatible');

export { createOpenAICompatiblePlugin };
