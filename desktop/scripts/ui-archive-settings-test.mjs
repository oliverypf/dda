// Real compiled frontend, isolated browser storage and a simulated native bridge.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(process.env.HMCODEX_UI_DIST ?? fileURLToPath(new URL('../dist/', import.meta.url)));
const output = resolve(process.env.HMCODEX_UI_ARTIFACTS ?? fileURLToPath(new URL('../../.codex-tmp/archive-settings-ui/', import.meta.url)));
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(path.startsWith(root + sep));
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const url = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: process.env.HMCODEX_BROWSER_CHANNEL ?? 'msedge', headless: true });
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, ...(detail === undefined ? {} : { detail }) }); assert.ok(pass, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 1000 } });
  await context.addInitScript(options => {
    const projects = [{ id: 'project-a', name: '项目甲', path: 'C:/fixture/A', paths: ['C:/fixture/A'], lastUsedAtMs: 2 }, { id: 'project-b', name: '项目乙', path: 'C:/fixture/B', paths: ['C:/fixture/B'], lastUsedAtMs: 1 }];
    const threads = [{ id: 'a-live', title: '甲的普通会话', cwd: 'C:/fixture/A', turnCount: 2, updatedAtMs: 2 }, { id: 'a-archived', title: '甲的单独归档会话', cwd: 'C:/fixture/A', turnCount: 1, updatedAtMs: 1 }, { id: 'b-live', title: '乙的会话', cwd: 'C:/fixture/B', turnCount: 1, updatedAtMs: 1 }];
    const projectArchives = options.archivedProject ? { 'project-a': { name: '项目甲', path: 'C:/fixture/A', archivedAtMs: 1 } } : {};
    if (options.many) for (let i = 0; i < 45; i++) projectArchives['archived-' + i] = { name: '已归档的长名称项目 ' + i, path: 'C:/fixture/long-path-' + i, archivedAtMs: i + 2 };
    if (!localStorage.getItem('archive-settings.seeded')) {
      localStorage.setItem('hmcodex.projects.v1', JSON.stringify(projects));
      localStorage.setItem('hmcodex.projectOrder.v1', JSON.stringify(['project-a', 'project-b']));
      localStorage.setItem('hmcodex.threadArchives.v1', JSON.stringify({ 'a-archived': 1 }));
      localStorage.setItem('hmcodex.projectArchives.v1', JSON.stringify(projectArchives));
      localStorage.setItem('archive-settings.seeded', '1');
    }
    let id = 0; const callbacks = new Map(), listeners = new Map();
    window.__archiveSettings = { calls: [], threads, callbacks, listeners };
    window.__TAURI_INTERNALS__ = {
      transformCallback: callback => { callbacks.set(++id, callback); return id; }, unregisterCallback: key => callbacks.delete(key),
      invoke: async (cmd, args = {}) => {
        window.__archiveSettings.calls.push({ cmd, args });
        if (cmd === 'plugin:event|listen') { listeners.set(args.event, args.handler); return ++id; }
        if (cmd === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'fixture', readOnly: true, workspaceRead: true, commandExecution: false, networkSideEffects: false, runtimeReady: true, releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
        if (cmd === 'runtime_dashboard') return { summaryOnly: true, threads };
        if (cmd === 'default_workspace') return { rootPath: 'C:/fixture/A', rootLabel: 'A' };
        if (cmd === 'set_workspace') return { rootPath: args.path, rootLabel: args.path.split('/').pop() };
        if (cmd === 'list_workspace') return [];
        if (cmd === 'list_threads') return { threads };
        if (cmd === 'get_thread') return { thread: { ...threads.find(t => t.id === args.threadId), turns: [] } };
        if (cmd === 'list_thread_events') return { threadId: args.threadId, thread: threads.find(t => t.id === args.threadId), events: [], hasMore: false, limit: args.limit ?? 100 };
        if (cmd === 'reconcile_runtime_state') return { ok: true, reconciled: 0, execution: { reconciled: 0, records: [] }, roles: { reconciled: 0, contexts: [] } };
        if (cmd === 'runtime_process_status') return { running: false, healthy: true };
        if (cmd === 'run_model_task') return new Promise(done => { window.__archiveSettings.finishTask = done; });
        if (cmd === 'model_config') {
          if (options.configFailure) throw Error('模拟配置读取失败');
          if (options.configPending) return new Promise(() => {});
          return { config: { schemaVersion: '1.0', provider: 'openai-chat', protocol: 'chat-completions', model: 'fixture-model', apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.test/v1' }, exists: true, configPath: 'C:/fixture/model-config.json' };
        }
        if (cmd === 'context_sidecar_status' || cmd === 'dream_maintenance_status') return undefined;
        return {};
      }
    };
  }, options);
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.locator('[data-project-group="project-b"]').waitFor();
  return { context, page, errors };
}
const open = async page => { await page.locator('[data-action="open-settings"]').first().click(); await page.locator('[data-settings-dialog]').waitFor(); };
const archived = page => page.locator('[data-action="settings-section"]').filter({ hasText: '已归档' });
const archivePanel = page => page.locator('[data-settings-panel]').filter({ has: page.locator('h2,h3', { hasText: '已归档项目' }) });
const close = page => page.locator('.settings-back').click();
async function scenario(name, options, body) {
  let state;
  try { state = await fixture(options); await body(state.page); check(name + ': no frontend errors', state.errors.length === 0, state.errors); }
  catch (error) { results.push({ name, pass: false, detail: String(error) }); }
  finally { if (state) { await state.page.screenshot({ path: resolve(output, name + '.png') }); await state.context.close(); } }
}
try {
  await scenario('entry-and-restore', {}, async page => {
    check('no standalone archived navigation', await page.locator('[data-action="navigate"][data-page="archived"]').count() === 0);
    await page.locator('[data-action="archive-project"][data-project-id="project-a"]').click();
    check('archive action still hides project', await page.locator('[data-project-group="project-a"]').count() === 0);
    check('undo notice remains available', await page.locator('[data-action="restore-project"][data-project-id="project-a"]').isVisible());
    await page.locator('[data-action="restore-project"][data-project-id="project-a"]').click();
    check('undo restores project', await page.locator('[data-project-group="project-a"]').count() === 1);
    await page.locator('[data-action="archive-project"][data-project-id="project-a"]').click();
    await open(page); await archived(page).click();
    check('settings contains project and thread lists', await archivePanel(page).isVisible());
    await page.screenshot({ path: resolve(output, 'archive-settings.png') });
    await archivePanel(page).locator('.run-history-row [data-action="restore-project"][data-project-id="project-a"]').click();
    check('project restore keeps settings open', await page.locator('[data-settings-dialog]').isVisible());
    check('restored project removed from archive panel', await archivePanel(page).locator('.run-history-row [data-action="restore-project"]').count() === 0);
    check('individual thread archive preserved', await archivePanel(page).locator('[data-action="restore-thread"][data-thread-id="a-archived"]').isVisible());
    await archivePanel(page).locator('[data-action="restore-thread"][data-thread-id="a-archived"]').click();
    check('thread restore keeps settings open', await page.locator('[data-settings-dialog]').isVisible());
    check('both empty states shown', (await archivePanel(page).innerText()).includes('暂无已归档项目') && (await archivePanel(page).innerText()).includes('暂无已归档会话'));
    check('restore never submits configuration', await page.evaluate(() => !window.__archiveSettings.calls.some(c => c.cmd === 'save_model_config')));
    await close(page); await page.reload(); await page.locator('[data-project-group="project-a"]').waitFor();
    check('restoration persists after reload', await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hmcodex.projectArchives.v1'))).length === 0 && Object.keys(JSON.parse(localStorage.getItem('hmcodex.threadArchives.v1'))).length === 0));
  });
  await scenario('draft-search-history', { archivedProject: true }, async page => {
    await open(page); await page.locator('[data-action="settings-section"][data-section="model"]').click();
    await page.locator('input[name="model"]').fill('my-unsaved-model');
    await page.locator('.settings-search').fill('已归档');
    check('settings search finds archives', await archivePanel(page).isVisible());
    await archived(page).click();
    await archivePanel(page).locator('.run-history-row [data-action="restore-project"]').click();
    await page.locator('[data-action="settings-section"][data-section="model"]').click();
    check('archive restore preserves settings draft', await page.locator('input[name="model"]').inputValue() === 'my-unsaved-model');
    await archived(page).click();
    await archivePanel(page).locator('[data-action="select-thread"][data-thread-id="a-archived"]').click();
    await page.locator('[data-settings-dialog]').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__archiveSettings.calls.some(c => c.cmd === 'list_thread_events' && c.args.threadId === 'a-archived'));
    check('archived history is displayed', await page.locator('[data-history-thread-id="a-archived"]').count() > 0 || (await page.locator('body').innerText()).includes('甲的单独归档会话'));
    check('view history does not restore thread', await page.evaluate(() => JSON.parse(localStorage.getItem('hmcodex.threadArchives.v1'))['a-archived'] === 1));
  });
  for (const mode of ['configFailure', 'configPending']) await scenario(mode, { [mode]: true, archivedProject: true }, async page => {
    await open(page); await archived(page).click();
    check(mode + ': archives available independently of model configuration', await archivePanel(page).locator('[data-action="restore-project"]').isVisible());
    await archivePanel(page).locator('[data-action="restore-project"]').click();
    check(mode + ': restoration works', await archivePanel(page).locator('[data-action="restore-project"]').count() === 0);
  });
  await scenario('restore-error-and-cross-window', { archivedProject: true }, async page => {
    await open(page); await archived(page).click();
    await page.evaluate(() => {
      window.__originalStorageWrite = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) { if (key === 'hmcodex.projectArchives.v1') throw Error('quota'); return window.__originalStorageWrite.call(this, key, value); };
    });
    await archivePanel(page).locator('[data-action="restore-project"]').click();
    check('failed restoration retains archived project', await archivePanel(page).locator('[data-action="restore-project"]').count() === 1);
    const visibleText = await page.locator('[data-settings-dialog]').innerText();
    check('restore failure is visible within settings', visibleText.includes('项目归档状态保存失败'));
    await page.evaluate(() => {
      Storage.prototype.setItem = window.__originalStorageWrite;
      localStorage.setItem('hmcodex.projectArchives.v1', '{}');
      dispatchEvent(new StorageEvent('storage', { key: 'hmcodex.projectArchives.v1', newValue: '{}', storageArea: localStorage }));
    });
    check('cross-window restore refreshes settings list', await archivePanel(page).locator('[data-action="restore-project"]').count() === 0);
  });
  await scenario('long-list-narrow', { many: true, viewport: { width: 780, height: 640 } }, async page => {
    await open(page); await archived(page).click();
    check('long list retains every archived project', await archivePanel(page).locator('[data-action="restore-project"]').count() === 45);
    const overflow = await page.locator('[data-settings-dialog]').evaluate(el => ({ width: el.getBoundingClientRect().width, windowWidth: innerWidth, bodyWidth: document.documentElement.scrollWidth }));
    check('settings stays within narrow viewport', overflow.width <= overflow.windowWidth + 2 && overflow.bodyWidth <= overflow.windowWidth + 2, overflow);
    await archivePanel(page).locator('[data-action="restore-project"]').last().scrollIntoViewIfNeeded();
    check('last archive entry reachable by scrolling', await archivePanel(page).locator('[data-action="restore-project"]').last().isVisible());
    await page.keyboard.press('Escape');
    check('Escape closes settings', await page.locator('[data-settings-dialog]').count() === 0);
  });
} finally {
  await browser.close(); await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ backend: 'fixture', frontend: root, results }, null, 2));
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = results.every(r => r.pass) ? 0 : 1;
}
