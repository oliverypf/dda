import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const EVIDENCE = 'C:/Temp/dda-full-access-evidence/sessions-final';
const PORT = 1437;
await mkdir(EVIDENCE, { recursive: true });

const shim = `import { mockIPC, mockWindows } from '/node_modules/@tauri-apps/api/mocks.js';
mockWindows('main');
window.__accept = { calls: [], deferred: new Map(), reconcileHold: [] };
const grant = { granted: true, rootPath: 'C:/fixture-a', rootLabel: 'fixture-a' };
const snapshot = { releaseChannel: 'dev', platform: 'WINDOWS', version: '9.9.9-test', readOnly: false,
  workspaceRead: true, commandExecution: true, networkSideEffects: false, runtimeReady: true,
  nodeVersion: 'v24.0.0', model: null, configLoaded: false };
const defaultIpc = {
  runtime_snapshot: () => snapshot,
  list_threads: () => [],
  default_workspace: () => grant,
  list_workspace: () => [],
  workspace_grant: () => grant,
  set_workspace: (a) => ({ granted: true, rootPath: a?.path ?? grant.rootPath, rootLabel: 'fixture-a' }),
  open_workspace: (a) => ({ ...grant, rootPath: a?.path ?? grant.rootPath }),
  access_mode: () => ({ mode: 'REQUIRE_APPROVAL', scope: 'WORKSPACE' }),
  load_desktop_settings: () => ({}),
  list_execution_state: () => [],
  runtime_dashboard: () => ({ ok: true, threads: [], execution: { records: [] }, feedback: [], memories: [], dreams: [], plugins: [], evolution: { proposals: [], reports: [], control: { enabled: false } } }),
  dream_maintenance_status: () => ({}),
  evolve_status: () => ({}),
  history_query: () => ({ items: [], hasMore: false }),
  read_thread_events: () => ({ events: [] }),
  plugin_inventory: () => [],
  model_config: () => ({ provider: 'fixture', model: 'fixture-model' }),
  show_desktop_notification: () => ({ accepted: true }),
  pending_sub_agent_count: () => 0,
  cell_maintenance_status: () => ({}),
  list_projects: () => []
};
mockIPC((cmd, args) => {
  window.__accept.calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
  if (cmd === 'run_model_task') {
    return new Promise((resolve) => window.__accept.deferred.set(args.clientSessionId ?? 'untagged', resolve));
  }
  if (cmd === 'reconcile_runtime_state' && window.__accept.holdReconcile) {
    return new Promise((resolve) => window.__accept.reconcileHold.push(resolve));
  }
  if (cmd === 'reconcile_runtime_state') return { ok: true, reconciled: 0, execution: { reconciled: 0, records: [] }, roles: { reconciled: 0, contexts: [] }, pendingApprovals: 0 };
  if (cmd === 'resolve_runtime_approval') { window.__accept.calls.at(-1).targeted = true; return {}; }
  if (cmd === 'cancel_model_task') { window.__accept.calls.at(-1).targeted = true; return { cancelled: true }; }
  if (cmd in defaultIpc) return defaultIpc[cmd](args);
  // Unknown mandatory IPC must be loud — a missing shape is a fixture bug.
  throw new Error('FIXTURE_MISSING_IPC:' + cmd);
}, { shouldMockEvents: true });
window.__emit = (event) => import('/node_modules/@tauri-apps/api/event.js').then((mod) => mod.emit('runtime-event', event));
window.__notify = (payload) => import('/node_modules/@tauri-apps/api/event.js').then((mod) => mod.emit('desktop-notification-activated', payload));
window.__settle = (sessionId, payload) => { const r = window.__accept.deferred.get(sessionId); if (r) r(payload); };
await import('/src/main.ts?acceptance=1');
`;

const ev = (runId, seq, kind, payload, sessionId) => ({
  type: 'runtime_event', schemaVersion: '1.0', runId, sequence: seq, kind,
  payload: payload ?? {}, emittedAtMs: Date.now(),
  ...(sessionId ? { clientSessionId: sessionId } : {})
});

const probe = async () => fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);
if (!(await probe())) {
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), shell: true, stdio: 'inherit' });
  server.unref();
  const deadline = Date.now() + 30000;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error('vite start timeout');
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
const consoleErrors = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });
const calls = (page) => page.evaluate(() => window.__accept.calls);

