import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeCustomInstructions } from './custom-instructions.mjs';
import { normalizeContinuousVerifierConfig } from './continuous-verifier.mjs';

// The continuous-verifier budget and criteria are operator configuration, not
// constants. They are validated by the same normaliser the verifier itself
// uses, so a config that reaches the runtime cannot disagree with what the
// verifier accepts.
const validateVerifierConfig = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:verifier');
  }
  for (const key of Object.keys(input)) {
    if (!VERIFIER_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:verifier.${key}`);
  }
  try {
    return normalizeContinuousVerifierConfig(input);
  } catch {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:verifier');
  }
};

export const MODEL_PROVIDERS = Object.freeze([
  'openai',
  'openai-responses',
  'openai-chat',
  'compatible',
  'deepseek'
]);

export const MODEL_PROTOCOLS = Object.freeze(['responses', 'chat-completions', 'deepseek-harness']);

// A provider's default wire protocol is intrinsic to the provider, not to the
// global default route.  `--provider openai` must keep using Responses even
// when the shipped default model is an OpenAI-compatible Chat Completions
// gateway such as OpenCode Go.
const defaultProtocolFor = (provider) => (provider === 'openai-chat' || provider === 'compatible'
  ? 'chat-completions'
  : 'responses');

export const DEFAULT_MODEL_CONFIG = Object.freeze({
  schemaVersion: '1.0',
  provider: 'openai-chat',
  protocol: 'chat-completions',
  model: 'mimo-v2.5-pro',
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  sessionHeader: 'x-opencode-session'
});

// OpenCode Go removed the short `mimo-v2.6` alias while retaining the
// explicitly versioned variants. Keep old hmCodex installations usable by
// normalising that alias only on the OpenCode Go route; other providers and
// user-selected model ids remain untouched.
const normalizeOpenCodeRoute = (value) => {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/+$/u, '').replace(/\/chat\/completions$/u, '');
    return url.origin === 'https://opencode.ai' && path === '/zen/go/v1';
  } catch {
    return false;
  }
};

export const normalizeLegacyModelAlias = ({ provider, model, baseURL, endpoint } = {}) => {
  if (provider !== 'openai-chat' || model !== 'mimo-v2.6') return model;
  if (normalizeOpenCodeRoute(baseURL) || normalizeOpenCodeRoute(endpoint)) return 'mimo-v2.6-pro';
  return model;
};

export const defaultModelConfigPath = (env = process.env) => {
  const dataRoot = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_CONFIG_HOME;
  return dataRoot ? join(dataRoot, 'hmCodex', 'model-config.json') : undefined;
};

const MAX_CONFIG_CHARS = 32 * 1024;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'provider',
  'protocol',
  'model',
  'baseURL',
  'endpoint',
  'apiKeyEnv',
  'headers',
  'sessionHeader',
  'customInstructions',
  'models',
  'roleBindings',
  'verifier',
  'decision'
]);
const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const ROLE_BINDING_KEYS = new Set(['selector', 'modelId', 'allowList', 'requiredCapabilities', 'requireEligible', 'candidateBindings', 'fanout', 'selectionPolicyRef', 'fanoutBudget']);
const CANDIDATE_BINDING_KEYS = new Set(['bindingId', 'modelId', 'expectedCost', 'expectedLatencyMs', 'expectedTokens']);
const FANOUT_BUDGET_KEYS = new Set(['maxCandidates', 'maxConcurrency', 'maxCost', 'maxTokens']);
const VERIFIER_KEYS = new Set(['criteria', 'repetitions', 'maxComparisons', 'pivots', 'seed', 'maxPromptChars', 'passThreshold', 'failThreshold']);
const DECISION_KEYS = new Set(['enabled', 'enforce', 'endpoint', 'apiKeyEnv', 'model', 'timeoutMs', 'maxStateChars', 'classificationEnabled', 'routeSelectionEnabled', 'topologyEnabled', 'planReviewEnabled', 'diagnosisEnabled', 'recoveryDirectionEnabled', 'contextPackEnabled']);
const MODEL_ENTRY_KEYS = new Set(['id', 'modelId', 'provider', 'protocol', 'model', 'baseURL', 'endpoint', 'apiKeyEnv', 'headers', 'sessionHeader', 'capabilities', 'roles', 'costPer1kTokens', 'latencyMs', 'state', 'version']);

const clone = (value) => structuredClone(value);

const optionalString = (value, field, maxLength = 500) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  }
  return value.trim();
};

const validateUrl = (value, field) => {
  if (value === undefined) return undefined;
  const text = optionalString(value, field, 2000);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  }
  return text;
};

const validateNonNegativeNumber = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  return value;
};

const validateBoundedInteger = (value, field, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  return value;
};

const validateStringList = (value, field, max = 32) => {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) {
    throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  }
  return [...new Set(value.map((item) => item.trim()))];
};

const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,120}$/;
const RESERVED_HEADER_NAMES = new Set(['accept', 'authorization', 'content-length', 'content-type', 'host']);

const validateHeaderName = (value, field) => {
  if (typeof value !== 'string' || !HEADER_NAME_PATTERN.test(value) || RESERVED_HEADER_NAMES.has(value.toLowerCase())) {
    throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  }
  return value;
};

const validateHeaders = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}`);
  const headers = {};
  for (const [name, headerValue] of entries) {
    const key = validateHeaderName(name, `${field}.${name}`);
    if (typeof headerValue !== 'string' || headerValue.length > 2000 || /[\r\n]/u.test(headerValue)) {
      throw new Error(`MODEL_CONFIG_INVALID_FIELD:${field}.${name}`);
    }
    headers[key] = headerValue;
  }
  return headers;
};

