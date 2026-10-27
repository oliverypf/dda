import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runClosedHook } from '../on-closed.mjs';
import { resolveSoftContrast, runDayloopSoft } from '../dayloop-soft.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const OUT = path.join(OFFLOOP, 'out-dayloop-tip-soft-contrast-live-r1');
const HARNESS = path.join(OUT, 'tip-soft-contrast-live.mjs');
const EVIDENCE = path.join(OUT, 'contrast-evidence.json');
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const SUBJECTS = Object.freeze(['t3/a', 't3/b']);
const CREDS = Object.freeze({ model: 'deepseek-v4.1-flash', jev: 'jev-latest' });
const TIP_PATHS = Object.freeze([
  '/workspace/dda-drive/bench/t3/run171a.jsonl',
  '/workspace/dda-drive/bench/t3/run171b.jsonl',
]);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function temporaryRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ol-dtscl-${label}-`));
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
globalThis.fetch = () => { counts.fetch++; throw new Error('forbidden fetch'); };
net.Socket.prototype.connect = function () { counts.socket++; throw new Error('forbidden socket'); };
if (${forbidSubprocess}) {
  const cp = require('node:child_process');
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    cp[key] = () => { counts.childProcess++; throw new Error('forbidden subprocess before opt-in'); };
  }
}
require('node:module').syncBuiltinESMExports();
process.on('exit', () => fs.appendFileSync(${JSON.stringify(countsPath)}, JSON.stringify(counts) + '\\n'));
`);
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    DDA_OFFLOOP_REAL_LIVE: '',
    OPENCODE_GO_API_KEY: '',
    OPENROUTER_API_KEY: '',
    OFFLOOP_DAYLOOP_SOFT: '',
    DDA_OFFLOOP_DAYLOOP_SOFT: '',
  };
  // An importer under a test worker otherwise inherits the binary child protocol.
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
    child = spawnSync(process.execPath, ['--require', guardPath, '--test-reporter=tap', ...args], {
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
    assert.deepEqual(count, { fetch: 0, socket: 0, childProcess: 0 }, 'zero guarded calls');
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

function seedClosedDrive(t, { verdict = 'MISS', notes = 'poison-loop', withSoftPair = true } = {}) {
  const root = temporaryRoot(t, 'closed');
  const benchLogPath = path.join(root, 'bench-log-run179.md');
  fs.writeFileSync(benchLogPath, `# Bench log — run179 tip-derived contrast control

- **Tip**: \`${PIN}\`
- **Status**: CLOSED ${verdict}
- GATE: **${verdict}**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run179a | t3/a | **${verdict}** | ${notes} |
| t3/run179b | t3/b | **${verdict}** | companion |
`);
  const bench = path.join(root, 'bench/t3');
  fs.mkdirSync(bench, { recursive: true });
  const softPairPaths = withSoftPair ? readJson(EVIDENCE).softPairPaths : [];
  for (const [index, cell] of ['a', 'b'].entries()) {
    fs.copyFileSync(TIP_PATHS[index], path.join(bench, `run179${cell}.jsonl`));
    if (withSoftPair) fs.copyFileSync(softPairPaths[index], path.join(bench, `run179${cell}-soft.jsonl`));
  }
  return { root, benchLogPath, outDir: path.join(root, 'out'), softDir: path.join(root, 'soft') };
}

function runClosed(seed, opts = {}) {
  let dayloopCalls = 0;
  let missCalls = 0;
  const result = runClosedHook({
    runId: '179', drive: seed.root, benchLogPath: seed.benchLogPath,
    outDir: seed.outDir, softWorktree: seed.softDir,
    dayloopSoft: true, dayloopFixture: 'soft-clean',
    ...opts,
    dayloopRunner: (options) => { dayloopCalls++; return runDayloopSoft(options); },
    invoker: () => { missCalls++; return { status: 0, stdout: '', stderr: '' }; },
  });
  return { result, dayloopCalls, missCalls };
}

function assertRejected(seed, reason, opts) {
  const { result, dayloopCalls, missCalls } = runClosed(seed, { l1Mode: 'live', l1Subjects: SUBJECTS, ...opts });
  assert.equal(dayloopCalls, 1);
  assert.equal(missCalls, 0);
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

test('T-dtscl-1: persisted one-family Go burn uses canonical tip runs and a traceable soft projection; default refuses before calls', (t) => {
  assert.equal(fs.existsSync(HARNESS), true, 'the explicit contrast harness exists');
  assert.equal(fs.existsSync(EVIDENCE), true, 'the deliberately invoked once-only contrast evidence exists');
  const before = fs.readFileSync(EVIDENCE, 'utf8');
  const evidence = JSON.parse(before);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.model, CREDS.model);
  assert.equal(evidence.jev, CREDS.jev);
  assert.equal(evidence.endpointHost, 'opencode.ai');
  assert.equal(evidence.tipSha, PIN);
  assert.equal(evidence.realBurnCount, 1);
  assert.equal(evidence.burnFamilyCount, 1);
  assert.equal(evidence.mainOpenRouterCalls, 0);
  assert.deepEqual(evidence.subjects, SUBJECTS);
  assert.ok(Number.isFinite(evidence.elapsedMs) && evidence.elapsedMs >= 0);
  assert.ok(['success', 'TRANSPORT'].includes(evidence.result));
  assert.equal(evidence.baselineSource, 'run');
  assert.equal(evidence.softSource, 'run-pair');
  assert.equal(evidence.softFallback, false);
  assert.equal(evidence.softProvenance, 'tip-derived-run-pair');
  assert.deepEqual(evidence.tipBaselinePaths, TIP_PATHS, 'record the canonical run171 artifacts, not only temporary copies');
  assert.equal(evidence.softPairPaths.length, 2);
  assert.equal(evidence.baselineArtifacts.length, 2);
  assert.equal(evidence.softArtifacts.length, 2);
  const fixtureSha = sha(path.join(OFFLOOP, 'test/fixtures/l1-soft-clean.jsonl'));
  const baselineFixtureSha = sha(path.join(OFFLOOP, 'test/fixtures/e2e-soft-baseline.jsonl'));
  for (let i = 0; i < TIP_PATHS.length; i++) {
    const canonical = TIP_PATHS[i];
    const baselineHash = sha(canonical);
    assert.ok(fs.statSync(canonical).size > 0);
    const baselineArtifact = evidence.baselineArtifacts[i];
    assert.equal(baselineArtifact.sourcePath, canonical);
    assert.equal(baselineArtifact.sha256, baselineHash);
    assert.equal(baselineArtifact.sizeBytes, fs.statSync(canonical).size);
    assert.equal(sha(baselineArtifact.path), baselineHash, 'temporary baseline is byte-identical to canonical tip');
    const softPath = evidence.softPairPaths[i];
    assert.equal(path.isAbsolute(softPath), true);
    assert.equal(softPath.startsWith(OUT + path.sep + 'temporary-miss-drive-'), true, 'soft pair remains in the inspectable temporary MISS drive');
    assert.equal(new RegExp(`^run\\d+${i === 0 ? 'a' : 'b'}-soft\\.jsonl$`).test(path.basename(softPath)), true);
    assert.ok(fs.statSync(softPath).size > 0);
    assert.notEqual(sha(softPath), fixtureSha, 'soft pair cannot be renamed l1-soft-clean fixture');
    assert.notEqual(sha(softPath), baselineFixtureSha, 'soft pair cannot be renamed e2e baseline fixture');
    const softArtifact = evidence.softArtifacts[i];
    assert.equal(softArtifact.path, softPath);
    assert.equal(softArtifact.sourcePath, canonical);
    assert.equal(softArtifact.sha256, sha(softPath));
    assert.equal(softArtifact.sizeBytes, fs.statSync(softPath).size);
    const sourceLines = fs.readFileSync(canonical, 'utf8').trim().split('\n');
    const projected = fs.readFileSync(softPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(projected.length > 0 && projected.length < sourceLines.length, 'projection retains a nonempty subset of actual tip events');
    const expectedLines = sourceLines.flatMap((line, index) => {
      const event = JSON.parse(line);
      return event.type === 'runtime_event' && /^(topology\.|harness\.|verification\.|run\.(started|failed|completed)$)/.test(event.kind || '') ? [index + 1] : [];
    });
    assert.deepEqual(projected.map((row) => row.softProjection?.sourceLine), expectedLines, 'retain every applicable source gate event in order');
    for (const row of projected) {
      const { softProjection, ...event } = row;
      assert.equal(softProjection.sourcePath, canonical);
      assert.equal(softProjection.sourceSha256, baselineHash);
      assert.equal(softProjection.policy, 'retain-gate-events-v1');
      assert.deepEqual(event, JSON.parse(sourceLines[softProjection.sourceLine - 1]), 'projection preserves the actual event payload, kind and sequence');
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
  assert.deepEqual(evidence.cliNetworkCalls, { fetch: 0, socket: 0, curl: 1, otherSubprocess: 0 }, 'the only real Go request was dispatched inside the CLI adapter');
  assert.deepEqual(evidence.cliOptions, { l1Mode: 'live', l1Live: true, l1Subjects: [...SUBJECTS], ...CREDS });
  assert.equal(evidence.cliSourceSha256, sha(path.join(OFFLOOP, 'on-closed.mjs')), 'CLI source remains unmodified');
  assertNoCandidate(summary);
  assert.ok(summary.results.length > 0, 'real tip events exercise bounded L1');
  if (evidence.result === 'TRANSPORT') {
    assert.ok(evidence.httpStatus != null || (typeof evidence.transportClass === 'string' && evidence.transportClass.length > 0));
    for (const row of summary.results) {
      assert.equal(row.adopt, false);
      assert.equal(row.l1.adopt, false);
      assert.equal(row.l1.reason, 'transport');
    }
  } else {
    assert.ok(evidence.httpStatus >= 200 && evidence.httpStatus < 300);
    for (const row of summary.results) {
      assert.equal(row.l1.tipShaBaseline, PIN);
      assert.equal(/^[a-f0-9]{64}$/.test(row.l1.softTreeFileListHash || ''), true);
      if (row.l1.adopt) assert.ok(['shipped_duplicate', 'experience_only'].includes(row.reason), 'positive probe cannot create a fresh candidate');
    }
  }
  const marker = path.join(OUT, 'real-burn-started.json');
  const transport = path.join(OUT, 'transport-record.json');
  const requestPath = path.join(OUT, 'request-evidence.json');
  const manifestPath = path.join(OUT, 'contrast-manifest.json');
  const evidenceFiles = [EVIDENCE, marker, transport, requestPath, manifestPath];
  const evidenceHashes = evidenceFiles.map(sha);
  const record = readJson(transport);
  assert.equal(record.realBurnCount, 1);
  assert.equal(record.burnFamilyCount, 1);
  assert.equal(record.retryCount, 0);
  assert.equal(record.mainOpenRouterCalls, 0);
  assert.equal(record.dispatchContext, 'inside-dayloop-cli-adapter');
  assert.equal(record.result, evidence.result);
  assert.equal(record.httpStatus, evidence.httpStatus);
  const burnMarker = readJson(marker);
  const request = readJson(requestPath);
  assert.equal(burnMarker.requestAttemptLimit, 1);
  assert.equal(burnMarker.requestSha256, record.requestSha256);
  assert.equal(request.requestSha256, record.requestSha256);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(request.payload)).digest('hex'), record.requestSha256);
  assert.equal(burnMarker.manifestSha256, sha(manifestPath));
  assert.equal(record.manifestSha256, sha(manifestPath));
  assert.equal(request.payload.model, CREDS.model);
  assert.equal(request.payload.stream, false);
  const contrastRequest = JSON.parse(request.payload.messages.find((row) => row.role === 'user').content);
  assert.equal(contrastRequest.tipSha, PIN);
  assert.deepEqual(contrastRequest.subjects, SUBJECTS);
  assert.equal(contrastRequest.softProvenance, 'tip-derived-run-pair');
  assert.deepEqual(contrastRequest.baselineArtifacts, evidence.baselineArtifacts);
  assert.deepEqual(contrastRequest.softArtifacts, evidence.softArtifacts);
  assert.deepEqual(contrastRequest.observations, evidence.observations, 'Go request contains the actual persisted tip/soft observations');
  assert.equal(contrastRequest.observations.length, 2);
  for (const [index, observation] of contrastRequest.observations.entries()) {
    assert.equal(observation.subject, SUBJECTS[index]);
    assert.ok(observation.baseline.eventCount > observation.soft.eventCount && observation.soft.eventCount > 0);
    assert.ok(observation.baseline.gateEvents.length > 0);
    assert.deepEqual(observation.soft.gateEvents, observation.baseline.gateEvents, 'tip-derived soft side preserves actual gate evidence');
  }
  const artifactText = evidenceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/OPENCODE.*(?:KEY|SESSION)|(?:KEY|SESSION).*OPENCODE|OPENROUTER_API_KEY/i.test(name) && secret.length >= 8) {
      assert.equal(artifactText.includes(secret), false, 'credential/session values stay out of persisted evidence');
    }
  }
  assert.equal(/(?:Authorization\s*:|Bearer\s+|x-opencode-session\s*[:=])/i.test(artifactText), false, 'raw authentication headers are absent');
  const denied = guardedChild(t, [HARNESS], { forbidSubprocess: true });
  assert.notEqual(denied.status, 0);
  assert.equal(/real_live_opt_in_required/.test(denied.stdout + denied.stderr), true, 'default refusal is explicit');
  assert.deepEqual(evidenceFiles.map(sha), evidenceHashes, 'default invocation never replaces evidence or burn records');
  t.diagnostic('realBurnCount=1; burnFamilyCount=1; canonical run171 a/b; softSource=run-pair; each projected event verified against tip; default fetch/socket/subprocess=0');
});

test('T-dtscl-2: absent pair is visible; credentials/bounds/opt-in reject; fixture default and PASS controls never burn', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('controls must not fetch'));
  const socket = t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('controls must not open a socket'));
  const { preflight } = await import('../out-dayloop-tip-soft-contrast-live-r1/tip-soft-contrast-live.mjs');
  const allowed = {
    env: { DDA_OFFLOOP_REAL_LIVE: '1', OPENCODE_GO_API_KEY: 'control-only-never-sent' },
    dependencyText: '# dayloop-cli-l1-flags-r1 — CLOSED — PASS\n# dayloop-opt-in-real-live-smoke-r1 — CLOSED — PASS',
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
  assert.deepEqual(excess, ['t3/a', 't3/b', 't3/c'], 'excess subjects are rejected without truncation');

  const missing = seedClosedDrive(t, { withSoftPair: false });
  const resolved = resolveSoftContrast({ runId: '179', drive: missing.root, fromMiss: true, fixture: 'soft-clean' });
  assert.equal(resolved.softSource, 'fixture-fallback');
  assert.equal(resolved.fallback, true);
  assert.equal(/missing_soft_pair/.test(resolved.reason || ''), true);
  const { result: fallback, dayloopCalls } = runClosed(missing, { ...CREDS, l1Mode: 'live', l1Subjects: SUBJECTS });
  assert.equal(dayloopCalls, 1);
  assert.equal(fallback.exitCode, 0);
  assert.deepEqual(fallback.candidatePaths, []);
  const summary = fallback.dayloopSummary;
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.softSource, 'fixture-fallback');
  assert.equal(summary.softFallback, true);
  assert.ok(summary.softFallbackReason);
  assertNoCandidate(summary);
  const fallbackExperience = fs.readFileSync(summary.softFallbackExperiencePath, 'utf8');
  assert.equal(/softSource.*fixture-fallback/.test(fallbackExperience), true);
  assert.equal(/adopted_candidate.*no/.test(fallbackExperience), true);
  assert.equal(/softSource\*\*: run-pair/.test(fallbackExperience), false, 'fallback cannot claim a run-pair');

  for (const opts of [{}, CREDS]) {
    const { result, dayloopCalls: calls, missCalls } = runClosed(seedClosedDrive(t), opts);
    assert.equal(calls, 1);
    assert.equal(missCalls, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.dayloopSummary.l1Mode, 'fixture');
    assert.equal(result.dayloopSummary.l1LiveRequested, false);
    assertNoCandidate(result.dayloopSummary);
  }
  for (const [action, notes] of [['path-anomaly', 'agent_miss'], ['noop', 'clean']]) {
    const seed = seedClosedDrive(t, { verdict: 'PASS', notes });
    const { result, dayloopCalls: calls, missCalls } = runClosed(seed, { ...CREDS, l1Mode: 'live', l1Live: true, l1Subjects: SUBJECTS });
    assert.equal(result.decision.action, action);
    assert.equal(result.dayloopInvoked, false);
    assert.equal(calls, 0);
    assert.equal(missCalls, action === 'path-anomaly' ? 1 : 0);
    assert.deepEqual(result.candidatePaths, []);
    assert.equal(fs.existsSync(seed.softDir), false);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(socket.mock.callCount(), 0);
  t.diagnostic('missing soft pair visibly fixture-fallback; opt-in/key/model/jev/subject guards reject; CANDIDATE=0; defaults fixture; PASS path-anomaly/noop dayloop=0; fetch/socket=0');
});

