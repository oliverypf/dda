import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';

// Provider model catalog: fetch + multi-select write-back.
// This module never calls the desktop `save_model_config` command and never
// rewrites route fields. Confirmation replaces one providerKey's models only.

export const CATALOG_FETCH_TIMEOUT_MS = 30_000;
export const CATALOG_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
export const MAX_CATALOG_MODELS = 256;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_CATALOG_PROVIDERS = 64;
const DISPLAY_NAME_MAX = 240;
const CATALOG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const API_KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,120}$/;
const RESERVED_HEADER_NAMES = new Set(['accept', 'authorization', 'content-length', 'content-type', 'host']);
const OPENAI_COMPATIBLE_PROVIDERS = new Set(['openai', 'openai-responses', 'openai-chat', 'compatible']);

const DEFAULT_ROUTE = Object.freeze({
  provider: 'openai-chat',
  baseURL: 'https://opencode.ai/zen/go/v1',
  apiKeyEnv: 'OPENCODE_GO_API_KEY',
  sessionHeader: 'x-opencode-session'
});

const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const publicAddressError = (error) => {
  switch (error?.code) {
    case 'CATALOG_ADDRESS_MISSING':
      return '模型地址为空，无法获取可用模型。';
    case 'CATALOG_ADDRESS_INVALID':
      return '模型地址无效，无法获取可用模型。';
    case 'CATALOG_PROVIDER_UNSUPPORTED':
      return '当前 Provider 不支持获取可用模型。';
    case 'CATALOG_CREDENTIAL_MISSING':
      return '访问凭证环境变量名无效，无法获取可用模型。';
    default:
      return '获取可用模型失败。';
  }
};

/** Drop credential material if a caller-supplied message ever contains it. */
export const redactCatalogError = (message) => {
  const text = typeof message === 'string' ? message : '';
  const lower = text.toLowerCase();
  if (!text
    || lower.includes('authorization')
    || /bearer\s+\S/iu.test(text)
    || /:\/\/[^\s/]*@/u.test(text)) {
    return '获取可用模型失败。';
  }
  return [...text].slice(0, 240).join('');
};

/**
 * Trim, reject query/hash/userinfo, drop one trailing `/chat/completions`
 * or `/responses` segment, and drop trailing slashes. Origin and path are
 * compared with the URL parser, not substring search.
 */
export const normalizeCatalogAddress = (raw) => {
  if (typeof raw !== 'string') throw fail('CATALOG_ADDRESS_INVALID');
  const trimmed = raw.trim();
  if (!trimmed) throw fail('CATALOG_ADDRESS_MISSING');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw fail('CATALOG_ADDRESS_INVALID');
  }
  if (url.search || url.hash || url.username || url.password) throw fail('CATALOG_ADDRESS_INVALID');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('CATALOG_ADDRESS_INVALID');
  let path = url.pathname.replace(/\/+$/u, '');
  if (path.endsWith('/chat/completions')) path = path.slice(0, -'/chat/completions'.length);
  else if (path.endsWith('/responses')) path = path.slice(0, -'/responses'.length);
  path = path.replace(/\/+$/u, '');
  if (!path) path = '/';
  url.pathname = path;
  url.search = '';
  url.hash = '';
  const href = path === '/' ? url.origin : url.href.replace(/\/$/u, '');
  return { href, origin: url.origin, pathname: path };
};

export const joinModelsUrl = (normalized, kind) => {
  const { href, pathname } = normalized;
  if (pathname === '/models' || pathname.endsWith('/models')) return href;
  if (kind === 'deepseek') return `${href}/models`;
  if (pathname === '/v1' || pathname.endsWith('/v1')) return `${href}/models`;
  return `${href}/v1/models`;
};

