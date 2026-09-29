#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const exe = process.env.HMCODEX_UI_EXE ?? 'C:\\Program Files\\hmCodex\\hmcodex-desktop.exe';
const port = Number(process.env.HMCODEX_UI_PORT ?? '9337');
const fail = (message) => { throw new Error(message); };
const isShortDuration = (value) => {
  if (value === '0s') return true;
  const match = String(value).match(/^([0-9.eE+-]+)(ms|s)$/);
  if (!match) return false;
  const amount = Number(match[1]) * (match[2] === 'ms' ? 0.001 : 1);
  return Number.isFinite(amount) && amount <= 0.001;
};

spawnSync('taskkill', ['/IM', 'hmcodex-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
const child = spawn(exe, [], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
  },
});
child.unref();
let browser;
try {
  let target;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      target = targets.find((entry) => entry.type === 'page' && /tauri\.localhost|localhost|127\.0\.0\.1/i.test(entry.url));
      if (target) break;
    } catch {}
    await delay(250);
  }
  if (!target) fail('UI_TARGET_TIMEOUT');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.querySelector('.connection-status')?.classList.contains('status-ready'), null, { timeout: 30000 });
  const results = [];
  const check = (name, condition, detail = '') => {
    if (!condition) fail(`${name}${detail ? `: ${detail}` : ''}`);
    results.push({ name, detail });
  };
  const named = await page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((element) => ({
      text: element.innerText.trim(),
      aria: element.getAttribute('aria-label'),
      title: element.getAttribute('title'),
      action: element.dataset.action,
    }))
    .filter((item) => !item.text && !item.aria && !item.title));
  check('all visible buttons have an accessible name', named.length === 0, JSON.stringify(named));
  const controls = await page.evaluate(() => [...document.querySelectorAll('input,textarea,select')]
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((element) => ({
      name: element.getAttribute('name'),
      aria: element.getAttribute('aria-label'),
      placeholder: element.getAttribute('placeholder'),
      id: element.id,
      labelled: element.id ? Boolean(document.querySelector(`label[for="${CSS.escape(element.id)}"]`)) : false,
    }))
    .filter((item) => !item.aria && !item.placeholder && !item.labelled));
  check('all visible form controls have a label or hint', controls.length === 0, JSON.stringify(controls));
  check('desktop has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  check('200% root font size has no viewport overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  check('reduced-motion media query is active', await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
  const motion = await page.evaluate(() => {
    const element = document.querySelector('.send-button') ?? document.body;
    const style = getComputedStyle(element);
    return {
      animationDuration: style.animationDuration,
      transitionDuration: style.transitionDuration,
      scrollBehavior: style.scrollBehavior,
    };
  });
  check('reduced-motion disables long animation/transition', isShortDuration(motion.animationDuration) && isShortDuration(motion.transitionDuration) && motion.scrollBehavior === 'auto', JSON.stringify(motion));
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
  const contrast = await page.evaluate(() => {
    const element = document.querySelector('.send-button') ?? document.body;
    const style = getComputedStyle(element);
    return {
      matches: matchMedia('(prefers-contrast: more)').matches,
      borderWidth: style.borderTopWidth,
      border: getComputedStyle(document.documentElement).getPropertyValue('--border').trim(),
    };
  });
  check('high-contrast media query is active', contrast.matches, JSON.stringify(contrast));
  check('high-contrast controls have a 2px border', contrast.borderWidth === '2px', JSON.stringify(contrast));
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  if (browser) {
    try { await browser.close(); } catch {}
  }
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}


