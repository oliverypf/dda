import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
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
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  let id = 0;
  window.__TAURI_INTERNALS__ = {
    transformCallback() { return ++id; },
    async invoke(command, args = {}) {
      if (command.startsWith('plugin:event|')) return ++id;
      if (command === 'runtime_snapshot') return { platform: 'WINDOWS', version: 'fixture', runtimeReady: true, readOnly: true, workspaceRead: true, releaseChannel: 'WINDOWS_PHASE1_READ_ONLY' };
      if (command === 'default_workspace') return { rootLabel: 'Fixture', rootPath: 'C:/fixture' };
      if (command === 'list_workspace') return [];
      if (command === 'context_sidecar_status' || command === 'dream_maintenance_status') return undefined;
      if (command === 'reconcile_runtime_state') return {
        ok: true, reconciled: 4,
        execution: { reconciled: 2, records: [] },
        roles: { reconciled: 1, contexts: [] },
        dream: { reconciled: 1, runs: [] },
        remote: { state: 'LOCAL_ONLY', endpoint: null, checkedAtMs: 1, reason: '当前 runtime 未配置远端恢复源' }, pendingApprovals: 2, pendingApprovalRecords: [{ recordId: 'approval-fixture', state: 'PRESENTED', runId: 'run-fixture', operationId: 'op-fixture' }], revokedLeases: 1, revokedLeaseRecords: [{ recordId: 'lease-fixture', state: 'REVOKED', runId: 'run-fixture', operationId: 'op-fixture', reason: 'OWNER_PROCESS_LOST' }],
        workspace: { available: true, status: 'READY', changedFiles: 3, staged: 1, unstaged: 1, untracked: 1, conflicted: 0, observationDigest: 'sha256:fixture' }
      };
      if (command === 'runtime_dashboard') return { ok: true, summaryOnly: !args.details, threads: [], execution: { records: [] }, feedback: [], memories: [], dreams: [], plugins: [], pluginVersions: [], projection: { decisions: [{ decisionId: 'council-fixture', decisionType: 'REVIEW_PLAN', role: 'council', status: 'COMMITTED', optionCount: 2, selectedOptionId: 'council-p1', reasonCodes: ['COUNCIL_ACCEPT_PLAN'], options: [{ optionId: 'council-p1', actionKind: 'COUNCIL_PROPOSAL', rejectionReasonCodes: [] }, { optionId: 'council-abstain', actionKind: 'ABSTAIN', rejectionReasonCodes: ['JUDGE_RETURNED_DECISION'] }] }, { decisionId: 'probe-fixture', decisionType: 'COUNCIL_PROBE', role: 'council', status: 'COMMITTED', optionCount: 1, selectedOptionId: 'probe-1', reasonCodes: ['PROBE_SELECTED'], options: [{ optionId: 'probe-1', actionKind: 'READ_ONLY_PROBE', rejectionReasonCodes: [] }] }] }, pluginVersions: [], evolution: { proposals: [], reports: [], control: { enabled: true } } };
      if (command === 'model_config') return { config: { schemaVersion: '1.0', provider: 'openai-chat', protocol: 'chat-completions', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', baseURL: 'https://example.test/v1' }, exists: true, configPath: 'C:/fixture/model-config.json' };
      if (command === 'export_data') return { ok: true, output: 'C:/fixture/exports/export-all-1.json' };
      throw Error(`Unexpected call ${command}`);
    }
  };
});
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.connection-status.status-ready').waitFor();
  await page.locator('[data-action="navigate"][data-page="diagnostics"]').click();
  await page.getByText('最近恢复检查', { exact: true }).waitFor();
  const text = await page.locator('.page-placeholder').innerText();
  assert.match(text, /工作区 就绪/);
  assert.match(text, /差异 3（暂存 1 \/ 未暂存 1 \/ 未跟踪 1 \/ 冲突 0）/);
  assert.match(text, /待审批 2/);
  assert.match(text, /远端状态[：:]\s*仅本地/);
  assert.match(text, /已撤销授权 1/);
  assert.match(text, /approval-fixture/);
  assert.match(text, /待处理审批/);
  assert.match(text, /lease-fixture/);
  assert.match(text, /原执行进程已退出/);
  await page.locator('[data-action="navigate"][data-page="workbench"]').click();
  if (!(await page.locator('.app-shell').getAttribute('class')).includes('context-open')) await page.locator('.context-toggle').click();
  await page.locator('.council-section').waitFor();
  assert.equal(await page.locator('[data-council-kind="Judge"]').count(), 1);
  assert.equal(await page.locator('[data-council-kind="Proposal"]').count(), 0);
  assert.equal(await page.locator('[data-council-ranking="council-p1"]').count(), 1);
  assert.equal(await page.locator('[data-council-kind="Probe"]').count(), 1);
  assert.match(await page.locator('.council-section').innerText(), /暂无结构化审阅记录/);
  await page.locator('[data-action="navigate"][data-page="diagnostics"]').click();
  await page.locator('[data-action="export-data"]').click();
  await page.waitForTimeout(500);
  console.log(await page.locator('.page-placeholder').innerText());
  await page.getByText('导出完成：C:/fixture/exports/export-all-1.json', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS diagnostics recovery detail and export completion feedback');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
