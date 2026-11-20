// Per-model context window. Every model resolves to a token ceiling: an
// operator override, a published window, or the default. Compaction starts
// before that ceiling so the next completion still fits.

export const MIN_CONTEXT_LIMIT_TOKENS = 8_192;
export const MAX_CONTEXT_LIMIT_TOKENS = 2_000_000;
export const DEFAULT_CONTEXT_LIMIT_TOKENS = 128_000;
export const DEFAULT_CHARS_PER_TOKEN = 2;
const MIN_CHARS_PER_TOKEN = 1;
const MAX_CHARS_PER_TOKEN = 8;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;

// Longest matching prefix wins. A rule matches the id itself or an id that
// continues with "-" or "." so "deepseek-v4" does not claim "deepseek-v40".
const BUILTIN_CONTEXT_LIMITS = Object.freeze([
  ['deepseek-v4', 1_048_576],
  ['deepseek-reasoner', 128_000],
  ['deepseek-chat', 128_000],
  ['gpt-4.1', 1_047_576],
  ['gpt-4o', 128_000],
  ['o4-mini', 200_000],
  ['o3', 200_000],
  ['o1', 200_000],
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-3-7', 200_000],
  ['claude-3-5', 200_000],
  ['claude-3', 200_000],
  ['gemini-2.5', 1_048_576],
  ['gemini-2.0', 1_048_576],
  ['gemini-1.5', 1_048_576],
  ['qwen3', 262_144],
  ['qwen2.5', 131_072]
]);

export const normalizeContextModelId = (modelId) => {
  const text = String(modelId ?? '').trim().toLowerCase();
  if (!text) return '';
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
};

export const parseContextLimitTokens = (value) => {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(number) || number < MIN_CONTEXT_LIMIT_TOKENS || number > MAX_CONTEXT_LIMIT_TOKENS) return undefined;
  return number;
};

export const knownContextLimitTokens = (modelId) => {
  const id = normalizeContextModelId(modelId);
  if (!id) return undefined;
  let best;
  for (const [prefix, tokens] of BUILTIN_CONTEXT_LIMITS) {
    const matched = id === prefix || id.startsWith(`${prefix}-`) || id.startsWith(`${prefix}.`);
    if (!matched) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, tokens };
  }
  return best?.tokens;
};

const configuredLimit = (limits, modelId) => {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return undefined;
  const direct = typeof modelId === 'string' ? parseContextLimitTokens(limits[modelId]) : undefined;
  if (direct) return direct;
  const wanted = normalizeContextModelId(modelId);
  if (!wanted) return undefined;
  for (const [key, value] of Object.entries(limits)) {
    if (normalizeContextModelId(key) !== wanted) continue;
    const parsed = parseContextLimitTokens(value);
    if (parsed) return parsed;
  }
  return undefined;
};

export const resolveContextLimitTokens = ({ modelId, limits } = {}) => {
  const configured = configuredLimit(limits, modelId);
  if (configured) return { tokens: configured, source: 'configured' };
  const known = knownContextLimitTokens(modelId);
  if (known) return { tokens: known, source: 'builtin' };
  return { tokens: DEFAULT_CONTEXT_LIMIT_TOKENS, source: 'default' };
};

export const validateModelContextLimits = (input) => {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:modelContextLimits');
  }
  const entries = Object.entries(input);
  if (entries.length > 256) throw new Error('MODEL_CONFIG_INVALID_FIELD:modelContextLimits');
  const limits = {};
  const seen = new Set();
  for (const [modelId, value] of entries) {
    if (typeof modelId !== 'string' || modelId !== modelId.trim() || !MODEL_ID_PATTERN.test(modelId)) {
      throw new Error('MODEL_CONFIG_INVALID_FIELD:modelContextLimits');
    }
    const normalized = normalizeContextModelId(modelId);
    if (seen.has(normalized)) throw new Error('MODEL_CONFIG_INVALID_FIELD:modelContextLimits');
    seen.add(normalized);
    const tokens = parseContextLimitTokens(value);
    if (tokens === undefined) throw new Error('MODEL_CONFIG_INVALID_FIELD:modelContextLimits');
    limits[modelId] = tokens;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
};

// Leave room for the completion. A 1M window that also counts max output
// keeps 128K aside; smaller windows keep about a fifth, capped at 32K.
export const reservedOutputTokens = (limitTokens) => {
  const limit = parseContextLimitTokens(limitTokens) ?? DEFAULT_CONTEXT_LIMIT_TOKENS;
  if (limit >= 1_000_000) return 131_072;
  return Math.min(32_768, Math.max(1_024, Math.floor(limit * 0.2)));
};

export const compactionTriggerTokens = (limitTokens) => {
  const limit = parseContextLimitTokens(limitTokens) ?? DEFAULT_CONTEXT_LIMIT_TOKENS;
  const reserved = Math.min(Math.max(0, limit - 4_096), reservedOutputTokens(limit));
  const usable = Math.max(4_096, limit - reserved);
  return Math.max(4_096, Math.floor(usable * 0.9));
};

export const clampCharsPerToken = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CHARS_PER_TOKEN;
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, number));
};

export const messageCharBudget = ({
  limitTokens,
  overheadChars = 0,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
} = {}) => {
  const total = Math.floor(compactionTriggerTokens(limitTokens) * clampCharsPerToken(charsPerToken));
  return Math.max(4_000, total - Math.max(0, Math.trunc(overheadChars)));
};

export const contextCompactionBudget = ({
  limitTokens,
  systemChars = 0,
  toolsChars = 0,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
  envMaxChars
} = {}) => {
  const modelBudget = messageCharBudget({
    limitTokens,
    overheadChars: Math.max(0, systemChars) + Math.max(0, toolsChars),
    charsPerToken
  });
  if (Number.isFinite(envMaxChars) && envMaxChars >= 4_000) {
    return Math.max(4_000, Math.min(modelBudget, Math.trunc(envMaxChars)));
  }
  return modelBudget;
};