const submit = async (page, text) => {
  await page.fill('textarea[name="prompt"]', text);
  await page.click('[data-action="send-prompt"], form [type="submit"], .composer button.primary-action');
};
const sessionCalls = async (page) => page.evaluate(() => window.__accept.calls.filter((c) => c.cmd === 'run_model_task').map((c) => c.args));
const selectSession = async (page, id) => {
  await page.locator(`.session-row[data-session-id="${id}"]`).click({ timeout: 5000 });
};

// ── Scenario 1: interactive sessions ───────────────────────────────────────
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => consoleErrors.push('scenario1:' + String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('scenario1:' + m.text()); });
await page.route(`**/src/main.ts`, (route) => route.fulfill({ contentType: 'application/javascript', body: shim }));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

try {
  await page.waitForSelector('textarea[name="prompt"]', { timeout: 20000 });

  // Native identity must be truthful with a valid snapshot.
  await page.waitForFunction(() => document.body.innerText.includes('本地运行时'), undefined, { timeout: 10000 });
  const brandText = await page.evaluate(() => document.querySelector('.brand-row')?.innerText ?? 'BRAND_ROW_MISSING');
  check('native WINDOWS label', brandText?.includes('Windows 本地运行时'), brandText);
  check('version label present', await page.evaluate(() => document.body.innerText.includes('v9.9.9-test')));

  // A: submit + bind
  await submit(page, 'task A inspect alpha');
  await page.waitForFunction(() => window.__accept.calls.some((c) => c.cmd === 'run_model_task'), undefined, { timeout: 15000 });
  const [callA] = await sessionCalls(page);
  const sessionA = callA.clientSessionId;
  check('A clientSessionId', Boolean(sessionA), sessionA);
  check('A frozen cwd', callA.workspacePath === 'C:/fixture-a', callA.workspacePath);
  await page.evaluate((e) => window.__emit(e), ev('run-a', 1, 'run.started', {}, sessionA));
  await page.evaluate((e) => window.__emit(e), ev('run-a', 2, 'run.state_changed', { to: 'EXECUTING' }, sessionA));
  await page.evaluate((e) => window.__emit(e), ev('run-a', 3, 'model.text_delta', { text: 'A-only' }, sessionA));

  // Rogue frames BEFORE anything else: duplicate seq, unknown session,
  // wrong-run tagged to A — all must be dropped while A is healthy.
  await page.evaluate((e) => window.__emit(e), ev('run-a', 3, 'model.text_delta', { text: 'dup-seq' }, sessionA));
  await page.evaluate((e) => window.__emit(e), ev('run-ghost', 1, 'model.text_delta', { text: 'ghost' }, 'ui-unknown'));
  await page.evaluate((e) => window.__emit(e), ev('run-other', 1, 'model.text_delta', { text: 'wrong-run' }, sessionA));
  check('duplicate seq dropped', await page.evaluate(() => !document.body.innerText.includes('dup-seq')));
  check('unknown session dropped', await page.evaluate(() => !document.body.innerText.includes('ghost')));
  check('wrong-run dropped', await page.evaluate(() => !document.body.innerText.includes('wrong-run')));

  // Approval A: distinct id/digest/future expiry.
  const future = Date.now() + 300000;
  await page.evaluate((e) => window.__emit(e), ev('run-a', 4, 'approval.requested',
    { requestId: 'req-a', capability: 'shell.execute', requestDigest: 'sha256:' + 'a'.repeat(64), approvalExpiresAt: future, command: 'cmd /c alpha' }, sessionA));

  // New-task parks A → empty enabled composer AND blank timeline on the FIRST click, session row for A persists.
  await page.click('[data-action="new-task"]');
  await page.waitForFunction(() => {
    const ta = document.querySelector('textarea[name="prompt"]');
    const send = document.querySelector('[data-action="send-prompt"], form [type="submit"], .composer button.primary-action');
    return ta && ta.value === '' && !ta.disabled && send && !send.disabled;
  }, undefined, { timeout: 8000 });
  check('park → empty enabled composer', true);
  check('first new-task click clears live timeline immediately', await page.evaluate(() => {
    const human = document.querySelector('[data-live-human]');
    const transcriptText = document.querySelector('.transcript')?.innerText ?? '';
    return Boolean(human) && human.children.length === 0
      && !transcriptText.includes('task A inspect alpha')
      && !transcriptText.includes('A-only');
  }));
  check('first new-task click clears right context panel immediately', await page.evaluate(() => {
    const ctx = document.querySelector('.context-panel')?.innerText ?? '';
    return !ctx.includes('task A inspect alpha');
  }));
  check('still native WINDOWS after park', await page.evaluate(() => document.body.innerText.includes('Windows 本地运行时')));
  // Sessions render inside their project group; the global switcher is gone.
  check('session row inside project group', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.session-row')];
    return rows.length >= 1 && rows.every((r) => r.closest('[data-project-group]'));
  }));
  check('no global session switcher', await page.evaluate(() => !document.querySelector('.session-switcher') && !document.querySelector('[data-session-switcher]')));
  check('pristine draft has no row', await page.evaluate(() => document.querySelectorAll('.session-row').length === 1));

  // A second new-task click on an untouched draft must not stack draft rows.
  await page.click('[data-action="new-task"]');
  await page.waitForTimeout(300);
  check('no draft accumulation', await page.evaluate(() => document.querySelectorAll('.session-row').length === 1));
  await page.click('[data-action="close-project-picker"]').catch(() => {});
  await page.waitForTimeout(200);

  // Draft retention: type B draft, switch to A (draft captured into B's
  // session → non-pristine → earns its own row), back (draft restored).
  await page.fill('textarea[name="prompt"]', 'task B build beta');
  await selectSession(page, sessionA);
  await page.waitForTimeout(300);
  check('session rows stay enabled after switch', await page.evaluate(() =>
    [...document.querySelectorAll('.session-row')].every((r) => !r.disabled)));
  check('non-empty draft earns a row', await page.evaluate(() => document.querySelectorAll('.session-row').length === 2));
  check('A transcript shows A text', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    return text.includes('A-only') && text.includes('task A inspect alpha') && !text.includes('task B build beta');
  }));
  check('A approval still REQUESTED', await page.evaluate(() => document.body.innerText.includes('req-a') || document.body.innerText.includes('批准一次')));
  const draftSessionId = await page.evaluate((sid) =>
    [...document.querySelectorAll('.session-row')].find((r) => r.dataset.sessionId !== sid)?.dataset.sessionId ?? '', sessionA);
  await selectSession(page, draftSessionId);
  await page.waitForTimeout(300);
  check('B draft survives switch', await page.evaluate(() => document.querySelector('textarea[name="prompt"]')?.value === 'task B build beta'));
  check('B draft view does not leak A timeline', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    return !text.includes('A-only') && !text.includes('task A inspect alpha');
  }));

  // Submit B from the restored draft.
  await page.click('[data-action="send-prompt"], form [type="submit"], .composer button.primary-action');
  await page.waitForFunction(() => window.__accept.calls.filter((c) => c.cmd === 'run_model_task').length === 2, undefined, { timeout: 15000 });
  const [, callB] = await sessionCalls(page);
  const sessionB = callB.clientSessionId;
  check('B distinct clientSessionId', sessionB && sessionB !== sessionA, sessionB);
  check('B same frozen cwd', callB.workspacePath === 'C:/fixture-a');
  await page.evaluate((e) => window.__emit(e), ev('run-b', 1, 'run.started', {}, sessionB));
  await page.evaluate((e) => window.__emit(e), ev('run-b', 4, 'model.text_delta', { text: 'beta-2' }, sessionB));
  await page.evaluate((e) => window.__emit(e), ev('run-b', 5, 'approval.requested',
    { requestId: 'req-b', capability: 'shell.execute', requestDigest: 'sha256:' + 'b'.repeat(64), approvalExpiresAt: future, command: 'cmd /c beta' }, sessionB));
  await page.waitForTimeout(250);
  check('B transcript shows only B items', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    const ctx = document.querySelector('.context-panel')?.innerText ?? '';
    return text.includes('task B build beta') && text.includes('beta-2')
      && !text.includes('task A inspect alpha') && !text.includes('A-only')
      && !ctx.includes('task A inspect alpha');
  }));

  // Notification for A's approval selects A session before policy.
  await page.evaluate((p) => window.__notify(p), { kind: 'APPROVAL_REQUIRED', runId: 'run-a', requestId: 'req-a' });
  await page.waitForTimeout(400);
  check('notification selects A session without B bleed', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    const ctx = document.querySelector('.context-panel')?.innerText ?? '';
    return text.includes('A-only') && text.includes('task A inspect alpha')
      && !text.includes('task B build beta') && !text.includes('beta-2')
      && !ctx.includes('task B build beta');
  }));

  // Switch to B, approve via UI → targeted {sessionId:B, runId:run-b, digest-b}.
  await selectSession(page, sessionB);
  await page.waitForTimeout(300);
  check('B switch isolated and rows enabled', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    const rowsEnabled = [...document.querySelectorAll('.session-row')].every((r) => !r.disabled);
    return rowsEnabled && text.includes('beta-2') && !text.includes('A-only') && !text.includes('task A inspect alpha');
  }));
  await page.click('[data-action="resolve-approval"][data-approved="true"]');
  await page.waitForFunction(() => window.__accept.calls.some((c) => c.cmd === 'resolve_runtime_approval'), undefined, { timeout: 8000 });
  const approvalCall = await page.evaluate(() => window.__accept.calls.find((c) => c.cmd === 'resolve_runtime_approval').args);
  check('approval targets B session', approvalCall.sessionId === sessionB, approvalCall);
  check('approval carries real run-b', approvalCall.runId === 'run-b', approvalCall);
  check('approval digest exact', approvalCall.displayedDigest === 'sha256:' + 'b'.repeat(64));

  // A remains REQUESTED — switch back and confirm its approve button exists.
  await selectSession(page, sessionA);
  await page.waitForTimeout(300);
  check('A approval still pending', await page.evaluate(() => Boolean(document.querySelector('[data-action="resolve-approval"]'))));

  // Short-lived expiring approval on A: the expiry timer flips only A's
  // request; B's pending approval must be unaffected.
  await page.evaluate((e) => window.__emit(e), ev('run-a', 5, 'approval.requested',
    { requestId: 'req-a2', capability: 'shell.execute', requestDigest: 'sha256:' + 'c'.repeat(64), approvalExpiresAt: Date.now() + 1200, command: 'cmd /c short' }, sessionA));
  await page.waitForTimeout(2500);
  check('A short approval expired locally', await page.evaluate(() => !document.body.innerText.includes('cmd /c short') || document.body.innerText.includes('已过期') || document.body.innerText.includes('EXPIRED')));

  // Cancel A → mock {cancelled:true} → UI CANCELLED; late A failure can't regress.
  await page.click('[data-action="cancel-run"]');
  await page.waitForFunction(() => window.__accept.calls.some((c) => c.cmd === 'cancel_model_task'), undefined, { timeout: 8000 });
  const cancelCall = await page.evaluate(() => window.__accept.calls.find((c) => c.cmd === 'cancel_model_task').args);
  check('cancel targets A owner', cancelCall.sessionId === sessionA, cancelCall);
  check('cancel carries real run-a', cancelCall.runId === 'run-a', cancelCall);
  await page.waitForTimeout(400);
  check('A UI shows cancelled', await page.evaluate(() => document.body.innerText.includes('取消') || document.body.innerText.includes('CANCELLED')),
    await page.evaluate(() => document.querySelector('.task-summary-state, .run-state, [data-region="conversation"]')?.innerText?.slice(0, 120)));
  await page.evaluate(({ id }) => window.__settle(id, { ok: false, error: 'cancelled', plugins: [], runId: 'run-a' }), { id: sessionA });
  await page.waitForTimeout(400);
  check('A stays cancelled after failure settle', await page.evaluate(() => document.body.innerText.includes('取消') || document.body.innerText.includes('CANCELLED')));

  // B completes while A selected → view stays; all invocations drained.
  await page.evaluate(({ id }) => window.__settle(id, { ok: false, error: 'fixture terminal', plugins: [], runId: 'run-b' }), { id: sessionB });
  await page.waitForTimeout(500);
  check('view stays on A after B settles', await page.evaluate(() => document.body.innerText.includes('A-only')));
  check('composer enabled after all drained', await page.evaluate(() => {
    const ta = document.querySelector('textarea[name="prompt"]');
    return ta && !ta.disabled;
  }));
  // Idle new-task across project change must preserve settled A's timeline & root,
  // and cross-root switching back to A must never leave session rows disabled.
  await page.click('[data-action="new-task"]');
  await page.waitForSelector('[data-action="select-new-task-project"][data-project-id="__projectless__"]', { timeout: 5000 });
  await page.click('[data-action="select-new-task-project"][data-project-id="__projectless__"]');
  await page.waitForFunction(() => !document.querySelector('.project-picker-backdrop'), undefined, { timeout: 5000 });
  check('projectless new-task clears live timeline', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    return !text.includes('A-only') && !text.includes('task A inspect alpha');
  }));
  await selectSession(page, sessionA);
  await page.waitForTimeout(300);
  check('settled A survives cross-project new-task and rows remain enabled', await page.evaluate(() => {
    const text = document.querySelector('.transcript')?.innerText ?? '';
    const rowsEnabled = [...document.querySelectorAll('.session-row')].every((r) => !r.disabled);
    return rowsEnabled && text.includes('A-only') && text.includes('task A inspect alpha');
  }));
  const runCalls = await page.evaluate(() => window.__accept.calls.filter((c) => c.cmd === 'run_model_task').length);
  check('no stray model calls', runCalls === 2, runCalls);

  await page.screenshot({ path: `${EVIDENCE}/sessions-desktop.png` });

  // Mobile: close the context panel first, assert no horizontal overflow.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.click('[data-action="toggle-context"]').catch(() => {});
  await page.waitForTimeout(400);
  check('mobile no h-overflow', await page.evaluate(() => document.documentElement.scrollWidth <= 375));
  await page.screenshot({ path: `${EVIDENCE}/sessions-mobile.png` });
} catch (error) {
  check('scenario1 harness error', false, String(error));
  await page.screenshot({ path: `${EVIDENCE}/sessions-failure.png` }).catch(() => {});
}
const allCalls = await calls(page).catch(() => []);
await page.close();

