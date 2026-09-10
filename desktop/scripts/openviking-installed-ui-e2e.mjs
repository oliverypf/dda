#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const installedRoot = process.env.HMCODEX_INSTALLED_ROOT
  ?? join(process.env.LOCALAPPDATA, 'Programs', 'hmCodex');
const executable = join(installedRoot, 'hmcodex-desktop.exe');
const sidecar = join(installedRoot, 'sidecar', 'openviking-server.exe');
const supervisor = join(installedRoot, 'runtime', 'src', 'openviking-sidecar-supervisor.mjs');
const cdpPort = Number(process.env.HMCODEX_OPENVIKING_UI_PORT ?? 9488);

assert.ok(process.platform === 'win32', 'This installed-package E2E targets Windows');
assert.ok(['executable', 'sidecar', 'supervisor'].every((name) => statSync({ executable, sidecar, supervisor }[name]).isFile()), 'INSTALLED_OPENVIKING_LAYOUT_MISSING');

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const stopApp = (pid) => {
  if (!Number.isInteger(pid)) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
};

const connectCdp = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`, {
        signal: AbortSignal.timeout(1000)
      })).json();
      const page = targets.find((target) => target.type === 'page' && /tauri\.localhost|localhost/i.test(target.url));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = () => reject(new Error('UI_WEBSOCKET_OPEN_FAILED'));
        });
        let nextId = 0;
        return {
          evaluate: (expression) => new Promise((resolve, reject) => {
            const id = ++nextId;
            ws.onmessage = (event) => {
              const message = JSON.parse(event.data);
              if (message.id !== id) return;
              ws.onmessage = undefined;
              if (message.error) reject(new Error(message.error.message));
              else if (message.result?.exceptionDetails) reject(new Error('UI_EVALUATION_FAILED'));
              else resolve(message.result?.result?.value);
            };
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
          }),
          close: () => ws.close()
        };
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`UI_CDP_TIMEOUT: ${lastError instanceof Error ? lastError.message : 'unknown'}`);
};

const waitUntil = async (action, timeoutMs = 30000, label = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await action();
    if (lastValue) return lastValue;
    await delay(250);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}; last=${JSON.stringify(lastValue)}`);
};

const sidecarReady = async (url) => {
  try {
    const response = await fetch(`${url}/ready`, { signal: AbortSignal.timeout(1000) });
    const body = await response.json();
    return response.ok && body?.status === 'ok' && body?.result?.ready === true;
  } catch {
    return false;
  }
};

const runScenario = async ({ name, expected, environment }) => {
  spawnSync('taskkill', ['/IM', 'hmcodex-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
  const dataDir = await mkdtemp(join(process.env.TEMP, `hmcodex-openviking-${name}-`));
  const url = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(executable, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...environment,
      HMCODEX_OPENVIKING_URL: url,
      HMCODEX_OPENVIKING_API_KEY: 'installed-ui-e2e-key',
      HMCODEX_OPENVIKING_DATA_DIR: dataDir,
      HMCODEX_OPENVIKING_START_TIMEOUT_MS: '10000',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`
    }
  });
  let client;
  try {
    if (environment.HMCODEX_OPENVIKING_EXECUTABLE === sidecar) {
      assert.ok(await waitUntil(() => sidecarReady(url), 20000, 'installed sidecar ready'), 'sidecar did not start');
    }
    client = await connectCdp();
    const visible = await waitUntil(() => client.evaluate(
      `[...document.querySelectorAll('.runtime-line')].some((line) => line.innerText.includes(${JSON.stringify(expected)}))`
    ), 20000, expected);
    assert.ok(visible, `UI did not show: ${expected}`);
    return { name, expected, url };
  } finally {
    client?.close();
    stopApp(child.pid);
    await rm(dataDir, { recursive: true, force: true });
  }
};

const ready = await runScenario({
  name: 'ready',
  expected: '记忆已就绪（托管）',
  environment: { HMCODEX_OPENVIKING_EXECUTABLE: sidecar }
});
const unavailable = await runScenario({
  name: 'unavailable',
  expected: '记忆不可用（已降级）',
  environment: { HMCODEX_OPENVIKING_EXECUTABLE: 'C:\\hmcodex-openviking-missing.exe' }
});

console.log(JSON.stringify({ status: 'passed', ready, unavailable }));
