// Isolated browser with simulated native event transport and delayed audit reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../../.codex-tmp/settings-ui/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep));
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, channel: process.env.HMCODEX_BROWSER_CHANNEL });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  let id = 0;
  let saved = JSON.parse(localStorage.getItem('fixture-config') ?? 'null') ?? {
    schemaVersion: '1.0', provider: 'openai-chat', protocol: 'chat-completions', model: 'fixture-model',
    apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.test/v1',
    verifier: { criteria: ['提供证据'], repetitions: 2, maxComparisons: 32 }
  };
  window.__settingsTest = { saved: [], failSave: false };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return ++id; },
    async invoke(command, args = {}) {
      if (command.startsWith('plugin:event|')) return ++id;
      if (command === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'fixture', runtimeReady: true,
        readOnly: true, workspaceRead: true, commandExecution: false, networkSideEffects: false,
        releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
      if (command === 'reconcile_runtime_state') return { ok: true, reconciled: 0 };
      if (command === 'default_workspace') return { rootLabel: 'Fixture', rootPath: 'C:/fixture' };
      if (command === 'list_workspace') return [];
      if (command === 'context_sidecar_status' || command === 'dream_maintenance_status') return undefined;
      if (command === 'runtime_dashboard') return { ok: true, summaryOnly: !args.details, threads: [],
        execution: { records: [] }, feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [],
        evolution: { proposals: [], reports: [], control: { enabled: true, changedAtMs: 0 } } };
      if (command === 'model_config') return { config: saved, exists: true, configPath: 'C:/fixture/model-config.json' };
      if (command === 'save_model_config') {
        if (window.__settingsTest.failSave) throw Error('模拟保存失败');
        saved = args.config;
        localStorage.setItem('fixture-config', JSON.stringify(saved));
        window.__settingsTest.saved.push(saved);
        return { config: saved, exists: true, configPath: 'C:/fixture/model-config.json' };
      }
      throw Error(`Unexpected call ${command}`);
    }
  };
});
const open = async () => {
  await page.locator('[data-action="open-settings"]').click();
  await page.waitForSelector('[data-form="model-settings"]');
};
const section = (id) => page.locator(`[data-action="settings-section"][data-section="${id}"]`).click();
const assertFocusReturned = async (route) => {
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-action')), 'open-settings', `${route} returns focus to settings launcher`);
};
const assertFocusCycle = async () => {
  const count = await page.locator('[data-settings-dialog]').evaluate(dialog => [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')].filter(el => el.getClientRects().length > 0).length);
  assert.ok(count > 1);
  await page.locator('.settings-back').focus();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < count; i++) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-settings-dialog]'))), true, `${key} stays in dialog`);
    }
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('settings-back')), true, `${key} wraps exactly once`);
  }
};
const save = async () => {
  await page.locator('[data-form="model-settings"] .send-button').click();
  await page.waitForSelector('.settings-message-success');
};
try {
  await mkdir(output, { recursive: true });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('.connection-status')?.classList.contains('status-ready'));
  await open();
  const requiredSections = ['connection', 'model', 'workspace', 'plugins', 'verifier', 'memory', 'personalization', 'storage', 'accessibility', 'diagnostics'];
  for (const sectionId of requiredSections) {
    await section(sectionId);
    assert.equal(await page.locator(`[data-settings-panel="${sectionId}"]`).isVisible(), true, `${sectionId} settings panel is reachable`);
    if (!['model', 'personalization', 'verifier'].includes(sectionId)) {
      assert.ok(await page.locator(`[data-settings-panel="${sectionId}"] .settings-field-readonly`).count() > 0, `${sectionId} settings panel exposes a read-only status`);
    }
  }
  await section('model');
  await assertFocusCycle();
  let reachedModel = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    reachedModel = await page.evaluate(() => document.activeElement?.getAttribute('name') === 'model');
    if (reachedModel) break;
  }
  assert.ok(reachedModel, 'model field reachable by Tab');
  const focus = await page.locator('[name="model"]').evaluate(el => ({ visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle, width: getComputedStyle(el).outlineWidth }));
  assert.equal(focus.visible, true);
  assert.equal(focus.outline, 'solid', 'keyboard focus must retain an outline');
  assert.ok(parseFloat(focus.width) >= 2);
  const sidebar = await page.locator('.settings-sidebar').boundingBox();
  const content = await page.locator('.settings-main').boundingBox();
  assert.ok(sidebar.x + sidebar.width <= content.x + 1, 'sidebar is left of settings content');
  assert.equal(await page.locator('[data-settings-panel="model"]').isVisible(), true);
  await page.locator('[name="model"]').fill('draft-model');
  await section('verifier');
  await page.locator('[name="verifierCriteria"]').fill('提供证据\n不能编造结果');
  await page.locator('[name="verifierRepetitions"]').fill('3');
  await section('personalization');
  const instructions = '每次回复都使用中文。\n先给结论，再解释原因。\n代码和命令保留原文。';
  await page.locator('[name="customInstructions"]').fill(instructions);
  await page.screenshot({ path: resolve(output, 'personalization-desktop.png') });
  await save();
  const saved = await page.evaluate(() => window.__settingsTest.saved.at(-1));
  assert.equal(saved.customInstructions, instructions);
  assert.equal(saved.model, 'draft-model');
  assert.deepEqual(saved.verifier.criteria, ['提供证据', '不能编造结果']);
  assert.equal(saved.verifier.repetitions, 3);
  await page.locator('.settings-back').click();
  await assertFocusReturned('Back button');
  await page.reload();
  await open();
  await section('personalization');
  assert.equal(await page.locator('[name="customInstructions"]').inputValue(), instructions);
  // Search filters actual panels while preserving unsaved fields.
  await page.locator('.settings-search').fill('中文');
  assert.equal(await page.locator('[data-settings-panel="personalization"]').isVisible(), true);
  assert.equal(await page.locator('[data-settings-panel="model"]').isVisible(), false);
  await page.locator('.settings-search').fill('不存在的设置');
  assert.equal(await page.locator('[data-settings-empty]').isVisible(), true);
  await section('model');
  await page.screenshot({ path: resolve(output, 'model-desktop.png') });
  assert.equal(await page.locator('.settings-search').inputValue(), '');
  // Invalid hidden fields route back to the relevant panel for correction.
  await page.locator('[name="model"]').fill('');
  await section('personalization');
  await page.locator('[data-form="model-settings"] .send-button').click();
  assert.equal(await page.locator('[data-settings-panel="model"]').isVisible(), true);
  await page.locator('[name="model"]').fill('restored-model');
  await section('verifier');
  await page.locator('[name="verifierPassThreshold"]').fill('0.2');
  await page.locator('[name="verifierFailThreshold"]').fill('0.9');
  await section('personalization');
  await page.locator('[data-form="model-settings"] .send-button').click();
  await page.waitForSelector('.settings-message-error');
  assert.equal(await page.locator('[data-settings-panel="verifier"]').isVisible(), true);
  assert.equal(await page.locator('[name="verifierPassThreshold"]').inputValue(), '0.2');
  await page.locator('[name="verifierPassThreshold"]').fill('0.9');
  await page.locator('[name="verifierFailThreshold"]').fill('0.5');
  await section('personalization');
  assert.equal(await page.locator('[name="customInstructions"]').inputValue(), instructions);
  await page.locator('[name="customInstructions"]').fill('');
  await save();
  assert.equal(await page.evaluate(() => window.__settingsTest.saved.at(-1).customInstructions), undefined);
  await page.locator('.settings-back').click();
  await open();
  assert.equal(await page.locator('[name="customInstructions"]').inputValue(), '');
  // Failed writes keep all unsaved edits and support retry.
  await page.locator('[name="customInstructions"]').fill(instructions);
  await page.evaluate(() => { window.__settingsTest.failSave = true; });
  await page.locator('[data-form="model-settings"] .send-button').click();
  await page.waitForSelector('.settings-message-error');
  assert.equal(await page.locator('[name="customInstructions"]').inputValue(), instructions);
  await page.evaluate(() => { window.__settingsTest.failSave = false; });
  await save();
  await page.setViewportSize({ width: 390, height: 844 });
  await section('personalization');
  assert.equal(await page.locator('[data-settings-panel="personalization"]').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const textarea = await page.locator('[name="customInstructions"]').boundingBox();
  assert.ok(textarea.x >= 0 && textarea.x + textarea.width <= 390);
  await page.screenshot({ path: resolve(output, 'personalization-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: resolve(output, 'personalization-dark.png') });
  await page.locator('[name="customInstructions"]').press('Escape');
  assert.equal(await page.locator('[data-settings-dialog]').count(), 0);
  assert.equal(await page.locator('.app-shell').evaluate((shell) => shell.inert), false);
  await assertFocusReturned('Escape');
  for (const selector of ['[aria-label="关闭设置"]', '[data-form="model-settings"] [data-action="close-settings"]']) {
    await open();
    await assertFocusCycle();
    await page.locator(selector).click();
    await assertFocusReturned(selector);
  }
  assert.deepEqual(errors, []);
  console.log('PASS settings keyboard focus cycling and close restoration, layout, section drafts, search, Chinese instructions, reload, clear, validation, retry, mobile and dark mode');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