const resolveApiKeyEnv = (route, providerKey) => {
  const fromFile = typeof route?.apiKeyEnv === 'string' ? route.apiKeyEnv.trim() : '';
  if (fromFile) {
    if (!API_KEY_ENV_PATTERN.test(fromFile)) throw fail('CATALOG_CREDENTIAL_MISSING');
    return fromFile;
  }
  if (providerKey === 'opencode-go') return 'OPENCODE_GO_API_KEY';
  if (providerKey === 'deepseek') return 'DEEPSEEK_API_KEY';
  return undefined;
};

/**
 * Address, providerKey, and protocol branch are one decision.
 * OpenAI-compatible uses endpoint when present, otherwise baseURL.
 * DeepSeek uses baseURL only and ignores endpoint.
 */
export const resolveCatalogTarget = (route = {}) => {
  const provider = typeof route.provider === 'string' ? route.provider.trim() : '';
  let raw;
  if (provider === 'deepseek') {
    const base = typeof route.baseURL === 'string' ? route.baseURL.trim() : '';
    raw = base || 'https://api.deepseek.com/models';
  } else if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    const endpoint = typeof route.endpoint === 'string' ? route.endpoint.trim() : '';
    const baseURL = typeof route.baseURL === 'string' ? route.baseURL.trim() : '';
    raw = endpoint || baseURL;
    if (!raw) throw fail('CATALOG_ADDRESS_MISSING');
  } else {
    throw fail('CATALOG_PROVIDER_UNSUPPORTED');
  }
  const normalized = normalizeCatalogAddress(raw);
  const opencodeGo = normalized.origin === 'https://opencode.ai' && normalized.pathname === '/zen/go/v1';
  let providerKey;
  let kind;
  if (opencodeGo) {
    providerKey = 'opencode-go';
    kind = 'openai';
  } else if (provider === 'deepseek') {
    providerKey = 'deepseek';
    kind = 'deepseek';
  } else {
    providerKey = provider;
    kind = 'openai';
  }
  return {
    providerKey,
    modelsUrl: joinModelsUrl(normalized, kind),
    apiKeyEnv: resolveApiKeyEnv(route, providerKey),
    origin: normalized.origin,
    pathname: normalized.pathname
  };
};

export const routeFromDocument = (document) => {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { ...DEFAULT_ROUTE };
  return {
    provider: document.provider,
    baseURL: document.baseURL,
    endpoint: document.endpoint,
    apiKeyEnv: document.apiKeyEnv,
    sessionHeader: document.sessionHeader,
    headers: document.headers
  };
};

const validSessionHeader = (value) => {
  if (typeof value !== 'string' || !HEADER_NAME_PATTERN.test(value) || RESERVED_HEADER_NAMES.has(value.toLowerCase())) {
    return undefined;
  }
  return value;
};

const remoteDisplayName = (remote, id) => {
  const name = remote && typeof remote.name === 'string' ? remote.name.trim() : '';
  return name || id;
};

export const parseRemoteModelList = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data)) {
    return { ok: false, error: '获取可用模型失败：响应中没有模型列表。' };
  }
  const remote = [];
  const seen = new Set();
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || !CATALOG_MODEL_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined;
    remote.push(name ? { id, name } : { id });
  }
  return { ok: true, remote };
};

