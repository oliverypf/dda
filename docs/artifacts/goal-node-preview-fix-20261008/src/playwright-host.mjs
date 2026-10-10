import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ACTIONS, CAPABILITIES } from './runtime-safety-monitor.mjs';

const WORKER_PATH = fileURLToPath(new URL('./playwright-worker.mjs', import.meta.url));
const MAX_HOSTS = 32;

const normalizedHosts = (targets) => [...new Set(
  (Array.isArray(targets) ? targets : [])
    .map((target) => typeof target === 'string' ? target : target?.host)
    .filter((host) => typeof host === 'string' && /^[a-z0-9.-]{1,253}$/iu.test(host.trim()))
    .map((host) => host.trim().toLowerCase())
)].slice(0, MAX_HOSTS);

export class PlaywrightWorkerHost {
  #allowedHosts;
  #child;
  #buffer = '';
  #pending = new Map();
  #nextId = 1;

  constructor({ targets = [] } = {}) {
    this.#allowedHosts = normalizedHosts(targets);
    if (!this.#allowedHosts.length) throw new Error('BROWSER_ALLOWLIST_INVALID');
  }

  async #ensure() {
    if (this.#child) return;
    this.#child = spawn(process.execPath, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.#child.stdout.on('data', (chunk) => {
      this.#buffer += chunk.toString('utf8');
      let newline;
      while ((newline = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, newline); this.#buffer = this.#buffer.slice(newline + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        const pending = this.#pending.get(message.id); if (!pending) continue;
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
      }
    });
    this.#child.once('error', (error) => { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); });
    await this.#request('init', { allowedHosts: this.#allowedHosts });
  }

  #request(op, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#child?.stdin?.writable) return reject(new Error('BROWSER_WORKER_UNAVAILABLE'));
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => { if (error) { this.#pending.delete(id); reject(error); } });
    });
  }

  async open({ runId, url, maxChars, timeoutMs } = {}) {
    await this.#ensure();
    return this.#request('open', { runId, url, maxChars, timeoutMs });
  }

  async close() {
    if (!this.#child) return;
    await this.#request('close').catch(() => {});
    this.#child.kill();
    this.#child = undefined;
  }
}

export const registerPlaywrightTools = (registry, worker, { leaseProvider, monitor, onLeaseStarted, onLeaseConsumed, onLeaseFailed, runId, targets = [] } = {}) => {
  if (!worker || typeof worker.open !== 'function') throw new TypeError('BROWSER_WORKER_INVALID');
  const targetList = Array.isArray(targets) ? targets : [];
  registry.register({
    name: 'browser.open',
    description: 'Open one explicitly approved URL in an isolated Playwright context and return bounded page text.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 2048 },
        maxChars: { type: 'integer', minimum: 1, maximum: 65536 },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 }
      },
      required: ['url'],
      additionalProperties: false
    },
    readOnly: false,
    metadata: { actionClass: 'SIDE_EFFECT', capability: CAPABILITIES.NETWORK, isolation: 'child-process-browser-context' },
    handler: async ({ url, maxChars = 32768, timeoutMs = 15000 }) => {
      const parsed = new URL(url);
      const target = targetList.find((candidate) => String(candidate?.host ?? '').toLowerCase() === parsed.hostname.toLowerCase());
      if (!target) throw new Error('BROWSER_TARGET_FORBIDDEN');
      const capability = CAPABILITIES.NETWORK;
      const request = { host: parsed.hostname, scheme: parsed.protocol.slice(0, -1), port: parsed.port ? Number(parsed.port) : undefined, method: 'GET', path: parsed.pathname || '/' };
      let lease;
      try {
        lease = await leaseProvider?.({ capability, request });
        if (typeof leaseProvider === 'function' && !lease) throw new Error('SAFETY_LEASE_REQUIRED');
        if (monitor && typeof monitor.authorize === 'function') await monitor.authorize(ACTIONS.NETWORK, request, lease);
        await onLeaseStarted?.({ capability, request, lease });
        const result = await worker.open({ runId, url, maxChars, timeoutMs });
        await onLeaseConsumed?.({ capability, request, lease, result: { ok: true } });
        return result;
      } catch (error) {
        await Promise.resolve(onLeaseFailed?.({ capability, request, lease, error })).catch(() => {});
        throw error;
      } finally {
        lease?.releaseWorkspace?.();
      }
    }
  });
  return registry;
};

export const createPlaywrightWorkerHost = (options) => new PlaywrightWorkerHost(options);
