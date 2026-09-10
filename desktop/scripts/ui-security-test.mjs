#!/usr/bin/env node
// Controlled-channel UI security acceptance. The suite launches a real Tauri
// executable and uses a local OpenAI-compatible fixture so approval, denial,
// timeout, verifier evidence and recovery paths are deterministic.

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

const DEFAULT_EXE = 'C:\\Program Files\\hmCodex\\hmcodex-desktop.exe';
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const exe = option('--exe', process.env.HMCODEX_UI_EXE ?? DEFAULT_EXE);
const port = Number(option('--port', process.env.HMCODEX_UI_PORT ?? '9335'));
const closeWhenDone = !argv.includes('--keep-open');
const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  console.log(`${status.padEnd(5)} ${name}${detail ? ` — ${detail}` : ''}`);
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
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
        this.pending.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* best effort */ } }
}

const waitForTarget = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
      const targets = await response.json();
      const page = targets.find((item) => item.type === 'page' && /tauri\.localhost|localhost/i.test(item.url));
      if (page) return page;
    } catch (error) { lastError = error; }
    await delay(250);
  }
  throw new Error(`UI_TARGET_TIMEOUT: ${lastError instanceof Error ? lastError.message : 'unknown'}`);
};

const connect = async () => {
  const page = await waitForTarget();
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('UI_WEBSOCKET_OPEN_FAILED')); });
  return new CdpClient(ws);
};