const validateSessionHeader = (value) => {
  if (value === undefined) return undefined;
  return validateHeaderName(optionalString(value, 'sessionHeader', 120), 'sessionHeader');
};

const validateModelEntry = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models');
  for (const key of Object.keys(input)) if (!MODEL_ENTRY_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:models.${key}`);
  const modelId = optionalString(input.modelId ?? input.id, 'models.modelId', 240);
  if (!modelId || !MODEL_ID_PATTERN.test(modelId)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.modelId');
  const provider = optionalString(input.provider, 'models.provider', 80);
  if (!provider || !MODEL_PROVIDERS.includes(provider)) throw new Error(`MODEL_CONFIG_UNKNOWN_PROVIDER:${provider}`);
  const protocol = optionalString(input.protocol, 'models.protocol', 40);
  if (!protocol || !MODEL_PROTOCOLS.includes(protocol)) throw new Error(`MODEL_CONFIG_UNKNOWN_PROTOCOL:${protocol}`);
  const model = optionalString(input.model, 'models.model', 200);
  if (!model) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.model');
  const apiKeyEnv = optionalString(input.apiKeyEnv, 'models.apiKeyEnv', 120);
  if (apiKeyEnv !== undefined && !API_KEY_ENV_PATTERN.test(apiKeyEnv)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.apiKeyEnv');
  const state = input.state ?? 'ACTIVE';
  if (!['ACTIVE', 'DEGRADED', 'DISABLED', 'QUARANTINED'].includes(state)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.state');
  const costPer1kTokens = input.costPer1kTokens === undefined ? undefined : Number(input.costPer1kTokens);
  const latencyMs = input.latencyMs === undefined ? undefined : Number(input.latencyMs);
  if (costPer1kTokens !== undefined && (!Number.isFinite(costPer1kTokens) || costPer1kTokens < 0)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.costPer1kTokens');
  if (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0)) throw new Error('MODEL_CONFIG_INVALID_FIELD:models.latencyMs');
  return {
    modelId,
    provider,
    protocol,
    model,
    ...(input.baseURL === undefined ? {} : { baseURL: validateUrl(input.baseURL, 'models.baseURL') }),
    ...(input.endpoint === undefined ? {} : { endpoint: validateUrl(input.endpoint, 'models.endpoint') }),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(input.headers === undefined ? {} : { headers: validateHeaders(input.headers, 'models.headers') }),
    ...(input.sessionHeader === undefined ? {} : { sessionHeader: validateSessionHeader(input.sessionHeader) }),
    ...(input.capabilities === undefined ? {} : { capabilities: validateStringList(input.capabilities, 'models.capabilities') }),
    ...(input.roles === undefined ? {} : { roles: validateStringList(input.roles, 'models.roles') }),
    ...(costPer1kTokens === undefined ? {} : { costPer1kTokens }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    state,
    ...(input.version === undefined ? {} : { version: optionalString(input.version, 'models.version', 64) })
  };
};

const validateRoleBindings = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MODEL_CONFIG_INVALID_FIELD:roleBindings');
  const result = {};
  for (const [role, raw] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(role)) throw new Error('MODEL_CONFIG_INVALID_FIELD:roleBindings');
    if (typeof raw === 'string') {
      result[role] = raw.trim();
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}`);
    for (const key of Object.keys(raw)) if (!ROLE_BINDING_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:roleBindings.${role}.${key}`);
    const selector = raw.selector ?? (raw.modelId ? 'PINNED' : (raw.candidateBindings ? 'CANDIDATE_SET' : 'ALLOW_LIST'));
    if (!['PINNED', 'ALLOW_LIST', 'BEST_AVAILABLE', 'CANDIDATE_SET'].includes(selector)) throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.selector`);
    if (selector === 'CANDIDATE_SET') {
      // Candidate-set shape is validated here so a malformed fanout fails at
      // config load, not in the middle of a task.
      if (!Array.isArray(raw.candidateBindings) || raw.candidateBindings.length < 1 || raw.candidateBindings.length > 16) {
        throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.candidateBindings`);
      }
      const candidateBindings = raw.candidateBindings.map((binding, index) => {
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.candidateBindings[${index}]`);
        for (const key of Object.keys(binding)) {
          if (!CANDIDATE_BINDING_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:roleBindings.${role}.candidateBindings[${index}].${key}`);
        }
        const modelId = optionalString(binding.modelId, `roleBindings.${role}.candidateBindings[${index}].modelId`, 240);
        if (!modelId || !MODEL_ID_PATTERN.test(modelId)) throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.candidateBindings[${index}].modelId`);
        const bindingId = binding.bindingId === undefined ? undefined : optionalString(binding.bindingId, `roleBindings.${role}.candidateBindings[${index}].bindingId`, 240);
        return {
          modelId,
          ...(bindingId ? { bindingId } : {}),
          ...(binding.expectedCost === undefined ? {} : { expectedCost: validateNonNegativeNumber(binding.expectedCost, `roleBindings.${role}.candidateBindings[${index}].expectedCost`) }),
          ...(binding.expectedLatencyMs === undefined ? {} : { expectedLatencyMs: validateNonNegativeNumber(binding.expectedLatencyMs, `roleBindings.${role}.candidateBindings[${index}].expectedLatencyMs`) }),
          ...(binding.expectedTokens === undefined ? {} : { expectedTokens: validateNonNegativeNumber(binding.expectedTokens, `roleBindings.${role}.candidateBindings[${index}].expectedTokens`) })
        };
      });
      if (raw.fanout !== undefined && (!Number.isInteger(raw.fanout) || raw.fanout < 1 || raw.fanout > candidateBindings.length)) {
        throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.fanout`);
      }
      let fanoutBudget;
      if (raw.fanoutBudget !== undefined) {
        if (!raw.fanoutBudget || typeof raw.fanoutBudget !== 'object' || Array.isArray(raw.fanoutBudget)) {
          throw new Error(`MODEL_CONFIG_INVALID_FIELD:roleBindings.${role}.fanoutBudget`);
        }
        for (const key of Object.keys(raw.fanoutBudget)) {
          if (!FANOUT_BUDGET_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:roleBindings.${role}.fanoutBudget.${key}`);
        }
        fanoutBudget = {
          ...(raw.fanoutBudget.maxCandidates === undefined ? {} : { maxCandidates: validateBoundedInteger(raw.fanoutBudget.maxCandidates, `roleBindings.${role}.fanoutBudget.maxCandidates`, 1, 16) }),
          ...(raw.fanoutBudget.maxConcurrency === undefined ? {} : { maxConcurrency: validateBoundedInteger(raw.fanoutBudget.maxConcurrency, `roleBindings.${role}.fanoutBudget.maxConcurrency`, 1, 8) }),
          ...(raw.fanoutBudget.maxCost === undefined ? {} : { maxCost: validateNonNegativeNumber(raw.fanoutBudget.maxCost, `roleBindings.${role}.fanoutBudget.maxCost`) }),
          ...(raw.fanoutBudget.maxTokens === undefined ? {} : { maxTokens: validateNonNegativeNumber(raw.fanoutBudget.maxTokens, `roleBindings.${role}.fanoutBudget.maxTokens`) })
        };
      }
      result[role] = {
        selector,
        candidateBindings,
        ...(raw.fanout === undefined ? {} : { fanout: raw.fanout }),
        ...(raw.selectionPolicyRef === undefined ? {} : { selectionPolicyRef: optionalString(raw.selectionPolicyRef, `roleBindings.${role}.selectionPolicyRef`, 120) }),
        ...(fanoutBudget === undefined ? {} : { fanoutBudget })
      };
      continue;
    }
    result[role] = {
      selector,
      ...(raw.modelId === undefined ? {} : { modelId: optionalString(raw.modelId, `roleBindings.${role}.modelId`, 240) }),
      ...(raw.allowList === undefined ? {} : { allowList: validateStringList(raw.allowList, `roleBindings.${role}.allowList`, 256) }),
      ...(raw.requiredCapabilities === undefined ? {} : { requiredCapabilities: validateStringList(raw.requiredCapabilities, `roleBindings.${role}.requiredCapabilities`) }),
      ...(raw.requireEligible === undefined ? {} : { requireEligible: raw.requireEligible === true })
    };
  }
  return result;
};

