#!/usr/bin/env node
// Functional UI tests for the hmCodex desktop shell.
//
// The tests drive the real Tauri window through the WebView2 DevTools
// protocol. They cover the user-visible interactions that the runtime unit
// tests cannot: navigation, panels, workspace browsing, file preview, the
// Phase 1 READ ONLY gate, thread switching, timeline pagination, governance
// refresh, cancel, and (with --task) a real model-backed task.
//
// Usage:
//   node scripts/ui-functional-test.mjs
//   node scripts/ui-functional-test.mjs --task
//   node scripts/ui-functional-test.mjs --inspect
//   node scripts/ui-functional-test.mjs --exe "C:\path\to\hmcodex-desktop.exe" --port 9333

import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startUiModelFixture } from './ui-local-model-fixture.mjs';

const DEFAULT_EXE = 'C:\\Program Files\\hmCodex\\hmcodex-desktop.exe';
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const exe = option('--exe', process.env.HMCODEX_UI_EXE ?? DEFAULT_EXE);
const port = Number(option('--port', process.env.HMCODEX_UI_PORT ?? '9333'));
const runTaskFlow = flag('--task') || process.env.HMCODEX_UI_TASK === '1';
const inspectOnly = flag('--inspect');
const closeWhenDone = flag('--close');
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = process.env.HMCODEX_UI_WORKSPACE_ROOT ?? resolve(scriptRoot, '..');

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${status.padEnd(5)} ${name}${suffix}`);
};
const pass = (name, detail) => record(name, 'PASS', detail);
const fail = (name, detail) => record(name, 'FAIL', detail);
const skip = (name, detail) => record(name, 'SKIP', detail);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const runTest = async (name, fn) => {
  try {
    const detail = await fn();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    if (error?.skip) skip(name, error.message);
    else fail(name, error instanceof Error ? error.message : String(error));
  }
};

const skipTest = (message) => {
  const error = new Error(message);
  error.skip = true;
  throw error;
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
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
    }
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

const fetchTargets = async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`CDP_HTTP_${response.status}`);
  return response.json();
};

const waitForTarget = async (timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchTargets();
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

const launchApp = (extraEnv = {}) => {
  spawnSync('taskkill', ['/IM', 'hmcodex-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...extraEnv,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      HMCODEX_RELEASE_CHANNEL: 'WINDOWS_PHASE1_READ_ONLY',
      HMCODEX_WORKSPACE_ROOT: extraEnv.HMCODEX_WORKSPACE_ROOT ?? workspaceRoot
    }
  });
  child.unref();
  return child.pid;
};

const waitFor = async (client, expression, { timeout = 15000, interval = 200, label = expression } = {}) => {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await client.evaluate(expression);
    if (lastValue) return lastValue;
    await delay(interval);
  }
  throw new Error(`WAIT_TIMEOUT: ${label}; last=${JSON.stringify(lastValue)}`);
};

const exists = (client, selector) =>
  client.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
const count = (client, selector) =>
  client.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const text = (client, selector) =>
  client.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '').trim()`);
