#!/usr/bin/env node
// Automated UI acceptance for the model-disconnect scenario.
//
// 1. Copy the real model config to a temporary file and point baseURL at an
//    unreachable loopback port.
// 2. Launch the installed app with HMCODEX_MODEL_CONFIG=<temporary config>.
// 3. Submit a task and assert the UI reaches a terminal state and shows the
//    transport failure.
// 4. Relaunch with the real config and assert a new task can complete.
// 5. Delete the temporary config.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startUiModelFixture } from './ui-local-model-fixture.mjs';

const DEFAULT_EXE = 'C:\\Program Files\\dda\\dda-desktop.exe';
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const exe = option('--exe', process.env.HMCODEX_UI_EXE ?? DEFAULT_EXE);
const port = Number(option('--port', process.env.HMCODEX_UI_PORT ?? '9334'));
const keepApp = !argv.includes('--close');
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = process.env.HMCODEX_UI_WORKSPACE_ROOT ?? resolve(scriptRoot, '..');

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const runTest = async (name, fn) => {
  try {
    const detail = await fn();
    record(name, 'PASS', typeof detail === 'string' ? detail : '');
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
};

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Best-effort close.
    }
  }
}

const waitForTarget = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && /tauri\.localhost|localhost|127\.0\.0\.1/i.test(target.url));
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await delay(300);
  }
  throw new Error(`UI_TARGET_TIMEOUT: ${lastError instanceof Error ? lastError.message : 'no target'}`);
};

const connect = async () => {
  const page = await waitForTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('UI_WEBSOCKET_OPEN_FAILED'));
  });
  return new CdpClient(ws);
};

const launch = (fixtureEnv, envOverrides = {}) => {
  spawnSync('taskkill', ['/IM', 'dda-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...fixtureEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_WORKSPACE_ROOT: fixtureEnv?.HMCODEX_WORKSPACE_ROOT ?? workspaceRoot,
      ...envOverrides
    }
  });
  child.unref();
  return child.pid;
};
const stop = (pid) => {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
};

const waitFor = async (client, expression, { timeout = 30000, interval = 300, label = expression } = {}) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await client.evaluate(expression);
    if (lastValue) return lastValue;
    await delay(interval);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}; last=${JSON.stringify(lastValue)}`);
};

const text = (client, selector) =>
  client.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').trim()`);
