import { createHash } from 'node:crypto';
import { ContextPort } from './context-port.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:1933';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const clone = (value) => structuredClone(value);
const bounded = (value, max = 500) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);
const digest = (value) => `sha256:${createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')}`;

class OpenVikingRequestError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = 'OpenVikingRequestError';
    this.retryable = retryable;
  }
}

const requestError = (code, options) => new OpenVikingRequestError(code, options);

const validateBaseURL = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value ?? DEFAULT_BASE_URL));
  } catch {
    throw new Error('OPENVIKING_BASE_URL_INVALID');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || !['', '/'].includes(parsed.pathname)
  ) {
    throw new Error('OPENVIKING_BASE_URL_INVALID');
  }
  parsed.pathname = '/';
  return parsed.toString().replace(/\/$/u, '');
};

const positiveInteger = (value, fallback, minimum, maximum, errorCode) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(errorCode);
  return parsed;
};

const safeSessionId = (value) => {
  const sessionId = bounded(value, 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(sessionId)) {
    throw requestError('OPENVIKING_RESPONSE_INVALID');
  }
  return sessionId;
};

const errorForStatus = (status) => {
  if (status === 401) return requestError('OPENVIKING_UNAUTHENTICATED');
  if (status === 403) return requestError('OPENVIKING_PERMISSION_DENIED');
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return requestError('OPENVIKING_UNAVAILABLE', { retryable: true });
  }
  return requestError('OPENVIKING_REQUEST_FAILED');
};

const readBoundedBody = async (response, maximumBytes) => {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw requestError('OPENVIKING_RESPONSE_TOO_LARGE');
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximumBytes) throw requestError('OPENVIKING_RESPONSE_TOO_LARGE');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw requestError('OPENVIKING_RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
};

const responseEnvelope = async (response, maximumBytes, requireResult) => {
  const raw = await readBoundedBody(response, maximumBytes);
  let envelope;
  try {
    envelope = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw requestError('OPENVIKING_RESPONSE_INVALID');
  }
  if (!response.ok) throw errorForStatus(response.status);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.status !== 'ok') {
    throw requestError('OPENVIKING_RESPONSE_INVALID');
  }
  if (requireResult && (!Object.hasOwn(envelope, 'result') || envelope.result === undefined || envelope.result === null)) {
    throw requestError('OPENVIKING_RESPONSE_INVALID');
  }
  return envelope;
};

const normalizeEntry = (entry, scope) => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const uri = bounded(entry.uri, 1000);
  if (!uri.startsWith('viking://')) return undefined;
  const statement = bounded(entry.text ?? entry.overview ?? entry.abstract, 1200);
  if (!statement) return undefined;
  const score = Number(entry.score);
  return {
    memoryId: uri,
    scope: bounded(scope, 160) || 'workspace',
    kind: bounded(entry.category ?? 'memory', 64) || 'memory',
    statement,
    ...(Number.isFinite(score) ? {
      confidence: Math.max(0, Math.min(1, score)),
      score
    } : {}),
    sourceDigest: digest(uri)
  };
};

/**
 * Direct REST ContextPort for an explicitly selected local OpenViking server.
 * It accepts only loopback URLs, bounds every response, retries only read-only
 * operations, and never includes response bodies or credentials in errors.
 */
export class OpenVikingContextAdapter {
  #apiKey;
  #baseURL;
  #fetch;
  #maxResponseBytes;
  #peerId;
  #sessionByRun = new Map();
  #sessionPromises = new Map();
  #sessionByMemory = new Map();
  #timeoutMs;

