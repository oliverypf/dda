import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runClosedHook } from '../on-closed.mjs';
import { resolveSoftContrast, runDayloopSoft } from '../dayloop-soft.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(OFFLOOP, 'out-dayloop-tip-soft-adopt-live-r1');
const HARNESS = path.join(OUT, 'tip-soft-adopt-live.mjs');
const EVIDENCE = path.join(OUT, 'adopt-evidence.json');
const CHILD_NODE = fs.existsSync('/home/box/.local/node24/bin/node')
  ? '/home/box/.local/node24/bin/node' : process.execPath;
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const SUBJECTS = Object.freeze(['t3/a', 't3/b']);
const CREDS = Object.freeze({ model: 'deepseek-v4.1-flash', jev: 'jev-latest' });
const TIP_PATHS = Object.freeze([
  '/workspace/dda-drive/bench/t3/run171a.jsonl',
  '/workspace/dda-drive/bench/t3/run171b.jsonl',
]);
const LOCKED = Object.freeze({
  'dayloop-soft.mjs': '3dcbb96acbf980d3b73019920b247a04e1b7d85b72d0e858b4b0b55bcb6ab213',
  'on-closed.mjs': '6181dea75e82b3ecbe47e0132a99d026438a8a7aef97243f0a23f16d282f6995',
  'probe-l1.mjs': 'd4d5059e5e048c5090a3f866c3fd72e8828b2f93a61c2bc27bd7d5402d77b0de',
});
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const sha = (file) => digest(fs.readFileSync(file));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function temporaryRoot(t, label) {
  const root = fs.mkdtempSync(path.join(OUT, `.test-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function guardedChild(t, args, { forbidSubprocess = false, optIn = false } = {}) {
  const root = temporaryRoot(t, 'guard');
  const countsPath = path.join(root, 'network.jsonl');
  const guardPath = path.join(root, 'guard.cjs');
  fs.writeFileSync(guardPath, `
const fs = require('node:fs');
const net = require('node:net');
const cp = require('node:child_process');
const counts = { fetch: 0, socket: 0, childProcess: 0 };
globalThis.fetch = () => { counts.fetch++; throw new Error('forbidden fetch'); };
net.Socket.prototype.connect = function () { counts.socket++; throw new Error('forbidden socket'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = (...args) => {
    if (!${forbidSubprocess} && name === 'spawnSync' && [process.execPath, 'git'].includes(args[0])) return original(...args);
    counts.childProcess++; throw new Error('forbidden subprocess');
  };
}
require('node:module').syncBuiltinESMExports();
process.on('exit', () => fs.appendFileSync(${JSON.stringify(countsPath)}, JSON.stringify(counts) + '\\n'));
`);
  const env = {
    ...process.env, TMPDIR: root, NODE_OPTIONS: '',
    DDA_OFFLOOP_REAL_LIVE: optIn ? '1' : '',
    OPENCODE_GO_API_KEY: optIn ? 'control-only-never-sent' : '',
    OPENROUTER_API_KEY: '', OFFLOOP_DAYLOOP_SOFT: '', DDA_OFFLOOP_DAYLOOP_SOFT: '',
  };
  delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(env)) {
    if (/OPENCODE.*SESSION|SESSION.*OPENCODE/i.test(name)) delete env[name];
  }
  const stdoutPath = path.join(root, 'stdout');
  const stderrPath = path.join(root, 'stderr');
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  let child;
  try {
    child = spawnSync(CHILD_NODE, ['--require', guardPath, '--test-reporter=tap', ...args], {
      cwd: OFFLOOP, env, stdio: ['ignore', stdoutFd, stderrFd], timeout: 60_000,
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  assert.equal(Boolean(child.error), false, 'guarded child completes without an execution error');
  assert.equal(child.signal, null, 'guarded child completes before its deadline');
  assert.equal(fs.existsSync(countsPath), true, 'child installed its network/subprocess guards');
  const counts = fs.readFileSync(countsPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(counts.length > 0);
  for (const count of counts) {
    assert.deepEqual(count, { fetch: 0, socket: 0, childProcess: 0 }, 'no fetch/socket/live subprocess');
  }
  return { status: child.status, stdout: fs.readFileSync(stdoutPath, 'utf8'), stderr: fs.readFileSync(stderrPath, 'utf8') };
}

function assertNoCandidate(summary) {
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  for (const row of summary.results) {
    assert.equal(row.wroteCandidate, false);
    assert.equal(row.candidatePath, null);
  }
}

function seedClosedDrive(t, { withSoftPair = true } = {}) {
  const root = temporaryRoot(t, 'closed');
  const benchLogPath = path.join(root, 'bench-log-run180.md');
  fs.writeFileSync(benchLogPath, `# Bench log — run180 negative dispatch control

- **Tip**: \`${PIN}\`
- **Status**: CLOSED MISS
- GATE: **MISS**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run180a | t3/a | **MISS** | poison-loop |
| t3/run180b | t3/b | **MISS** | companion |
`);
  const bench = path.join(root, 'bench/t3');
  fs.mkdirSync(bench, { recursive: true });
  const pair = withSoftPair ? readJson(EVIDENCE).softPairPaths : [];
  for (const [index, cell] of ['a', 'b'].entries()) {
    fs.copyFileSync(TIP_PATHS[index], path.join(bench, `run180${cell}.jsonl`));
    if (withSoftPair) fs.copyFileSync(pair[index], path.join(bench, `run180${cell}-soft.jsonl`));
  }
  return { root, benchLogPath, outDir: path.join(root, 'out'), softDir: path.join(root, 'soft') };
}

function runClosed(seed, opts = {}) {
  let dayloopCalls = 0;
  const result = runClosedHook({
    runId: '180', drive: seed.root, benchLogPath: seed.benchLogPath,
    outDir: seed.outDir, softWorktree: seed.softDir,
    dayloopSoft: true, dayloopFixture: 'soft-clean', ...opts,
    dayloopRunner: (options) => { dayloopCalls++; return runDayloopSoft(options); },
    invoker: () => assert.fail('MISS must use dayloop'),
  });
  return { result, dayloopCalls };
}

function assertRejected(seed, reason, opts) {
  const { result, dayloopCalls } = runClosed(seed, { l1Mode: 'live', l1Subjects: SUBJECTS, ...opts });
  assert.equal(dayloopCalls, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision.action, 'miss');
  assert.deepEqual(result.candidatePaths, []);
  const summary = result.dayloopSummary;
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1Bounded, true);
  assertNoCandidate(summary);
  assert.equal(fs.existsSync(seed.softDir), false, 'rejection precedes worktree creation');
  assert.ok(summary.results.length > 0);
  for (const row of summary.results) {
    assert.equal(row.adopt, false);
    assert.equal(row.l1.adopt, false);
    assert.equal(row.l1.rejected, true);
    assert.equal(row.l1.reason, reason);
    assert.equal(row.l1.softWriteCount ?? 0, 0);
  }
}

test('T-dtsal-1: new bounded Go burn links true tip/soft pairs to actual adopt or honest TRANSPORT; default, marker and replay cannot reburn', (t) => {
  assert.equal(fs.existsSync(HARNESS), true);
  assert.equal(fs.existsSync(EVIDENCE), true, 'new deliberate burn evidence is required');
  const evidence = readJson(EVIDENCE);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.model, CREDS.model);
  assert.equal(evidence.jev, CREDS.jev);
  assert.equal(evidence.endpointHost, 'opencode.ai');
  assert.equal(evidence.tipSha, PIN);
  assert.equal(evidence.realBurnCount, 1);
  assert.equal(evidence.burnFamilyCount, 1);
  assert.equal(evidence.retryCount, 0);
  assert.equal(evidence.mainOpenRouterCalls, 0);
  assert.equal(evidence.jevNetworkCalls, 0);
  assert.equal(evidence.goKeyPresent, true);
  assert.equal(evidence.sessionHeaderPresent, true);
  assert.deepEqual(evidence.subjects, SUBJECTS);
  assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= 0);
  assert.ok(['success', 'TRANSPORT'].includes(evidence.result));
  assert.equal(evidence.baselineSource, 'run');
  assert.equal(evidence.softSource, 'run-pair');
  assert.equal(evidence.softFallback, false);
  assert.equal(evidence.softProvenance, 'tip-derived-run-pair');
  assert.equal(evidence.historicalRunVerdict, 'CLOSED PASS');
  assert.equal(evidence.dispatchControlVerdict, 'CLOSED MISS');
  assert.deepEqual(evidence.tipBaselinePaths, TIP_PATHS);
  assert.equal(evidence.softPairPaths.length, 2);
  assert.equal(evidence.baselineArtifacts.length, 2);
  assert.equal(evidence.softArtifacts.length, 2);
  const fixtures = fs.readdirSync(path.join(OFFLOOP, 'test/fixtures'))
    .filter((name) => /^l1-soft-.*\.jsonl$/.test(name) || name === 'e2e-soft-baseline.jsonl')
    .map((name) => sha(path.join(OFFLOOP, 'test/fixtures', name)));
  for (const [i, canonical] of TIP_PATHS.entries()) {
    const baselineHash = sha(canonical);
    const baseline = evidence.baselineArtifacts[i];
    assert.ok(fs.statSync(canonical).size > 0);
    assert.equal(baseline.sourcePath, canonical);
    assert.equal(baseline.sha256, baselineHash);
    assert.equal(baseline.sizeBytes, fs.statSync(canonical).size);
    assert.equal(sha(baseline.path), baselineHash);
    const softPath = evidence.softPairPaths[i];
    assert.equal(softPath.startsWith(OUT + path.sep + 'temporary-miss-drive-'), true, 'new knife owns a separate soft pair');
    assert.ok(fs.statSync(softPath).size > 0);
    assert.equal(fixtures.includes(sha(softPath)), false, 'soft pair cannot be a renamed fixture');
    const soft = evidence.softArtifacts[i];
    assert.equal(soft.path, softPath);
    assert.equal(soft.sourcePath, canonical);
    assert.equal(soft.sha256, sha(softPath));
    assert.equal(soft.sizeBytes, fs.statSync(softPath).size);
    const sourceLines = fs.readFileSync(canonical, 'utf8').trim().split('\n');
    const projected = fs.readFileSync(softPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(projected.length > 0 && projected.length < sourceLines.length);
    const expectedLines = sourceLines.flatMap((line, index) => {
      const event = JSON.parse(line);
      return event.type === 'runtime_event' && /^(topology\.|harness\.|verification\.|run\.(started|failed|completed)$)/.test(event.kind || '') ? [index + 1] : [];
    });
    assert.deepEqual(projected.map((row) => row.softProjection?.sourceLine), expectedLines);
    for (const row of projected) {
      const { softProjection, ...event } = row;
      assert.equal(softProjection.sourcePath, canonical);
      assert.equal(softProjection.sourceSha256, baselineHash);
      assert.equal(softProjection.policy, 'retain-gate-events-v1');
      assert.deepEqual(event, JSON.parse(sourceLines[softProjection.sourceLine - 1]), 'real event payload and order remain intact');
    }
  }
  const summary = evidence.dayloopSummary;
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.l1Bounded, true);
  assert.deepEqual(summary.l1Subjects, SUBJECTS);
  assert.equal(summary.tipSha, PIN);
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.baselineFallback, false);
  assert.equal(summary.softSource, 'run-pair');
  assert.equal(summary.softFallback, false);
  assert.deepEqual(summary.softJsonlPaths, evidence.softPairPaths);
  assert.deepEqual(summary.baselineJsonlPaths, evidence.baselineArtifacts.map((row) => row.path));
  assert.equal(evidence.dayloopInvoked, true);
  assert.equal(evidence.cliExitCode, 0);
  assert.deepEqual(evidence.cliNetworkCalls, { fetch: 0, socket: 0, curl: 1, otherSubprocess: 0 });
  assert.deepEqual(evidence.cliOptions, { l1Mode: 'live', l1Live: true, l1Subjects: [...SUBJECTS], ...CREDS });
  assert.equal(evidence.cliSourceSha256, LOCKED['on-closed.mjs']);
  assertNoCandidate(summary);
  assert.ok(summary.results.length > 0);
  const actualAdopt = summary.results.some((row) => row.adopt === true || row.l1?.adopt === true);
  assert.equal(evidence.adopt, actualAdopt, 'adopt must come from the real evaluator');
  if (evidence.result === 'TRANSPORT') {
    assert.equal(actualAdopt, false, 'TRANSPORT is honest failure, never adopt success');
    assert.ok(evidence.httpStatus != null || typeof evidence.transportClass === 'string');
    for (const row of summary.results) {
      assert.equal(row.adopt, false);
      assert.equal(row.l1.adopt, false);
      assert.equal(row.l1.reason, 'transport');
    }
  } else {
    assert.equal(actualAdopt, true, 'PASS requires at least one actual successful adopt');
    assert.ok(evidence.httpStatus >= 200 && evidence.httpStatus < 300);
    for (const row of summary.results) {
      assert.equal(row.l1.tipShaBaseline, PIN);
      assert.match(row.l1.softTreeFileListHash, /^[a-f0-9]{64}$/);
      if (row.adopt || row.l1.adopt) assert.ok(['shipped_duplicate', 'experience_only'].includes(row.reason));
    }
  }
  const markerPath = path.join(OUT, 'real-burn-started.json');
  const recordPath = path.join(OUT, 'transport-record.json');
  const requestPath = path.join(OUT, 'request-evidence.json');
  const manifestPath = path.join(OUT, 'adopt-manifest.json');
  const immutableFiles = [EVIDENCE, markerPath, recordPath, requestPath, manifestPath];
  const originalHashes = immutableFiles.map(sha);
  const marker = readJson(markerPath);
  const record = readJson(recordPath);
  const request = readJson(requestPath);
  assert.equal(record.realBurnCount, 1);
  assert.equal(record.burnFamilyCount, 1);
  assert.equal(record.retryCount, 0);
  assert.equal(record.mainOpenRouterCalls, 0);
  assert.equal(record.dispatchContext, 'inside-dayloop-cli-adapter');
  assert.equal(record.result, evidence.result);
  assert.equal(record.httpStatus, evidence.httpStatus);
  assert.equal(marker.requestAttemptLimit, 1);
  assert.equal(marker.requestSha256, record.requestSha256);
  assert.equal(request.requestSha256, record.requestSha256);
  assert.equal(digest(JSON.stringify(request.payload)), record.requestSha256);
  assert.equal(marker.manifestSha256, sha(manifestPath));
  assert.equal(record.manifestSha256, sha(manifestPath));
  const oldMarker = readJson(path.join(OFFLOOP, 'out-dayloop-tip-soft-contrast-live-r1/real-burn-started.json'));
  assert.ok(Date.parse(marker.startedAt) > Date.parse(oldMarker.startedAt), 'this knife performed a new burn after wave7');
  assert.notEqual(marker.requestSha256, oldMarker.requestSha256, 'wave7 request/transport cannot masquerade as new evidence');
  assert.equal(request.payload.model, CREDS.model);
  assert.equal(request.payload.stream, false);
  const auditInput = JSON.parse(request.payload.messages.find((row) => row.role === 'user').content);
  assert.equal(auditInput.tipSha, PIN);
  assert.deepEqual(auditInput.subjects, SUBJECTS);
  assert.equal(auditInput.softProvenance, evidence.softProvenance);
  assert.deepEqual(auditInput.baselineArtifacts, evidence.baselineArtifacts);
  assert.deepEqual(auditInput.softArtifacts, evidence.softArtifacts);
  assert.deepEqual(auditInput.observations, evidence.observations);
  for (const [i, observation] of auditInput.observations.entries()) {
    assert.equal(observation.subject, SUBJECTS[i]);
    assert.ok(observation.baseline.eventCount > observation.soft.eventCount && observation.soft.eventCount > 0);
    assert.ok(observation.baseline.gateEvents.length > 0);
    assert.deepEqual(observation.soft.gateEvents, observation.baseline.gateEvents);
  }
  for (const [name, hash] of Object.entries(LOCKED)) {
    assert.equal(sha(path.join(OFFLOOP, name)), hash, 'locked product remains byte-identical');
    assert.equal(sha(path.join(evidence.root, 'offloop', name)), hash, 'CLI executes byte-identical product copies');
  }
  const artifactText = immutableFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|SESSION)/i.test(name) && secret.length >= 8) {
      assert.equal(artifactText.includes(secret), false, 'credential/session values are absent');
    }
  }
  assert.equal(/(?:Authorization\s*:|Bearer\s+|x-opencode-session\s*[:=])/i.test(artifactText), false);
  const denied = guardedChild(t, [HARNESS], { forbidSubprocess: true });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stdout + denied.stderr, /real_live_opt_in_required/);
  const second = guardedChild(t, [HARNESS], { forbidSubprocess: true, optIn: true });
  assert.notEqual(second.status, 0);
  assert.match(second.stdout + second.stderr, /real_burn_already_attempted_use_replay/);
  const replay = guardedChild(t, [HARNESS, '--replay'], { optIn: true });
  assert.equal(replay.status, 0, 'replay evaluates the stored record without another request');
  const replayEvidence = readJson(path.join(OUT, 'replay-evidence.json'));
  assert.deepEqual(replayEvidence.cliNetworkCalls, { fetch: 0, socket: 0, curl: 0, otherSubprocess: 0 });
  assert.equal(replayEvidence.adopt, evidence.adopt);
  assert.equal(replayEvidence.result, evidence.result);
  assert.deepEqual(immutableFiles.map(sha), originalHashes, 'default, second attempt and replay preserve original burn evidence');
  t.diagnostic(`new realBurnCount=1; actual adopt=${actualAdopt}; result=${evidence.result}; softSource=run-pair; default/marker/replay fetch/socket/burn=0`);
});

