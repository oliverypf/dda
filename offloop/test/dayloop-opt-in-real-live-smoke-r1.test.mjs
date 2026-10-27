import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runClosedHook } from '../on-closed.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(OFFLOOP, 'out-dayloop-opt-in-real-live-smoke-r1');
const EVIDENCE = path.join(OUT, 'smoke-evidence.json');
const HARNESS = path.join(OUT, 'real-live-smoke.mjs');
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const CREDS = { model: 'deepseek-v4.1-flash', jev: 'jev-latest' };
const SUBJECTS = Object.freeze(['t3/a', 't3/b']);
const CONTROL_ARGS = Object.freeze([
  '--test', '--test-reporter=tap',
  // Node 20 must use its default isolation; opt out on Node 24 and newer.
  ...(Number(process.versions.node.split('.')[0]) >= 24 ? ['--test-isolation=none'] : []),
  'test/dayloop-live-bounded-expand-r1.test.mjs',
  'test/dayloop-cli-l1-flags-r1.test.mjs',
]);

function temporaryRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ol-dlors-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function guardedChild(t, args, { forbidSubprocess = false } = {}) {
  const root = temporaryRoot(t, 'guard');
  const countsPath = path.join(root, 'network.jsonl');
  const guardPath = path.join(root, 'guard.cjs');
  fs.writeFileSync(guardPath, `
const fs = require('node:fs');
const net = require('node:net');
const counts = { fetch: 0, socket: 0, childProcess: 0 };
globalThis.fetch = () => { counts.fetch++; throw new Error('forbidden network fetch'); };
net.Socket.prototype.connect = function () { counts.socket++; throw new Error('forbidden network socket'); };
if (${forbidSubprocess}) {
  const cp = require('node:child_process');
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[method] = () => { counts.childProcess++; throw new Error('forbidden subprocess before opt-in'); };
  }
}
require('node:module').syncBuiltinESMExports();
process.on('exit', () => fs.appendFileSync(process.env.DLORS_NETWORK_COUNTS, JSON.stringify(counts) + '\\n'));
`);
  const stdoutPath = path.join(root, 'stdout');
  const stderrPath = path.join(root, 'stderr');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    DLORS_NETWORK_COUNTS: countsPath,
    DDA_OFFLOOP_REAL_LIVE: '',
    OPENCODE_GO_API_KEY: '',
    OPENROUTER_API_KEY: '',
    OFFLOOP_DAYLOOP_SOFT: '',
    DDA_OFFLOOP_DAYLOOP_SOFT: '',
  };
  // Let the child select its own reporter instead of inheriting the parent's test IPC context.
  delete env.NODE_TEST_CONTEXT;
  let child;
  try {
    child = spawnSync(process.execPath, ['--require', guardPath, ...args], {
      cwd: OFFLOOP,
      env,
      stdio: ['ignore', stdoutFd, stderrFd],
      timeout: 60_000,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  const counts = fs.readFileSync(countsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(counts.length > 0, 'the protected child must install its guards');
  for (const count of counts) {
    assert.deepEqual(count, { fetch: 0, socket: 0, childProcess: 0 }, 'no real fetch/socket/subprocess burn');
  }
  return { args: [...args], status: child.status, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
}

function assertTapControls(child) {
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.ok(child.args.includes('--test-reporter=tap'), 'an explicit TAP reporter is required for TAP assertions');
  for (const id of ['T-dlive-1', 'T-dlive-2', 'T-dcl1-1', 'T-dcl1-2', 'T-dcl1-3', 'T-dcl1-4', 'T-dcl1-5', 'T-dcl1-6']) {
    assert.match(child.stdout, new RegExp(`^ok \\d+ - ${id}:`, 'm'));
  }
  assert.match(child.stdout, /^1\.\.8$/m);
  assert.match(child.stdout, /^# tests 8$/m);
  assert.match(child.stdout, /^# pass 8$/m);
  assert.match(child.stdout, /^# fail 0$/m);
}

function seedClosedDrive(t, { verdict = 'MISS', notes = 'poison-loop' } = {}) {
  const root = temporaryRoot(t, 'closed');
  const benchLogPath = path.join(root, 'bench-log-run178.md');
  fs.writeFileSync(benchLogPath, `# Bench log — run178 opt-in smoke control

- **Tip**: \`${PIN}\`
- **Status**: CLOSED ${verdict}
- GATE: **${verdict}**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run178a | t3/a | **${verdict}** | ${notes} |
| t3/run178b | t3/b | **${verdict}** | companion |
`);
  const benchDir = path.join(root, 'bench/t3');
  fs.mkdirSync(benchDir, { recursive: true });
  for (const cell of ['a', 'b']) {
    fs.copyFileSync(path.join(OFFLOOP, 'test/fixtures/e2e-soft-baseline.jsonl'), path.join(benchDir, `run178${cell}.jsonl`));
    fs.copyFileSync(path.join(OFFLOOP, 'test/fixtures/l1-soft-clean.jsonl'), path.join(benchDir, `run178${cell}-soft.jsonl`));
  }
  return { root, benchLogPath, outDir: path.join(root, 'out'), softDir: path.join(root, 'soft') };
}

function runClosed(seed, opts = {}) {
  let dayloopCalls = 0;
  const result = runClosedHook({
    runId: '178', drive: seed.root, benchLogPath: seed.benchLogPath,
    outDir: seed.outDir, softWorktree: seed.softDir,
    dayloopSoft: true, dayloopFixture: 'soft-clean',
    ...opts,
    dayloopRunner: (options) => { dayloopCalls++; return runDayloopSoft(options); },
    invoker: () => ({ status: 0, stdout: '', stderr: '' }),
  });
  return { result, dayloopCalls };
}

function assertRejected(seed, reason, opts) {
  const { result, dayloopCalls } = runClosed(seed, { l1Mode: 'live', l1Subjects: SUBJECTS, ...opts });
  assert.equal(dayloopCalls, 1);
  assert.equal(result.decision.action, 'miss');
  assert.deepEqual(result.candidatePaths, []);
  const summary = result.dayloopSummary;
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(fs.existsSync(seed.softDir), false);
  assert.ok(summary.results.length > 0);
  for (const row of summary.results) {
    assert.equal(row.adopt, false);
    assert.equal(row.wroteCandidate, false);
    assert.equal(row.candidatePath, null);
    assert.equal(row.l1.adopt, false);
    assert.equal(row.l1.rejected, true);
    assert.equal(row.l1.reason, reason);
    assert.equal(row.l1.softWriteCount ?? 0, 0);
  }
  assert.deepEqual(fs.readdirSync(seed.outDir).filter((name) => name.startsWith('freeze-candidate')), []);
}

test('T-dlors-1: persisted one-family real Go smoke has bounded CLI evidence; default harness refuses all network', (t) => {
  assert.ok(fs.existsSync(HARNESS), 'the deliberately invoked smoke harness must exist');
  assert.ok(fs.existsSync(EVIDENCE), 'run the explicit real smoke once before acceptance');
  const before = fs.readFileSync(EVIDENCE, 'utf8');
  const evidence = JSON.parse(before);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.model, CREDS.model);
  assert.equal(evidence.jev, CREDS.jev);
  assert.equal(evidence.endpointHost, 'opencode.ai');
  assert.equal(evidence.tipSha, PIN);
  assert.equal(evidence.realBurnCount, 1, 'exactly one bounded request was deliberately attempted');
  assert.equal(evidence.burnFamilyCount, 1, 'no retry or matrix expansion');
  assert.equal(evidence.mainOpenRouterCalls, 0);
  assert.deepEqual(evidence.subjects, SUBJECTS);
  assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= 0);
  assert.ok(['success', 'TRANSPORT'].includes(evidence.result));
  if (evidence.httpStatus != null) {
    assert.ok(Number.isInteger(evidence.httpStatus) && evidence.httpStatus >= 100 && evidence.httpStatus <= 599);
  }
  const summary = evidence.dayloopSummary;
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(summary.tipSha, PIN);
  assert.deepEqual(summary.l1Subjects, SUBJECTS);
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.baselineFallback, false);
  assert.equal(summary.softSource, 'run-pair');
  assert.equal(summary.softFallback, false);
  assert.ok(summary.results.length > 0, 'a seeded CLOSED MISS exercised bounded L1');
  if (evidence.result === 'TRANSPORT') {
    assert.ok(evidence.httpStatus != null || (typeof evidence.transportClass === 'string' && evidence.transportClass.length > 0));
    for (const row of summary.results) {
      assert.equal(row.adopt, false);
      assert.equal(row.wroteCandidate, false);
      assert.equal(row.candidatePath, null);
      assert.equal(row.l1.adopt, false);
      assert.equal(row.l1.reason, 'transport');
    }
  } else {
    assert.ok(evidence.httpStatus >= 200 && evidence.httpStatus < 300);
    for (const row of summary.results) {
      assert.equal(row.l1.tipShaBaseline, PIN);
      assert.match(row.l1.softTreeFileListHash, /^[a-f0-9]{64}$/);
      if (!row.wroteCandidate) assert.ok(['shipped_duplicate', 'experience_only'].includes(row.reason), 'an explicit EXPERIENCE-only reason must be visible');
    }
  }
  for (const name of ['OPENCODE_GO_API_KEY', 'OPENROUTER_API_KEY']) {
    const secret = process.env[name];
    if (secret && secret.length >= 8) assert.equal(before.includes(secret), false, `${name} value must not enter evidence`);
  }
  const denied = guardedChild(t, [HARNESS], { forbidSubprocess: true });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stdout + denied.stderr, /DDA_OFFLOOP_REAL_LIVE|opt.in/i);
  assert.equal(fs.readFileSync(EVIDENCE, 'utf8'), before, 'the default path must not replace real evidence');
  t.diagnostic(`persisted realBurnCount=1; burnFamilyCount=1; subjects=2; model=${CREDS.model}; result=${evidence.result}; default fetch/socket/subprocess=0`);
});

test('T-dlors-2: blank credentials and >2 subjects reject without calls/candidates; defaults and PASS remain zero-live', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('no live fetch allowed in controls'));
  const socket = t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('no live socket allowed in controls'));
  const { preflight } = await import('../out-dayloop-opt-in-real-live-smoke-r1/real-live-smoke.mjs');
  const allowed = {
    env: { DDA_OFFLOOP_REAL_LIVE: '1', OPENCODE_GO_API_KEY: 'fixture-only-never-sent' },
    dependencyText: '# dayloop-cli-l1-flags-r1 — CLOSED — PASS',
    tipSha: PIN, subjects: SUBJECTS, ...CREDS,
  };
  assert.deepEqual(preflight(allowed), { ok: true });
  assert.deepEqual(preflight({ ...allowed, env: {} }), { ok: false, reason: 'real_live_opt_in_required' });
  for (const key of ['', '  ']) {
    assert.deepEqual(preflight({ ...allowed, env: { ...allowed.env, OPENCODE_GO_API_KEY: key } }), { ok: false, reason: 'go_api_key_required' });
  }
  for (const field of ['model', 'jev']) {
    for (const value of ['', '  ', null]) {
      assert.deepEqual(preflight({ ...allowed, [field]: value }), { ok: false, reason: 'live_requires_model_jev' });
    }
  }
  assert.deepEqual(preflight({ ...allowed, dependencyText: '# dayloop-cli-l1-flags-r1 — FROZEN' }), { ok: false, reason: 'dependency_not_closed' });
  for (const opts of [
    {}, { model: CREDS.model }, { jev: CREDS.jev },
    { model: '', jev: CREDS.jev }, { model: '  ', jev: CREDS.jev },
    { model: CREDS.model, jev: '' }, { model: CREDS.model, jev: '  ' },
  ]) assertRejected(seedClosedDrive(t), 'live_requires_model_jev', opts);

  const excess = Object.freeze(['t3/a', 't3/b', 't3/c']);
  assert.deepEqual(preflight({ ...allowed, subjects: excess }), { ok: false, reason: 'bound_exceeded' });
  assertRejected(seedClosedDrive(t), 'bound_exceeded', { ...CREDS, l1Subjects: excess });
  assert.deepEqual(excess, ['t3/a', 't3/b', 't3/c'], 'reject the complete request without truncation');

  for (const opts of [{}, CREDS]) {
    const { result, dayloopCalls } = runClosed(seedClosedDrive(t), opts);
    assert.equal(dayloopCalls, 1);
    assert.equal(result.dayloopSummary.l1LiveRequested, false);
    assert.equal(result.dayloopSummary.l1Mode, 'fixture');
    assert.equal(result.dayloopSummary.frozenWrites, 0);
  }
  for (const [action, notes] of [['path-anomaly', 'agent_miss'], ['noop', 'clean']]) {
    const seed = seedClosedDrive(t, { verdict: 'PASS', notes });
    const { result, dayloopCalls } = runClosed(seed, { ...CREDS, l1Mode: 'live', l1Live: true, l1Subjects: SUBJECTS });
    assert.equal(result.decision.action, action);
    assert.equal(result.dayloopInvoked, false);
    assert.equal(dayloopCalls, 0);
    assert.deepEqual(result.candidatePaths, []);
    assert.equal(fs.existsSync(seed.softDir), false);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(socket.mock.callCount(), 0);
  t.diagnostic('7 credential rejects + 1 subject-bound reject; 0 candidates; 2 default controls; PASS path-anomaly/noop dayloop=0; fetch/socket=0');
});

test('T-dlors-3: T-dtrh-1 explicit TAP proves all eight protected T-dlive and T-dcl1 fixture controls pass', (t) => {
  const child = guardedChild(t, CONTROL_ARGS);
  assertTapControls(child);
  assert.throws(() => assertTapControls({ ...child, status: 1 }), { code: 'ERR_ASSERTION' }, 'passing prose cannot override a failed exit');
  assert.throws(() => assertTapControls({ ...child, stdout: child.stdout.replace(/^(ok \d+ - T-dlive-1:)/m, 'not $1') }), { code: 'ERR_ASSERTION' }, 'not ok must not match an ok substring');
  assert.throws(() => assertTapControls({ ...child, stdout: child.stdout.replace(/^# pass 8$/m, '# pass 80') }), { code: 'ERR_ASSERTION' }, 'the pass count must match exactly');
  t.diagnostic('Method A: status=0; explicit TAP 8/8 with all IDs; fetch/socket/forbidden-subprocess counters=0; fixture CLI subprocesses remain permitted');
});

test('T-dtrh-2: a protected child without an explicit TAP reporter cannot false-green', (t) => {
  const child = guardedChild(t, CONTROL_ARGS.filter((arg) => arg !== '--test-reporter=tap'));
  assert.equal(child.status, 0, child.stderr || child.stdout);
  // A redirected default may itself be TAP. Reject the missing reporter contract
  // explicitly, independent of Node version, terminal detection or prose shape.
  assert.throws(() => assertTapControls(child), /an explicit TAP reporter is required/);
  t.diagnostic('missing-reporter child exited 0 but TAP acceptance explicitly rejected it; fetch/socket/forbidden-subprocess counters=0');
});
