import { lookup } from 'node:dns/promises';
import { createInterface } from 'node:readline';
import { describeBrowserFailure } from './browser-failure.mjs';
import { isPrivateNetworkAddress } from './runtime-safety-monitor.mjs';

let browser;
let initialized = false;
let publicNetwork = false;
let allowedHosts = new Set();
const contexts = new Map();
const publicVerdicts = new Map();

const reply = (id, value, error) => {
  process.stdout.write(`${JSON.stringify({ id, ...(error ? { error: String(error.message || error) } : { result: value }) })}\n`);
};

const namedLocalHost = (hostname) => {
  const host = String(hostname ?? '').trim().toLowerCase();
  return !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
};

const publicHostAllowed = async (hostname) => {
  const host = String(hostname ?? '').trim().toLowerCase();
  if (publicVerdicts.has(host)) return publicVerdicts.get(host);
  const allowed = await (async () => {
    if (namedLocalHost(host) || isPrivateNetworkAddress(host)) return false;
    const records = await lookup(host, { all: true }).catch(() => null);
    const addresses = (Array.isArray(records) ? records : [records])
      .map((record) => typeof record === 'string' ? record : record?.address)
      .filter((value) => typeof value === 'string' && value);
    return addresses.length > 0 && addresses.every((address) => !isPrivateNetworkAddress(address));
  })();
  publicVerdicts.set(host, allowed);
  return allowed;
};

const assertHost = async (value) => {
  let url;
  try { url = new URL(value); } catch { throw new Error('BROWSER_URL_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('BROWSER_TARGET_FORBIDDEN');
  if (publicNetwork) {
    if (!(await publicHostAllowed(url.hostname))) throw new Error('BROWSER_TARGET_FORBIDDEN');
    return url;
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error('BROWSER_TARGET_FORBIDDEN');
  return url;
};

const contextFor = async (runId) => {
  if (!contexts.has(runId)) {
    if (!browser) {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
    }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      try {
        const url = new URL(route.request().url());
        if (!['http:', 'https:'].includes(url.protocol)) return route.abort('blockedbyclient');
        if (publicNetwork) return (await publicHostAllowed(url.hostname)) ? route.continue() : route.abort('blockedbyclient');
        if (allowedHosts.has(url.hostname.toLowerCase())) return route.continue();
        return route.abort('blockedbyclient');
      } catch {
        return route.abort('blockedbyclient');
      }
    });
    contexts.set(runId, context);
  }
  return contexts.get(runId);
};

const handle = async (message) => {
  if (!message || typeof message !== 'object') throw new Error('BROWSER_REQUEST_INVALID');
  if (message.op === 'init') {
    if (initialized) throw new Error('BROWSER_ALREADY_INITIALIZED');
    if (message.publicNetwork === true) {
      publicNetwork = true;
      initialized = true;
      return { ok: true, publicNetwork: true };
    }
    if (!Array.isArray(message.allowedHosts) || message.allowedHosts.length < 1 || message.allowedHosts.length > 32) throw new Error('BROWSER_ALLOWLIST_INVALID');
    allowedHosts = new Set(message.allowedHosts.map((host) => String(host).trim().toLowerCase()).filter((host) => /^[a-z0-9.-]{1,253}$/u.test(host)));
    if (!allowedHosts.size) throw new Error('BROWSER_ALLOWLIST_INVALID');
    initialized = true;
    return { ok: true, allowedHosts: [...allowedHosts] };
  }
  if (!initialized) throw new Error('BROWSER_NOT_INITIALIZED');
  if (message.op === 'close') {
    for (const context of contexts.values()) await context.close().catch(() => {});
    contexts.clear();
    await Promise.resolve(browser?.close?.()).catch(() => {});
    browser = undefined;
    setImmediate(() => process.exit(0));
    return { ok: true, closed: true };
  }
  if (message.op !== 'open' || typeof message.runId !== 'string') throw new Error('BROWSER_REQUEST_INVALID');
  const url = await assertHost(message.url);
  const context = await contextFor(message.runId);
  const page = await context.newPage();
  const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: Math.min(Math.max(Number(message.timeoutMs) || 15000, 1000), 60000) });
  const finalUrl = await assertHost(page.url());
  const maxChars = Math.min(Math.max(Number(message.maxChars) || 32768, 1), 65536);
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, maxChars);
  const title = await page.title().catch(() => '');
  await page.close().catch(() => {});
  return { ok: true, url: finalUrl.toString(), title: title.slice(0, 512), text, status: response?.status?.() ?? null };
};

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try { reply(message.id, await handle(message)); } catch (error) { reply(message.id, undefined, describeBrowserFailure(error)); }
});

process.on('SIGTERM', async () => {
  for (const context of contexts.values()) await context.close().catch(() => {});
  await Promise.resolve(browser?.close?.()).catch(() => {});
  process.exit(0);
});
