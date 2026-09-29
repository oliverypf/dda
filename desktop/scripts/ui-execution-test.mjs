// Isolated browser with simulated native event transport and delayed audit reads.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = process.env.HMCODEX_UI_OUTPUT ?? fileURLToPath(new URL('../../.codex-tmp/execution-ui/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    assert.ok(path.startsWith(root.endsWith(sep) ? root : root + sep));
    res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true, channel: process.env.HMCODEX_BROWSER_CHANNEL });
const errors = [];
const results = [];
async function fixture(viewport = { width: 1440, height: 960 }, { controlled = false } = {}) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ controlled }) => {
    const callbacks = new Map(), listeners = new Map(), calls = [], auditWaiters = [];
    let callbackId = 0, sequence = 0, finish, runId;
    const state = window.__executionTest = {
      calls, auditWaiters, expected: '', rootWrites: 0, navWrites: 0, longTasks: [],
      emit(kind, payload = {}, overrides = {}) {
        const event = { type: 'runtime_event', schemaVersion: '1.0', runId,
          sequence: ++sequence, emittedAtMs: Date.now(), kind, payload, ...overrides };
        for (const id of listeners.get('runtime-event') ?? []) callbacks.get(id)({ payload: event });
      },
      delta(text) { state.expected += text; state.emit('model.text_delta', { text }); },
      complete(text = state.expected, verification = { status: 'PASS', summary: 'Fixture checks passed', checks: [] }) {
        state.emit('run.completed');
        finish({ ok: true, runId, text, threadId: 'thread-fixture',
          thread: { id: 'thread-fixture', title: 'Fixture', turnCount: 1, state: 'COMPLETED', createdAtMs: 1, updatedAtMs: Date.now(), cwd: '/fixture' },
          workspace: { entryCount: 0 }, executionMode: controlled ? 'CONTROLLED' : 'READ_ONLY', ...(verification === null ? {} : { verification }) });
      },
      rejectBeforeStart() { finish({ ok: false, error: 'Fixture transport failed before acknowledgement', plugins: [] }); },
      fail(checks) { state.emit('run.failed', { message: 'Verifier rejected task', checks }); finish({ ok: false, runId, error: 'Verifier rejected task', plugins: [] }); },
      releaseAudit() { for (const done of auditWaiters.splice(0)) done(); }
    };
    new PerformanceObserver((list) => state.longTasks.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { configurable: true,
      get() { return descriptor.get.call(this); }, set(value) { if (this.id === 'app') state.rootWrites++; descriptor.set.call(this, value); } });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'hmcodex.nav') state.navWrites++; return setItem.call(this, key, value); };
    window.__TAURI_INTERNALS__ = {
      transformCallback(fn) { callbacks.set(++callbackId, fn); return callbackId; },
      async invoke(command, args = {}) {
        calls.push({ command, args });
        if (command === 'plugin:event|listen') {
          listeners.set(args.event, [...(listeners.get(args.event) ?? []), args.handler]);
          return args.handler;
        }
        if (command.startsWith('plugin:event|')) return;
        if (command === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'test', runtimeReady: true, readOnly: true, workspaceRead: true, commandExecution: controlled, networkSideEffects: false, releaseChannel: controlled ? 'WINDOWS_PHASE1_5_CONTROLLED' : 'WINDOWS_PHASE1_READ_ONLY' };
        if (command === 'reconcile_runtime_state') return { ok: true, reconciled: 0 };
        if (command === 'default_workspace') return { rootLabel: 'Fixture', rootPath: '/fixture' };
        if (command === 'list_workspace') return [];
        if (command === 'context_sidecar_status' || command === 'dream_maintenance_status') return undefined;
        if (command === 'runtime_dashboard') {
          if (args.details && finish) await new Promise((done) => auditWaiters.push(done));
          return { ok: true, summaryOnly: !args.details, threads: [],
            modelUsage: finish ? { status: 'REPORTED', calls: 2, cacheReportedCalls: 2,
              cacheEligibleInputTokens: 100, cachedInputTokens: 0, cacheHitRate: 0, cacheCoverage: 1 }
              : { status: 'UNKNOWN', calls: 1, cacheReportedCalls: 0, cacheHitRate: null, cacheCoverage: 0 }, execution: { records: [] }, feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [], evolution: { proposals: [], reports: [], control: { enabled: true, changedAtMs: 0 } } };
        }
        if (['list_execution_state', 'list_memories', 'list_dream_runs', 'list_plugin_governance', 'list_evolution'].includes(command)) {
          await new Promise((done) => auditWaiters.push(done));
          return {};
        }
        if (command === 'model_config') return { config: { schemaVersion: '1.0', provider: 'openai-chat', protocol: 'chat-completions', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY' } };
        if (command === 'run_model_task') {
          sequence = 0; state.expected = ''; runId = `fixture-${calls.length}`;
          return new Promise((done) => {
            finish = done;
            if (state.deferStart) return;
            state.emit('run.started');
            state.emit('RoleContextAllocated', { role: 'executor', contextId: 'executor-fixture' });
          });
        }
        if (command === 'cancel_model_task') {
          finish({ ok: false, error: 'cancelled', runId });
          await new Promise((done) => setTimeout(done, 100));
          return { cancelled: true };
        }
        if (command === 'resolve_runtime_approval') return;
        throw Error(`Unexpected invoke: ${command}`);
      }
    };
  }, { controlled });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector('.connection-status')?.classList.contains('status-ready'));
  return page;
}
async function submit(page) {
  await page.locator('textarea[name="prompt"]').fill('Execution responsiveness fixture');
  await page.locator('.send-button').click();
  await page.waitForFunction(() => window.__executionTest.calls.some((c) => c.command === 'run_model_task'));
  await page.waitForSelector('[data-agent-id="executor-fixture"]');
}
async function mark(page) {
  await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const state = window.__executionTest;
    state.refs = ['.app-shell', '.composer', '.transcript', '.context-panel', '.composer-stop'].map((selector) => [selector, document.querySelector(selector)]);
    state.rootWrites = 0; state.navWrites = 0; state.started = performance.now();
    state.staticMutations = 0;
    state.staticObserver?.disconnect();
    state.staticObserver = new MutationObserver(records => { state.staticMutations += records.length; });
    for (const selector of ['.version-label', '.composer-note', '[data-region="thread-list"]']) {
      const element = document.querySelector(selector);
      if (element) state.staticObserver.observe(element, { subtree: true, childList: true, characterData: true });
    }
  });
}
async function identity(page) {
  return page.evaluate(() => ({ rootWrites: window.__executionTest.rootWrites,
    replaced: window.__executionTest.refs.filter(([selector, ref]) => document.querySelector(selector) !== ref).map(([selector]) => selector) }));
}
try {
  await mkdir(output, { recursive: true });
  const page = await fixture();
  await page.waitForFunction(() => document.querySelector('[data-model-cache="composer"]')?.textContent.includes('服务商未返回缓存统计'));
  assert.ok(!(await page.locator('[data-model-cache="composer"]').innerText()).includes('0.0%'));
  await submit(page);
  const profiler = process.env.HMCODEX_UI_PROFILE === '1' ? await page.context().newCDPSession(page) : undefined;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
    await profiler.send('Tracing.start', { categories: 'devtools.timeline,v8.execute', transferMode: 'ReturnAsStream' });
  }
  await mark(page);
  const burst = await page.evaluate(async () => {
    const state = window.__executionTest;
    const before = performance.now();
    for (let i = 0; i < 120; i++) state.emit('role.text_delta', { role: 'executor', contextId: 'executor-fixture', chars: i + 1 });
    const handlerMs = performance.now() - before;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return { handlerMs, rootWrites: state.rootWrites, navWrites: state.navWrites };
  });
  console.log(JSON.stringify({ roleBurst: burst }));
  assert.deepEqual(await identity(page), { rootWrites: 0, replaced: [] });
  assert.ok(burst.navWrites <= 1, 'token events must not synchronously persist navigation');
  results.push({ name: 'role burst coalesces and preserves shell', ...burst });
  await page.evaluate(() => window.__executionTest.delta('first <tag> & text\nsecond line'));
  await page.waitForFunction(() => document.querySelector('.timeline-item[data-status="STREAMING"] .timeline-body')?.textContent === window.__executionTest.expected);
  await page.evaluate(() => {
    const row = document.querySelector('.timeline-item[data-status="STREAMING"]');
    window.__executionTest.stream = row;
    row.querySelector('details').open = true;
  });
  await page.evaluate(async () => {
    const state = window.__executionTest;
    for (let batch = 0; batch < 16; batch++) {
      for (let i = 0; i < 64; i++) {
        state.emit('role.text_delta', { role: 'executor', contextId: 'executor-fixture', chars: i + 1 });
        state.delta(`\nline ${batch}:${i} <safe> & ${'x'.repeat(100)}`);
      }
      state.emit('workspace.snapshot', { entryCount: batch });
      await new Promise((done) => setTimeout(done, 16));
    }
  });
  await page.waitForFunction(() => window.__executionTest.stream.querySelector('.timeline-body')?.textContent === window.__executionTest.expected);
  assert.equal(await page.evaluate(() => window.__executionTest.stream.isConnected && window.__executionTest.stream.querySelector('details').open), true);
  assert.deepEqual(await identity(page), { rootWrites: 0, replaced: [] });
  const tasks = await page.evaluate(() => window.__executionTest.longTasks.filter((task) => task.start >= window.__executionTest.started));
  if (profiler) {
    const profile = await profiler.send('Profiler.stop');
    await writeFile(resolve(output, 'stream.cpuprofile'), JSON.stringify(profile.profile));
    const completed = new Promise(resolve => profiler.once('Tracing.tracingComplete', resolve));
    await profiler.send('Tracing.end');
    const { stream } = await completed;
    const chunks = [];
    for (;;) {
      const part = await profiler.send('IO.read', { handle: stream });
      chunks.push(part.base64Encoded ? Buffer.from(part.data, 'base64').toString('utf8') : part.data);
      if (part.eof) break;
    }
    await profiler.send('IO.close', { handle: stream });
    await writeFile(resolve(output, 'stream-trace.json'), chunks.join(''));
    await profiler.detach();
  }
  results.push({ name: 'event replay and paint must not produce tasks over 50ms', pass: tasks.length === 0, longTasks: tasks });
  assert.ok(await page.evaluate(() => window.__executionTest.navWrites <= 1));
  const staticMutations = await page.evaluate(() => window.__executionTest.staticMutations);
  results.push({ name: 'unchanged labels and saved threads receive no DOM mutations', staticMutations });
  assert.equal(staticMutations, 0, 'stream events must not rewrite unchanged labels or saved threads');
  results.push({ name: '1024 mixed role/text deltas preserve exact output and row identity', longTasks: tasks });
  const chunkSpacing = await page.evaluate(() => {
    const chunks = [...window.__executionTest.stream.querySelectorAll('.stream-text-chunk')];
    return chunks.slice(0, -1).every((chunk) => Math.abs(chunk.getBoundingClientRect().height - 8 * parseFloat(getComputedStyle(chunk).lineHeight)) < 1);
  });
  assert.equal(chunkSpacing, true, 'stream chunk boundaries must not add blank lines');

  await page.evaluate(() => {
    for (let i = 0; i < 600; i++) window.__executionTest.emit('model.route_resolved', { provider: 'fixture', model: `route-${i}` });
  });
  await page.waitForFunction(() => document.querySelector('[data-execution-group] > summary').textContent.includes('617'));
  assert.equal(await page.locator('[data-live-tools] .timeline-item').count(), 0);
  await page.evaluate(() => { document.querySelector('[data-execution-group]').open = true; });
  await page.waitForFunction(() => document.querySelectorAll('[data-live-tools] .timeline-item').length === 617);
  await page.evaluate(() => {
    window.__executionTest.toolRow = document.querySelector('[data-live-tools] .timeline-item');
    window.__executionTest.toolRow.querySelector('details')?.setAttribute('open', '');
    window.__executionTest.emit('model.route_resolved', { model: 'last route' });
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-live-tools] .timeline-item').length === 618);
  assert.equal(await page.evaluate(() => window.__executionTest.toolRow.isConnected && (!window.__executionTest.toolRow.querySelector('details') || window.__executionTest.toolRow.querySelector('details').open)), true);
  await page.evaluate(() => { document.querySelector('[data-execution-group]').open = false; });
  results.push({ name: '600 collapsed events mount on demand and preserve disclosure state' });
  await page.evaluate(() => window.__executionTest.emit('tool.call_requested', {
    id: 'tool-visible', name: 'workspace.list', operationId: 'op-visible'
  }));
  await page.waitForSelector('[data-live-human] [data-tool-name="workspace.list"]');
  assert.match(await page.locator('[data-live-human] [data-tool-name="workspace.list"] .timeline-body').innerText(), /正在工作区目录/);
  await page.evaluate(() => window.__executionTest.emit('tool.result', {
    id: 'tool-visible', name: 'workspace.list', operationId: 'op-visible', ok: true, outputChars: 24
  }));
  await page.waitForFunction(() => document.querySelector('[data-live-human] [data-tool-name="workspace.list"] .timeline-body')?.textContent.includes('已完成'));
  results.push({ name: 'tool execution is readable in the conversation timeline while running and after completion' });
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-fixture', capability: 'fixture.read', requestDigest: 'sha256:fixture' }));
  await page.waitForSelector('[data-live-region="approvals"] [data-approved="false"]');
  await page.locator('[data-live-region="approvals"] [data-approved="false"]').click();
  assert.equal(await page.locator('[data-live-region="approvals"] [data-approved="false"]').isDisabled(), true);
  await page.evaluate(() => window.__executionTest.emit('approval.resolved', { requestId: 'approval-fixture', state: 'DECLINED' }));
  await page.waitForFunction(() => document.querySelectorAll('[data-live-region="approvals"] .approval-card').length === 0);
  results.push({ name: 'approvals remain responsive during streaming' });
  // Track the same text block on screen; scrollTop may legitimately change
  // when Chromium compensates for new content inserted above the reader.
  const readingY = await page.evaluate(() => {
    const transcript = document.querySelector('.transcript');
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - 180);
    transcript.dispatchEvent(new Event('scroll'));
    const bounds = transcript.getBoundingClientRect();
    const chunks = [...document.querySelectorAll('.stream-text-chunk')];
    const anchor = chunks.find(chunk => {
      const box = chunk.getBoundingClientRect();
      return box.top >= bounds.top && box.top < bounds.bottom;
    });
    if (!anchor) throw Error('No visible reading anchor');
    window.__executionTest.readingAnchor = anchor;
    return anchor.getBoundingClientRect().top;
  });
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-reading', capability: 'fixture.read', requestDigest: 'sha256:reading' }));
  const readingCard = page.locator('[data-live-region="approvals"] article[data-approval-id="approval-reading"]');
  await readingCard.waitFor();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const readingAfter = await page.evaluate(() => ({ connected: window.__executionTest.readingAnchor.isConnected, top: window.__executionTest.readingAnchor.getBoundingClientRect().top }));
  assert.equal(readingAfter.connected, true);
  assert.ok(Math.abs(readingAfter.top - readingY) < 2, 'approval preserves the same visible text block');
  assert.equal(await readingCard.getAttribute('aria-live'), 'assertive');
  await page.evaluate(() => window.__executionTest.emit('approval.resolved', { requestId: 'approval-reading', state: 'DECLINED' }));
  await readingCard.waitFor({ state: 'detached' });
  results.push({ name: 'approval arrival preserves the same on-screen reading anchor' });
  await page.evaluate(() => {
    window.__executionTest.emit('approval.requested', { requestId: 'approval-keyboard', capability: 'shell.execute', risk: 'HIGH', requestDigest: 'sha256:keyboard' });
  });
  const keyboardCard = page.locator('[data-live-region="approvals"] article[data-approval-id="approval-keyboard"]');
  await keyboardCard.waitFor();
  await keyboardCard.locator('[data-approved="false"]').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-approved')), 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.matches(':focus-visible')), true);
  const rejectFocus = await keyboardCard.locator('[data-approved="false"]').evaluate(el => ({ width: el.getBoundingClientRect().width, outline: getComputedStyle(el).outlineStyle }));
  const approveFocus = await keyboardCard.locator('[data-approved="true"]').evaluate(el => ({ width: el.getBoundingClientRect().width }));
  assert.ok(rejectFocus.width >= approveFocus.width - 1 && rejectFocus.outline === 'solid', 'reject has equal target size and visible keyboard focus');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-approved')), 'true');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-approved')), 'false');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__executionTest.calls.some(call => call.command === 'resolve_runtime_approval' && call.args.requestId === 'approval-keyboard' && call.args.approved === false));
  await page.evaluate(() => window.__executionTest.emit('approval.resolved', { requestId: 'approval-keyboard', state: 'DECLINED' }));
  await keyboardCard.waitFor({ state: 'detached' });
  results.push({ name: 'high-risk approval buttons have keyboard order, visible reject focus and direct Enter rejection' });

  const highRiskCalls = () => page.evaluate(() => window.__executionTest.calls.filter(call => call.command === 'resolve_runtime_approval' && call.args.requestId === 'approval-confirm').length);
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-confirm', capability: 'shell.execute', risk: 'HIGH', command: 'echo <review>', requestDigest: 'sha256:confirm' }));
  const confirmCard = page.locator('[data-live-region="approvals"] article[data-approval-id="approval-confirm"]');
  await confirmCard.locator('[data-approved="true"]').click();
  const confirmation = page.locator('dialog.approval-confirmation');
  await confirmation.waitFor();
  assert.equal(await highRiskCalls(), 0, 'opening confirmation must not authorize');
  const confirmGeometry = await confirmation.locator('button').evaluateAll(buttons => buttons.map(button => ({ y: button.getBoundingClientRect().y, height: button.getBoundingClientRect().height })));
  assert.ok(confirmGeometry.every(button => Math.abs(button.y - confirmGeometry[0].y) < 1 && Math.abs(button.height - confirmGeometry[0].height) < 1), 'desktop confirmation buttons align and have equal heights');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-confirmation')), 'back');
  assert.match(await confirmation.locator('pre').innerText(), /echo <review>/);
  await page.keyboard.press('Enter');
  await confirmation.waitFor({ state: 'detached' });
  assert.equal(await highRiskCalls(), 0, 'repeated Enter returns without approval');
  await confirmCard.locator('[data-approved="true"]').click();
  await page.keyboard.press('Escape');
  await confirmation.waitFor({ state: 'detached' });
  assert.equal(await highRiskCalls(), 0);
  await confirmCard.locator('[data-approved="true"]').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await confirmation.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  const confirmWidths = await confirmation.locator('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().width));
  assert.ok(Math.abs(confirmWidths[1] - confirmWidths[2]) < 1, 'reject and confirm have equal target widths on mobile');
  await page.screenshot({ path: resolve(output, 'high-risk-confirmation-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 960 });
  await confirmation.locator('[data-confirmation="approve"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__executionTest.calls.some(call => call.command === 'resolve_runtime_approval' && call.args.requestId === 'approval-confirm' && call.args.approved === true));
  assert.equal(await highRiskCalls(), 1);
  await page.evaluate(() => window.__executionTest.emit('approval.resolved', { requestId: 'approval-confirm', state: 'APPROVED' }));
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-confirm-expire', capability: 'shell.execute', risk: 'HIGH', requestDigest: 'sha256:expire' }));
  await page.locator('[data-live-region="approvals"] [data-approval-id="approval-confirm-expire"] [data-approved="true"]').click();
  await confirmation.waitFor();
  await page.evaluate(() => window.__executionTest.emit('approval.expired', { requestId: 'approval-confirm-expire' }));
  await confirmation.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__executionTest.calls.filter(call => call.command === 'resolve_runtime_approval' && call.args.requestId === 'approval-confirm-expire').length), 0);
  results.push({ name: 'high-risk confirmation defaults to return; Enter and Escape cannot accidentally approve; explicit approval dispatches once; expiration dismisses stale confirmation' });

  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-approved', intentId: 'intent-approved', capability: 'fixture.read', requestDigest: 'sha256:approved' }));
  await page.locator('[data-live-region="approvals"] [data-approved="true"]').click();
  await page.evaluate(() => window.__executionTest.emit('approval.resolved', { requestId: 'approval-approved', state: 'APPROVED' }));
  const approvedCard = page.locator('[data-live-region="approvals"] [data-approval-id="approval-approved"]').first();
  await approvedCard.filter({ hasText: '正在重新检查策略' }).waitFor();
  assert.match(await approvedCard.innerText(), /正在重新检查策略/);
  assert.equal(await approvedCard.locator('[data-action="resolve-approval"]').count(), 0);
  await page.evaluate(() => window.__executionTest.emit('lease.issued', { intentId: 'intent-approved', leaseId: 'lease-approved', expiresAt: Date.now() + 60000 }));
  await approvedCard.filter({ hasText: '已授权执行' }).waitFor();
  assert.match(await approvedCard.innerText(), /已授权执行/);
  await page.evaluate(() => window.__executionTest.emit('lease.claimed', { intentId: 'intent-approved', leaseId: 'lease-approved' }));
  await approvedCard.filter({ hasText: '执行器已领取授权' }).waitFor();
  assert.match(await approvedCard.innerText(), /执行器已领取授权/);
  await page.evaluate(() => window.__executionTest.emit('lease.consumed', { intentId: 'intent-approved', leaseId: 'lease-approved', ok: false }));
  await approvedCard.filter({ hasText: '授权已使用' }).waitFor();
  assert.match(await approvedCard.innerText(), /授权已使用.*执行器报告失败/);
  assert.doesNotMatch(await approvedCard.innerText(), /已授权执行/);
  await page.evaluate(() => {
    window.__executionTest.emit('approval.requested', { requestId: 'approval-failed', intentId: 'intent-failed', capability: 'fixture.read', requestDigest: 'sha256:failed' });
    window.__executionTest.emit('approval.resolved', { requestId: 'approval-failed', state: 'APPROVED' });
    window.__executionTest.emit('lease.failed', { intentId: 'intent-failed', errorCode: 'FIXTURE_UNKNOWN_OUTCOME' });
  });
  const failedCard = page.locator('[data-live-region="approvals"] [data-approval-id="approval-failed"]').first();
  await failedCard.filter({ hasText: '授权不可继续使用' }).waitFor({ timeout: 3000 });
  assert.match(await failedCard.innerText(), /授权不可继续使用.*执行结果不确定/);
  assert.equal(await failedCard.locator('[data-action="resolve-approval"]').count(), 0);
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-expired', capability: 'fixture.read', requestDigest: 'sha256:expired' }));
  await page.evaluate(() => window.__executionTest.emit('approval.expired', { requestId: 'approval-expired' }));
  assert.equal(await page.locator('[data-action="resolve-approval"][data-approval-id="approval-expired"]').count(), 0);
  results.push({ name: 'approval waits for policy lease before showing authorization; expired request has no actions' });
  // The runtime may deliver expiration late: local deadlines must close the UI first.
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-timer', capability: 'fixture.read', requestDigest: 'sha256:timer', approvalExpiresAt: Date.now() + 400 }));
  await page.locator('[data-action="resolve-approval"][data-approval-id="approval-timer"]').first().waitFor();
  await page.locator('[data-live-region="approvals"] [data-approval-id="approval-timer"]').filter({ hasText: '审批已过期' }).waitFor();
  assert.equal(await page.locator('[data-action="resolve-approval"][data-approval-id="approval-timer"]').count(), 0);
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-clock', capability: 'fixture.read', requestDigest: 'sha256:clock', approvalExpiresAt: Date.now() + 60000 }));
  await page.locator('[data-live-region="approvals"] [data-approved="true"][data-approval-id="approval-clock"]').waitFor();
  // Simulate waking with a stale button before the timeout callback gets a turn.
  await page.evaluate(() => {
    const originalNow = Date.now;
    Date.now = () => originalNow() + 120000;
    try { document.querySelector('[data-approved="true"][data-approval-id="approval-clock"]').click(); }
    finally { Date.now = originalNow; }
  });
  await page.locator('[data-live-region="approvals"] [data-approval-id="approval-clock"]').filter({ hasText: '审批已过期' }).waitFor();
  assert.equal(await page.evaluate(() => window.__executionTest.calls.some(c => c.command === 'resolve_runtime_approval' && ['approval-timer', 'approval-clock'].includes(c.args.requestId))), false);
  results.push({ name: 'local expiration disables both locations and rejects stale clicks before the timer fires' });
  await page.evaluate(() => { const transcript = document.querySelector('.transcript'); transcript.scrollTop = 100; transcript.dispatchEvent(new Event('scroll')); });
  const top = await page.locator('.transcript').evaluate((el) => el.scrollTop);
  await page.evaluate(() => window.__executionTest.delta('\nkeep reading position'));
  await page.waitForFunction(() => window.__executionTest.stream.querySelector('.timeline-body').textContent === window.__executionTest.expected);
  assert.ok(Math.abs(await page.locator('.transcript').evaluate((el) => el.scrollTop) - top) < 2);
  await page.locator('[data-action="open-settings"]').click();
  await page.waitForSelector('[data-settings-dialog]');
  await mark(page);
  await page.evaluate(() => {
    window.__executionTest.delta('\nwhile settings are open');
    for (let i = 0; i < 100; i++) window.__executionTest.emit('role.text_delta', { role: 'executor', contextId: 'executor-fixture', chars: i });
  });
  await page.waitForTimeout(60);
  assert.deepEqual(await identity(page), { rootWrites: 0, replaced: [] });
  await page.locator('[data-action="close-settings"]').last().click();
  await page.waitForFunction(() => document.querySelector('.timeline-item[data-status="STREAMING"] .timeline-body')?.textContent === window.__executionTest.expected);
  results.push({ name: 'reading position and settings survive live events' });
  await page.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'approval-unsettled', capability: 'fixture.read', requestDigest: 'sha256:unsettled' }));
  await page.locator('[data-action="resolve-approval"][data-approval-id="approval-unsettled"]').first().waitFor();
  await page.evaluate(() => window.__executionTest.complete());
  await page.waitForFunction(() => document.querySelectorAll('[data-action="resolve-approval"][data-approval-id="approval-unsettled"]').length === 0);
  await page.waitForFunction(() => document.querySelector('.send-button')?.disabled === false, undefined, { timeout: 5000 });
  assert.ok(await page.evaluate(() => window.__executionTest.auditWaiters.length > 0));
  assert.equal(await page.locator('.timeline-item[data-status="STREAMING"]').count(), 0);
  results.push({ name: 'completion visible while audit reads are still pending' });
  await page.evaluate(() => window.__executionTest.releaseAudit());
  await page.waitForFunction(() => document.querySelector('[data-model-cache="composer"]')?.textContent.includes('0.0%'));
  assert.match(await page.locator('[data-model-cache="composer"]').innerText(), /覆盖 2\/2 次调用/);
  results.push({ name: 'completed live task refreshes cache and displays real zero hits' });
  await page.screenshot({ path: resolve(output, 'desktop.png') });
  await page.locator('[data-execution-group] > summary').click();
  await page.waitForFunction(() => document.querySelector('[data-execution-group]')?.open);
  await page.locator('[data-action="new-task"]').click();
  // New task now opens the project chooser so the workspace boundary is
  // explicit. Continue through the current workspace when it is available.
  const chooser = page.locator('.project-picker-card');
  if (await chooser.count()) {
    await chooser.locator('.project-picker-none').click();
  }
  await page.waitForFunction(() => document.activeElement?.matches('textarea[name="prompt"]'));
  assert.equal(await page.locator('.approval-card').count(), 0, 'new task does not inherit prior approvals');
  await mark(page);
  await page.keyboard.type('typing in a new task', { delay: 30 });
  assert.equal(await page.locator('textarea[name="prompt"]').inputValue(), 'typing in a new task');
  assert.deepEqual(await identity(page), { rootWrites: 0, replaced: [] },
    'restoring expanded details must not repeatedly rebuild the new-task shell');
  results.push({ name: 'new task retains focus and accepts typing after expanding execution details' });

  const mobile = await fixture({ width: 390, height: 844 });
  await submit(mobile);
  await mobile.evaluate(() => window.__executionTest.delta('mobile output\n'.repeat(40)));
  await mobile.waitForSelector('.timeline-body');
  await mobile.locator('.composer-stop').click();
  await mobile.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
  assert.equal(await mobile.locator('.stream-caret').count(), 0);
  await mobile.evaluate(() => window.__executionTest.delta('late cancelled text'));
  await mobile.waitForTimeout(50);
  assert.equal(await mobile.locator('.transcript').textContent().then((text) => text.includes('late cancelled text')), false);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: resolve(output, 'mobile.png') });
  await mobile.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
  results.push({ name: 'mobile cancellation responsive; late events discarded; settled reader unlocks composer' });
  const nonstream = await fixture();
  await submit(nonstream);
  await nonstream.locator('[data-page="workspace"]').click();
  await mark(nonstream);
  await nonstream.evaluate(() => window.__executionTest.complete('full nonstream response\n'.repeat(2000)));
  await nonstream.waitForFunction(() => document.querySelector('.send-button')?.disabled === false, undefined, { timeout: 5000 });
  await nonstream.locator('.nav-list [data-page="workbench"]').click();
  await nonstream.waitForFunction(() => [...document.querySelectorAll('.timeline-body')].some((body) => body.textContent === 'full nonstream response\n'.repeat(2000)));
  results.push({ name: 'nonstream response completes promptly while viewing another page' });
  const controlled = await fixture(undefined, { controlled: true });
  await controlled.locator('[data-action="toggle-mode"]').click();
  assert.match(await controlled.locator('.version-label').innerText(), /受控模式/);
  await submit(controlled);
  await controlled.evaluate(() => window.__executionTest.emit('approval.requested', { requestId: 'layout-approval', capability: 'file.write', path: 'example.txt', requestDigest: 'fixture' }));
  await controlled.locator('[data-live-region="approvals"] .approval-actions').waitFor();
  for (const width of [1440, 390]) {
    await controlled.setViewportSize({ width, height: 960 });
    const metrics = await controlled.locator('[data-live-region="approvals"] .approval-actions').evaluate(actions => [...actions.querySelectorAll('button')].map(button => {
      const range = document.createRange(); range.selectNodeContents(button);
      return { width: button.getBoundingClientRect().width, textHeight: range.getBoundingClientRect().height, fontSize: parseFloat(getComputedStyle(button).fontSize) };
    }));
    assert.ok(metrics[0].width >= metrics[1].width - 1, 'reject is as easy to target as approve');
    assert.ok(metrics.every(metric => metric.textHeight <= metric.fontSize * 1.6), 'approval action labels stay on one line');
    assert.equal(await controlled.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await controlled.setViewportSize({ width: 1440, height: 960 });
  const approvalCallsBeforeCancel = await controlled.evaluate(() => window.__executionTest.calls.filter(call => call.command === 'resolve_runtime_approval').length);
  await controlled.locator('[data-live-region="approvals"] .approval-card [data-action="cancel-run"]').click();
  await controlled.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
  assert.equal(await controlled.locator('[data-action="resolve-approval"]').count(), 0, 'card cancellation closes all pending decisions');
  assert.equal(await controlled.evaluate(() => window.__executionTest.calls.filter(call => call.command === 'resolve_runtime_approval').length), approvalCallsBeforeCancel, 'cancellation does not approve or decline');
  assert.equal(await controlled.evaluate(() => window.__executionTest.calls.filter(call => call.command === 'cancel_model_task').length), 1);
  await controlled.locator('[data-execution-group] > summary').click();
  await controlled.waitForFunction(() => document.querySelector('.transcript')?.textContent.includes('已经执行的操作不会自动撤销'));
  assert.match(await controlled.locator('.transcript').textContent(), /已经执行的操作不会自动撤销/);
  assert.doesNotMatch(await controlled.locator('.transcript').textContent(), /只读运行没有产生外部副作用/);
  await controlled.locator('[data-action="toggle-mode"]').click();
  assert.match(await controlled.locator('.version-label').innerText(), /只读模式/);
  results.push({ name: 'controlled mode label matches selection and cancellation does not promise rollback or no side effects' });
  for (const verification of [
    { status: 'FAIL', summary: 'Fixture failed', checks: [] },
    { status: 'UNKNOWN', summary: 'Fixture missing evidence', checks: [] },
    { status: 'PASS', summary: 'Rule checks passed', checks: [], semantic: { status: 'ABSTAIN', required: true, summary: 'No independent evidence' } },
    null
  ]) {
    const unverified = await fixture(undefined, { controlled: true });
    await unverified.locator('[data-action="toggle-mode"]').click();
    await submit(unverified);
    await unverified.evaluate(verification => window.__executionTest.complete('Preserve this output', verification), verification);
    await unverified.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
    assert.match(await unverified.locator('.run-status').innerText(), /任务未完成/);
    await unverified.locator('[data-execution-group] > summary').click();
    await unverified.getByText('未达到验收条件', { exact: true }).waitFor();
    assert.match(await unverified.locator('.transcript').innerText(), /未达到验收条件/);
    assert.match(await unverified.locator('.transcript').innerText(), /Preserve this output/);
    await unverified.close();
  }
  results.push({ name: 'failed, unknown, required abstention and missing verification never become successful runs' });
  const checksPage = await fixture();
  await submit(checksPage);
  await checksPage.evaluate(() => window.__executionTest.emit('workspace.snapshot', { path: '/fixture/README.md', summary: 'Evidence target' }, { eventId: 'workspace-evidence-1' }));
  await checksPage.evaluate(() => window.__executionTest.complete('Report retained', {
    status: 'UNKNOWN', summary: 'Evidence incomplete', checks: [
      { id: 'build', status: 'PASS', message: 'Compilation passed', evidence: ['event:workspace-evidence-1', 'build:sha256:fixture'] },
      { id: 'tests', status: 'FAIL', message: 'A test failed', evidence: ['test:fixture'] },
      { id: 'goal', status: 'UNKNOWN', message: 'Missing <coverage>', evidence: [] },
      { id: 'diff', status: 'SKIPPED', message: 'No diff check performed', evidence: [] }
    ]
  }));
  const checkPanel = checksPage.locator('.verification-checks');
  await checkPanel.waitFor();
  assert.equal(await checkPanel.locator('.verification-check').count(), 4);
  assert.match(await checkPanel.innerText(), /通过 · build/);
  assert.match(await checkPanel.innerText(), /失败 · tests/);
  assert.match(await checkPanel.innerText(), /未知状态 · goal/);
  assert.match(await checkPanel.innerText(), /已跳过 · diff/);
  assert.match(await checkPanel.innerText(), /Missing <coverage>/);
  assert.match(await checkPanel.innerText(), /运行时未提供逐项检查时间和影响等级/);
  assert.equal(await checkPanel.locator('[data-status="PENDING"]').count(), 2);
  assert.equal(await checkPanel.locator('[data-action="focus-evidence"][data-evidence-ref="event:workspace-evidence-1"]').count(), 1);
  assert.equal(await checkPanel.locator('[data-evidence-state="unresolved"]').count(), 4);
  await checkPanel.locator('[data-action="focus-evidence"][data-evidence-ref="event:workspace-evidence-1"]').click();
  await checksPage.waitForFunction(() => [...document.querySelectorAll('[data-item-id]')].some(node => node.textContent?.includes('工作区快照') && node.closest('[data-execution-group]')?.open === true));
  const targetState = await checksPage.evaluate(() => { const node = [...document.querySelectorAll('[data-item-id]')].find(n => n.textContent?.includes('工作区快照')); return { itemId: node?.getAttribute('data-item-id'), open: Boolean(node?.querySelector('details[open]')), groupOpen: Boolean(node?.closest('[data-execution-group]')?.open) }; });
  assert.ok(targetState.itemId, 'evidence target timeline row is rendered');
  assert.equal(targetState.open, true, 'evidence click opens target details');
  assert.equal(targetState.groupOpen, true, 'evidence click expands execution group');
  assert.equal(await checkPanel.locator('coverage').count(), 0);
  assert.match(await checksPage.locator('.run-status').innerText(), /任务未完成/);
  await checkPanel.scrollIntoViewIfNeeded();
  await checksPage.screenshot({ path: resolve(output, 'verification-checks-desktop.png') });
  await checksPage.setViewportSize({ width: 390, height: 844 });
  await checkPanel.scrollIntoViewIfNeeded();
  assert.equal(await checkPanel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await checksPage.screenshot({ path: resolve(output, 'verification-checks-mobile.png') });
  const closeContext = checksPage.locator('.mobile-context-close');
  if (await closeContext.isVisible()) await closeContext.click();
  await checksPage.locator('[data-action="new-task"]').click();
  const mobileChooser = checksPage.locator('.project-picker-card');
  if (await mobileChooser.count()) await mobileChooser.locator('.project-picker-none').click();
  await checkPanel.waitFor({ state: 'detached' });
  await checksPage.close();
  results.push({ name: 'per-check verifier report preserves all four statuses, safe text and evidence references, explicit missing metadata and new-task isolation' });
  const failedReport = await fixture();
  await submit(failedReport);
  await failedReport.evaluate(() => window.__executionTest.fail([
    { id: 'required-tests', status: 'FAIL', message: 'Required tests failed', evidence: ['test:failure'] },
    { id: 'uncertain', status: 'UNRECOGNIZED', message: 'Status not understood', evidence: [null, 'event:valid'] },
    null
  ]));
  await failedReport.locator('.verification-checks').waitFor();
  await failedReport.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
  assert.match(await failedReport.locator('.run-status').innerText(), /任务未完成/);
  assert.match(await failedReport.locator('.submit-receipt').innerText(), /已被接受/);
  assert.doesNotMatch(await failedReport.locator('.submit-receipt').innerText(), /已被拒绝/);
  assert.equal(await failedReport.locator('.verification-check').count(), 2);
  assert.match(await failedReport.locator('.verification-checks').innerText(), /失败 · required-tests/);
  assert.match(await failedReport.locator('.verification-checks').innerText(), /未知状态 · uncertain/);
  assert.match(await failedReport.locator('.verification-checks').innerText(), /event:valid/);
  await failedReport.locator('.verification-checks').scrollIntoViewIfNeeded();
  await failedReport.screenshot({ path: resolve(output, 'failed-verification-report.png') });
  await failedReport.close();
  results.push({ name: 'run.failed retains checks after failed bridge response; malformed entries are ignored and unsupported statuses remain unknown' });

  const unacknowledged = await fixture();
  await unacknowledged.evaluate(() => { window.__executionTest.deferStart = true; });
  await unacknowledged.locator('textarea[name="prompt"]').fill('No runtime acknowledgement');
  await unacknowledged.locator('.send-button').click();
  await unacknowledged.waitForFunction(() => window.__executionTest.calls.some(call => call.command === 'run_model_task'));
  await unacknowledged.locator('.submit-receipt-pending').waitFor();
  assert.match(await unacknowledged.locator('.submit-receipt').innerText(), /等待运行时确认/);
  await unacknowledged.evaluate(() => window.__executionTest.rejectBeforeStart());
  await unacknowledged.waitForFunction(() => document.querySelector('.send-button')?.disabled === false);
  assert.match(await unacknowledged.locator('.submit-receipt').innerText(), /未收到运行时接受确认/);
  assert.doesNotMatch(await unacknowledged.locator('.submit-receipt').innerText(), /已被接受|已被拒绝/);
  const receiptRows = await unacknowledged.locator('.submit-receipt').evaluate(el => [...el.children].map(child => ({ top: child.getBoundingClientRect().top, bottom: child.getBoundingClientRect().bottom })));
  assert.ok(receiptRows.slice(1).every((row, i) => row.top > receiptRows[i].bottom), 'receipt ID, status and prompt occupy separate rows');
  await unacknowledged.screenshot({ path: resolve(output, 'receipt-unconfirmed.png') });
  await unacknowledged.close();
  results.push({ name: 'submission waits for acknowledgement; pre-acknowledgement failure remains unconfirmed; execution failure preserves accepted receipt' });
  assert.deepEqual(errors, []);
  const ok = results.every((result) => result.pass !== false);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exitCode = 1;
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ ok, results }, null, 2));
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