const attr = (client, selector, name) =>
  client.evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const click = (client, selector) =>
  client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return 'NOT_FOUND';
    if (element.disabled) return 'DISABLED';
    element.click();
    return 'CLICKED';
  })()`);
const clickByDataset = (client, selector, datasetKey, value) =>
  client.evaluate(`(() => {
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((candidate) => candidate.dataset[${JSON.stringify(datasetKey)}] === ${JSON.stringify(value)});
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
const timelineHasError = (client, fragment) =>
  client.evaluate(`[...document.querySelectorAll('.timeline-item')]
    .some((item) => item.innerText.includes(${JSON.stringify(fragment)}))`);

const inspectDom = async (client) => {
  const summary = await client.evaluate(`JSON.stringify({
    title: document.title,
    appShell: Boolean(document.querySelector('.app-shell')),
    navigation: Boolean(document.querySelector('.navigation-rail')),
    workbench: Boolean(document.querySelector('.workbench')),
    contextPanel: Boolean(document.querySelector('.context-panel')),
    connection: document.querySelector('.connection-status')?.innerText.trim() ?? null,
    runStatus: document.querySelector('.run-status')?.innerText.trim() ?? null,
    modePill: document.querySelector('.mode-pill')?.innerText.trim() ?? null,
    modeDisabled: document.querySelector('.mode-pill')?.disabled ?? null,
    composer: Boolean(document.querySelector('textarea[name="prompt"]')),
    sendDisabled: document.querySelector('.send-button')?.disabled ?? null,
    cancelPresent: Boolean(document.querySelector('.composer-stop')),
    cancelDisabled: document.querySelector('.composer-stop')?.disabled ?? null,
    threadCount: document.querySelectorAll('.thread-row').length,
    timelineCount: document.querySelectorAll('.timeline-item').length,
    workspaceEntries: document.querySelectorAll('.workspace-entry').length,
    governanceGroups: document.querySelectorAll('.governance-group').length,
    timelineMore: Boolean(document.querySelector('.timeline-more')),
    workspacePath: document.querySelector('.workspace-path')?.innerText.trim() ?? null,
    bodyText: document.body.innerText.slice(0, 500)
  }, null, 2)`);
  console.log(summary);
};

const waitForReady = async (client) => {
  await waitFor(client, `document.querySelector('.connection-status')?.classList.contains('status-ready') === true`, {
    timeout: 45000,
    interval: 500,
    label: 'runtime ready'
  });
  // Runtime readiness is reported before startup recovery finishes loading
  // persisted state. Wait for the composer gate as well so the initial shell
  // assertion does not race the background recovery queries.
  await waitFor(client, `document.querySelector('textarea[name="prompt"]')?.disabled === false`, {
    timeout: 120000,
    interval: 500,
    label: 'composer ready'
  });
  // The full-local debug build is a valid native channel too. The previous
  // gate only accepted the phase-1.5 title, so it timed out after the runtime
  // was already ready and made the UI suite report a false startup failure.
  await runTest('T00 发布渠道标记', async () => {
    await waitFor(client, `document.querySelector('.mode-pill') && /WINDOWS_(?:MVP_PRE_PHASE1|PHASE1_READ_ONLY|PHASE1_5_CONTROLLED|FULL_LOCAL)/u.test(document.querySelector('.mode-pill').title)`, {
      timeout: 5000, interval: 500, label: 'release mode gate'
    });
  });
  await runTest('T00A 空会话不进入项目树', async () => {
    const emptyRows = await client.evaluate(`document.querySelectorAll('.project-thread-row .thread-meta').length
      ? [...document.querySelectorAll('.project-thread-row .thread-meta')].filter((row) => /0 次 Turn/u.test(row.innerText)).length
      : 0`);
    assert(emptyRows === 0, `empty thread rows: ${emptyRows}`);
    return '0-turn threads hidden';
  });
};

const isControlledChannel = async (client) => /WINDOWS_(?:PHASE1_5_CONTROLLED|FULL_LOCAL)/u.test(await attr(client, '.mode-pill', 'title') ?? '');

const suite = async (client) => {
  await waitForReady(client);

  await runTest('T01 初始渲染与只读门控', async () => {
    assert((await client.evaluate('document.title')) === 'hmCodex', 'title');
    assert(await exists(client, '.app-shell'), 'app-shell');
    assert(await exists(client, '.navigation-rail'), 'navigation-rail');
    assert(await exists(client, '.workbench'), 'workbench');
    assert(await exists(client, '.context-panel'), 'context-panel');
    assert((await text(client, '.connection-status')).length > 0, 'connection-status');
    assert(/等待任务|只读检查完成|任务未完成|任务已取消|历史会话/u.test(await text(client, '.run-status')), 'startup restores idle or saved terminal state');
    const controlled = await isControlledChannel(client);
    if (controlled) {
      assert((await attr(client, '.mode-pill', 'disabled')) === null, 'mode pill enabled');
    } else {
      assert((await text(client, '.mode-pill')).includes('只读模式'), 'mode pill 只读模式');
      assert((await attr(client, '.mode-pill', 'disabled')) !== null, 'mode pill disabled');
    }
    assert(await exists(client, 'textarea[name="prompt"]'), 'composer textarea');
    assert((await attr(client, 'textarea[name="prompt"]', 'disabled')) === null, 'composer enabled');
    assert(await exists(client, '.send-button'), 'send button');
    assert((await attr(client, '.send-button', 'disabled')) === null, 'send enabled');
    assert(await exists(client, '.composer-stop'), 'cancel button present');
    assert((await attr(client, '.composer-stop', 'disabled')) !== null, 'cancel disabled when idle');
    return 'title/connection/run-state/composer/mode/cancel';
  });

  await runTest('T01A 空闲刷新不重建右侧上下文面板', async () => {
    const captured = await client.evaluate(`(() => {
      const panel = document.querySelector('.context-panel');
      if (!panel) return false;
      window.__hmCodexContextPanelBefore = panel;
      return true;
    })()`);
    assert(captured, 'context panel');
    if (!(await exists(client, '[data-action="refresh-execution-state"]'))) skipTest('当前布局未挂载右侧上下文操作');
    assert((await click(client, '[data-action="refresh-execution-state"]')) === 'CLICKED', 'refresh execution state');
    await delay(700);
    assert(await client.evaluate('window.__hmCodexContextPanelBefore === document.querySelector(\'.context-panel\')'), 'context panel DOM identity changed');
    return 'context panel preserved';
  });

  await runTest('T01B 主导航移动到右侧', async () => {
    assert(await count(client, '.navigation-rail [data-action="navigate"][data-page]') === 0, 'left rail has no primary page buttons');
    assert(await count(client, '.context-page-nav [data-action="navigate"][data-page]') === 6, 'right navigation has six page buttons');
    assert(await exists(client, '.navigation-rail [data-region="thread-list"]'), 'project list remains on left');
    return 'primary navigation is on the right';
  });

  await runTest('T02 上下文面板开关', async () => {
    const before = (await attr(client, '.app-shell', 'class')).includes('context-open');
    assert((await click(client, '[data-action="toggle-context"]')) === 'CLICKED', 'toggle click');
    await waitFor(client, `document.querySelector('.app-shell')?.classList.contains('context-open') !== ${JSON.stringify(before)}`, { label: 'context panel opened' });
    const opened = await attr(client, '.app-shell', 'class');
    assert(opened.includes('context-open') !== before, 'context visibility toggled');
    assert((await click(client, '[data-action="toggle-context"]')) === 'CLICKED', 'toggle click again');
    await waitFor(client, `document.querySelector('.app-shell')?.classList.contains('context-open') === ${JSON.stringify(before)}`, { label: 'context panel closed' });
    if (!before) {
      assert(await client.evaluate(`getComputedStyle(document.querySelector('.context-page-nav')).display !== 'none'`), 'right navigation stays visible when context collapses');
      assert(await client.evaluate(`getComputedStyle(document.querySelector('.context-header')).display === 'none'`), 'task context content hidden after collapse');
    }
    return 'open/close';
  });

  await runTest('T03 工作区目录导航与三态变更证据', async () => {
    assert((await click(client, '[data-action="navigate"][data-page="workspace"]')) === 'CLICKED', 'workspace page navigation');
    await waitFor(client, `Boolean(document.querySelector('[data-diff-panel="workspace"]'))`, { label: 'workspace diff panel' });
    assert(await count(client, '[data-diff-state="proposed"]') === 1, 'proposed diff state');
    assert(await count(client, '[data-diff-state="executed"]') === 1, 'executed diff state');
    assert(await count(client, '[data-diff-state="verified"]') === 1, 'verified diff state');
    assert((await text(client, '[data-diff-panel="workspace"]')).includes('建议 / 执行 / 验证'), 'diff state legend');
    await waitFor(client, `(document.querySelector('.workspace-path')?.innerText.trim() ?? '').length > 0`, {
      timeout: 45000,
      interval: 300,
      label: 'workspace path'
    });
    const directory = await client.evaluate(`[...document.querySelectorAll('.workspace-entry[data-entry-kind="DIRECTORY"]')]
      .map((element) => element.dataset.entryPath)[0] ?? null`);
    if (!directory) skipTest('当前工作区没有可导航目录');
    const beforePath = await text(client, '.workspace-path');
    assert(/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(beforePath), `workspace path is not absolute: ${beforePath}`);
    const pathLayout = await client.evaluate(`(() => {
      const element = document.querySelector('.workspace-path');
      const style = element ? getComputedStyle(element) : null;
      return element && style ? { whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap } : null;
    })()`);
    assert(pathLayout?.whiteSpace !== 'nowrap' && pathLayout?.overflowWrap === 'anywhere', `workspace path cannot wrap: ${JSON.stringify(pathLayout)}`);
    assert((await clickByDataset(client, '.workspace-entry', 'entryPath', directory)) === 'CLICKED', 'directory click');
    await waitFor(client, `document.querySelector('.workspace-path')?.innerText.trim() !== ${JSON.stringify(beforePath)}`, { label: 'workspace path changed' });
    const afterPath = await text(client, '.workspace-path');
    assert(afterPath.includes(directory), `path contains ${directory}`);
    const up = await exists(client, '[data-action="workspace-up"]');
    if (up) {
      await click(client, '[data-action="workspace-up"]');
      await waitFor(client, `document.querySelector('.workspace-path')?.innerText.trim() === ${JSON.stringify(beforePath)}`, { label: 'workspace path restored' });
    }
    return `${beforePath} · entered ${directory}${up ? ' + returned' : ''}`;
  });

  await runTest('T04 文件只读预览', async () => {
    const file = await client.evaluate(`[...document.querySelectorAll('.workspace-entry[data-entry-kind="FILE"]')]
      .map((element) => element.dataset.entryPath)[0] ?? null`);
    if (!file) skipTest('当前目录没有可预览文件');
    assert((await clickByDataset(client, '.workspace-entry', 'entryPath', file)) === 'CLICKED', 'file click');
    await waitFor(client, `Boolean(document.querySelector('.file-preview'))`, { label: 'file preview' });
    const heading = await text(client, '.file-preview h3');
    const digest = await text(client, '.digest');
    assert(heading.includes(file), `preview heading ${heading}`);
    assert(/^sha256:[0-9a-f]{64}$/u.test(digest), 'preview digest');
    return `${file} · ${digest.slice(0, 18)}…`;
  });

  await runTest('T05 READ ONLY 模式不可切换', async () => {
    const before = await text(client, '.mode-pill');
    if (await isControlledChannel(client)) {
      assert((await attr(client, '.mode-pill', 'disabled')) === null, 'mode pill enabled');
      if (!before.includes('受控模式')) {
        assert((await click(client, '.mode-pill')) === 'CLICKED', 'enter CONTROLLED');
        await waitFor(client, `/受控模式/u.test(document.querySelector('.mode-pill').innerText)`, { label: 'controlled mode entered' });
      }
      assert((await click(client, '.mode-pill')) === 'CLICKED', 'toggle to READ ONLY');
      await waitFor(client, `/只读模式/u.test(document.querySelector('.mode-pill').innerText)`, { label: 'read-only mode reached' });
      assert((await click(client, '.mode-pill')) === 'CLICKED', 'toggle back to CONTROLLED');
      await waitFor(client, `/受控模式/u.test(document.querySelector('.mode-pill').innerText)`, { label: 'controlled mode restored' });
      return '受控模式 ⇄ 只读模式';
    }
    assert(before.includes('只读模式'), '只读模式 label');
    assert((await attr(client, '.mode-pill', 'disabled')) !== null, 'mode pill disabled');
    const clickResult = await click(client, '.mode-pill');
    assert(clickResult === 'DISABLED' || clickResult === 'NOT_FOUND', `mode pill click blocked (${clickResult})`);
    assert((await text(client, '.mode-pill')) === before, 'mode label unchanged');
    return '只读模式门控生效';
  });

  await runTest('T06 新建任务重置', async () => {
    assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'new task click');
    await waitFor(client, `Boolean(document.querySelector('.project-picker-backdrop'))`, { label: 'project picker visible' });
    assert((await client.evaluate(`(() => {
      const button = document.querySelector('[data-action="close-project-picker"]');
      const target = button?.querySelector('svg') ?? button;
      if (!target) return 'NOT_FOUND';
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'CLICKED';
    })()`)) === 'CLICKED', 'close project picker');
    await waitFor(client, `!document.querySelector('.project-picker-backdrop')`, { label: 'project picker closed by header button' });
    assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'reopen new task picker');
    await waitFor(client, `Boolean(document.querySelector('.project-picker-backdrop'))`, { label: 'project picker reopened' });
    const projectOption = await client.evaluate(`(() => {
      const options = [...document.querySelectorAll('[data-action="select-new-task-project"]')];
      return options.find((option) => option.dataset.projectId !== '__projectless__')?.dataset.projectId
        ?? options[0]?.dataset.projectId
        ?? null;
    })()`);
    assert(projectOption, 'project picker option');
    assert((await clickByDataset(client, '[data-action="select-new-task-project"]', 'projectId', projectOption)) === 'CLICKED', 'project selected');
    await waitFor(client, `!document.querySelector('.project-picker-backdrop')`, { label: 'project picker closed' });
    await waitFor(client, `document.querySelector('.run-status')?.innerText.trim().startsWith('等待任务')`, { label: 'idle after new task' });
    assert((await attr(client, '.composer-stop', 'disabled')) !== null, 'cancel disabled idle');
    assert((await attr(client, '.send-button', 'disabled')) === null, 'send enabled idle');
    const editableProject = await client.evaluate(`(() => {
      const button = document.querySelector('.project-edit-button');
      const project = button?.closest('.project-group')?.querySelector('.project-header-copy strong')?.innerText.trim() ?? null;
      return button && project ? { project } : null;
    })()`);
    assert(editableProject?.project, 'editable project');
    assert((await click(client, '.project-edit-button')) === 'CLICKED', 'edit project click');
    await waitFor(client, `Boolean(document.querySelector('.project-edit-card'))`, { label: 'project edit dialog' });
    assert(await exists(client, '[data-action="add-project-target"]'), 'add target control');
    const editName = `${editableProject.project}（测试）`;
    assert((await client.evaluate(`(() => { const input = document.querySelector('[data-role="project-edit-name"]'); if (!input) return 'NOT_FOUND'; input.value = ${JSON.stringify(editName)}; input.dispatchEvent(new Event('input', { bubbles: true })); return 'SET'; })()`)) === 'SET', 'edit project name');
    assert((await click(client, '[data-action="save-project-edit"]')) === 'CLICKED', 'save project edit');
    await waitFor(client, `!document.querySelector('.project-edit-card')`, { label: 'project edit closed' });
    assert((await client.evaluate(`document.body.innerText.includes(${JSON.stringify(editName)})`)), 'edited project name visible');
    assert((await click(client, '.project-edit-button')) === 'CLICKED', 'reopen project edit');
    await waitFor(client, `Boolean(document.querySelector('.project-edit-card'))`, { label: 'project edit reopen' });
    await client.evaluate(`(() => { const input = document.querySelector('[data-role="project-edit-name"]'); input.value = ${JSON.stringify(editableProject.project)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click(client, '[data-action="save-project-edit"]');
    await waitFor(client, `!document.querySelector('.project-edit-card')`, { label: 'project edit restore' });
    assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'projectless new task click');
    await waitFor(client, `Boolean(document.querySelector('.project-picker-backdrop'))`, { label: 'projectless picker visible' });
    assert((await clickByDataset(client, '[data-action="select-new-task-project"]', 'projectId', '__projectless__')) === 'CLICKED', 'projectless selected');
    await waitFor(client, `!document.querySelector('.project-picker-backdrop')`, { label: 'projectless picker closed' });
    const projectlessLabel = await text(client, '.workspace-identity strong');
    assert(projectlessLabel === '未绑定项目', `projectless workspace label: ${projectlessLabel}`);
    return 'idle/composer reset';
  });

  await runTest('T07 线程选择与时间线恢复', async () => {
    const threads = await count(client, '.thread-row');
    if (threads === 0) skipTest('当前没有已保存线程');
    const first = await client.evaluate(`(() => {
      const row = [...document.querySelectorAll('.thread-row')].find((candidate) => !candidate.innerText.includes('0 次 Turn'));
      return row ? { id: row.dataset.threadId, title: row.querySelector('.thread-title')?.innerText.trim() ?? '' } : null;
    })()`);
    assert(first?.id, 'first thread id');
    assert((await clickByDataset(client, '.thread-row', 'threadId', first.id)) === 'CLICKED', 'thread click');
    await waitFor(client, `document.querySelector('.thread-row.active')?.dataset.threadId === ${JSON.stringify(first.id)}`, { label: 'thread active' });
    await waitFor(client, `document.querySelectorAll('.timeline-item').length > 0`, { label: 'thread timeline' });
    await waitFor(client, `document.querySelector('[data-region="conversation"]')?.getAttribute('aria-busy') === 'false'`, { label: 'history load settled' });
    assert(await exists(client, 'textarea[name="prompt"]'), 'composer after history load');
    assert((await attr(client, 'textarea[name="prompt"]', 'disabled')) === null, 'composer enabled after history load');
    assert(await exists(client, '.run-status'), 'run status after history load');
    assert((await text(client, '.run-status')).startsWith('等待任务') || /任务未完成|只读检查完成|任务已取消|已验证完成|历史会话/u.test(await text(client, '.run-status')), 'run status after history load');
    const historyText = await text(client, 'body');
    for (const hiddenKind of ['RecoveryStarted', 'RecoveryCompleted', 'DiagnosisRequested', 'DreamRunReconciled']) {
      assert(!historyText.includes(hiddenKind), `internal history event hidden: ${hiddenKind}`);
    }
    return `${first.title || first.id} · ${await count(client, '.timeline-item')} timeline items`;
  });

  await runTest('T08 会话不加载全局审计分页', async () => {
    assert(!(await exists(client, '.timeline-more')), 'global audit pagination hidden from transcript');
    assert(!(await exists(client, '[data-action="load-more-timeline"]')), 'global timeline action absent');
    return `${await count(client, '.timeline-item')} thread timeline items`;
  });

  await runTest('T09 治理面板刷新', async () => {
    assert((await click(client, '[data-action="refresh-governance"]')) === 'CLICKED', 'refresh governance click');
    await waitFor(client, `document.querySelectorAll('.governance-group, .governance-row').length > 0`, { timeout: 20000, label: 'governance rendered' });
    assert(!(await timelineHasError(client, '治理状态')), 'no governance refresh error');
    return `${await count(client, '.governance-group')} governance groups`;
  });

  await runTest('T10 执行状态刷新', async () => {
    assert((await click(client, '[data-action="refresh-execution-state"]')) === 'CLICKED', 'refresh execution click');
    await delay(1500);
    assert(!(await timelineHasError(client, '执行状态')), 'no execution refresh error');
    return 'refresh accepted';
  });

  await runTest('T11 无界面渲染错误', async () => {
    const body = await text(client, 'body');
    assert(!body.includes('界面渲染出错'), 'no render error banner');
    return 'no render error';
  });

  for (const page of ['runs', 'workspace', 'memory', 'safety', 'diagnostics', 'workbench']) {
    await runTest(`NAV ${page}`, async () => {
      assert((await clickByDataset(client, '.nav-list [data-page]', 'page', page)) === 'CLICKED', 'navigation click');
      await waitFor(client, `document.querySelector('.nav-list [data-page="${page}"]')?.classList.contains('active')`, { label: `${page} active` });
      assert((await text(client, '.transcript')).length > 0, 'page content visible');
      assert(!(await text(client, 'body')).includes('界面渲染出错'), 'no render error');
      return 'active navigation and visible content';
    });
  }

  if (runTaskFlow) {
    await runTest('T13 真实任务终态与时间线渲染', async () => {
      assert((await click(client, '[data-action="new-task"]')) === 'CLICKED', 'new task click');
      await waitFor(client, `document.querySelector('.send-button')?.disabled === false`, { timeout: 10000, label: 'new task ready to submit' });
      assert((await setComposer(client, 'hello')) === 'SET', 'set composer');
      assert((await submitComposer(client)) === 'SUBMITTED', 'submit composer');
      await waitFor(client, `document.querySelector('.composer-stop')?.disabled === false`, { timeout: 30000, label: 'new task actually started' });
      await waitFor(client, `/只读检查完成|任务未完成|任务已取消/.test(document.querySelector('.run-status')?.innerText ?? '')`, { timeout: 180000, interval: 500, label: 'task terminal state' });
      const terminal = await text(client, '.run-status');
      assert((await count(client, '.timeline-item')) > 0, 'timeline items after terminal state');
      await waitFor(client, `document.querySelectorAll('.thread-row').length > 0`, { timeout: 60000, label: 'thread persisted after terminal state' });
      const hasErrorOrOutput = await client.evaluate(`[...document.querySelectorAll('.timeline-item')].some((item) => item.innerText.length > 80 || /run\\.failed|PLAN_STEP_FAILED|错误|失败/u.test(item.innerText))`);
      assert(hasErrorOrOutput, 'timeline renders model output or terminal error');
      return `${terminal} · ${await count(client, '.timeline-item')} timeline items · ${await count(client, '.thread-row')} threads`;
    });
    await runTest('T12 真实任务取消流程', async () => {
      await waitFor(client, `document.querySelector('.send-button')?.disabled === false`, { timeout: 180000, label: 'previous task reader released' });
      assert((await setComposer(client, 'hello')) === 'SET', 'set composer');
      assert((await submitComposer(client)) === 'SUBMITTED', 'submit composer');
      await waitFor(client, `document.querySelector('.composer-stop') && !document.querySelector('.composer-stop').disabled`, { timeout: 30000, label: 'cancel enabled while running' });
      assert((await attr(client, '.send-button', 'disabled')) !== null, 'send disabled while running');
      assert((await click(client, '.composer-stop')) === 'CLICKED', 'cancel click');
      await waitFor(client, `document.querySelector('.run-status')?.innerText.includes('任务已取消')`, { timeout: 30000, label: 'cancelled state' });
      assert((await attr(client, '.composer-stop', 'disabled')) !== null, 'cancel disabled after cancellation');
      await waitFor(client, `document.querySelector('.send-button')?.disabled === false`, { timeout: 10000, label: 'send enabled after cancellation' });
      return 'running -> cancelled -> idle';
    });

  } else {
    skip('T12 真实任务取消流程', '使用 --task 运行真实模型任务流程');
    skip('T13 真实任务终态与时间线渲染', '使用 --task 运行真实模型任务流程');
  }
};

const main = async () => {
  const fixture = runTaskFlow ? await startUiModelFixture({ delayMs: 80 }) : undefined;
  const pid = launchApp(fixture ? {
    ...fixture.env,
    HMCODEX_MODEL_CONFIG: fixture.modelConfigPath,
    HMCODEX_UI_MODEL_FIXTURE_KEY: 'fixture-key',
    HMCODEX_WORKSPACE_ROOT: fixture.workspaceRoot
  } : {});
  console.log(`hmCodex UI functional tests · exe=${exe} · port=${port} · pid=${pid}`);
  let client;
  try {
    client = await connect();
    if (inspectOnly) {
      await inspectDom(client);
      return;
    }
    await suite(client);
  } finally {
    client?.close();
    if (closeWhenDone) {
      spawnSync('taskkill', ['/IM', 'hmcodex-desktop.exe', '/F'], { stdio: 'ignore', windowsHide: true });
    }
    await fixture?.close();
  }
  const passed = results.filter((item) => item.status === 'PASS').length;
  const failed = results.filter((item) => item.status === 'FAIL').length;
  const skipped = results.filter((item) => item.status === 'SKIP').length;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`UI_TEST_FATAL: ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