export const catalogModelsFor = (document, providerKey) => {
  const catalogs = document?.providerModelCatalogs;
  if (!Array.isArray(catalogs)) return [];
  const entry = catalogs.find((item) => item && item.providerKey === providerKey);
  if (!entry || !Array.isArray(entry.models)) return [];
  const models = [];
  const seen = new Set();
  for (const model of entry.models) {
    if (!model || typeof model.id !== 'string' || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
};

export const buildCatalogPickerRows = ({ catalogModels = [], remoteModels = [] } = {}) => {
  const remoteById = new Map();
  for (const remote of remoteModels) {
    if (!remote || typeof remote.id !== 'string' || remoteById.has(remote.id)) continue;
    if (!CATALOG_MODEL_ID_PATTERN.test(remote.id)) continue;
    remoteById.set(remote.id, remote);
  }
  const rows = [];
  const seen = new Set();
  for (const entry of catalogModels) {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const remote = remoteById.get(entry.id);
    const preserved = typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName : undefined;
    rows.push({
      id: entry.id,
      displayName: preserved ?? remoteDisplayName(remote, entry.id),
      checked: true,
      localOnly: !remote,
      preserveDisplayName: preserved !== undefined,
      preservedDisplayName: preserved
    });
  }
  for (const remote of remoteById.values()) {
    if (seen.has(remote.id)) continue;
    seen.add(remote.id);
    rows.push({
      id: remote.id,
      displayName: remoteDisplayName(remote, remote.id),
      checked: false,
      localOnly: false,
      preserveDisplayName: false
    });
  }
  return rows;
};

const validDisplayName = (value) => typeof value === 'string'
  && value.trim().length > 0
  && value.length <= DISPLAY_NAME_MAX
  && !/[\u0000-\u001F\u007F]/u.test(value);

/**
 * Checked ids are kept. Unchecked ids are removed. Existing non-empty
 * displayName is copied verbatim. Missing displayName is filled from the
 * remote `name`, otherwise the id. Ids that were not in the picker are ignored.
 */
export const applyCatalogConfirmation = ({ catalogModels = [], remoteModels = [], checkedIds = [] } = {}) => {
  const rows = buildCatalogPickerRows({ catalogModels, remoteModels });
  const checked = new Set(checkedIds);
  const next = [];
  for (const row of rows) {
    if (!checked.has(row.id)) continue;
    if (!CATALOG_MODEL_ID_PATTERN.test(row.id)) return { ok: false, error: '模型目录校验失败，未写入。' };
    const displayName = row.preserveDisplayName ? row.preservedDisplayName : row.displayName;
    if (!validDisplayName(displayName)) return { ok: false, error: '模型目录校验失败，未写入。' };
    next.push({ id: row.id, displayName });
  }
  if (next.length > MAX_CATALOG_MODELS) return { ok: false, error: '模型目录校验失败，未写入。' };
  return { ok: true, models: next };
};

export const replaceProviderCatalog = (document, providerKey, models) => {
  const catalogs = Array.isArray(document.providerModelCatalogs) ? document.providerModelCatalogs : [];
  const nextCatalogs = [];
  let placed = false;
  for (const entry of catalogs) {
    if (entry && entry.providerKey === providerKey) {
      if (!placed) {
        nextCatalogs.push({ providerKey, models });
        placed = true;
      }
      continue;
    }
    nextCatalogs.push(entry);
  }
  if (!placed) nextCatalogs.push({ providerKey, models });
  return { ...document, providerModelCatalogs: nextCatalogs };
};

export const readModelConfigDocument = async (configPath) => {
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, existed: false, document: null };
    return { ok: false, error: '读取模型配置失败。' };
  }
  if (raw.length > MAX_CONFIG_BYTES) return { ok: false, error: '模型配置超过 32 KB。' };
  let document;
  try {
    document = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { ok: false, error: '模型配置不是有效 JSON。' };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, error: '模型配置不是 JSON 对象。' };
  }
  return { ok: true, existed: true, document };
};

export const writeCatalogDocument = async (configPath, document) => {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) throw fail('CATALOG_CONFIG_TOO_LARGE');
  const temporary = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(serialized);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, configPath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
};

const validCatalogModel = (model) => {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  if (typeof model.id !== 'string' || !CATALOG_MODEL_ID_PATTERN.test(model.id)) return false;
  if (model.displayName !== undefined && !validDisplayName(model.displayName)) return false;
  return Object.keys(model).every((key) => key === 'id' || key === 'displayName');
};