test('T-dtscl-3: prior T-dlors, T-dlive and T-dcl1 controls pass with network guards and an explicit TAP reporter', (t) => {
  const child = guardedChild(t, ['--input-type=module', '-e', `
await import('./test/dayloop-opt-in-real-live-smoke-r1.test.mjs');
await import('./test/dayloop-live-bounded-expand-r1.test.mjs');
await import('./test/dayloop-cli-l1-flags-r1.test.mjs');
`]);
  assert.equal(child.status, 0, 'prior guarded controls pass; child output is never dumped into TAP');
  assert.equal(child.stdout.startsWith('TAP version 13'), true, 'child uses readable TAP rather than an inherited binary reporter');
  for (const id of ['T-dlors-1', 'T-dlors-2', 'T-dlors-3', 'T-dlive-1', 'T-dlive-2', 'T-dcl1-1', 'T-dcl1-2', 'T-dcl1-3', 'T-dcl1-4', 'T-dcl1-5', 'T-dcl1-6']) {
    assert.equal(new RegExp(`^ok \\d+ - ${id}:`, 'm').test(child.stdout), true, `${id} passes under network guards`);
  }
  assert.equal(/^# fail 0\b/m.test(child.stdout), true);
  t.diagnostic('existing T-dlors/T-dlive/T-dcl1 rechecked under fetch/socket guards; child output explicitly TAP; no real burn');
});
