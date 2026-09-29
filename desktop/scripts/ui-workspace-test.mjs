import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep));
    response.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, channel: process.env.HMCODEX_BROWSER_CHANNEL });
const errors = [];

async function fixture({ deferRuntime = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ deferRuntime }) => {
    const threads = [{ id: 'saved-a', title: 'Saved A', cwd: 'C:\\projects\\A', turnCount: 1,
      resumable: true, state: 'PAUSED', createdAtMs: 1, updatedAtMs: 2 }];
    localStorage.setItem('hmcodex.nav', JSON.stringify({ threadId: 'saved-a', page: 'workbench' }));
    const waits = new Map();
    const state = window.__workspaceTest = {
      calls: [], waits, root: 'C:\\projects\\A', selectedRoot: 'C:\\projects\\B', cancel: false,
      failList: false, deferPick: false, deferTask: false, deferRead: false,
      release(name) { assertGate(name)(); waits.delete(name); }
    };
    const assertGate = (name) => {
      const finish = waits.get(name);
      if (!finish) throw Error(`Missing gate: ${name}`);
      return finish;
    };
    const gate = (name) => new Promise((finish) => waits.set(name, finish));
    let callbackId = 0;
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return ++callbackId; },
      async invoke(command, args = {}) {
        state.calls.push({ command, args, workspace: state.root });
        if (command.startsWith('plugin:event|')) return ++callbackId;
        if (command === 'runtime_snapshot' && deferRuntime) await gate('runtime');
        if (command === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'fixture', runtimeReady: true,
          readOnly: true, workspaceRead: true, commandExecution: false, networkSideEffects: false,
          releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
        if (command === 'reconcile_runtime_state') return { ok: true, reconciled: 0 };
        if (command === 'default_workspace') return { rootLabel: 'A', rootPath: state.root };
        if (command === 'choose_workspace') {
          if (state.deferPick) await gate('pick');
          if (state.cancel) throw Error('cancelled');
          state.root = state.selectedRoot;
          return { rootLabel: state.root.split(/[/\\]/).filter(Boolean).at(-1), rootPath: state.root };
        }
        if (command === 'set_workspace') {
          state.root = args.path;
          return { rootLabel: state.root.split(/[/\\]/).filter(Boolean).at(-1), rootPath: state.root };
        }
        if (command === 'list_workspace') {
          if (state.failList) throw Error('LIST_DENIED');
          return [{ name: 'README.md', relativePath: 'README.md', kind: 'FILE', sizeBytes: 12 }];
        }
        if (command === 'read_workspace_file') {
          if (state.deferRead) await gate('read');
          return { relativePath: args.relativePath, content: 'STALE_WORKSPACE_FILE', contentDigest: 'sha256:file',
            totalBytes: 20, truncated: false, binary: false };
        }
        if (command === 'list_thread_events') return { threadId: args.threadId,
          thread: threads.find((thread) => thread.id === args.threadId), events: [], limit: args.limit, hasMore: false };
        if (command === 'runtime_dashboard') return { ok: true, summaryOnly: !args.details,
          threads, execution: { records: [] }, feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [],
          evolution: { proposals: [], reports: [], control: { enabled: true, changedAtMs: 0 } } };
        if (command === 'list_execution_state') return { records: [] };
        if (command === 'list_memories') return { memories: [] };
        if (command === 'list_dream_runs') return { runs: [] };
        if (command === 'list_plugin_governance') return { plugins: [] };
        if (command === 'list_evolution') return { proposals: [], reports: [] };
        if (command === 'dream_maintenance_status') return undefined;
        if (command === 'run_model_task') {
          if (state.deferTask) await gate('task');
          const existing = threads.find((thread) => thread.id === args.threadId);
          if (existing && existing.cwd.toLowerCase() !== state.root.toLowerCase()) {
            return { ok: false, error: 'THREAD_WORKSPACE_MISMATCH', plugins: [] };
          }
          const thread = existing ?? { id: `new-${threads.length}`, title: args.prompt, cwd: state.root,
            turnCount: 0, createdAtMs: Date.now(), updatedAtMs: Date.now() };
          if (!existing) threads.push(thread);
          thread.turnCount++;
          thread.resumable = false;
          thread.state = 'COMPLETED';
          return { ok: true, runId: `runtime-${state.calls.length}`, threadId: thread.id, thread,
            text: 'ok', reasoningChars: 0, plugins: [], workspace: { entryCount: 1 } };
        }
        throw Error(`Unexpected native call: ${command}`);
      }
    };
  }, { deferRuntime });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A'
    && !document.querySelector('textarea[name="prompt"]')?.disabled);
  return page;
}