const waitFor = async (client, expression, { timeout = 30000, interval = 250, label = expression } = {}) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await client.evaluate(expression);
    if (lastValue) return lastValue;
    await delay(interval);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}; last=${JSON.stringify(lastValue)}`);
};
const waitForFile = async (path, { timeout = 30000, interval = 250, label = path } = {}) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await delay(interval);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}`);
};
const text = (client, selector) => client.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').trim()`);
const bodyText = (client) => client.evaluate('document.body.innerText');
const exists = (client, selector) => client.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const click = (client, selector) => client.evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return 'NOT_FOUND';
  if (element.disabled) return 'DISABLED';
  element.click();
  return 'CLICKED';
})()`);
const clickApproval = (client, approved) => client.evaluate(`(() => {
  const element = document.querySelector('[data-action="resolve-approval"][data-approved="${approved ? 'true' : 'false'}"]');
  if (!element) return 'NOT_FOUND';
  if (element.disabled) return 'DISABLED';
  element.click();
  return 'CLICKED';
})()`);
const approveAll = async (client) => {
  while ((await clickApproval(client, true)) === 'CLICKED') await delay(1000);
};
const setComposer = (client, value) => client.evaluate(`(() => {
  const textarea = document.querySelector('textarea[name="prompt"]');
  if (!textarea) return 'NOT_FOUND';
  textarea.value = ${JSON.stringify(value)};
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  return 'SET';
})()`);
const submitComposer = (client) => client.evaluate(`(() => {
  const form = document.querySelector('form[data-form="composer"]');
  if (!form) return 'NOT_FOUND';
  form.requestSubmit();
  return 'SUBMITTED';
})()`);
const timelineHas = async (client, fragment) => client.evaluate(`[...document.querySelectorAll('.timeline-item')].some((item) => item.innerText.includes(${JSON.stringify(fragment)}))`);

const sse = (response, events) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
};
const textResponse = (response, content) => sse(response, [
  { choices: [{ delta: { content }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }] }
]);
const toolResponse = (response, call) => sse(response, [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }, finish_reason: null }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
]);

const startMockProvider = () => {
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const model = payload.model;
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (process.env.HMCODEX_UI_SECURITY_DEBUG === '1') {
        console.log(`DEBUG model=${model} tools=${Array.isArray(payload.tools) ? payload.tools.length : 0} messages=${messages.length}`);
      }
      if (model === 'planner-fixture' && Array.isArray(payload.tools) && payload.tools.length > 0 && messages.length <= 2) {
        const prompt = messages.at(-1)?.content ?? '';
        const call = prompt.includes('TIMEOUT_SECURITY_PROBE')
          ? { id: `call-timeout-${randomUUID()}`, name: 'shell.execute', arguments: { command: 'node', args: ['-e', 'setTimeout(() => console.log("late"), 10000); console.log("started")'], timeoutMs: 1000 } }
          : { id: `call-write-${randomUUID()}`, name: 'file.write', arguments: { path: prompt.includes('DENY_SECURITY_PROBE') ? 'denied-by-ui.txt' : 'approved-by-ui.txt', content: 'controlled-ui-ok' } };
        toolResponse(response, call);
        return;
      }
      if (model === 'planner-fixture') {
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
          textResponse(response, 'Fixture-controlled action complete.');
          return;
        }
        const prompt = messages.map((message) => message?.content ?? '').join(' ');
        textResponse(response, JSON.stringify({
          planId: 'security-ui-plan',
          steps: [{
            stepId: 'controlled-step',
            summary: prompt,
            actionKind: prompt.includes('TIMEOUT_SECURITY_PROBE') ? 'SHELL_EXECUTE' : 'WRITE_FILE',
            dependencies: []
          }],
          assumptions: ['Fixture-controlled action'],
          acceptanceCriteria: ['Action reaches the expected terminal state']
        }));
        return;
      }
      if (model === 'verifier-fixture') {
        textResponse(response, JSON.stringify({ status: 'PASS', summary: 'Evidence-backed controlled execution', progress: 1, evidenceRefs: ['security-ui-fixture'], failureCodes: [] }));
        return;
      }
      textResponse(response, 'fixture ready');
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
};

const makeModelConfig = (server, endpointOverride) => {
  const endpoint = endpointOverride ?? `http://127.0.0.1:${server.address().port}/chat/completions`;
  return {
    schemaVersion: '1.0',
    provider: 'compatible',
    protocol: 'chat-completions',
    model: 'planner-fixture',
    endpoint,
    apiKeyEnv: 'HMCODEX_SECURITY_UI_API_KEY',
    models: [
      { modelId: 'executor-fixture', provider: 'compatible', protocol: 'chat-completions', model: 'executor-fixture', endpoint, apiKeyEnv: 'HMCODEX_SECURITY_UI_API_KEY', roles: ['executor'], capabilities: ['model.invoke.stream', 'tool.calls'] },
      { modelId: 'verifier-fixture', provider: 'openai-chat', protocol: 'chat-completions', model: 'verifier-fixture', endpoint, apiKeyEnv: 'HMCODEX_SECURITY_UI_API_KEY', roles: ['semanticVerifier'], capabilities: ['model.invoke.stream'] }
    ],
    roleBindings: { semanticVerifier: 'verifier-fixture' }
  };
};

const terminate = () => {
  spawnSync('taskkill', ['/IM', 'hmcodex-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
};

const launch = (modelConfigPath, modelRegistryPath, dataDir) => {
  terminate();
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      HMCODEX_MODEL_CONFIG: modelConfigPath,
      HMCODEX_MODEL_REGISTRY: modelRegistryPath,
      HMCODEX_DATA_DIR: dataDir,
      HMCODEX_SECURITY_UI_API_KEY: 'fixture-key',
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED'
    }
  });
  child.unref();
  return child.pid;
};

const debug = (message) => { if (process.env.HMCODEX_UI_SECURITY_DEBUG === '1') console.log(`DEBUG ${message}`); };

const ready = async (client) => {
  await waitFor(client, `document.querySelector('.connection-status')?.classList.contains('status-ready')`, { timeout: 45000, label: 'runtime ready' });
  await waitFor(client, `document.querySelector('.mode-pill')?.getAttribute('disabled') === null`, { timeout: 45000, label: 'controlled mode enabled' });
};

const setWorkspace = async (client, root) => {
  await client.evaluate(`(async () => {
    await window.__TAURI__.core.invoke('set_workspace', { path: ${JSON.stringify(root)} });
    return true;
  })()`);
  await delay(500);
};

