// Both clients use this same adapter and real upstream model. Credentials
// remain in the gateway process; request artifacts contain no auth headers.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { listenOnFetchablePort } from '../../runtime/test/helpers/listen-loopback.mjs';
import { emitGoalResponse, flattenGoalTools } from './goal-model-fixture.mjs';
import { priceGoalUsage, validateGoalPricing } from './goal-measurements.mjs';
import { goalRequestCorrelation } from './goal-request-correlation.mjs';

const contentText = content => typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('\n');
export const responsesToChat = body => {
  const messages = [];
  if (body.instructions) messages.push({ role: 'system', content: body.instructions });
  for (const item of typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? []) {
    if (item.type === 'function_call') {
      const call = { id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
    } else if (item.role) {
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: contentText(item.content) });
    }
  }
  const tools = flattenGoalTools(body.tools).filter(tool => tool.type === 'function').map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description ?? '', parameters: tool.parameters ?? { type: 'object', properties: {} }
  } }));
  return { model: body.model, messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}), stream: false, max_tokens: 4096 };
};

export const startGoalLiveGateway = async (config, prices = {}, { fetchImpl = globalThis.fetch } = {}) => {
  if (config.protocol !== 'chat-completions') throw Error('LIVE_GATEWAY_REQUIRES_CHAT_COMPLETIONS_CONFIG');
  const apiKey = process.env[config.apiKeyEnv]?.trim();
  if (!apiKey) throw Error(`LIVE_MODEL_KEY_MISSING:${config.apiKeyEnv}`);
  const upstream = config.endpoint ?? `${config.baseURL.replace(/\/$/u, '')}/chat/completions`;
  const pricing = prices.schemaVersion ? validateGoalPricing(prices) : null;
  if (pricing && pricing.model !== config.model) throw Error('PRICING_MODEL_IDENTITY_MISMATCH');
  let active;
  const server = createServer(async (req, res) => {
    let request, responseStatus = 502;
    try {
      if (req.headers.authorization !== 'Bearer local-fixture-key') throw Error('LOCAL_GATEWAY_UNAUTHORIZED');
      if (!active || active.requests.length >= 24) throw Error('MODEL_CALL_BUDGET_REACHED');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== config.model) throw Error('MODEL_IDENTITY_MISMATCH');
      request = { sequence: active.requests.length + 1, body, model: config.model, startedAt: new Date().toISOString() };
      active.requests.push(request);
      const headers = { ...config.headers, 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
      if (config.sessionHeader) headers[config.sessionHeader] = active.sessionId;
      else if (new URL(upstream).hostname === 'opencode.ai') headers['x-opencode-session'] = active.sessionId;
      headers['user-agent'] = 'dda-goal-comparison/3.0';
      const upstreamResponse = await fetchImpl(upstream, { method: 'POST', headers, body: JSON.stringify(responsesToChat(body)), signal: AbortSignal.timeout(60000) });
      request.upstreamStatus = upstreamResponse.status;
      Object.assign(request, goalRequestCorrelation(upstreamResponse, null));
      if (!upstreamResponse.ok) responseStatus = upstreamResponse.status;
      if (!upstreamResponse.ok) throw Error(`LIVE_MODEL_HTTP_${upstreamResponse.status}`);
      const data = await upstreamResponse.json();
      Object.assign(request, goalRequestCorrelation(upstreamResponse, data));
      request.upstreamModel = typeof data.model === 'string' ? data.model : null;
      request.rawUsage = data.usage ?? null;
      const message = data.choices?.[0]?.message;
      if (!message) throw Error('LIVE_MODEL_EMPTY_RESPONSE');
      const output = [];
      if (message.content) output.push({ type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: message.content, annotations: [] }] });
      for (const call of message.tool_calls ?? []) output.push({ type: 'function_call', id: `fc_${randomUUID()}`,
        call_id: call.id ?? `call_${randomUUID()}`, name: call.function.name, arguments: call.function.arguments, status: 'completed' });
      if (!output.length) throw Error('LIVE_MODEL_EMPTY_OUTPUT');
      const rawUsage = data.usage ?? {};
      const inputTokens = rawUsage.prompt_tokens, outputTokens = rawUsage.completion_tokens;
      if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) throw Error('LIVE_MODEL_USAGE_MISSING');
      const cached = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens;
      const usage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
        ...(Number.isFinite(cached) ? { input_tokens_details: { cached_tokens: cached } } : {}), output_tokens_details: { reasoning_tokens: rawUsage.completion_tokens_details?.reasoning_tokens ?? 0 } };
      const priced = priceGoalUsage({ inputTokens, outputTokens, cachedInputTokens: cached }, pricing);
      const estimatedCost = pricing ? priced.value : Number.isFinite(prices.input) && Number.isFinite(prices.output)
        ? (inputTokens * prices.input + outputTokens * prices.output) / 1e6 : null;
      Object.assign(request, { output, usage, rawUsage, cachedTokens: Number.isFinite(cached) ? cached : null,
        estimatedCost, pricing: pricing ? priced : null, actualCost: null,
        priceAssumption: pricing ? `${pricing.basis}; separate cached input rate; actual invoice unknown` : 'uncached input rate; actual billing unknown', completedAt: new Date().toISOString() });
      emitGoalResponse(res, output, usage, config.model);
    } catch (error) {
      if (request) Object.assign(request, { error: error.message, ...(typeof error.cause?.code === 'string' ? { transportErrorCode: error.cause.code } : {}), completedAt: new Date().toISOString(), actualCost: null });
      res.writeHead(responseStatus, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const port = await listenOnFetchablePort(server);
  return { endpoint: `http://127.0.0.1:${port}/responses`, model: config.model, mode: 'live', pricing, privateEnvKeys: [config.apiKeyEnv],
    begin(task) { active = { task, sessionId: randomUUID(), requests: [] }; return active; },
    close: () => new Promise(done => server.close(done)) };
};
