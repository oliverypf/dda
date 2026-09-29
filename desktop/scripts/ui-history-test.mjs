// Run after build.mjs. Uses an isolated browser and a stubbed native bridge;
// it never launches the installed app or touches the user's Harness database.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = resolve(process.env.HMCODEX_UI_ARTIFACTS ?? fileURLToPath(new URL('../../.codex-tmp/history-ui/', import.meta.url)));
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep));
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: process.env.HMCODEX_BROWSER_CHANNEL });
const results = [];
const errors = [];

async function openFixture({ savedThread = 'a', savedPage = 'workbench', delaySummary = false, viewport = { width: 1440, height: 960 } } = {}) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ savedThread, savedPage, delaySummary }) => {
    localStorage.setItem('hmcodex.nav', JSON.stringify({ threadId: savedThread, page: savedPage }));
    localStorage.setItem('hmcodex.activePage', savedPage);
    const threads = ['a', 'b', 'c', 'empty', 'broken', 'invalid', 'fresh', 'partial'].map((id, index) => ({
      id, title: `History ${id}`, state: 'COMPLETED', turnCount: 600,
      createdAtMs: 1000 + index, updatedAtMs: 2000 + index, cwd: '/fixture'
    }));
    const waits = new Map();
    const gate = (name) => new Promise((done) => waits.set(name, done));
    const calls = [];
    const defer = new Set();
    const counts = new Map();
    const state = window.__historyTest = { calls, defer, waits,
      release(name) { const done = waits.get(name); if (!done) throw Error(`Missing gate: ${name}`); waits.delete(name); done(); },
      rootWrites: 0, longTasks: []
    };
    new PerformanceObserver((list) => state.longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration }))))
      .observe({ type: 'longtask', buffered: true });
    let callbackId = 0;
    const callbacks = new Map();
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++callbackId, fn); return callbackId; },
      async invoke(command, args = {}) {
        calls.push({ command, args, at: performance.now() });
        if (command.startsWith('plugin:event|')) return ++callbackId;
        if (command === 'runtime_snapshot') {
          await gate('health');
          return { platform: 'WINDOWS', version: 'test', readOnly: true, workspaceRead: true,
            commandExecution: false, networkSideEffects: false, runtimeReady: true, releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
        }
        if (command === 'reconcile_runtime_state') { await gate('recovery'); return { ok: true, reconciled: 0 }; }
        if (command === 'default_workspace') return { rootLabel: 'Fixture', rootPath: '/fixture' };
        if (command === 'list_workspace') return [];
        if (command === 'context_sidecar_status' || command === 'dream_maintenance_status') return undefined;
        if (command === 'runtime_dashboard') {
          if (!args.details && delaySummary) await gate('summary');
          return { ok: true, summaryOnly: !args.details, threads,
            ...(args.details ? { modelUsage: { status: 'REPORTED', calls: 4, cacheReportedCalls: 3,
              inputTokens: 1200, cacheEligibleInputTokens: 1000, cachedInputTokens: 800,
              uncachedInputTokens: 200, cacheHitRate: 0.8, cacheCoverage: 0.75 } } : {}), execution: { records: [] },
            feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [],
            evolution: { proposals: [], reports: [], control: { enabled: true, changedAtMs: 0 } } };
        }
        if (command === 'list_thread_events') {
          const id = args.threadId;
          const count = (counts.get(id) ?? 0) + 1;
          counts.set(id, count);
          if (defer.has(id)) await gate(`events:${id}`);
          if (id === 'broken' && count === 1) throw Error('fixture history failure');
          const end = args.before ? Number(args.before) : 600;
          const start = Math.max(0, end - args.limit);
          const events = id === 'empty' ? [] : Array.from({ length: end - start }, (_, i) => ({
            type: 'runtime_event', schemaVersion: '1.0', eventId: `${id}-${start + i}`, runId: `run-${id}`,
            sequence: start + i + 1, emittedAtMs: 2000 + start + i,
            kind: 'history.task.run.completed', payload: { persistedKind: id === 'partial' && start + i === 599 ? 'TaskRunFailed' : 'TaskRunCompleted', outputDigest: `sha256:${id}-${start + i}`,
              ...(start + i === 599 ? { responseText: `原来的模型回复 ${id}\n\n- 已完成分析\n<script>window.historyInjected = true</script>` }
                : start + i === 598 ? { responseUnavailable: true } : {}) }
          }));
          return { threadId: id === 'invalid' && count === 1 ? 'wrong-thread' : id,
            thread: threads.find((t) => t.id === id), events, limit: args.limit,
            hasMore: id !== 'empty' && start > 0, nextCursor: id !== 'empty' && start > 0 ? String(start) : undefined };
        }
        if (command === 'model_config') return { config: { schemaVersion: '1.0', provider: 'openai-chat',
          protocol: 'chat-completions', model: 'fixture', baseURL: 'https://example.invalid', apiKeyEnv: 'FIXTURE_KEY' } };
        throw Error(`Unexpected native call: ${command}`);
      }
    };
  }, { savedThread, savedPage, delaySummary });
  await page.goto(url);
  return page;
}

