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

async function fixture({ deferRuntime = false, sidebar = false, duplicateRoots = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ deferRuntime, sidebar, duplicateRoots }) => {
    const threads = [{ id: 'saved-a', title: 'Saved A', cwd: 'C:\\projects\\A', turnCount: 1,
      resumable: true, state: 'PAUSED', createdAtMs: 1, updatedAtMs: 2 }];
    if (sidebar) {
      const projects = ['A', ...Array.from({ length: 12 }, (_, index) => `P${index + 1}`)].map((name) => ({
        id: `project:c:\\projects\\${name.toLowerCase()}`, name: name === 'A' ? 'Saved project A' : name, path: `C:\\projects\\${name}`,
        paths: [`C:\\projects\\${name}`], lastUsedAtMs: 1
      }));
      if (duplicateRoots) {
        projects[0].path = '\\\\?\\C:\\projects\\A';
        projects[0].paths = ['C:\\projects\\A', 'c:/projects/a/'];
      }
      if (!localStorage.getItem('hmcodex.projects.v1')) localStorage.setItem('hmcodex.projects.v1', JSON.stringify(projects));
      threads.push(...['X', 'Y'].map((name, index) => ({ id: `discovered-${name}`, title: `History ${name}`,
        cwd: `C:\\projects\\${name}`, turnCount: 1, resumable: true, state: 'PAUSED', createdAtMs: 1, updatedAtMs: 4 - index })));
    }
    localStorage.setItem('hmcodex.nav', JSON.stringify({ threadId: 'saved-a', page: 'workbench' }));
    const waits = new Map();
    const state = window.__workspaceTest = {
      calls: [], waits, threads, root: 'C:\\projects\\A', selectedRoot: 'C:\\projects\\B', cancel: false,
      failList: false, deferPick: false, deferTask: false, deferRead: false, deferWorkspace: false,
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
          if (state.deferWorkspace) await gate('workspace');
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
  }, { deferRuntime, sidebar, duplicateRoots });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A'
    && !document.querySelector('textarea[name="prompt"]')?.disabled);
  return page;
}

const choose = async (page) => {
  await page.locator('[data-action="navigate"][data-page="workspace"]').first().click();
  await page.locator('[data-action="open-workspace"]').click();
};
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

const projectOrder = (page) => page.locator('.project-group').evaluateAll((groups) => groups.map((group) => group.dataset.projectGroup));
const settleFrames = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

