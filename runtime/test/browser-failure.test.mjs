import test from 'node:test';
import assert from 'node:assert/strict';
import { describeBrowserFailure } from '../src/browser-failure.mjs';

test('missing Playwright browser tells the user the install command', () => {
  const error = describeBrowserFailure(new Error(
    "browserType.launch: Executable doesn't exist at C:\\Users\\User\\AppData\\Local\\ms-playwright\\chrome-headless-shell.exe\n"
    + 'Please run the following command to download new browsers: npx playwright install'
  ));
  assert.equal(error.message.startsWith('BROWSER_NOT_INSTALLED:'), true);
  assert.match(error.message, /npx playwright install chromium/);
  assert.doesNotMatch(error.message, /AppData/);
});

test('a missing playwright package names both install steps', () => {
  const error = describeBrowserFailure(new Error("Cannot find package 'playwright' imported from playwright-worker.mjs"));
  assert.match(error.message, /^BROWSER_RUNTIME_MISSING:/);
  assert.match(error.message, /npm install/);
  assert.match(error.message, /npx playwright install chromium/);
});

test('navigation timeout and connection failure keep a next step', () => {
  assert.match(describeBrowserFailure(new Error('page.goto: Timeout 15000ms exceeded.')).message, /^BROWSER_NAVIGATION_TIMEOUT:/);
  assert.match(describeBrowserFailure(new Error('page.goto: net::ERR_CONNECTION_RESET')).message, /^BROWSER_NAVIGATION_FAILED:/);
});

test('browser codes gain a remedy, and other structured codes stay intact', () => {
  assert.match(describeBrowserFailure(new Error('BROWSER_TARGET_FORBIDDEN')).message, /^BROWSER_TARGET_FORBIDDEN: 这个地址不能用浏览器打开/);
  const safety = new Error('SAFETY_LEASE_REQUIRED');
  assert.equal(describeBrowserFailure(safety), safety);
});

test('an unknown browser failure keeps a short detail and drops secrets', () => {
  const error = describeBrowserFailure(new Error('page.goto: crashed sk-supersecretvalue while opening https://example.test/a?token=1'));
  assert.match(error.message, /^BROWSER_WORKER_FAILED: 浏览器没有打开：/);
  assert.match(error.message, /https:\/\/example\.test\/a/);
  assert.doesNotMatch(error.message, /token=1|sk-supersecretvalue/);
});
