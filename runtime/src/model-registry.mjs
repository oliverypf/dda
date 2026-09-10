import { createHash, randomUUID } from 'node:crypto';
import { mergeRecordsById, persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

const SCHEMA_VERSION = '1.0';
const MAX_MODELS = 256;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/;
const API_KEY_ENV = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,120}$/;
const RESERVED_HEADERS = new Set(['accept', 'authorization', 'content-length', 'content-type', 'host']);
const URL_PROTOCOLS = new Set(['http:', 'https:']);
const PROVIDERS = new Set(['openai', 'openai-responses', 'openai-chat', 'compatible', 'deepseek']);
const PROTOCOLS = new Set(['responses', 'chat-completions', 'deepseek-harness']);
const STATES = new Set(['ACTIVE', 'DEGRADED', 'DISABLED', 'QUARANTINED']);
const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const boundedString = (value, field, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  return value.trim();
};
const optionalUrl = (value, field) => {
  if (value === undefined) return undefined;
  const text = boundedString(value, field, 2000);
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`); }
  if (!URL_PROTOCOLS.has(parsed.protocol) || parsed.username || parsed.password) throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  return text;
};
const safeList = (value, field, max = 32) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 160)) {
    throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  }
  return [...new Set(value.map((item) => item.trim()))];
};
const safeHeaderName = (value, field) => {
  if (typeof value !== 'string' || !HEADER_NAME.test(value) || RESERVED_HEADERS.has(value.toLowerCase())) {
    throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  }
  return value;
};
const safeHeaders = (value, field) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}`);
  const headers = {};
  for (const [name, headerValue] of entries) {
    const key = safeHeaderName(name, `${field}.${name}`);
    if (typeof headerValue !== 'string' || headerValue.length > 2000 || /[\r\n]/u.test(headerValue)) {
      throw new Error(`MODEL_REGISTRY_INVALID_FIELD:${field}.${name}`);
    }
    headers[key] = headerValue;
  }
  return headers;
};

const normalizeModel = (input, now = Date.now) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('MODEL_REGISTRY_MODEL_INVALID');
  const modelId = boundedString(input.modelId ?? input.id, 'modelId', 240);
  if (!MODEL_ID.test(modelId)) throw new Error('MODEL_REGISTRY_MODEL_ID_INVALID');
  const provider = boundedString(input.provider, 'provider', 80);
  if (!PROVIDERS.has(provider)) throw new Error(`MODEL_REGISTRY_PROVIDER_INVALID:${provider}`);
  const protocol = boundedString(input.protocol, 'protocol', 40);
  if (!PROTOCOLS.has(protocol)) throw new Error(`MODEL_REGISTRY_PROTOCOL_INVALID:${protocol}`);
  const model = boundedString(input.model, 'model', 200);
  const apiKeyEnv = input.apiKeyEnv === undefined ? undefined : boundedString(input.apiKeyEnv, 'apiKeyEnv', 120);
  if (apiKeyEnv !== undefined && !API_KEY_ENV.test(apiKeyEnv)) throw new Error('MODEL_REGISTRY_API_KEY_ENV_INVALID');
  const headers = safeHeaders(input.headers, 'headers');
  const sessionHeader = input.sessionHeader === undefined ? undefined : safeHeaderName(boundedString(input.sessionHeader, 'sessionHeader', 120), 'sessionHeader');
  const state = input.state ?? 'ACTIVE';
  if (!STATES.has(state)) throw new Error('MODEL_REGISTRY_STATE_INVALID');
  const costPer1kTokens = input.costPer1kTokens === undefined ? undefined : Number(input.costPer1kTokens);
  const latencyMs = input.latencyMs === undefined ? undefined : Number(input.latencyMs);
  if (costPer1kTokens !== undefined && (!Number.isFinite(costPer1kTokens) || costPer1kTokens < 0)) throw new Error('MODEL_REGISTRY_COST_INVALID');
  if (latencyMs !== undefined && (!Number.isFinite(latencyMs) || latencyMs < 0)) throw new Error('MODEL_REGISTRY_LATENCY_INVALID');
  const roles = safeList(input.roles, 'roles');
  const capabilities = safeList(input.capabilities, 'capabilities');
  const record = {
    modelId,
    provider,
    protocol,
    model,
    ...(input.baseURL === undefined ? {} : { baseURL: optionalUrl(input.baseURL, 'baseURL') }),
    ...(input.endpoint === undefined ? {} : { endpoint: optionalUrl(input.endpoint, 'endpoint') }),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(headers ? { headers } : {}),
    ...(sessionHeader ? { sessionHeader } : {}),
    capabilities: capabilities.length ? capabilities : ['model.invoke.stream'],
    ...(roles.length ? { roles } : {}),
    ...(costPer1kTokens === undefined ? {} : { costPer1kTokens }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    state,
    version: boundedString(input.version ?? '1', 'version', 64),
    updatedAtMs: Number.isInteger(input.updatedAtMs) ? input.updatedAtMs : now()
  };
  return record;
};