try {
  const duplicates = await fixture({ sidebar: true, duplicateRoots: true });
  const duplicateOrder = await projectOrder(duplicates);
  const openDuplicateSettings = async () => {
    await duplicates.locator('.project-group').first().locator('[data-action="edit-project"]').click();
    await settleFrames(duplicates);
  };
  await openDuplicateSettings();
  assert.equal(await duplicates.locator('.project-target-row').count(), 1, 'old extended/ordinary/case variants represent one source folder');
  assert.deepEqual(await duplicates.locator('.project-target-row span').allTextContents(), ['C:\\projects\\A']);
  for (const target of ['\\\\?\\C:\\projects\\B', 'C:\\projects\\C']) {
    await duplicates.evaluate((target) => { window.__workspaceTest.selectedRoot = target; }, target);
    await duplicates.locator('[data-action="add-project-target"]').click();
    await duplicates.waitForFunction(() => !document.querySelector('[data-action="save-project-edit"]')?.disabled);
  }
  assert.deepEqual(await duplicates.locator('.project-target-row span').allTextContents(), ['C:\\projects\\A', 'C:\\projects\\B', 'C:\\projects\\C'],
    'different folders remain distinct and earlier unsaved additions are retained');
  await duplicates.evaluate(() => { window.__workspaceTest.selectedRoot = 'c:/projects/b/'; });
  await duplicates.locator('[data-action="add-project-target"]').click();
  await duplicates.waitForFunction(() => Boolean(document.querySelector('.project-name-error'))
    && !document.querySelector('[data-action="save-project-edit"]')?.disabled);
  assert.equal(await duplicates.locator('.project-target-row').count(), 3, 'adding an equivalent draft folder cannot duplicate it');
  await duplicates.locator('[data-action="save-project-edit"]').click();
  const savedRoots = await duplicates.evaluate(() => JSON.parse(localStorage.getItem('hmcodex.projects.v1'))
    .find((project) => project.name === 'Saved project A').paths);
  assert.deepEqual(savedRoots, ['C:\\projects\\A', '\\\\?\\C:\\projects\\B', 'C:\\projects\\C'], 'display formatting retains actual native paths');
  await duplicates.reload();
  await duplicates.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A');
  await openDuplicateSettings();
  assert.deepEqual(await duplicates.locator('.project-target-row span').allTextContents(), ['C:\\projects\\A', 'C:\\projects\\B', 'C:\\projects\\C']);
  assert.deepEqual(await projectOrder(duplicates), duplicateOrder);
  await duplicates.close();
  console.log('PASS equivalent Windows roots deduplicate on load/add/save/reload, native paths remain intact, and distinct draft folders stay visible');

  const settings = await fixture({ sidebar: true });
  const settingsOrder = await projectOrder(settings);
  const openProjectSettings = async (name) => {
    const group = settings.locator('.project-group').filter({
      has: settings.locator('.project-header strong').filter({ hasText: new RegExp(`^${name}$`) })
    });
    await group.locator('[data-action="edit-project"]').click();
    await settleFrames(settings);
    assert.equal(await settings.locator('.project-edit-card').isVisible(), true, `settings opens for ${name} from history`);
    assert.equal(await settings.locator('[data-role="project-edit-name"]').inputValue(), name);
    assert.equal(await settings.locator('[data-role="project-edit-name"]').evaluate((field) => document.activeElement === field), true);
    assert.equal(await settings.locator('[data-history-title]').innerText(), 'Saved A', 'opening settings preserves the selected historical conversation');
  };
  for (const [index, name] of ['Saved project A', 'P6', 'X'].entries()) {
    await openProjectSettings(name);
    await settings.locator('[data-role="project-edit-name"]').fill('Discarded draft');
    if (index === 1) await settings.keyboard.press('Escape');
    else await settings.locator('[data-action="cancel-project-edit"]').nth(index === 0 ? 1 : 0).click();
    await settleFrames(settings);
    assert.equal(await settings.locator('.project-picker-backdrop').count(), 0, 'closing settings removes its backdrop');
    assert.equal(await settings.locator('[data-history-title]').innerText(), 'Saved A');
    assert.deepEqual(await projectOrder(settings), settingsOrder, 'settings preserves saved, empty, and discovered project positions');
    assert.equal(await settings.locator('.composer-project').innerText(), 'Saved project A', 'cancel does not save a draft name');
  }
  await openProjectSettings('Saved project A');
  await settings.locator('[data-action="add-project-target"]').click();
  await settings.waitForFunction(() => document.querySelectorAll('.project-target-row').length === 2
    && !document.querySelector('[data-action="save-project-edit"]')?.disabled);
  assert.deepEqual(await settings.locator('.project-target-row span').allTextContents(), ['C:\\projects\\A', 'C:\\projects\\B']);
  assert.equal(await settings.evaluate(() => window.__workspaceTest.root), 'C:\\projects\\A');
  await settings.locator('[data-action="remove-project-target"][data-target-index="1"]').click();
  assert.equal(await settings.locator('.project-target-row').count(), 1);
  await settings.locator('[data-role="project-edit-name"]').fill('');
  await settings.locator('[data-action="save-project-edit"]').click();
  assert.equal(await settings.locator('.project-name-error').isVisible(), true, 'validation errors stay in the open settings dialog');
  await settings.locator('[data-role="project-edit-name"]').fill('History project A');
  await settings.keyboard.press('Enter');
  await settleFrames(settings);
  assert.equal(await settings.locator('.project-picker-backdrop').count(), 0, 'saving settings removes its backdrop');
  assert.equal(await settings.locator('[data-history-title]').innerText(), 'Saved A');
  assert.equal(await settings.locator('.composer-project').innerText(), 'History project A');
  assert.deepEqual(await projectOrder(settings), settingsOrder);
  await settings.close();
  console.log('PASS historical project settings open for saved, empty, and discovered projects; cancel, Escape, folder controls, validation, and save preserve history');

  const sidebar = await fixture({ sidebar: true });
  assert.equal(await sidebar.locator('.composer-project').innerText(), 'Saved project A', 'history composer uses the saved project name');
  assert.equal(await sidebar.locator('.workspace-identity strong').innerText(), 'Saved project A');
  assert.equal(await sidebar.locator('.topbar [data-action="open-workspace"]').count(), 0);
  assert.equal((await sidebar.locator('.topbar').innerText()).includes('更换项目'), false);
  console.log('PASS topbar omits the redundant project switch');
  await sidebar.setViewportSize({ width: 1440, height: 600 });
  const originalOrder = await projectOrder(sidebar);
  assert.equal(originalOrder.length, 16);
  const project = sidebar.locator('.project-header').filter({ hasText: /^\s*P6\s*$/ });
  await project.scrollIntoViewIfNeeded();
  const anchor = await project.elementHandle();
  const beforeToggle = await sidebar.evaluate(() => ({
    list: document.querySelector('[data-region="thread-list"]').scrollTop,
    rail: document.querySelector('.navigation-rail').scrollTop
  }));
  for (let toggle = 0; toggle < 4; toggle++) {
    if (toggle === 0) await project.click();
    else await sidebar.keyboard.press('Space');
    await settleFrames(sidebar);
    assert.deepEqual(await projectOrder(sidebar), originalOrder, 'expand/collapse preserves every project position');
    assert.equal(await anchor.evaluate((header) => header.isConnected && document.activeElement === header), true,
      'expand/collapse retains the original header and keyboard focus');
    assert.equal(await project.getAttribute('aria-expanded'), String(toggle % 2 === 0));
    assert.deepEqual(await sidebar.evaluate(() => ({
      list: document.querySelector('[data-region="thread-list"]').scrollTop,
      rail: document.querySelector('.navigation-rail').scrollTop
    })), beforeToggle, 'expand/collapse preserves sidebar scroll position');
  }
  console.log('PASS project toggles preserve order, header identity, keyboard focus, and scroll position');

  await sidebar.evaluate(() => { window.__workspaceTest.threads.find((thread) => thread.id === 'discovered-Y').updatedAtMs = 100; });
  await submit(sidebar, 'refresh conversation activity');
  await finished(sidebar);
  await settleFrames(sidebar);
  assert.deepEqual(await projectOrder(sidebar), originalOrder, 'conversation activity cannot reorder discovered project groups');
  assert.equal(await sidebar.locator('.composer-project').innerText(), 'Saved project A', 'live composer uses the saved project name');
  console.log('PASS conversation refresh preserves discovered project order');

  await sidebar.locator('.project-group').first().locator('[data-action="edit-project"]').click();
  await sidebar.locator('[data-role="project-edit-name"]').fill('Renamed project A');
  await sidebar.locator('[data-action="save-project-edit"]').click();
  await sidebar.waitForFunction(() => document.querySelector('.composer-project')?.textContent === 'Renamed project A');
  assert.equal(await sidebar.locator('.project-header strong').first().innerText(), 'Renamed project A');
  assert.equal(await sidebar.locator('.workspace-identity strong').innerText(), 'Renamed project A');
  assert.equal(await sidebar.evaluate(() => window.__workspaceTest.root), 'C:\\projects\\A', 'renaming a project preserves its actual directory');
  await sidebar.locator('[data-thread-id="saved-a"]').click();
  await sidebar.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A');
  await settleFrames(sidebar);
  assert.equal(await sidebar.locator('.composer-project').innerText(), 'Renamed project A', 'history refresh preserves the edited project name');
  assert.deepEqual(await projectOrder(sidebar), originalOrder, 'renaming a project preserves its sidebar position');
  console.log('PASS composer and topbar follow saved project names through live tasks, edits, and history selection');

  const discovered = sidebar.locator('.project-header').filter({ hasText: /^\s*Y\s*$/ });
  await discovered.click();
  await sidebar.locator('[data-thread-id="discovered-Y"]').click();
  await sidebar.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'History Y');
  await finished(sidebar);
  await settleFrames(sidebar);
  assert.deepEqual(await projectOrder(sidebar), originalOrder, 'saving a discovered project retains its displayed position');
  await sidebar.reload();
  await sidebar.waitForFunction(() => document.querySelectorAll('.project-group').length === 16
    && !document.querySelector('textarea[name="prompt"]')?.disabled);
  await settleFrames(sidebar);
  assert.deepEqual(await projectOrder(sidebar), originalOrder, 'project order survives reload after saving a discovered project');
  assert.equal(await sidebar.locator('.composer-project').innerText(), 'Renamed project A', 'saved project display name survives reload');
  await sidebar.close();
  console.log('PASS discovered project selection and reload preserve the existing sidebar order');

  if (!process.argv.includes('--sidebar-only')) {
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

  await page.evaluate(() => { window.__workspaceTest.deferWorkspace = true; });
  await page.locator('[data-thread-id="saved-a"]').click();
  const historyPicker = page.locator('.project-picker-card');
  if (await historyPicker.count()) {
    await historyPicker.waitFor();
    assert.match(await historyPicker.innerText(), /先切换到会话所属目录/);
    await historyPicker.locator('[data-action="select-new-task-project"]').filter({ hasText: 'C:\\projects\\A' }).click();
  }
  await page.waitForFunction(() => document.querySelector('[data-history-title]')?.textContent === 'Saved A'
    && !document.querySelector('[data-history-status]')?.textContent.includes('正在加载历史会话'));
  await page.waitForFunction(() => window.__workspaceTest.waits.has('workspace'));
  assert.equal(await page.locator('.composer .send-button').isDisabled(), true, 'sending waits for the history directory');
  await page.evaluate(() => window.__workspaceTest.release('workspace'));
  await finished(page);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('hmcodex.nav')).threadId), 'saved-a');
  assert.equal(await page.locator('.composer .send-button').isDisabled(), false, 'history remains usable after directory reconciliation');
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
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