/** Runtime load allows this key. Invalid shapes fail the config the same way other fields do. */
export const validateProviderModelCatalogs = (input) => {
  if (!Array.isArray(input) || input.length > MAX_CATALOG_PROVIDERS) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:providerModelCatalogs');
  }
  const seen = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('MODEL_CONFIG_INVALID_FIELD:providerModelCatalogs');
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'providerKey' && key !== 'models') {
        throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:providerModelCatalogs.${key}`);
      }
    }
    if (typeof entry.providerKey !== 'string' || !CATALOG_KEY_PATTERN.test(entry.providerKey) || seen.has(entry.providerKey)) {
      throw new Error('MODEL_CONFIG_INVALID_FIELD:providerModelCatalogs.providerKey');
    }
    seen.add(entry.providerKey);
    if (!Array.isArray(entry.models) || entry.models.length > MAX_CATALOG_MODELS) {
      throw new Error('MODEL_CONFIG_INVALID_FIELD:providerModelCatalogs.models');
    }
    const ids = new Set();
    const models = entry.models.map((model) => {
      if (model && typeof model === 'object' && !Array.isArray(model)) {
        for (const key of Object.keys(model)) {
          if (key !== 'id' && key !== 'displayName') {
            throw new Error(`MODEL_CONFIG_UNKNOWN_FIELD:providerModelCatalogs.models.${key}`);
          }
        }
      }
      if (!validCatalogModel(model) || ids.has(model.id)) {
        throw new Error('MODEL_CONFIG_INVALID_FIELD:providerModelCatalogs.models');
      }
      ids.add(model.id);
      return model.displayName === undefined ? { id: model.id } : { id: model.id, displayName: model.displayName };
    });
    return { providerKey: entry.providerKey, models };
  });
};

export const fetchProviderModels = async ({
  route,
  headers,
  env = {},
  fetchImpl,
  createSessionId,
  timeoutMs = CATALOG_FETCH_TIMEOUT_MS
} = {}) => {
  let target;
  try {
    target = resolveCatalogTarget(route);
  } catch (error) {
    return { ok: false, error: publicAddressError(error) };
  }
  if (!target.apiKeyEnv) return { ok: false, error: '未配置访问凭证环境变量，无法获取可用模型。' };
  const apiKey = typeof env[target.apiKeyEnv] === 'string' ? env[target.apiKeyEnv].trim() : '';
  if (!apiKey) return { ok: false, error: `环境变量 ${target.apiKeyEnv} 未设置，无法获取可用模型。` };
  const sessionHeader = validSessionHeader(route?.sessionHeader);
  const sessionId = sessionHeader ? createSessionId?.() : undefined;
  const requestHeaders = {};
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof name === 'string' && name && typeof value === 'string') requestHeaders[name] = value;
    }
  }
  if (sessionHeader && typeof sessionId === 'string' && sessionId) requestHeaders[sessionHeader] = sessionId;
  requestHeaders.authorization = `Bearer ${apiKey}`;
  requestHeaders.accept = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.modelsUrl, {
      method: 'GET',
      headers: requestHeaders,
      signal: controller.signal
    });
    if (!response?.ok) {
      const status = Number(response?.status) || 0;
      return { ok: false, error: status ? `获取可用模型失败（HTTP ${status}）。` : '获取可用模型失败。' };
    }
    let payload;
    try {
      payload = typeof response.json === 'function' ? await response.json() : undefined;
    } catch {
      return { ok: false, error: '获取可用模型失败：响应不是 JSON。' };
    }
    const parsed = parseRemoteModelList(payload);
    if (!parsed.ok) return { ok: false, error: redactCatalogError(parsed.error) };
    return { ok: true, providerKey: target.providerKey, modelsUrl: target.modelsUrl, remote: parsed.remote };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, error: '获取可用模型超时。' };
    }
    return { ok: false, error: '获取可用模型失败。' };
  } finally {
    clearTimeout(timer);
  }
};

const pickerRowsForClient = (rows) => rows.map((row) => ({
  id: row.id,
  displayName: row.displayName,
  checked: row.checked,
  localOnly: row.localOnly
}));

export const showProviderCatalog = async (configPath) => {
  const loaded = await readModelConfigDocument(configPath);
  if (!loaded.ok) return loaded;
  const route = routeFromDocument(loaded.existed ? loaded.document : null);
  let providerKey = '';
  let warning;
  try {
    providerKey = resolveCatalogTarget(route).providerKey;
  } catch {
    warning = '模型地址无效，暂时无法确定提供方。';
  }
  return {
    ok: true,
    providerKey,
    provider: typeof route.provider === 'string' ? route.provider : '',
    models: providerKey ? catalogModelsFor(loaded.document, providerKey).map((model) => (
      model.displayName === undefined ? { id: model.id } : { id: model.id, displayName: model.displayName }
    )) : [],
    ...(warning ? { warning } : {})
  };
};

export const saveProviderModelCatalog = async ({ configPath, providerKey, checkedIds, remote } = {}) => {
  const loaded = await readModelConfigDocument(configPath);
  if (!loaded.ok) return { ...loaded, error: redactCatalogError(loaded.error) };
  if (!loaded.existed || !loaded.document) {
    return { ok: false, error: '请先保存模型连接，再写入模型目录。' };
  }
  if (typeof providerKey !== 'string' || !CATALOG_KEY_PATTERN.test(providerKey)) {
    return { ok: false, error: '模型目录校验失败，未写入。' };
  }
  if (!Array.isArray(checkedIds) || !Array.isArray(remote)) {
    return { ok: false, error: '模型目录校验失败，未写入。' };
  }
  let target;
  try {
    target = resolveCatalogTarget(routeFromDocument(loaded.document));
  } catch (error) {
    return { ok: false, error: publicAddressError(error) };
  }
  if (target.providerKey !== providerKey) {
    return { ok: false, error: '当前模型连接已变化，模型目录未写入。' };
  }
  const applied = applyCatalogConfirmation({
    catalogModels: catalogModelsFor(loaded.document, providerKey),
    remoteModels: remote,
    checkedIds
  });
  if (!applied.ok) return applied;
  const next = replaceProviderCatalog(loaded.document, providerKey, applied.models);
  try {
    await writeCatalogDocument(configPath, next);
  } catch (error) {
    if (error?.code === 'CATALOG_CONFIG_TOO_LARGE') {
      return { ok: false, error: '模型配置超过 32 KB，模型目录未写入。' };
    }
    return { ok: false, error: '模型目录写入失败，未修改配置。' };
  }
  return { ok: true, providerKey, models: applied.models };
};

export const runCatalogCli = async ({
  command,
  configPath,
  env = process.env,
  stdin,
  fetchImpl,
  createSessionId,
  timeoutMs
} = {}) => {
  if (command === 'show') return showProviderCatalog(configPath);
  if (command === 'fetch') {
    const loaded = await readModelConfigDocument(configPath);
    if (!loaded.ok) return { ok: false, error: redactCatalogError(loaded.error) };
    const document = loaded.existed ? loaded.document : null;
    const route = routeFromDocument(document);
    const fetched = await fetchProviderModels({
      route,
      headers: document?.headers,
      env,
      fetchImpl,
      createSessionId,
      timeoutMs
    });
    if (!fetched.ok) return { ok: false, error: redactCatalogError(fetched.error) };
    const rows = pickerRowsForClient(buildCatalogPickerRows({
      catalogModels: catalogModelsFor(document, fetched.providerKey),
      remoteModels: fetched.remote
    }));
    return { ok: true, providerKey: fetched.providerKey, remote: fetched.remote, rows };
  }
  if (command === 'save') {
    let payload;
    try {
      payload = JSON.parse(stdin);
    } catch {
      return { ok: false, error: '模型目录校验失败，未写入。' };
    }
    return saveProviderModelCatalog({
      configPath,
      providerKey: payload?.providerKey,
      checkedIds: payload?.checkedIds,
      remote: payload?.remote
    });
  }
  return { ok: false, error: '不支持的模型目录命令。' };
};