test('T-dtsal-2: missing soft pair, credentials, bounds and opt-in reject or show fallback; no fake-green candidate', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('negative controls must not fetch'));
  const socket = t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('negative controls must not open a socket'));
  const { preflight } = await import('../out-dayloop-tip-soft-adopt-live-r1/tip-soft-adopt-live.mjs');
  const allowed = {
    env: { DDA_OFFLOOP_REAL_LIVE: '1', OPENCODE_GO_API_KEY: 'control-only-never-sent' },
    dependencyText: '# dayloop-tip-soft-contrast-live-r1 — CLOSED — PASS',
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
  const excess = Object.freeze(['t3/a', 't3/b', 't3/c']);
  assert.deepEqual(preflight({ ...allowed, subjects: excess }), { ok: false, reason: 'bound_exceeded' });
  const pair = readJson(EVIDENCE).softPairPaths;
  assert.deepEqual(preflight({ ...allowed, softPairPaths: pair }), { ok: true });
  const empty = path.join(temporaryRoot(t, 'empty-pair'), 'empty-soft.jsonl');
  fs.writeFileSync(empty, '');
  for (const softPairPaths of [[], pair.slice(0, 1), [empty, pair[1]], [`${empty}.missing`, pair[1]]]) {
    assert.deepEqual(preflight({ ...allowed, softPairPaths }), { ok: false, reason: 'soft_pair_required' });
  }
  for (const opts of [{}, { model: CREDS.model }, { jev: CREDS.jev }, { model: '  ', jev: CREDS.jev }]) {
    assertRejected(seedClosedDrive(t), 'live_requires_model_jev', opts);
  }
  assertRejected(seedClosedDrive(t), 'bound_exceeded', { ...CREDS, l1Subjects: excess });
  assert.deepEqual(excess, ['t3/a', 't3/b', 't3/c'], 'bounds reject without truncating');
  const missing = seedClosedDrive(t, { withSoftPair: false });
  const resolved = resolveSoftContrast({ runId: '180', drive: missing.root, fromMiss: true, fixture: 'soft-clean' });
  assert.equal(resolved.softSource, 'fixture-fallback');
  assert.equal(resolved.fallback, true);
  assert.match(resolved.reason || '', /missing_soft_pair/);
  const { result: fallback, dayloopCalls } = runClosed(missing, { ...CREDS, l1Mode: 'live', l1Subjects: SUBJECTS });
  assert.equal(dayloopCalls, 1);
  assert.equal(fallback.exitCode, 0);
  assert.deepEqual(fallback.candidatePaths, []);
  assert.equal(fallback.dayloopSummary.baselineSource, 'run');
  assert.equal(fallback.dayloopSummary.softSource, 'fixture-fallback');
  assert.equal(fallback.dayloopSummary.softFallback, true);
  assertNoCandidate(fallback.dayloopSummary);
  const fallbackExperience = fs.readFileSync(fallback.dayloopSummary.softFallbackExperiencePath, 'utf8');
  assert.match(fallbackExperience, /softSource.*fixture-fallback/);
  assert.match(fallbackExperience, /adopted_candidate.*no/);
  assert.doesNotMatch(fallbackExperience, /softSource\*\*: run-pair/);
  for (const opts of [{}, CREDS]) {
    const { result } = runClosed(seedClosedDrive(t), opts);
    assert.equal(result.dayloopSummary.l1Mode, 'fixture');
    assert.equal(result.dayloopSummary.l1LiveRequested, false);
    assertNoCandidate(result.dayloopSummary);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(socket.mock.callCount(), 0);
  t.diagnostic('missing pair is explicit fixture-fallback; no opt-in/key/model/jev and >2 subjects reject; fake CANDIDATE=0; fetch/socket=0');
});