const setControlledMode = async (client) => {
  await ready(client);
  if (await client.evaluate(`document.querySelector('.mode-pill')?.innerText.includes('CONTROLLED')`)) return;
  assert((await click(client, '.mode-pill')) === 'CLICKED', 'switch to controlled mode');
  await waitFor(client, `document.querySelector('.mode-pill')?.innerText.includes('CONTROLLED')`, { label: 'controlled mode selected' });
};

const runTask = async (client, prompt) => {
  assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'new task');
  await waitFor(client, `document.querySelector('.send-button') && !document.querySelector('.send-button').disabled`, { timeout: 30000, label: 'composer ready' });
  await delay(3000);
  assert((await setComposer(client, prompt)) === 'SET', 'set prompt');
  assert((await submitComposer(client)) === 'SUBMITTED', 'submit task');
};

const terminal = (client, timeout = 120000) => waitFor(client, `/只读检查完成|任务未完成|任务已取消/.test(document.querySelector('.run-status')?.innerText ?? '')`, { timeout, interval: 300, label: 'task terminal state' });

const main = async () => {
  console.log(`hmCodex controlled UI security tests · exe=${exe} · port=${port}`);
  const server = await startMockProvider();
  const workspace = await mkdtemp(join(tmpdir(), 'hmcodex-ui-security-'));
  const normalConfigPath = join(workspace, 'model-config.json');
  const badConfigPath = join(workspace, 'model-config-disconnected.json');
  await writeFile(normalConfigPath, JSON.stringify(makeModelConfig(server)));
  await writeFile(badConfigPath, JSON.stringify(makeModelConfig(server, 'http://127.0.0.1:9/hmCodex/disconnected')));
  let client;
  try {
    launch(normalConfigPath, join(workspace, 'model-registry.json'), workspace);
      client = await connect();
      await ready(client);
      await setWorkspace(client, workspace);
    await runTest('S01 受控门与模式区分', async () => {
      await setControlledMode(client);
      const mode = await text(client, '.mode-pill');
      const note = await text(client, '.composer-note');
      assert(mode.includes('CONTROLLED'), `mode=${mode}`);
      assert(note.includes('受控模式'), `note=${note}`);
      return mode;
    });
    await runTest('S02 网络目标编辑器拒绝非法 JSON', async () => {
      assert((await client.evaluate(`(() => {
        const input = document.querySelector('[data-role="network-targets"]');
        if (!input) return 'NOT_FOUND';
        input.value = '{bad-json';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'SET';
      })()`)) === 'SET', 'set invalid network JSON');
      const error = await text(client, '.network-target-error');
      assert(error.includes('JSON'), `error=${error}`);
      await client.evaluate(`(() => {
        const input = document.querySelector('[data-role="network-targets"]');
        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      return error.slice(0, 120);
    });
    await runTest('S03 审批拒绝后无副作用', async () => {
      await setControlledMode(client);
      await runTask(client, 'DENY_SECURITY_PROBE write denied-by-ui.txt');
      await waitFor(client, `Boolean(document.querySelector('.approval-card'))`, { timeout: 90000, label: 'approval card' });
      assert((await clickApproval(client, false)) === 'CLICKED', 'deny approval');
      await terminal(client, 120000);
      await waitFor(client, `!Boolean(document.querySelector('.approval-card'))`, { label: 'approval resolved' });
      assert(!existsSync(join(workspace, 'denied-by-ui.txt')), 'denied file absent');
      return 'approval declined; no write';
    });
    await runTest('S04 审批批准执行一次并显示 Verifier', async () => {
      client.close();
      launch(normalConfigPath, join(workspace, 'model-registry.json'), workspace);
      client = await connect();
      await setControlledMode(client);
      await setWorkspace(client, workspace);
      await runTask(client, 'APPROVE_SECURITY_PROBE write approved-by-ui.txt');
      await waitFor(client, `Boolean(document.querySelector('.approval-card'))`, { timeout: 90000, label: 'approval card' });
      assert((await clickApproval(client, true)) === 'CLICKED', 'approve approval');
      await approveAll(client);
      await waitForFile(join(workspace, 'approved-by-ui.txt'), { timeout: 60000, label: 'approved file' });
      await waitFor(client, `document.querySelector('.timeline')?.innerText.includes('PolicyLease 已消费')`, { timeout: 30000, label: 'lease consumed' });
      await approveAll(client);
      await waitFor(client, `document.querySelector('.timeline')?.innerText.includes('语义 Verifier 证据') && document.querySelector('.timeline')?.innerText.includes('verifier-fixture')`, { timeout: 180000, label: 'verifier evidence' });
      if (await client.evaluate(`Boolean(document.querySelector('.composer-stop') && !document.querySelector('.composer-stop').disabled)`)) {
        assert((await click(client, '.composer-stop')) === 'CLICKED', 'cancel lingering run');
      }
      await terminal(client, 60000);
      const content = await readFile(join(workspace, 'approved-by-ui.txt'), 'utf8');
      assert(content === 'controlled-ui-ok', 'approved file content');
      assert(await timelineHas(client, '语义 Verifier 证据'), 'semantic verifier evidence visible');
      assert(await timelineHas(client, 'verifier-fixture'), 'independent verifier identity visible');
      return 'approved write; verifier PASS';
    });
    await runTest('S05 副作用超时进入失败终态', async () => {
      client.close();
      launch(normalConfigPath, join(workspace, 'model-registry.json'), workspace);
      client = await connect();
      await setControlledMode(client);
      await setWorkspace(client, workspace);
      await runTask(client, 'TIMEOUT_SECURITY_PROBE run a sleeping command');
      await waitFor(client, `Boolean(document.querySelector('.approval-card'))`, { timeout: 90000, label: 'approval card' });
      assert((await clickApproval(client, true)) === 'CLICKED', 'approve timed action');
      await approveAll(client);
      await waitFor(client, `document.querySelector('.timeline')?.innerText.includes('ACTION_FAILED') || document.querySelector('.timeline')?.innerText.includes('失败')`, { timeout: 60000, label: 'timeout failure evidence' });
      assert((await click(client, '.composer-stop')) === 'CLICKED', 'cancel lingering timeout run');
      await terminal(client, 60000);
      assert(await timelineHas(client, '任务未完成') || await timelineHas(client, 'ACTION_FAILED') || await timelineHas(client, '失败'), 'timeout failure visible');
      return 'timeout reached terminal failure';
    });
    await runTest('S06 断线显示失败并可恢复', async () => {
      terminate();
      launch(badConfigPath, join(workspace, 'model-registry.json'), workspace);
      client.close();
      client = await connect();
      await setControlledMode(client);
      await runTask(client, 'DISCONNECT_SECURITY_PROBE');
      await waitFor(client, `document.querySelector('.timeline')?.innerText.includes('Cordis runtime') || document.body.innerText.includes('MODEL_HTTP_ERROR')`, { timeout: 180000, label: 'disconnect failure evidence' });
      await terminal(client, 30000);
      assert(await timelineHas(client, 'Cordis runtime') || await bodyText(client).then((value) => value.includes('MODEL_HTTP_ERROR')), 'disconnect visible');
      terminate();
      launch(normalConfigPath, join(workspace, 'model-registry.json'), workspace);
      client.close();
      client = await connect();
      await setControlledMode(client);
      assert((await click(client, '[data-action="refresh-execution-state"]')) === 'CLICKED', 'refresh execution state');
      await delay(1000);
      assert(!(await timelineHas(client, '执行状态')), 'execution recovery has no refresh error');
      return 'disconnect failed safely; restart recovered';
    });
  } finally {
    client?.close();
    if (closeWhenDone) terminate();
    server.close();
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, 0 skipped`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`UI_SECURITY_TEST_FATAL: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