const choose = (page) => page.locator('[data-action="open-workspace"]').first().click();
const calls = (page, command) => page.evaluate((command) => window.__workspaceTest.calls.filter((call) => call.command === command), command);
const submit = async (page, prompt = 'workspace task') => {
  const count = (await calls(page, 'run_model_task')).length;
  await page.locator('textarea[name="prompt"]').fill(prompt);
  await page.locator('.composer .send-button').click();
  await page.waitForFunction((count) => window.__workspaceTest.calls.filter((call) => call.command === 'run_model_task').length > count, count);
};
const dismissProjectPicker = async (page) => {
  const picker = page.locator('.project-picker-card');
  if (await picker.count()) await picker.locator('.project-picker-none').click();
};
const finished = (page) => page.waitForFunction(() => !document.querySelector('textarea[name="prompt"]')?.disabled
  && !document.querySelector('[data-action="open-workspace"]')?.disabled);

try {
  const draft = await fixture({ deferRuntime: true });
  await draft.locator('[data-action="new-task"]').click();
  await dismissProjectPicker(draft);
  const composer = draft.locator('textarea[name="prompt"]');
  await composer.click();
  await draft.keyboard.type('draft before hydration');
  await composer.evaluate((field) => {
    field.setSelectionRange(6, 12, 'backward');
  });
  await draft.evaluate(() => window.__workspaceTest.release('runtime'));
  await draft.waitForFunction(() => window.__workspaceTest.calls.some((call) => call.command === 'reconcile_runtime_state'));
  await draft.evaluate(async () => {
    for (let frame = 0; frame < 10; frame++) await new Promise(requestAnimationFrame);
  });
  assert.equal(await composer.evaluate((field) => field === document.activeElement), true, 'new-task composer retains focus after runtime hydration');
  assert.deepEqual(await composer.evaluate((field) => [field.selectionStart, field.selectionEnd, field.selectionDirection]), [6, 12, 'backward']);
  await draft.keyboard.type('after');
  assert.equal(await composer.inputValue(), 'draft after hydration');
  await draft.close();
  console.log('PASS new-task typing and selection survive delayed native hydration');

  const page = await fixture();
  await choose(page);
  await finished(page);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hmcodex.nav')).threadId), null);
  assert.equal(await page.locator('[data-history-items]').count(), 0);
  assert.equal(await page.locator('[data-thread-id="saved-a"]').count(), 1);
  await submit(page);
  await finished(page);
  const first = (await calls(page, 'run_model_task'))[0];
  assert.equal(first.workspace, 'C:\\projects\\B');
  assert.equal(first.args.threadId, undefined);
  assert.equal(first.args.resume, undefined);
  await submit(page, 'continue B');
  await finished(page);
  assert.equal((await calls(page, 'run_model_task'))[1].args.threadId, 'new-1');
  console.log('PASS switched root starts a fresh thread; following turn continues it');

  await page.locator('[data-thread-id="saved-a"]').click();
  const historyPicker = page.locator('.project-picker-card');
  if (await historyPicker.count()) {
    await historyPicker.waitFor();
    assert.match(await historyPicker.innerText(), /先切换到会话所属目录/);
    await historyPicker.locator('[data-action="select-new-task-project"]').filter({ hasText: 'C:\\projects\\A' }).click();
  }
  await page.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A'
    && !document.querySelector('[data-history-status]')?.textContent.includes('正在加载历史会话'));
  await submit(page, 'cross-workspace history');
  await finished(page);
  assert.equal((await calls(page, 'run_model_task')).at(-1).args.threadId, 'saved-a');
  assert.equal(await page.locator('body').innerText().then((text) => text.includes('THREAD_WORKSPACE_MISMATCH')), false);
  await page.close();
  console.log('PASS historical thread switches to its project before continuing');

  for (const cancel of [true, false]) {
    const same = await fixture();
    await same.evaluate((cancel) => { window.__workspaceTest.cancel = cancel; window.__workspaceTest.selectedRoot = 'C:\\projects\\A'; }, cancel);
    await choose(same);
    await finished(same);
    await submit(same);
    await finished(same);
    const submitted = (await calls(same, 'run_model_task'))[0];
    assert.equal(submitted.args.threadId, 'saved-a');
    assert.equal(submitted.args.resume, true);
    await same.close();
  }
  console.log('PASS cancel and same-directory selection retain the active thread/checkpoint');

  const failure = await fixture();
  await failure.evaluate(() => { window.__workspaceTest.failList = true; });
  await choose(failure);
  await finished(failure);
  assert.equal(await failure.evaluate(() => JSON.parse(localStorage.getItem('hmcodex.nav')).threadId), null);
  await submit(failure);
  await finished(failure);
  assert.equal((await calls(failure, 'run_model_task'))[0].workspace, 'C:\\projects\\B');
  assert.equal((await calls(failure, 'run_model_task'))[0].args.threadId, undefined);
  await failure.close();
  console.log('PASS directory-list failure still synchronizes native root and thread binding');

  const busy = await fixture();
  await busy.evaluate(() => { window.__workspaceTest.deferPick = true; });
  await choose(busy);
  await busy.waitForFunction(() => window.__workspaceTest.waits.has('pick'));
  assert.equal(await busy.locator('.composer .send-button').isDisabled(), true);
  assert.equal(await busy.locator('[data-action="open-workspace"]').first().isDisabled(), true);
  await busy.evaluate(() => {
    document.querySelector('[data-action="open-workspace"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const form = document.querySelector('[data-form="composer"]');
    form.querySelector('textarea').value = 'must not submit while choosing';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  assert.equal((await calls(busy, 'choose_workspace')).length, 1);
  assert.equal((await calls(busy, 'run_model_task')).length, 0);
  await busy.evaluate(() => window.__workspaceTest.release('pick'));
  await finished(busy);
  await busy.evaluate(() => { window.__workspaceTest.deferTask = true; });
  await submit(busy);
  await busy.waitForFunction(() => window.__workspaceTest.waits.has('task'));
  assert.equal(await busy.locator('[data-action="open-workspace"]').first().isDisabled(), true);
  await busy.evaluate(() => document.querySelector('[data-action="open-workspace"]').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  assert.equal((await calls(busy, 'choose_workspace')).length, 1);
  await busy.evaluate(() => window.__workspaceTest.release('task'));
  await finished(busy);
  await busy.close();
  console.log('PASS directory selection and active tasks cannot race or switch twice');

  const stale = await fixture();
  const contextToggle = stale.locator('[data-action="toggle-context"]').first();
  if ((await contextToggle.getAttribute('aria-expanded')) !== 'true') await contextToggle.click();
  await stale.evaluate(() => { window.__workspaceTest.deferRead = true; });
  await stale.locator('[data-entry-path="README.md"]').first().click();
  await stale.waitForFunction(() => window.__workspaceTest.waits.has('read'));
  await choose(stale);
  await finished(stale);
  await stale.evaluate(() => window.__workspaceTest.release('read'));
  await stale.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal((await stale.locator('body').innerText()).includes('STALE_WORKSPACE_FILE'), false);
  await stale.close();
  console.log('PASS in-flight old workspace reads cannot overwrite the new workspace');
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