const click = (client, selector) =>
  client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return 'NOT_FOUND';
    if (element.disabled) return 'DISABLED';
    element.click();
    return 'CLICKED';
  })()`);
const setComposer = (client, value) =>
  client.evaluate(`(() => {
    const textarea = document.querySelector('textarea[name="prompt"]');
    if (!textarea) return 'NOT_FOUND';
    textarea.value = ${JSON.stringify(value)};
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    return 'SET';
  })()`);
const submitComposer = (client) =>
  client.evaluate(`(() => {
    const form = document.querySelector('form[data-form="composer"]');
    if (!form) return 'NOT_FOUND';
    form.requestSubmit();
    return 'SUBMITTED';
  })()`);

const waitForReady = async (client) => {
  await waitFor(client, `Boolean(document.querySelector('.connection-status.status-ready'))`, { timeout: 45000, label: 'runtime ready' });
  if (await client.evaluate(`document.querySelector('.mode-pill')?.innerText.includes('受控模式') === true`)) {
    assert((await click(client, '.mode-pill')) === 'CLICKED', 'select read-only mode');
  }
  await waitFor(client, `document.querySelector('.mode-pill')?.innerText.includes('只读模式') === true`, { timeout: 45000, label: 'read-only execution mode' });
};

const submitAndWaitTerminal = async (client, prompt, timeoutMs) => {
  assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'new task click');
  await waitFor(client, `Boolean(document.querySelector('.project-picker-card'))`, { label: 'new task project picker' });
  assert(await client.evaluate(`(() => {
    const button = document.querySelector('.project-picker-last-used')
      ?? [...document.querySelectorAll('[data-action="select-new-task-project"]')].find(item => item.dataset.projectId !== '__projectless__');
    if (!button) return false;
    button.click();
    return true;
  })()`), 'select fixture project');
  await waitFor(client, `!document.querySelector('.project-picker-card')`, { label: 'fixture project selected' });
  assert((await setComposer(client, prompt)) === 'SET', 'set composer');
  assert((await submitComposer(client)) === 'SUBMITTED', 'submit composer');
  await waitFor(client, `/只读检查完成|任务未完成|任务已取消/.test(document.querySelector('.run-status')?.innerText ?? '')`, {
    timeout: timeoutMs,
    interval: 500,
    label: 'terminal state'
  });
  return await text(client, '.run-status > span');
};

const main = async () => {
  const fixture = await startUiModelFixture({ delayMs: 40 });
  const badEndpoint = 'http://127.0.0.1:1/dda/disconnected';
  const fixtureConfig = JSON.parse(await (await import('node:fs/promises')).readFile(fixture.modelConfigPath, 'utf8'));
  const patchedConfigPath = join(fixture.workspaceRoot, 'model-config-disconnected.json');
  const badRegistryPath = join(fixture.workspaceRoot, 'model-registry-disconnected.json');
  const goodRegistryPath = join(fixture.workspaceRoot, 'model-registry-recovered.json');
  writeFileSync(patchedConfigPath, `${JSON.stringify({
    ...fixtureConfig,
    endpoint: badEndpoint,
    models: fixtureConfig.models.map((model) => ({ ...model, endpoint: badEndpoint }))
  }, null, 2)}\n`, 'utf8');
  console.log(`dda UI disconnect tests · exe=${exe} · port=${port} · fixture=${fixture.endpoint}`);
  let client;
  let recoveredPid;
  try {
    const disconnectedPid = launch(fixture.env, { HMCODEX_MODEL_CONFIG: patchedConfigPath, HMCODEX_MODEL_REGISTRY: badRegistryPath });
    console.log(`disconnectedAppPid=${disconnectedPid}`);
    client = await connect();
    await waitForReady(client);
    await runTest('T14 模型断线 UI 错误渲染', async () => {
      const status = await submitAndWaitTerminal(client, 'hello', 120000);
      assert(status === '任务未完成', `expected 任务未完成, got ${status}`);
      const hasError = await client.evaluate(`[...document.querySelectorAll('.timeline-item')]
        .some((item) => /fetch failed|ECONNREFUSED|连接.*失败|模型.*失败|run\\.failed/u.test(item.innerText))`);
      assert(hasError, 'UI shows a transport failure');
      return status;
    });
    client.close();
    client = undefined;
    // Let the disconnected app's runtime children release their JSON-store
    // locks before the recovered app starts a new task.
    stop(disconnectedPid);
    await delay(5000);

    recoveredPid = launch(fixture.env, { HMCODEX_MODEL_REGISTRY: goodRegistryPath });
    console.log(`recoveredAppPid=${recoveredPid}`);
    client = await connect();
    await waitForReady(client);
    await runTest('T15 恢复配置后任务可继续', async () => {
      let status = await submitAndWaitTerminal(client, 'hello', 180000);
      if (status !== '只读检查完成') {
        const lockTimeout = await client.evaluate(`document.body.innerText.includes('PERSISTENCE_LOCK_TIMEOUT')`);
        if (lockTimeout) {
          await delay(5000);
          status = await submitAndWaitTerminal(client, 'hello', 180000);
        }
      }
      assert(status === '只读检查完成', `expected 只读检查完成, got ${status}`);
      return status;
    });
  } finally {
    client?.close();
    stop(recoveredPid);
    if (existsSync(patchedConfigPath)) unlinkSync(patchedConfigPath);
    if (!keepApp) spawnSync('taskkill', ['/IM', 'dda-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    await fixture.close();
  }
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`UI_DISCONNECT_TEST_FATAL: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