const choose = async (page, id) => {
  await page.locator(`[data-action="select-thread"][data-thread-id="${id}"]`).click();
  await page.waitForFunction((id) => document.querySelector('[data-history-title]')?.textContent === `History ${id}`
    && document.querySelector('[data-region="conversation"]')?.getAttribute('aria-busy') === 'false', id);
};
const identity = async (page) => page.evaluate(() => {
  window.__historyTest.rootWrites = 0;
  const selectors = ['.app-shell', '[data-region="thread-list"]', '[data-region="conversation"]', '.transcript', '.composer', 'textarea[name="prompt"]'];
  window.__historyTest.refs = selectors.map((selector) => [selector, document.querySelector(selector)]);
  const app = document.querySelector('#app');
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(app, 'innerHTML', { configurable: true,
    get() { return descriptor.get.call(this); }, set(value) { window.__historyTest.rootWrites++; descriptor.set.call(this, value); } });
});
const assertIdentity = async (page) => assert.deepEqual(await page.evaluate(() => ({
  changed: window.__historyTest.refs.filter(([selector, element]) => document.querySelector(selector) !== element).map(([selector]) => selector),
  rootWrites: window.__historyTest.rootWrites
})), { changed: [], rootWrites: 0 });

try {
  await mkdir(output, { recursive: true });
  const page = await openFixture();
  await page.waitForSelector('[data-history-items] .timeline-item');
  await page.waitForFunction(() => document.querySelectorAll('[data-history-items] .timeline-item').length === 100);
  assert.equal(await page.locator('[data-history-items] .timeline-item').count(), 100);
  assert.match(await page.locator('[data-history-items]').innerText(), /原来的模型回复 a/);
  assert.match(await page.locator('[data-history-items]').innerText(), /本地没有可恢复的模型回复正文/);
  assert.match(await page.locator('[data-history-status]').innerText(), /未保存模型回复正文/);
  assert.equal(await page.evaluate(() => window.historyInjected), undefined);
  const initial = await page.evaluate(() => window.__historyTest.calls);
  const dashboardCalls = initial.filter((c) => c.command === 'runtime_dashboard');
  assert.equal(dashboardCalls.filter((c) => c.args.details !== true).length, 1);
  assert.ok(dashboardCalls.filter((c) => c.args.details === true).length <= 1);
  assert.deepEqual(initial.filter((c) => c.command === 'list_thread_events').map((c) => c.args), [{ threadId: 'a', limit: 100, before: undefined }]);
  assert.ok(!initial.some((c) => ['get_thread', 'reconcile_runtime_state'].includes(c.command)));
  results.push({ name: 'startup history before health/recovery, summaries plus one 100-event page', pass: true });

  assert.match(await page.locator('[data-model-cache="composer"]').innerText(), /缓存命中率/);
  await identity(page);
  await page.locator('textarea[name="prompt"]').fill('draft survives switching');
  await page.evaluate(() => window.__historyTest.release('health'));
  await page.waitForFunction(() => window.__historyTest.waits.has('recovery'));
  await choose(page, 'b');
  await assertIdentity(page);
  assert.equal(await page.locator('textarea[name="prompt"]').inputValue(), 'draft survives switching');
  await page.evaluate(() => window.__historyTest.release('recovery'));
  await choose(page, 'a');
  await assertIdentity(page);
  await page.waitForFunction(() => document.querySelector('[data-model-cache="composer"]')?.textContent.includes('80.0%'));
  await assertIdentity(page);
  const metric = page.locator('[data-model-cache="composer"]');
  assert.match(await metric.innerText(), /覆盖 3\/4 次调用/);
  const box = await metric.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
  await page.screenshot({ path: resolve(output, 'cache-history.png') });
  results.push({ name: 'history cache updates in viewport without replacing composer or requiring diagnostics', pass: true });
  results.push({ name: 'history switches during recovery without replacing shell/sidebar/composer/transcript', pass: true });

  await page.locator('[data-action="history-older"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const rows = [...document.querySelector('[data-history-items]').children];
    window.__historyTest.rows = rows;
    rows[0].querySelector('details').open = true;
    window.__historyTest.anchorTop = rows[0].getBoundingClientRect().top;
  });
  await page.locator('[data-action="history-older"]').click();
  await page.waitForFunction(() => document.querySelector('[data-history-items]').children.length === 200);
  await page.waitForFunction(() => {
    const anchor = window.__historyTest.rows[0];
    return Math.abs(anchor.getBoundingClientRect().top - window.__historyTest.anchorTop) < 5;
  });
  assert.equal(await page.evaluate(() => {
    const rows = [...document.querySelector('[data-history-items]').children];
    return rows.slice(100).every((row, i) => row === window.__historyTest.rows[i]) && window.__historyTest.rows[0].querySelector('details').open;
  }), true);
  const anchor = await page.evaluate(() => ({ before: window.__historyTest.anchorTop,
    after: window.__historyTest.rows[0].getBoundingClientRect().top, scroll: document.querySelector('.transcript').scrollTop }));
  assert.ok(Math.abs(anchor.after - anchor.before) < 5,
    `Prepending a page must preserve the visible scroll anchor: ${JSON.stringify(anchor)}`);
  await assertIdentity(page);
  for (let count = 300; count <= 600; count += 100) {
    await page.locator('[data-action="history-older"]').click();
    await page.waitForFunction((count) => document.querySelector('[data-history-items]').children.length === count, count);
  }
  assert.equal(await page.locator('[data-action="history-older"]').isVisible(), false);
  assert.equal(await page.locator('[data-history-items] .timeline-item').evaluateAll((rows) => new Set(rows.map((r) => r.dataset.itemId)).size), 600);
  results.push({ name: 'all older pages reachable, existing rows/disclosures preserved', pass: true });

  await page.evaluate(() => window.__historyTest.defer.add('c'));
  await page.locator('[data-thread-id="c"]').click();
  await page.waitForFunction(() => window.__historyTest.waits.has('events:c'));
  await choose(page, 'b');
  await page.evaluate(() => { window.__historyTest.defer.delete('c'); window.__historyTest.release('events:c'); });
  await page.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'History b');
  assert.ok((await page.locator('[data-history-items] .timeline-item').first().getAttribute('data-item-id')).includes('b-'));
  await assertIdentity(page);
  results.push({ name: 'late response cannot overwrite newer selection', pass: true });

  for (const id of ['broken', 'invalid']) {
    await choose(page, id);
    assert.ok(await page.locator('[data-history-status]').textContent());
    assert.equal(await page.locator('textarea[name="prompt"]').isDisabled(), true);
    await page.locator('[data-action="history-older"]').click();
    await page.waitForFunction(() => document.querySelector('[data-history-items]').children.length === 0
      || document.querySelector('[data-history-items]').children.length === 100);
    await page.waitForFunction(() => document.querySelector('textarea[name="prompt"]')?.disabled === false);
    if (id === 'broken') {
      assert.equal(await page.locator('[data-history-items] .timeline-item').count(), 100);
    }
    assert.equal(await page.locator('textarea[name="prompt"]').isEnabled(), true);
  }
  await choose(page, 'partial');
  assert.match(await page.locator('[data-history-items] .timeline-agent').innerText(), /中断前的回复/);
  assert.match(await page.locator('[data-history-items] .timeline-agent').innerText(), /原来的模型回复 partial/);
  assert.equal(await page.locator('[data-history-items] .timeline-error').count(), 1);
  results.push({ name: 'interrupted response is restored alongside the failure', pass: true });
  await choose(page, 'empty');
  assert.equal(await page.locator('[data-history-items] .timeline-item').count(), 0);
  assert.equal(await page.locator('[data-action="history-older"]').isVisible(), false);
  results.push({ name: 'empty history, failed reads and invalid page identity recover correctly', pass: true });

  await choose(page, 'a');
  const historyCalls = await page.evaluate(() => window.__historyTest.calls.filter((c) => c.command === 'list_thread_events').length);
  await page.locator('[data-action="navigate"][data-page="memory"]').click();
  await page.waitForFunction(() => window.__historyTest.calls.some((c) => c.command === 'runtime_dashboard' && c.args.details));
  await page.locator('[data-thread-id="a"]').click();
  await page.waitForSelector('[data-history-items] .timeline-item');
  assert.equal(await page.evaluate(() => window.__historyTest.calls.filter((c) => c.command === 'list_thread_events').length), historyCalls);
  await page.locator('[data-action="open-settings"]').click();
  await page.waitForSelector('[data-settings-dialog]');
  await page.locator('[data-action="close-settings"]').last().click();
  await page.waitForSelector('[data-history-items] .timeline-item');
  assert.equal(await page.locator('textarea[name="prompt"]').inputValue(), 'draft survives switching');
  results.push({ name: 'lazy details and returning from pages/settings preserve history and draft', pass: true });

  await identity(page);
  const traceStart = await page.evaluate(() => performance.now());
  const historyCallsBeforeCachedSwitches = await page.evaluate(() => window.__historyTest.calls.filter((c) => c.command === 'list_thread_events').length);
  for (const id of ['b', 'c', 'a', 'b', 'c', 'a']) await choose(page, id);
  const historyCallsAfterCachedSwitches = await page.evaluate(() => window.__historyTest.calls.filter((c) => c.command === 'list_thread_events').length);
  assert.equal(historyCallsAfterCachedSwitches, historyCallsBeforeCachedSwitches,
    'returning to an unchanged task should reuse its recent history page');
  await assertIdentity(page);
  await page.screenshot({ path: resolve(output, 'desktop.png'), fullPage: true });
  const tasks = await page.evaluate((start) => window.__historyTest.longTasks.filter((task) => task.start >= start), traceStart);
  results.push({ name: 'six repeated 100-event switches', pass: true, longTasks: tasks });

  await page.evaluate(() => window.__historyTest.defer.add('fresh'));
  await page.locator('[data-thread-id="fresh"]').click();
  await page.waitForFunction(() => window.__historyTest.waits.has('events:fresh'));
  await page.locator('[data-action="new-task"]').click();
  const freshPicker = page.locator('.project-picker-card');
  if (await freshPicker.count()) await freshPicker.locator('.project-picker-none').click();
  await page.evaluate(() => { window.__historyTest.defer.delete('fresh'); window.__historyTest.release('events:fresh'); });
  assert.equal(await page.locator('[data-history-items]').count(), 0);
  assert.equal(await page.locator('textarea[name="prompt"]').isEnabled(), true);
  results.push({ name: 'new task invalidates pending history request', pass: true });

  const early = await openFixture({ delaySummary: true });
  await early.waitForFunction(() => window.__historyTest.waits.has('summary'));
  await early.locator('[data-action="new-task"]').click();
  const earlyPicker = early.locator('.project-picker-card');
  if (await earlyPicker.count()) await earlyPicker.locator('.project-picker-none').click();
  await early.evaluate(() => window.__historyTest.release('summary'));
  await early.waitForSelector('[data-thread-id="a"]');
  assert.equal(await early.locator('[data-history-items]').count(), 0);
  assert.ok(await early.evaluate(() => window.__historyTest.calls.filter((c) => c.command === 'list_thread_events').length <= 1));
  results.push({ name: 'startup restoration does not override early user navigation', pass: true });

  const mobile = await openFixture({ viewport: { width: 390, height: 844 } });
  await mobile.waitForSelector('[data-history-items] .timeline-item');
  await mobile.screenshot({ path: resolve(output, 'mobile.png'), fullPage: true });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  results.push({ name: 'mobile layout has no page overflow', pass: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, results, output }, null, 2));
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ ok: true, results, errors }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
