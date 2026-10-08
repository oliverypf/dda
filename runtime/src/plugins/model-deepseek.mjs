import LlmRuntime from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { cordisPlugin } from './cordis-plugin.mjs';
import { createOpenAICompatiblePlugin, encodeToolName, decodeToolName } from './model-openai.mjs';
import { resolveModelConfig } from '../model-config.mjs';
import { stableToolDefinitions } from '../prompt-cache.mjs';

const provider = 'deepseek-official';

export const deepSeekToolDefinitions = (tools) => {
  if (!Array.isArray(tools)) return undefined;
  const ordered = process.env.HMCODEX_PROMPT_CACHE === 'off' ? tools : stableToolDefinitions(tools);
  return ordered.map((tool) => ({
    name: encodeToolName(tool.name ?? tool.id),
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: tool.parameters ?? tool.inputSchema ?? {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  }));
};
const modelPlugin = (options) => cordisPlugin((ctx) => {
  const config = resolveAdapterOptions({
    apiKeyEnv: options.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    baseURL: options.baseURL,
    thinking: 'disabled',
    reasoningEffort: 'off',
    maxTokens: options.maxTokens ?? 4096,
    models: [{ id: options.model }]
  });
  const adapter = new DeepSeekAdapter({
    options: () => config,
    resolveApiKey: async () => {
      const key = process.env[options.apiKeyEnv ?? 'DEEPSEEK_API_KEY']?.trim();
      if (!key) throw new Error(`MISSING_CREDENTIAL:${options.apiKeyEnv ?? 'DEEPSEEK_API_KEY'}`);
      return key;
    },
    resolveUserId: () => 'hmcodex-local'
  });
  ctx.llm.registerAdapter([provider], adapter);
  ctx.provide('modelProvider', {
    provider,
    protocol: 'deepseek-harness',
    model: options.model,
    async *stream(request) {
      for await (const chunk of ctx.llm.stream({
        provider,
        model: options.model,
        system: request.system,
        messages: request.messages,
        ...(Array.isArray(request.tools) ? { tools: deepSeekToolDefinitions(request.tools) } : {}),
        ...(request.signal ? { signal: request.signal } : {})
      })) {
        if (chunk && typeof chunk === 'object' && typeof chunk.name === 'string') {
          yield { ...chunk, name: decodeToolName(chunk.name) };
        } else {
          yield chunk;
        }
      }
    }
  });
}, 'model-deepseek', ['llm']);

export const createDeepSeekModelPlugins = (options) => [
  LlmRuntime,
  modelPlugin({
    model: options.model,
    baseURL: options.baseURL,
    apiKeyEnv: options.apiKeyEnv,
    maxTokens: options.maxTokens
  })
];

/**
 * Resolve the model route explicitly. DeepSeek remains available, but is no
 * longer selected when the caller omits provider configuration.
 */
export const createModelPlugins = (options = {}) => {
  const config = options.protocol === 'deepseek-harness'
    ? options
    : resolveModelConfig({ overrides: options });
  const provider = config.provider;
  if (provider === 'deepseek') {
    return createDeepSeekModelPlugins(config);
  }
  if (provider === 'openai' || provider === 'openai-responses' || provider === 'openai-chat' || provider === 'compatible') {
    return [createOpenAICompatiblePlugin({
      ...config,
      provider,
      protocol: config.protocol,
      model: config.model,
      baseURL: config.baseURL,
      endpoint: config.endpoint,
      apiKeyEnv: config.apiKeyEnv
    })];
  }
  throw new Error(`UNKNOWN_MODEL_PROVIDER:${provider}`);
};
