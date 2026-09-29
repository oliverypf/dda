// Isolated browser with simulated native event transport and delayed audit reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../../.codex-tmp/memory-ui/', import.meta.url));
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
  const memories = ['PROPOSED', 'VERIFIED', 'ACTIVE'].map((status, index) => ({
    memoryId: `fixture-${status}`, statement: `Memory ${status}`, status, scope: 'workspace',
    confidence: .8, createdAtMs: 1, updatedAtMs: index + 1,
    sourceEventIds: [`event-${index}`], ...(index === 0 ? { sensitivity: 'SECURITY_AUDIT', version: 1 } : { expiresAtMs: 1800000000000, untrainable: index === 1, ...(index === 2 ? { version: 2, supersedesMemoryId: 'fixture-PROPOSED', conflictsWithMemoryIds: ['fixture-VERIFIED'] } : {}) })
  }));
  memories.push({ memoryId: 'fixture-CONFLICT', statement: 'Memory CONFLICT', status: 'ACTIVE', scope: 'workspace', confidence: .7, createdAtMs: 1, updatedAtMs: 4, sourceEventIds: ['event-conflict'], conflictsWithMemoryIds: ['fixture-VERIFIED'], version: 1 });
  window.__memoryTest = { memories, calls: [], fail: false, unexpected: [] };
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return ++id; },
    async invoke(command, args = {}) {
      if (command.startsWith('plugin:event|')) return ++id;
      if (command === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'fixture', runtimeReady: true, readOnly: true, workspaceRead: true, releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
      if (command === 'default_workspace') return { rootLabel: 'Fixture', rootPath: 'C:/fixture' };
      if (command === 'list_workspace') return [];
      if (command === 'reconcile_runtime_state') return { ok: true, reconciled: 0 };
      if (command === 'context_sidecar_status' || command === 'dream_maintenance_status') return undefined;
      if (command === 'runtime_dashboard') return { ok: true, summaryOnly: !args.details, threads: [], execution: { records: [] }, feedback: [], memories: structuredClone(memories), dreams: [], plugins: [], pluginVersions: [], evolution: { proposals: [], reports: [], control: { enabled: true } } };
      if (command === 'list_memories') { if (window.__memoryTest.failRead) throw Error('FIXTURE_READ_FAILED'); return { memories: structuredClone(memories) }; }
      if (command === 'list_dream_runs') return { runs: [] };
      if (command === 'list_plugin_governance') return { plugins: [] };
      if (command === 'list_evolution') return { proposals: [], reports: [] };
      if (command === 'memory_action') {
        window.__memoryTest.calls.push(args);
        if (window.__memoryTest.hold) await new Promise(resolve => { window.__memoryTest.release = resolve; });
        if (window.__memoryTest.fail) throw Error('FIXTURE_DELETE_FAILED');
        const index = memories.findIndex(m => m.memoryId === args.memoryId);
        if (index < 0) throw Error('INVALID_FIXTURE_ACTION');
        const current = memories[index];
        if (args.operation === 'edit' || args.operation === 'resolve-conflict') {
          const next = { ...current, memoryId: `${current.memoryId}-v2`, statement: args.statement ?? current.statement, scope: args.scope ?? current.scope, confidence: args.confidence ?? current.confidence, sensitivity: args.sensitivity ?? current.sensitivity, version: Number(current.version ?? 1) + 1, supersedesMemoryId: current.memoryId, updatedAtMs: Date.now() };
          if (args.operation === 'resolve-conflict') delete next.conflictsWithMemoryIds;
          memories.push(next);
          return { memory: next };
        }
        if (args.operation !== 'delete') throw Error('INVALID_FIXTURE_ACTION');
        memories.splice(index, 1);
        return {};
      }
      window.__memoryTest.unexpected.push(command);
      throw Error(`Unexpected call ${command}`);
    }
  };
});
try {
  await mkdir(output, { recursive: true });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.connection-status.status-ready').waitFor();
  await page.locator('[data-action="navigate"][data-page="memory"]').click();
  const content = page.locator('.transcript');
  await content.getByText('Memory PROPOSED', { exact: true }).waitFor();
  assert.match(await content.innerText(), /event-0/);
  assert.match(await content.innerText(), /2027/);
  const row = content.locator('.run-history-copy').first();
  const titleBox = await row.locator('strong').boundingBox();
  const metaBox = await row.locator('span').boundingBox();
  assert.ok(metaBox.y >= titleBox.y + titleBox.height, 'metadata below title');
  assert.match(await content.innerText(), /有效期 未设置/);
  assert.match(await content.innerText(), /训练限制：未提供/);
  assert.match(await content.innerText(), /敏感性 SECURITY_AUDIT/);
  assert.match(await content.innerText(), /版本 1/);
  assert.match(await content.innerText(), /替代 fixture-PROPOSED/);
  assert.match(await content.innerText(), /冲突 fixture-VERIFIED/);
  assert.match(await content.innerText(), /禁止训练标记：是/);
  assert.match(await content.innerText(), /不代表已获训练授权/);
  await content.locator('[data-action="memory-edit"][data-memory-id="fixture-PROPOSED"]').click();
  const editForm = content.locator('[data-form="memory-edit"][data-memory-id="fixture-PROPOSED"]');
  await editForm.waitFor();
  await editForm.locator('textarea[name="statement"]').fill('Memory PROPOSED edited');
  await editForm.locator('input[name="sensitivity"]').count().catch(() => {});
  await editForm.locator('select[name="sensitivity"]').selectOption('RESTRICTED');
  await editForm.locator('button[type="submit"]').click();
  await content.getByText('Memory PROPOSED edited', { exact: true }).waitFor();
  assert.equal((await page.evaluate(() => window.__memoryTest.calls.at(-1).operation)), 'edit');
  assert.match(await content.innerText(), /已被新版本替代 fixture-PROPOSED-v2/);
  await content.locator('[data-operation="resolve-conflict"][data-memory-id="fixture-CONFLICT"]').click();
  await content.locator('article[data-memory-id="fixture-CONFLICT-v2"]').waitFor();
  assert.equal((await page.evaluate(() => window.__memoryTest.calls.at(-1).operation)), 'resolve-conflict');
  assert.equal(await content.locator('article[data-memory-id="fixture-CONFLICT-v2"] [data-operation="resolve-conflict"]').count(), 0);
  await content.locator('[data-operation="delete"][data-memory-id="fixture-PROPOSED-v2"]').click();
  await content.locator('article[data-memory-id="fixture-PROPOSED-v2"]').waitFor({ state: 'detached' });
  await content.locator('[data-operation="delete"][data-memory-id="fixture-CONFLICT-v2"]').click();
  await content.locator('article[data-memory-id="fixture-CONFLICT-v2"]').waitFor({ state: 'detached' });
  await content.locator('[data-operation="delete"][data-memory-id="fixture-CONFLICT"]').click();
  await content.locator('article[data-memory-id="fixture-CONFLICT"]').waitFor({ state: 'detached' });
  await content.getByText('Memory PROPOSED', { exact: true }).waitFor();
  let tabReached = false;
  for (let count = 0; count < 80; count++) {
    await page.keyboard.press('Tab');
    tabReached = await page.evaluate(() => document.activeElement?.matches('.transcript [data-operation="delete"][data-memory-id="fixture-ACTIVE"]') ?? false);
    if (tabReached) break;
  }
  assert.ok(tabReached, 'Tab reaches memory delete from navigation without programmatic focus');
  assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
  await page.screenshot({ path: resolve(output, 'memory-desktop.png') });
  await page.evaluate(() => { window.__memoryTest.calls = []; });
  await page.evaluate(() => {
    window.__memoryTest.fail = true;
    window.__memoryTest.hold = true;
    const buttons = [...document.querySelectorAll('[data-operation="delete"][data-memory-id="fixture-PROPOSED"]')];
    buttons.forEach(button => button.click());
  });
  assert.equal(await page.evaluate(() => window.__memoryTest.calls.length), 1, 'duplicate page/context clicks dispatch once');
  assert.equal(await page.locator('[data-action="memory-action"][data-memory-id="fixture-PROPOSED"]:enabled').count(), 0, 'all operations disabled in both locations');
  await page.evaluate(() => document.querySelector('[data-operation="verify"][data-memory-id="fixture-PROPOSED"]').click());
  assert.equal(await page.evaluate(() => window.__memoryTest.calls.length), 1, 'conflicting verify not submitted');
  await page.evaluate(() => { window.__memoryTest.hold = false; window.__memoryTest.release(); });
  await content.locator('[role="alert"]').waitFor();
  await page.evaluate(() => { window.__memoryTest.fail = true; });
  await content.locator('[data-operation="delete"][data-memory-id="fixture-PROPOSED"]').click();
  await content.locator('[role="alert"]').filter({ hasText: '操作未完成' }).waitFor({ timeout: 3000 });
  assert.equal(await content.getByText('Memory PROPOSED', { exact: true }).isVisible(), true);
  await page.screenshot({ path: resolve(output, 'memory-failure.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no narrow viewport overflow');
  const retryButton = content.locator('[role="alert"] [data-action="refresh-governance"]');
  await retryButton.scrollIntoViewIfNeeded();
  const retryBounds = await retryButton.boundingBox();
  assert.ok(retryBounds.x >= 0 && retryBounds.x + retryBounds.width <= 390, 'retry within viewport');
  assert.equal(await retryButton.evaluate(el => getComputedStyle(el).whiteSpace), 'nowrap', 'retry label must remain on one line');
  await page.screenshot({ path: resolve(output, 'memory-narrow-dark.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });

  await page.evaluate(() => { window.__memoryTest.fail = false; window.__memoryTest.calls = []; });
  for (const status of ['PROPOSED', 'VERIFIED', 'ACTIVE']) {
    const button = content.locator(`[data-operation="delete"][data-memory-id="fixture-${status}"]`);
    await button.focus();
    await page.keyboard.press('Enter');
    await content.getByText(`Memory ${status}`, { exact: true }).waitFor({ state: 'detached' });
  }
  assert.deepEqual(await page.evaluate(() => window.__memoryTest.calls.map(c => [c.operation,c.memoryId])), [
    ['delete','fixture-PROPOSED'], ['delete','fixture-VERIFIED'], ['delete','fixture-ACTIVE']
  ]);
  assert.equal(await content.locator('[role="alert"]').count(), 0, 'successful retry clears error');
  assert.deepEqual(await page.evaluate(() => window.__memoryTest.unexpected), []);
  await page.evaluate(() => {
    window.__memoryTest.memories.push(...Array.from({length: 19}, (_, i) => ({memoryId: `older-${i}`, statement: `Older memory ${i}`, status: 'ACTIVE', scope: 'workspace', confidence: .8, createdAtMs: 1, updatedAtMs: i})));
  });
  await page.locator('[data-action="refresh-governance"]').first().click();
  await content.getByText('Older memory 18', { exact: true }).waitFor();
  await content.locator('[data-action="memory-page"][data-delta="1"]').click({timeout: 3000});
  await content.getByText('Older memory 10', { exact: true }).waitFor();
  await content.locator('[data-action="memory-page"][data-delta="1"]').click();
  await content.getByText('Older memory 0', { exact: true }).waitFor();
  assert.equal(await content.locator('[data-action="memory-page"][data-delta="1"]').isDisabled(), true);
  for (const index of [2, 1, 0]) {
    await content.locator(`[data-operation="delete"][data-memory-id="older-${index}"]`).click();
    await content.getByText(`Older memory ${index}`, {exact: true}).waitFor({state: 'detached'});
  }
  assert.match(await content.locator('[aria-label="记忆分页"]').innerText(), /第 2 \/ 2 页/);
  await content.getByText('Older memory 3', {exact: true}).waitFor();
  await page.screenshot({path: resolve(output, 'memory-pagination.png')});

  await page.evaluate(() => { window.__memoryTest.failRead = true; });
  await page.locator('[data-action="refresh-governance"]').first().click();
  await content.getByRole('alert').filter({hasText: '刷新未完成'}).waitFor({timeout: 3000});
  assert.equal(await content.getByText('Older memory 3', {exact: true}).isVisible(), true);
  await page.evaluate(() => { window.__memoryTest.failRead = false; });
  await content.getByRole('alert').getByRole('button', {name: '重新读取'}).click();
  await content.getByRole('alert').filter({hasText: '刷新未完成'}).waitFor({state: 'detached'});
  await page.evaluate(() => { window.__memoryTest.failRead = true; });
  await content.locator('[data-operation="delete"][data-memory-id="older-3"]').click();
  await content.getByRole('alert').filter({hasText: '刷新未完成'}).waitFor();
  assert.equal(await content.locator('[data-operation="delete"][data-memory-id="older-3"]').isDisabled(), true, 'acknowledged action must await reconciliation');
  assert.equal(await content.getByRole('alert').filter({hasText: '操作未完成'}).count(), 0);
  await page.evaluate(() => { window.__memoryTest.failRead = false; });
  await content.getByRole('button', {name: '重新读取'}).click();
  await content.getByText('Older memory 3', {exact: true}).waitFor({state: 'detached'});
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ ok: true, scope: 'browser with mocked native transport; no real deletion', cases: ['source and expiry fields', 'unknown training restriction', 'explicit training restriction flags', 'three states delete dispatch and refresh', 'failed request retains records and displays uncertainty', 'successful retry clears error', '390px dark viewport and retry bounds', 'keyboard Enter activates deletion', 'Tab reaches deletion with visible focus', '19 records reachable over three pages', 'empty last page clamps after deletion', 'read failure preserves records and retry clears stale warning', 'pending duplicate and conflicting actions suppressed in both locations'] }, null, 2));
  console.log('PASS memory fields, unknown semantics, delete bridge dispatch and refresh for three states');
} catch (error) {
  console.log(await page.locator('.transcript').innerText());
  console.log(await page.evaluate(() => window.__memoryTest.calls));
  throw error;
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
