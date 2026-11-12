import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startUiModelFixture } from './ui-local-model-fixture.mjs';

const [exe, evidenceDirectory] = process.argv.slice(2);
assert(exe && evidenceDirectory, 'Usage: node subagent-panel-acceptance.mjs <exe> <evidence-directory>');
const evidence = resolve(evidenceDirectory);
await mkdir(evidence, { recursive: true });
const fixture = await startUiModelFixture({ delayMs: 12000 });
const port = 9437;
let child;
let browser;
let page;
const report = { exe: resolve(exe), measurements: [], errors: [], scope: 'Isolated native UI with a local read-only fixture; not a PE/runtime safety acceptance.' };
const measure = () => {
  const panel = document.querySelector('.subagent-panel');
  if (!panel) throw new Error('PANEL_ABSENT');
  const list = panel.querySelector('.subagent-list');
  const button = panel.querySelector('[data-action="toggle-subagents"]');
  const style = getComputedStyle(panel);
  return {
    width: innerWidth, height: panel.getBoundingClientRect().height,
    className: panel.className, cssHeight: style.height, padding: style.padding,
    hidden: list.hidden, listDisplay: getComputedStyle(list).display,
    rows: list.querySelectorAll('.subagent-row').length,
    visibleRows: [...list.querySelectorAll('.subagent-row')].filter(row => row.getClientRects().length > 0).length,
    expanded: button.getAttribute('aria-expanded'),
    controls: button.getAttribute('aria-controls'), listId: list.id,
    horizontalOverflow: panel.scrollWidth > panel.clientWidth,
    summary: panel.querySelector('.subagent-count').textContent
  };
};
try {
  child = spawn(resolve(exe), [], {
    env: {
      ...process.env, ...fixture.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED'
    },
    windowsHide: true, stdio: 'ignore'
  });
  child.on('error', error => report.errors.push(String(error)));
  report.fixturePid = child.pid;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch {}
    await delay(300);
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.waitForSelector('textarea[name="prompt"]', { timeout: 45000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('.send-button');
    return button && !button.disabled;
  }, undefined, { timeout: 45000 });
  await page.locator('textarea[name="prompt"]').fill('Inspect README.md using read-only workspace tools and summarize it.');
  await page.locator('form[data-form="composer"]').evaluate(form => form.requestSubmit());
  // Ignore the desktop's provisional host rows before runtime allocation.
  await page.locator('.subagent-name').filter({ hasText: '结果验证（规则）' }).waitFor({ timeout: 60000 });
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 1121 && await page.locator('.mobile-context-close').count()) {
      await page.locator('.mobile-context-close').click({ force: true });
    }
    await page.waitForSelector('.subagent-panel', { timeout: 15000 });
    const initial = await page.evaluate(measure);
    assert(initial.rows > 0);
    if (initial.expanded === 'false') await page.locator('[data-action="toggle-subagents"]').click({ force: true });
    const expanded = await page.evaluate(measure);
    assert.equal(expanded.visibleRows, expanded.rows);
    const expectedRows = expanded.rows;
    await page.locator('[data-action="toggle-subagents"]').click({ force: true });
    const collapsed = await page.evaluate(measure);
    assert.equal(collapsed.height, 44);
    assert.equal(collapsed.expanded, 'false');
    assert.equal(collapsed.controls, collapsed.listId);
    assert.equal(collapsed.listDisplay, 'none');
    assert.equal(collapsed.visibleRows, 0);
    assert.equal(collapsed.rows, expectedRows);
    assert.equal(collapsed.horizontalOverflow, false);
    const measurement = { width, expanded, collapsed };
    report.measurements.push(measurement);
    await page.screenshot({ path: join(evidence, `collapsed-${width}.png`) });
    if (width === 1280) {
      await page.evaluate(() => {
        window.__panelMutationCount = 0;
        window.__panelObserver = new MutationObserver(records => {
          window.__panelMutationCount += records.length;
        });
        window.__panelObserver.observe(document.querySelector('.subagent-panel').parentElement, {
          childList: true, subtree: true, characterData: true, attributes: true
        });
      });
      await page.waitForFunction(() => window.__panelMutationCount > 0, undefined, { timeout: 15000 });
      await page.evaluate(() => window.__panelObserver.disconnect());
      const afterStream = await page.evaluate(measure);
      measurement.afterStream = afterStream;
      assert.equal(afterStream.height, 44);
      assert.equal(afterStream.expanded, 'false');
    }
    await page.locator('[data-action="toggle-subagents"]').click({ force: true });
    const reopened = await page.evaluate(measure);
    measurement.reopened = reopened;
    assert(reopened.rows >= expectedRows);
    assert.equal(reopened.visibleRows, reopened.rows);
    assert.equal(reopened.expanded, 'true');
    await page.screenshot({ path: join(evidence, `expanded-${width}.png`) });
    await page.locator('[data-action="toggle-subagents"]').click({ force: true });
    const recollapsed = await page.evaluate(measure);
    measurement.recollapsed = recollapsed;
    assert.equal(recollapsed.height, 44);
  }
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = error.stack ?? String(error);
  if (page) {
    report.pageText = await page.locator('body').innerText().catch(() => '');
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  report.fixtureStats = await fetch(fixture.statsUrl).then(response => response.json()).catch(error => String(error));
  if (browser) await browser.close().catch(() => {});
  // Only this harness's child tree may be stopped, never other dda windows.
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  await fixture.close().catch(error => { report.cleanupError = String(error); });
  await writeFile(join(evidence, 'panel-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