const validateDecisionConfig = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:decision');
  }
  for (const key of Object.keys(input)) {
    if (!DECISION_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:decision.${key}`);
  }
  for (const key of ['enabled', 'enforce', 'classificationEnabled', 'routeSelectionEnabled', 'topologyEnabled', 'planReviewEnabled', 'diagnosisEnabled', 'recoveryDirectionEnabled', 'contextPackEnabled']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      throw new Error(`MODEL_CONFIG_INVALID_FIELD:decision.${key}`);
    }
  }
  const endpoint = validateUrl(input.endpoint, 'decision.endpoint');
  const apiKeyEnv = optionalString(input.apiKeyEnv, 'decision.apiKeyEnv', 120);
  if (apiKeyEnv !== undefined && !API_KEY_ENV_PATTERN.test(apiKeyEnv)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:decision.apiKeyEnv');
  }
  const model = optionalString(input.model, 'decision.model', 200);
  const timeoutMs = input.timeoutMs === undefined
    ? undefined
    : validateBoundedInteger(input.timeoutMs, 'decision.timeoutMs', 100, 10000);
  const maxStateChars = input.maxStateChars === undefined
    ? undefined
    : validateBoundedInteger(input.maxStateChars, 'decision.maxStateChars', 1000, 32000);
  return {
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.enforce === undefined ? {} : { enforce: input.enforce }),
    ...(endpoint ? { endpoint } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(model ? { model } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxStateChars === undefined ? {} : { maxStateChars }),
    ...(input.classificationEnabled === undefined ? {} : { classificationEnabled: input.classificationEnabled }),
    ...(input.routeSelectionEnabled === undefined ? {} : { routeSelectionEnabled: input.routeSelectionEnabled }),
    ...(input.topologyEnabled === undefined ? {} : { topologyEnabled: input.topologyEnabled }),
    ...(input.planReviewEnabled === undefined ? {} : { planReviewEnabled: input.planReviewEnabled }),
    ...(input.diagnosisEnabled === undefined ? {} : { diagnosisEnabled: input.diagnosisEnabled })
    ,...(input.recoveryDirectionEnabled === undefined ? {} : { recoveryDirectionEnabled: input.recoveryDirectionEnabled })
    ,...(input.contextPackEnabled === undefined ? {} : { contextPackEnabled: input.contextPackEnabled })
  };
};

export const validateModelConfig = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MODEL_CONFIG_INVALID');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:${key}`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== '1.0') {
    throw new Error('MODEL_CONFIG_UNSUPPORTED_SCHEMA');
  }
  const provider = optionalString(input.provider, 'provider', 80);
  if (provider !== undefined && !MODEL_PROVIDERS.includes(provider)) {
    throw new Error(`MODEL_CONFIG_UNKNOWN_PROVIDER:${provider}`);
  }
  const protocol = optionalString(input.protocol, 'protocol', 40);
  if (protocol !== undefined && !MODEL_PROTOCOLS.includes(protocol)) {
    throw new Error(`MODEL_CONFIG_UNKNOWN_PROTOCOL:${protocol}`);
  }
  const model = optionalString(input.model, 'model', 200);
  const apiKeyEnv = optionalString(input.apiKeyEnv, 'apiKeyEnv', 120);
  if (apiKeyEnv !== undefined && !API_KEY_ENV_PATTERN.test(apiKeyEnv)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:apiKeyEnv');
  }
  const baseURL = validateUrl(input.baseURL, 'baseURL');
  const endpoint = validateUrl(input.endpoint, 'endpoint');
  const customInstructions = normalizeCustomInstructions(input.customInstructions);
  return {
    schemaVersion: '1.0',
    ...(provider ? { provider } : {}),
    ...(protocol ? { protocol } : {}),
    ...(model ? { model } : {}),
    ...(baseURL ? { baseURL } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(input.headers === undefined ? {} : { headers: validateHeaders(input.headers, 'headers') }),
    ...(input.sessionHeader === undefined ? {} : { sessionHeader: validateSessionHeader(input.sessionHeader) }),
    ...(customInstructions ? { customInstructions } : {}),
    ...(input.models === undefined ? {} : {
      models: Array.isArray(input.models) && input.models.length <= 256 ? input.models.map(validateModelEntry) : (() => { throw new Error('MODEL_CONFIG_INVALID_FIELD:models'); })()
    }),
    ...(input.roleBindings === undefined ? {} : { roleBindings: validateRoleBindings(input.roleBindings) }),
    ...(input.verifier === undefined ? {} : { verifier: validateVerifierConfig(input.verifier) }),
    ...(input.decision === undefined ? {} : { decision: validateDecisionConfig(input.decision) })
  };
};

export const loadModelConfig = async (configPath, { required = false } = {}) => {
  if (!configPath) {
    if (required) throw new Error('MODEL_CONFIG_PATH_REQUIRED');
    return {};
  }
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return {};
    if (error?.code === 'ENOENT') throw new Error(`MODEL_CONFIG_NOT_FOUND:${configPath}`);
    throw new Error(`MODEL_CONFIG_READ:${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw.length > MAX_CONFIG_CHARS) throw new Error('MODEL_CONFIG_TOO_LARGE');
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    throw new Error('MODEL_CONFIG_INVALID_JSON');
  }
  return validateModelConfig(parsed);
};

export const resolveModelConfig = ({ fileConfig = {}, overrides = {}, env = process.env } = {}) => {
  const envValue = (name) => {
    const value = env?.[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const pick = (...values) => values.find((value) => value !== undefined);
  const provider = pick(overrides.provider, fileConfig.provider, envValue('HMCODEX_MODEL_PROVIDER'), DEFAULT_MODEL_CONFIG.provider);
  const isDeepSeek = provider === 'deepseek';
  // A provider switch is an explicit route change.  Do not silently carry
  // provider-specific model/endpoint/credential settings from a config file
  // belonging to the previous provider (for example `--provider deepseek`
  // while the user config points at OpenAI).  Explicit CLI fields still win;
  // otherwise resolve from the selected provider's environment/defaults.
  const providerFamily = (value) => value === 'deepseek' ? 'deepseek' : 'openai-compatible';
  const providerChangedByOverride = overrides.provider !== undefined
    && fileConfig.provider !== undefined
    && providerFamily(overrides.provider) !== providerFamily(fileConfig.provider);
  const providerIdentityChangedByOverride = overrides.provider !== undefined
    && fileConfig.provider !== undefined
    && overrides.provider !== fileConfig.provider;
  const fileProviderValue = (value) => providerChangedByOverride ? undefined : value;
  const fileProtocolValue = (value) => providerIdentityChangedByOverride ? undefined : value;
  const requestedProtocol = pick(overrides.protocol, fileProtocolValue(fileConfig.protocol), envValue('HMCODEX_MODEL_PROTOCOL'));
  if (requestedProtocol !== undefined && !MODEL_PROTOCOLS.includes(requestedProtocol)) {
    throw new Error(`MODEL_CONFIG_UNKNOWN_PROTOCOL:${requestedProtocol}`);
  }
  const protocol = isDeepSeek
    ? undefined
    : pick(
      overrides.protocol,
      fileProtocolValue(fileConfig.protocol),
      envValue('HMCODEX_MODEL_PROTOCOL'),
      defaultProtocolFor(provider)
    );
  const model = pick(
    overrides.model,
    fileProviderValue(fileConfig.model),
    envValue('HMCODEX_MODEL'),
    envValue(isDeepSeek ? 'DEEPSEEK_MODEL' : 'OPENAI_MODEL'),
    isDeepSeek ? 'deepseek-chat' : DEFAULT_MODEL_CONFIG.model
  );
  const baseURL = pick(
    overrides.baseURL,
    fileProviderValue(fileConfig.baseURL),
    envValue('HMCODEX_MODEL_BASE_URL'),
    envValue(isDeepSeek ? 'DEEPSEEK_BASE_URL' : 'OPENAI_BASE_URL'),
    isDeepSeek ? undefined : DEFAULT_MODEL_CONFIG.baseURL
  );
  // An endpoint is protocol-specific (`/responses` vs `/chat/completions`).
  // Do not carry a file endpoint across an explicit protocol/provider route
  // change unless the caller supplied a new endpoint on the command line.
  const fileEndpoint = fileProviderValue(fileConfig.endpoint);
  const endpointProtocolCompatible = fileEndpoint !== undefined
    && (fileConfig.protocol === undefined || fileConfig.protocol === protocol);
  const endpoint = pick(
    overrides.endpoint,
    endpointProtocolCompatible ? fileEndpoint : undefined,
    envValue('HMCODEX_MODEL_ENDPOINT')
  );
  const apiKeyEnv = pick(
    overrides.apiKeyEnv,
    fileProviderValue(fileConfig.apiKeyEnv),
    envValue('HMCODEX_MODEL_API_KEY_ENV'),
    isDeepSeek ? 'DEEPSEEK_API_KEY' : DEFAULT_MODEL_CONFIG.apiKeyEnv
  );
  // Extra request headers are provider-specific.  Drop file-supplied headers
  // when an explicit provider switch would otherwise leak them to another
  // gateway, and only apply the default session header on the exact default
  // route so a custom base URL never receives vendor-specific headers.
  const usesDefaultRoute = provider === DEFAULT_MODEL_CONFIG.provider
    && baseURL === DEFAULT_MODEL_CONFIG.baseURL
    && endpoint === undefined;
  // Endpoint-specific headers follow the same rule as the endpoint itself:
  // an explicit provider switch must not send a previous gateway's routing
  // headers (for example `x-opencode-session`) to the new provider.
  const fileHeaderValue = (value) => providerIdentityChangedByOverride ? undefined : value;
  const headers = pick(
    overrides.headers,
    fileHeaderValue(fileConfig.headers)
  );
  const sessionHeader = pick(
    overrides.sessionHeader,
    fileHeaderValue(fileConfig.sessionHeader),
    envValue('HMCODEX_MODEL_SESSION_HEADER'),
    usesDefaultRoute ? DEFAULT_MODEL_CONFIG.sessionHeader : undefined
  );
  const normalizedModel = normalizeLegacyModelAlias({ provider, model, baseURL, endpoint });
  const candidate = {
    schemaVersion: '1.0',
    provider,
    ...(protocol ? { protocol } : {}),
    model: normalizedModel,
    ...(baseURL ? { baseURL } : {}),
    ...(endpoint ? { endpoint } : {}),
    apiKeyEnv,
    ...(headers ? { headers: clone(headers) } : {}),
    ...(sessionHeader ? { sessionHeader } : {}),
    ...(fileConfig.customInstructions === undefined ? {} : { customInstructions: fileConfig.customInstructions }),
    ...(Array.isArray(fileConfig.models) ? { models: clone(fileConfig.models) } : {}),
    ...(fileConfig.roleBindings ? { roleBindings: clone(fileConfig.roleBindings) } : {}),
    ...(fileConfig.verifier ? { verifier: clone(fileConfig.verifier) } : {}),
    ...(fileConfig.decision ? { decision: clone(fileConfig.decision) } : {})
  };
  const resolved = validateModelConfig(candidate);
  if (isDeepSeek) resolved.protocol = 'deepseek-harness';
  return clone(resolved);
};

const parseBoolean = (value) => {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return undefined;
};

/** Resolve the optional Jev decision plane without changing the model route. */
export const resolveDecisionConfig = ({ fileConfig = {}, env = process.env } = {}) => {
  const configured = fileConfig?.decision ?? {};
  const envValue = (name) => {
    const value = env?.[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  // Jev is the default Decision Plane. Without a credential the engine still
  // fails closed to its bounded conservative fallbacks; it never revives the
  // removed LLM verifier path.
  const enabled = parseBoolean(envValue('HMCODEX_JEV_ENABLED')) ?? configured.enabled ?? true;
  const enforce = parseBoolean(envValue('HMCODEX_JEV_ENFORCE')) ?? configured.enforce ?? enabled;
  const endpoint = configured.endpoint ?? envValue('HMCODEX_JEV_ENDPOINT') ?? 'https://api.typesafe.ai/v1/system_one';
  const apiKeyEnv = configured.apiKeyEnv ?? envValue('HMCODEX_JEV_API_KEY_ENV') ?? 'JEV_API_KEY';
  const model = configured.model ?? envValue('HMCODEX_JEV_MODEL') ?? 'jev-latest';
  const timeoutMs = configured.timeoutMs ?? Number(envValue('HMCODEX_JEV_TIMEOUT_MS') ?? 1200);
  const maxStateChars = configured.maxStateChars ?? Number(envValue('HMCODEX_JEV_MAX_STATE_CHARS') ?? 16000);
  const featureFlag = (envName, configName) => parseBoolean(envValue(envName)) ?? configured[configName];
  return validateDecisionConfig({
    enabled, enforce, endpoint, apiKeyEnv, model, timeoutMs, maxStateChars,
    classificationEnabled: featureFlag('HMCODEX_JEV_CLASSIFY_ENABLED', 'classificationEnabled'),
    routeSelectionEnabled: featureFlag('HMCODEX_JEV_ROUTE_ENABLED', 'routeSelectionEnabled'),
    topologyEnabled: featureFlag('HMCODEX_JEV_TOPOLOGY_ENABLED', 'topologyEnabled'),
    planReviewEnabled: featureFlag('HMCODEX_JEV_PLAN_REVIEW_ENABLED', 'planReviewEnabled'),
    diagnosisEnabled: featureFlag('HMCODEX_JEV_DIAGNOSIS_ENABLED', 'diagnosisEnabled'),
    recoveryDirectionEnabled: featureFlag('HMCODEX_JEV_RECOVERY_DIRECTION_ENABLED', 'recoveryDirectionEnabled'),
    contextPackEnabled: featureFlag('HMCODEX_JEV_CONTEXT_PACK_ENABLED', 'contextPackEnabled')
  });
};
