#!/usr/bin/env node
// Regression test for the streaming-render jitter.
//
// The old path rebuilt the whole app (innerHTML + createIcons + scroll reset)
// on every text delta. This test marks the app root, submits a task, and
// asserts the shell node survives while the streaming row grows. A marker on
// #app itself cannot detect replacement of that element's innerHTML.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
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
const port = Number(option('--port', process.env.HMCODEX_UI_PORT ?? '9335'));
const prompt = option('--prompt', 'hello');
const timeoutMs = Number(option('--timeout-ms', '180000'));
const streamStartTimeoutMs = Number(option('--stream-start-timeout-ms', process.env.HMCODEX_STREAM_START_TIMEOUT_MS ?? '120000'));
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = process.env.HMCODEX_UI_WORKSPACE_ROOT ?? resolve(scriptRoot, '..');

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

const waitForTarget = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && /tauri\.localhost|localhost|127\.0\.0\.1/i.test(target.url));
      if (page) return page;
    } catch {
      // Retry until the WebView is up.
    }
    await delay(300);
  }
  throw new Error('UI_TARGET_TIMEOUT');
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

const waitFor = async (client, expression, { timeout = 45000, interval = 300, label = expression } = {}) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await client.evaluate(expression);
    if (lastValue) return lastValue;
    await delay(interval);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}; last=${JSON.stringify(lastValue)}`);
};

const main = async () => {
  spawnSync('taskkill', ['/IM', 'dda-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
  const fixture = await startUiModelFixture({ delayMs: 80 });
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...fixture.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_WORKSPACE_ROOT: fixture.workspaceRoot
    }
  });
  child.unref();
  const client = await connect();
  try {
    await waitFor(client, `Boolean(document.querySelector('.connection-status.status-ready'))`, { label: 'runtime ready' });
    if (await client.evaluate(`document.querySelector('.mode-pill')?.innerText.includes('受控模式') === true`)) {
      await client.evaluate(`document.querySelector('.mode-pill').click()`);
    }
    await waitFor(client, `document.querySelector('.mode-pill')?.innerText.includes('只读模式') === true`, { label: 'read-only execution mode' });
    await client.evaluate(`(() => {
      const textarea = document.querySelector('textarea[name="prompt"]');
      textarea.value = ${JSON.stringify(prompt)};
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('form[data-form="composer"]').requestSubmit();
      return 'SUBMITTED';
    })()`);
    await waitFor(client, `document.querySelector('.timeline-item[data-status=\"STREAMING\"]')`, { timeout: streamStartTimeoutMs, label: 'streaming row started' });
    await client.evaluate(`window.__streamingShell = document.querySelector('.app-shell')`);
    const samples = [];
    const deadline = Date.now() + timeoutMs;
    let lastLength = -1;
    let sawGrowth = false;
    let markerKeptWhileGrowing = 0;
    let maxBodyLength = 0;
    let rebuiltWhileStreaming = false;
    while (Date.now() < deadline) {
      const sample = await client.evaluate(`JSON.stringify({
        marker: window.__streamingShell === document.querySelector('.app-shell') ? 'keep' : null,
        runStatus: document.querySelector('.run-status')?.innerText.trim() ?? '',
        streamingLength: document.querySelector('.timeline-item[data-status="STREAMING"] .timeline-body')?.innerText.length ?? 0,
        itemCount: document.querySelectorAll('.timeline-item').length,
        scrollTop: document.querySelector('.transcript')?.scrollTop ?? 0,
        scrollHeight: document.querySelector('.transcript')?.scrollHeight ?? 0
      })`);
      const parsed = JSON.parse(sample);
      samples.push(parsed);
      if (parsed.streamingLength > 0 && parsed.marker !== 'keep') rebuiltWhileStreaming = true;
      maxBodyLength = Math.max(maxBodyLength, parsed.streamingLength);
      if (parsed.streamingLength > Math.max(0, lastLength)) sawGrowth = true;
      if (sawGrowth && parsed.marker === 'keep') markerKeptWhileGrowing += 1;
      lastLength = parsed.streamingLength;
      if (/只读检查完成|任务未完成|任务已取消/.test(parsed.runStatus)) break;
      await delay(200);
    }
    const terminal = samples.at(-1)?.runStatus ?? '';
    console.log(`samples=${samples.length} maxStreamingLength=${maxBodyLength} markerKeptWhileGrowing=${markerKeptWhileGrowing} terminal=${terminal}`);
    if (!sawGrowth) throw new Error('STREAMING_GROWTH_NOT_OBSERVED');
    if (rebuiltWhileStreaming) throw new Error(`APP_ROOT_REBUILT_DURING_STREAMING: markerKeptWhileGrowing=${markerKeptWhileGrowing}`);
    if (markerKeptWhileGrowing < 3) throw new Error(`INSUFFICIENT_STREAMING_SAMPLES: markerKeptWhileGrowing=${markerKeptWhileGrowing}`);
    console.log('PASS streaming row updated in place without rebuilding the app root');
  } finally {
    client.close();
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await fixture.close();
  }
};

main().catch((error) => {
  console.error(`UI_STREAMING_TEST_FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
