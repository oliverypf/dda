import { createInterface } from 'node:readline';

let browser;
let initialized = false;
let allowedHosts = new Set();
const contexts = new Map();

const reply = (id, value, error) => {
  process.stdout.write(`${JSON.stringify({ id, ...(error ? { error: String(error.message || error) } : { result: value }) })}\n`);
};

const assertHost = (value) => {
  let url;
  try { url = new URL(value); } catch { throw new Error('BROWSER_URL_INVALID'); }
  if (!['https:', 'http:'].includes(url.protocol) || !allowedHosts.has(url.hostname.toLowerCase())) throw new Error('BROWSER_TARGET_FORBIDDEN');
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
        if (['http:', 'https:'].includes(url.protocol) && allowedHosts.has(url.hostname.toLowerCase())) return route.continue();
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
  const url = assertHost(message.url);
  const context = await contextFor(message.runId);
  const page = await context.newPage();
  const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: Math.min(Math.max(Number(message.timeoutMs) || 15000, 1000), 60000) });
  const finalUrl = assertHost(page.url());
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
  try { reply(message.id, await handle(message)); } catch (error) { reply(message.id, undefined, error); }
});

process.on('SIGTERM', async () => {
  for (const context of contexts.values()) await context.close().catch(() => {});
  await Promise.resolve(browser?.close?.()).catch(() => {});
  process.exit(0);
});