const unsigned = (record) => {
  const { recordDigest, ...rest } = record;
  return rest;
};
const validRecord = (record) => {
  if (!record || typeof record !== 'object' || typeof record.modelId !== 'string' || typeof record.recordDigest !== 'string') return false;
  try {
    return record.recordDigest === digest(unsigned(record)) && MODEL_ID.test(record.modelId) && STATES.has(record.state);
  } catch { return false; }
};

export class ModelRegistry {
  #models = new Map();
  #storagePath;
  #now;
  #idFactory;
  #queue = Promise.resolve();
  #loaded = false;
  #eventStore;

  constructor({ storagePath, now = Date.now, idFactory = randomUUID, eventStore } = {}) {
    this.#storagePath = storagePath;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return;
    if (this.#eventStore?.list) {
      let events;
      try { events = await this.#eventStore.list({ aggregateType: 'ModelRegistry' }); }
      catch { throw new Error('MODEL_REGISTRY_READ_FAILED'); }
      let projected = false;
      try {
        for (const event of events) {
          if (!['ModelRegistryRecordCommitted', 'ModelRegistryRecordUpdated'].includes(event.kind)) continue;
          projected = true;
          const payload = event.payload;
          const record = {
            modelId: payload?.modelId, provider: payload?.provider, protocol: payload?.protocol, model: payload?.model,
            ...(payload?.baseURL ? { baseURL: payload.baseURL } : {}), ...(payload?.endpoint ? { endpoint: payload.endpoint } : {}),
            ...(payload?.apiKeyEnv ? { apiKeyEnv: payload.apiKeyEnv } : {}), capabilities: payload?.capabilities,
            ...(payload?.roles ? { roles: payload.roles } : {}), ...(payload?.costPer1kTokens === undefined ? {} : { costPer1kTokens: payload.costPer1kTokens }),
            ...(payload?.latencyMs === undefined ? {} : { latencyMs: payload.latencyMs }), state: payload?.state, version: payload?.version,
            updatedAtMs: payload?.updatedAtMs, registeredId: payload?.registeredId, recordDigest: payload?.recordDigest
          };
          if (!validRecord(record)) throw new Error('MODEL_REGISTRY_INVALID');
          const prior = this.#models.get(record.modelId);
          if (!prior || record.updatedAtMs >= prior.updatedAtMs) this.#models.set(record.modelId, clone(record));
        }
      } catch (error) {
        // 历史版本写入的注册事件可能缺少新字段导致校验失败；回退到文件存储，
        // 避免单条旧事件永久阻塞任务启动。
        if (error?.message !== 'MODEL_REGISTRY_INVALID' || !this.#storagePath) throw error;
        this.#models.clear();
        projected = false;
      }
      if (projected) {
        this.#loaded = true;
        return;
      }
    }
    if (!this.#storagePath) {
      this.#loaded = true;
      return;
    }
    let parsed;
    try { parsed = await readPersistentJsonFile(this.#storagePath); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw new Error('MODEL_REGISTRY_READ_FAILED');
    }
    if (parsed === undefined) {
      this.#loaded = true;
      return;
    }
    if (parsed?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.models) || parsed.models.length > MAX_MODELS || parsed.models.some((item) => !validRecord(item))) {
      throw new Error('MODEL_REGISTRY_INVALID');
    }
    const modelIds = new Set();
    for (const model of parsed.models) {
      if (modelIds.has(model.modelId)) throw new Error('MODEL_REGISTRY_INVALID');
      modelIds.add(model.modelId);
      this.#models.set(model.modelId, clone(model));
    }
    this.#loaded = true;
  }

  register(input) {
    const record = normalizeModel(input, this.#now);
    const existing = this.#models.get(record.modelId);
    if (existing) {
      if (existing.recordDigest === digest(record)) return clone(existing);
      throw new Error(`MODEL_REGISTRY_DUPLICATE:${record.modelId}`);
    }
    if (this.#models.size >= MAX_MODELS) throw new Error('MODEL_REGISTRY_FULL');
    const next = { ...record, registeredId: `model-record-${this.#idFactory()}` };
    next.recordDigest = digest(next);
    this.#models.set(next.modelId, next);
    this.#schedulePersist();
    return clone(next);
  }

  get hasDurableSink() { return Boolean(this.#eventStore && typeof this.#eventStore.append === 'function'); }

  async registerDurably(input) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const record = normalizeModel(input, this.#now);
    const existing = this.#models.get(record.modelId);
    if (existing) {
      if (existing.recordDigest === digest(record)) return clone(existing);
      throw new Error('MODEL_REGISTRY_DUPLICATE:' + record.modelId);
    }
    if (this.#models.size >= MAX_MODELS) throw new Error('MODEL_REGISTRY_FULL');
    const next = { ...record, registeredId: 'model-record-' + this.#idFactory() };
    next.recordDigest = digest(next);
    await this.#commitModelEvent('ModelRegistryRecordCommitted', next, { previousDigest: undefined });
    this.#models.set(next.modelId, next);
    this.#schedulePersist();
    try {
      await this.#queue;
    } catch (error) {
      this.#models.delete(next.modelId);
      throw error;
    }
    return clone(next);
  }

  async updateDurably(modelId, patch = {}) {
    if (!this.#eventStore || typeof this.#eventStore.append !== 'function') throw new Error('HARNESS_EVENT_STORE_REQUIRED');
    const current = this.#models.get(modelId);
    if (!current) throw new Error('MODEL_REGISTRY_NOT_FOUND:' + modelId);
    const next = normalizeModel({ ...current, ...patch, modelId: current.modelId, updatedAtMs: this.#now() }, this.#now);
    next.registeredId = current.registeredId;
    next.recordDigest = digest(next);
    await this.#commitModelEvent('ModelRegistryRecordUpdated', next, { previousDigest: current.recordDigest });
    this.#models.set(modelId, next);
    this.#schedulePersist();
    try {
      await this.#queue;
    } catch (error) {
      this.#models.set(modelId, current);
      throw error;
    }
    return clone(next);
  }

  async #commitModelEvent(kind, record, details = {}) {
    const payload = { modelId: record.modelId, provider: record.provider, protocol: record.protocol, model: record.model, state: record.state, version: record.version, capabilities: record.capabilities, roles: record.roles, recordDigest: record.recordDigest, registeredId: record.registeredId, updatedAtMs: record.updatedAtMs, ...details };
    const result = await this.#eventStore.append({
      runId: 'model-registry',
      aggregateType: 'ModelRegistry',
      aggregateId: record.modelId,
      commandId: kind + ':' + record.modelId + ':' + record.recordDigest,
      kind,
      payload,
      sensitivity: 'INTERNAL'
    });
    const receipt = result?.receipt ?? result;
    const event = result?.event ?? result?.events?.[0];
    if (receipt?.status !== 'COMMITTED' || !event?.eventId || !receipt.eventIds?.includes(event.eventId)
      || event.kind !== kind || event.aggregateId !== record.modelId
      || digest(event.payload) !== digest(payload)) throw new Error('DURABLE_COMMIT_REQUIRED');
    return result;
  }

  update(modelId, patch = {}) {
    const current = this.#models.get(modelId);
    if (!current) throw new Error(`MODEL_REGISTRY_NOT_FOUND:${modelId}`);
    const next = normalizeModel({ ...current, ...patch, modelId: current.modelId, updatedAtMs: this.#now() }, this.#now);
    next.registeredId = current.registeredId;
    next.recordDigest = digest(next);
    this.#models.set(modelId, next);
    this.#schedulePersist();
    return clone(next);
  }

  get(modelId) { const value = this.#models.get(modelId); return value ? clone(value) : undefined; }
  list() { return [...this.#models.values()].map(clone); }
  async flush() { await this.#queue; }

  select({ role, allowedModelIds, requiredCapabilities = ['model.invoke.stream'], profileRegistry, taskClass, requireEligible = false } = {}) {
    const allowed = allowedModelIds === undefined ? undefined : new Set(safeList(allowedModelIds, 'allowedModelIds', MAX_MODELS));
    const candidates = [];
    const rejected = [];
    for (const model of this.#models.values()) {
      const reasons = [];
      if (allowed && !allowed.has(model.modelId)) reasons.push('MODEL_NOT_ALLOWLISTED');
      if (!['ACTIVE', 'DEGRADED'].includes(model.state)) reasons.push(`MODEL_${model.state}`);
      if (role && Array.isArray(model.roles) && model.roles.length && !model.roles.includes(role)) reasons.push('ROLE_NOT_SUPPORTED');
      if (requiredCapabilities.some((capability) => !model.capabilities.includes(capability))) reasons.push('CAPABILITY_UNSUPPORTED');
      const profile = profileRegistry && taskClass
        ? profileRegistry.getProfile({ kind: 'CAPABILITY', entityType: 'model', entityId: model.modelId, capabilityId: `task.${taskClass}` })
        : undefined;
      if (requireEligible && (!profile || profile.eligibility?.eligible !== true)) reasons.push(profile ? 'PROFILE_NOT_ELIGIBLE' : 'PROFILE_MISSING');
      if (reasons.length) rejected.push({ modelId: model.modelId, reasons });
      else candidates.push({ model: clone(model), profile: profile ? clone(profile) : undefined });
    }
    candidates.sort((left, right) => {
      const stateRank = (value) => value === 'ACTIVE' ? 0 : 1;
      const profileRank = (value) => value?.eligibility?.eligible === true ? 0 : 1;
      return stateRank(left.model.state) - stateRank(right.model.state)
        || profileRank(left.profile) - profileRank(right.profile)
        || (left.model.costPer1kTokens ?? Number.MAX_SAFE_INTEGER) - (right.model.costPer1kTokens ?? Number.MAX_SAFE_INTEGER)
        || (left.model.latencyMs ?? Number.MAX_SAFE_INTEGER) - (right.model.latencyMs ?? Number.MAX_SAFE_INTEGER)
        || left.model.modelId.localeCompare(right.model.modelId);
    });
    return {
      selected: candidates[0] ? clone(candidates[0]) : undefined,
      candidates: candidates.map(clone),
      rejected: clone(rejected),
      status: candidates.length ? 'SELECTED' : 'BLOCKED',
      reason: candidates.length ? 'MODEL_REGISTRY_SELECTED' : 'NO_MODEL_CANDIDATE'
    };
  }

  #schedulePersist() {
    if (!this.#storagePath) return;
    const write = async () => persistJsonFile(this.#storagePath, { schemaVersion: SCHEMA_VERSION, models: this.list() }, {
      merge: (existing, incoming) => mergeRecordsById(existing, incoming, { collection: 'models', id: 'modelId' })
    });
    this.#queue = this.#queue.then(write, write);
    void this.#queue.catch(() => {});
  }
}

export const createModelRegistry = (options) => new ModelRegistry(options);
export const modelRegistryDigest = digest;
export const normalizeModelRecord = normalizeModel;