test('T-dtsal-3: T-dtscl, T-dlors, T-dlive and T-dcl1 remain green under guarded offline imports', (t) => {
  const child = guardedChild(t, ['--input-type=module', '-e', `
await import('./test/dayloop-tip-soft-contrast-live-r1.test.mjs');
await import('./test/dayloop-opt-in-real-live-smoke-r1.test.mjs');
await import('./test/dayloop-live-bounded-expand-r1.test.mjs');
await import('./test/dayloop-cli-l1-flags-r1.test.mjs');
`]);
  assert.equal(child.status, 0, 'prior guarded controls pass; provider/child output is never dumped into TAP');
  assert.equal(child.stdout.startsWith('TAP version 13'), true);
  for (const id of ['T-dtscl-1', 'T-dtscl-2', 'T-dtscl-3', 'T-dlors-1', 'T-dlors-2', 'T-dlors-3',
    'T-dlive-1', 'T-dlive-2', 'T-dcl1-1', 'T-dcl1-2', 'T-dcl1-3', 'T-dcl1-4', 'T-dcl1-5', 'T-dcl1-6']) {
    assert.match(child.stdout, new RegExp(`^ok \\d+ - ${id}:`, 'm'), `${id} passes with no live burn`);
  }
  assert.match(child.stdout, /^# fail 0\b/m);
  t.diagnostic('14 prior acceptance controls passed under fetch/socket guards and explicit TAP; no real burn');
});
