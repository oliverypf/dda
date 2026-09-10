import { lookup } from 'node:dns/promises';
import { performance } from 'node:perf_hooks';
import {
  ACTIONS,
  SAFETY_ERROR_CODES,
  SafetyError,
  boundOutput,
  digest,
  isPrivateNetworkAddress
} from './runtime-safety-monitor.mjs';

const MAX_TIMEOUT_MS = 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const boundedLimit = (value, maximum, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_INVALID, 'limit');
  }
  return value;
};

/**
 * Network adapter behind the same one-shot lease boundary as the process and
 * file executors. Redirects always fail closed: following one would require a
 * second authorization, and a consumed lease can never authorize it.
 */
export class RestrictedNetworkAdapter {
  #monitor;
  #fetchImpl;
  #lookup;
  #activeRequests = 0;
  #maxConcurrentRequests;

  constructor({ monitor, fetch: fetchImpl = globalThis.fetch, lookup: lookupImpl = lookup, maxConcurrentRequests = 2 } = {}) {
    if (!monitor) throw new TypeError('NETWORK_MONITOR_REQUIRED');
    this.#monitor = monitor;
    this.#fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.#lookup = typeof lookupImpl === 'function' ? lookupImpl : null;
    if (!Number.isInteger(maxConcurrentRequests) || maxConcurrentRequests < 1 || maxConcurrentRequests > 16) {
      throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_INVALID, 'maxConcurrentRequests');
    }
    this.#maxConcurrentRequests = maxConcurrentRequests;
  }

  get monitor() { return this.#monitor; }

  async request(request = {}, options = {}) {
    if (this.#activeRequests >= this.#maxConcurrentRequests) {
      throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_CONCURRENCY_LIMIT);
    }
    this.#activeRequests += 1;
    try {
      return await this.#request(request, options);
    } finally {
      this.#activeRequests -= 1;
    }
  }

  async #request(request = {}, { lease, signal } = {}) {
    if (typeof this.#fetchImpl !== 'function') throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_INVALID, 'fetch');
    const authorization = await this.#monitor.authorize(ACTIONS.NETWORK, request, lease);
    const target = authorization.target;
    await this.#assertResolvable(target.host);
    const limits = this.#monitor.limits;
    const timeoutMs = boundedLimit(request.timeoutMs, MAX_TIMEOUT_MS, 15 * 1000);
    const maxResponseBytes = boundedLimit(request.maxResponseBytes, limits.maxOutputBytes, limits.maxOutputBytes);
    const maxResponseChars = boundedLimit(request.maxResponseChars, limits.maxOutputChars, limits.maxOutputChars);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new SafetyError('EXECUTOR_NETWORK_TIMEOUT'));
    }, timeoutMs);
    const onOuterAbort = () => controller.abort(signal.reason instanceof Error ? signal.reason : new SafetyError('EXECUTOR_ABORTED'));
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    if (signal?.aborted) onOuterAbort();
    const startedAt = performance.now();
    try {
      const url = `${target.scheme}://${target.host}${target.port ? `:${target.port}` : ''}${target.path}`;
      const response = await this.#fetchImpl(url, {
        method: target.method,
        ...(target.headers ? { headers: target.headers } : {}),
        ...(target.body !== undefined && target.method !== 'GET' && target.method !== 'HEAD' ? { body: target.body } : {}),
        redirect: 'manual',
        signal: controller.signal
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_REDIRECT_FORBIDDEN, `${target.scheme}://${target.host}${target.path}`);
      }
      // DNS rebinding guard: the address that answered may differ from the
      // address we validated. Re-resolve after the response and fail closed
      // when the host now maps into a private or metadata range.
      await this.#assertResolvable(target.host);
      const body = await this.#collectBody(response, { maxResponseBytes, maxResponseChars });
      const aborted = signal?.aborted === true;
      return {
        ok: !timedOut && !aborted && response.status >= 200 && response.status < 300,
        status: response.status,
        aborted,
        timedOut,
        truncated: body.truncated,
        body: body.text,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        action: ACTIONS.NETWORK,
        targetDigest: digest(JSON.stringify({
          host: target.host,
          port: target.port,
          scheme: target.scheme,
          method: target.method,
          path: target.path
        })),
        lease: authorization.lease?.id ?? null
      };
    } catch (error) {
      if (timedOut) {
        return {
          ok: false,
          status: null,
          aborted: signal?.aborted === true,
          timedOut: true,
          truncated: true,
          body: '',
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          action: ACTIONS.NETWORK,
          lease: authorization.lease?.id ?? null
        };
      }
      if (error instanceof SafetyError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        const aborted = signal?.aborted === true;
        return {
          ok: false,
          status: null,
          aborted,
          timedOut,
          truncated: true,
          body: '',
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          action: ACTIONS.NETWORK,
          lease: authorization.lease?.id ?? null
        };
      }
      throw new SafetyError('EXECUTOR_NETWORK_FAILED', String(error?.message ?? '').slice(0, 200));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  async #assertResolvable(host) {
    if (!this.#lookup) return;
    const records = await this.#lookup(host, { all: true }).catch(() => {
      throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_RESOLVED_FORBIDDEN, host);
    });
    const addresses = (Array.isArray(records) ? records : [records])
      .map((record) => typeof record === 'string' ? record : record?.address)
      .filter((value) => typeof value === 'string' && value);
    if (!addresses.length) throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_RESOLVED_FORBIDDEN, host);
    for (const address of addresses) {
      if (isPrivateNetworkAddress(address)) {
        throw new SafetyError(SAFETY_ERROR_CODES.NETWORK_RESOLVED_FORBIDDEN, host);
      }
    }
  }

  async #collectBody(response, { maxResponseBytes, maxResponseChars }) {
    const stream = response?.body;
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      const chunks = [];
      let received = 0;
      let truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
        received += chunk.byteLength;
        if (received > maxResponseBytes) {
          chunks.push(chunk.subarray(0, Math.max(0, chunk.byteLength - (received - maxResponseBytes))));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(chunk);
      }
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const bounded = boundOutput(bodyText, {
        maxOutputBytes: maxResponseBytes,
        maxOutputChars: maxResponseChars
      });
      return { text: bounded.text, truncated: truncated || bounded.truncated };
    }
    const text = await response.text();
    return boundOutput(text, { maxOutputBytes: maxResponseBytes, maxOutputChars: maxResponseChars });
  }
}

export const createRestrictedNetworkAdapter = (options) => new RestrictedNetworkAdapter(options);