// ── Scenario 2: deferred hydration ─────────────────────────────────────────
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page2.on('pageerror', (e) => consoleErrors.push('scenario2:' + String(e)));
page2.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('scenario2:' + m.text()); });
const shim2 = shim.replace('window.__accept.holdReconcile', 'window.__accept.holdReconcile')
  .replace("window.__accept = { calls: [], deferred: new Map(), reconcileHold: [] };",
    "window.__accept = { calls: [], deferred: new Map(), reconcileHold: [], holdReconcile: true };");
await page2.route(`**/src/main.ts`, (route) => route.fulfill({ contentType: 'application/javascript', body: shim2 }));
await page2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
try {
  await page2.waitForSelector('textarea[name="prompt"]', { timeout: 20000 });
  // Submit A while hydration is held → run_model_task must NOT fire yet.
  await submit(page2, 'early task A');
  await page2.waitForTimeout(600);
  check('A launch held during hydration', await page2.evaluate(() => window.__accept.calls.every((c) => c.cmd !== 'run_model_task')));
  // Park to a new task, submit B as well — both queued.
  await page2.click('[data-action="new-task"]');
  await page2.waitForTimeout(300);
  await submit(page2, 'early task B');
  await page2.waitForTimeout(400);
  // Release the reconcile gate → both launches proceed with distinct owners.
  await page2.evaluate(() => {
    window.__accept.holdReconcile = false;
    window.__accept.reconcileHold.forEach((r) => r({ ok: true, reconciled: 0, execution: { reconciled: 0, records: [] }, roles: { reconciled: 0, contexts: [] } }));
  });
  await page2.waitForFunction(() => window.__accept.calls.filter((c) => c.cmd === 'run_model_task').length === 2, undefined, { timeout: 15000 });
  const calls2 = await page2.evaluate(() => window.__accept.calls.filter((c) => c.cmd === 'run_model_task').map((c) => c.args));
  check('deferred A/B distinct owners', calls2[0].clientSessionId !== calls2[1].clientSessionId, calls2.map((c) => c.clientSessionId));
  check('deferred A frozen cwd', calls2[0].workspacePath === 'C:/fixture-a', calls2[0].workspacePath);
  check('deferred B frozen cwd', calls2[1].workspacePath === 'C:/fixture-a', calls2[1].workspacePath);
} catch (error) {
  check('scenario2 harness error', false, String(error));
  await page2.screenshot({ path: `${EVIDENCE}/sessions-scenario2-failure.png` }).catch(() => {});
}
await page2.close();

const summary = {
  ok: results.every((r) => r.ok) && consoleErrors.length === 0,
  results, consoleErrors,
  calls: (allCalls ?? []).slice(0, 60)
};
await writeFile(`${EVIDENCE}/sessions-acceptance.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ok: summary.ok, failed: results.filter((r) => !r.ok).map((r) => r.name + ' :: ' + JSON.stringify(r.detail)), consoleErrors }, null, 2));
await browser.close();
process.exit(summary.ok ? 0 : 1);