  constructor({
    baseURL = DEFAULT_BASE_URL,
    apiKey,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    workspaceRoot = ''
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('OPENVIKING_FETCH_UNAVAILABLE');
    this.#baseURL = validateBaseURL(baseURL);
    this.#apiKey = typeof apiKey === 'string' && apiKey ? apiKey : undefined;
    this.#fetch = fetchImpl;
    this.#timeoutMs = positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60000, 'OPENVIKING_TIMEOUT_INVALID');
    this.#maxResponseBytes = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 4 * 1024 * 1024, 'OPENVIKING_RESPONSE_LIMIT_INVALID');
    this.#peerId = `hmcodex-workspace-${createHash('sha256').update(String(workspaceRoot || 'default'), 'utf8').digest('hex').slice(0, 32)}`;
  }

  async #request(path, { method = 'GET', body, readOnly = false, requireResult = true, authenticated = true } = {}) {
    const attempts = readOnly ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      timer.unref?.();
      try {
        const headers = {
          accept: 'application/json',
          'x-openviking-actor-peer': this.#peerId,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(authenticated && this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {})
        };
        const response = await this.#fetch(new URL(path, `${this.#baseURL}/`), {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal
        });
        return (await responseEnvelope(response, this.#maxResponseBytes, requireResult)).result;
      } catch (error) {
        const normalized = error instanceof OpenVikingRequestError
          ? error
          : controller.signal.aborted
            ? requestError('OPENVIKING_TIMEOUT', { retryable: true })
            : requestError('OPENVIKING_CONNECTION_FAILED', { retryable: true });
        if (attempt + 1 < attempts && normalized.retryable) continue;
        throw normalized;
      } finally {
        clearTimeout(timer);
      }
    }
    throw requestError('OPENVIKING_UNAVAILABLE');
  }

  #desiredSessionId(runId) {
    const normalizedRunId = bounded(runId, 240);
    if (!normalizedRunId) throw new Error('OPENVIKING_RUN_ID_REQUIRED');
    return `hmcodex-${createHash('sha256').update(normalizedRunId, 'utf8').digest('hex').slice(0, 32)}`;
  }

  async #ensureSession(runId) {
    const desired = this.#desiredSessionId(runId);
    const existing = this.#sessionByRun.get(runId);
    if (existing) return existing;
    const pending = this.#sessionPromises.get(runId);
    if (pending) return pending;
    const creation = (async () => {
      const result = await this.#request('/api/v1/sessions', {
        method: 'POST',
        body: { session_id: desired }
      });
      const sessionId = safeSessionId(result?.session_id);
      this.#sessionByRun.set(runId, sessionId);
      return sessionId;
    })();
    this.#sessionPromises.set(runId, creation);
    try {
      return await creation;
    } finally {
      this.#sessionPromises.delete(runId);
    }
  }

  async recall({ runId, query = '', scope = 'workspace', limit = 16, maxChars = 3000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(maxChars) || maxChars < 128 || maxChars > 16000) {
      throw new Error('CONTEXT_RECALL_OPTIONS_INVALID');
    }
    const sessionId = await this.#ensureSession(runId);
    const safeQuery = bounded(query, 4000);
    const result = await this.#request('/api/v1/search/search', {
      method: 'POST',
      readOnly: true,
      body: {
        query: safeQuery,
        mode: 'context',
        purpose: 'coding',
        peer_scope: 'actor',
        session_id: sessionId,
        max_tokens: Math.max(64, Math.min(24000, Math.ceil(maxChars * 1.5)))
      }
    });
    const entries = result?.stats?.rewrite === 'no_relevant'
      ? []
      : Array.isArray(result?.entries) ? result.entries : [];
    const items = [];
    let chars = 0;
    for (const entry of entries) {
      if (items.length >= limit) break;
      const item = normalizeEntry(entry, scope);
      if (!item) continue;
      const nextChars = JSON.stringify(item).length;
      if (chars + nextChars > maxChars) break;
      chars += nextChars;
      items.push(item);
      this.#sessionByMemory.set(item.memoryId, sessionId);
    }
    return {
      provider: 'openviking',
      status: 'AVAILABLE',
      queryDigest: digest(safeQuery),
      sessionId,
      items,
      chars,
      renderedDigest: digest(result?.rendered ?? ''),
      ...(Number.isFinite(Number(result?.stats?.used_tokens)) ? { usedTokens: Number(result.stats.used_tokens) } : {})
    };
  }

  async record(input = {}) {
    const statement = bounded(input.statement, 2000);
    if (!statement) throw new Error('CONTEXT_RECORD_STATEMENT_REQUIRED');
    const sessionId = await this.#ensureSession(input.runId);
    await this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/batch`, {
      method: 'POST',
      body: { messages: [{ role: 'assistant', content: statement }] }
    });
    const memoryId = `openviking-session:${sessionId}`;
    this.#sessionByMemory.set(memoryId, sessionId);
    return {
      provider: 'openviking',
      status: 'RECORDED',
      memory: {
        memoryId,
        statement,
        scope: bounded(input.scope, 256) || 'workspace',
        kind: bounded(input.kind, 64) || 'PROJECT',
        confidence: Number.isFinite(Number(input.confidence))
          ? Math.max(0, Math.min(1, Number(input.confidence)))
          : 0.5,
        sourceEventIds: Array.isArray(input.sourceEventIds)
          ? input.sourceEventIds.map((id) => bounded(id, 240)).filter(Boolean).slice(0, 32)
          : []
      }
    };
  }

  async used({ runId, memoryIds = [] } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length > 64) throw new Error('CONTEXT_USED_IDS_INVALID');
    const sessionId = this.#sessionByRun.get(runId);
    if (!sessionId) return { provider: 'openviking', status: 'RECORDED', used: [] };
    const contexts = [...new Set(memoryIds
      .filter((memoryId) => typeof memoryId === 'string' && memoryId.startsWith('viking://'))
      .filter((memoryId) => this.#sessionByMemory.get(memoryId) === sessionId))];
    if (!contexts.length) return { provider: 'openviking', status: 'RECORDED', used: [] };
    await this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/used`, {
      method: 'POST',
      body: { contexts }
    });
    return {
      provider: 'openviking',
      status: 'RECORDED',
      used: contexts.map((memoryId) => ({ runId: bounded(runId, 240), memoryId }))
    };
  }

  async commit({ runId, memoryIds = [] } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length > 64) throw new Error('CONTEXT_COMMIT_IDS_INVALID');
    const sessions = new Set();
    const runSession = this.#sessionByRun.get(runId);
    if (runSession) sessions.add(runSession);
    for (const memoryId of memoryIds) {
      if (typeof memoryId !== 'string') continue;
      const sessionId = this.#sessionByMemory.get(memoryId);
      if (sessionId) sessions.add(sessionId);
    }
    const taskIds = [];
    for (const sessionId of sessions) {
      const result = await this.#request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`, {
        method: 'POST',
        body: {}
      });
      if (typeof result?.task_id === 'string' && result.task_id) taskIds.push(bounded(result.task_id, 240));
    }
    return {
      provider: 'openviking',
      status: 'COMMITTED',
      memoryIds: clone(memoryIds.filter((memoryId) => typeof memoryId === 'string').slice(0, 64)),
      count: sessions.size,
      taskIds
    };
  }

  async health() {
    await this.#request('/ready', {
      readOnly: true,
      authenticated: false,
      requireResult: false
    });
    return { status: 'AVAILABLE', provider: 'openviking' };
  }
}

export const createOpenVikingContextPort = (options) => new ContextPort(new OpenVikingContextAdapter(options));
