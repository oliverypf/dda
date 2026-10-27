import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { runClosedHook } from '../on-closed.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const CREDS = { model: 'fixture-model', jev: 'fixture-jev' };

function seedClosedDrive(t, { verdict = 'MISS', notes = 'poison-loop', artifacts = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dayloop-live-bounded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = '178';
  const benchLogPath = path.join(root, `bench-log-run${runId}.md`);
  fs.writeFileSync(benchLogPath, `# Bench log — run${runId} bounded live fixture

- **Tip**: \`${PIN}\`
- **Status**: CLOSED ${verdict}
- GATE: **${verdict}**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run${runId}a | t3-dlive-a | **${verdict}** | ${notes} |
| t3/run${runId}b | t3-dlive-b | **${verdict}** | companion |
`, 'utf8');
  const benchDir = path.join(root, 'bench', 't3');
  const jsonlPaths = ['a', 'b'].map((cell) => path.join(benchDir, `run${runId}${cell}.jsonl`));
  const softJsonlPaths = ['a', 'b'].map((cell) => path.join(benchDir, `run${runId}${cell}-soft.jsonl`));
  if (artifacts) {
    fs.mkdirSync(benchDir, { recursive: true });
    for (const target of jsonlPaths) {
      fs.copyFileSync(path.join(FIXTURES, 'e2e-soft-baseline.jsonl'), target);
    }
    for (const target of softJsonlPaths) {
      fs.copyFileSync(path.join(FIXTURES, 'l1-soft-clean.jsonl'), target);
    }
  }
  return {
    root, runId, benchLogPath, jsonlPaths, softJsonlPaths,
    outDir: path.join(root, 'out'),
    softDir: path.join(root, 'soft-worktree'),
  };
}

function forbidNetwork(t) {
  // Live acceptance replays local JSONL; fail before any fetch or socket can use quota.
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('no network fetch is allowed'));
  const connect = t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('no network socket is allowed'));
  return () => {
    assert.equal(fetch.mock.callCount(), 0, 'zero fetch/model calls');
    assert.equal(connect.mock.callCount(), 0, 'zero network connections');
  };
}

function runMissOnce(seed, opts = {}) {
  const calls = [];
  const result = runClosedHook({
    runId: seed.runId,
    drive: seed.root,
    benchLogPath: seed.benchLogPath,
    outDir: seed.outDir,
    softWorktree: seed.softDir,
    dayloopSoft: true,
    dayloopFixture: 'soft-clean',
    ...opts,
    dayloopRunner: (dayloopOpts) => {
      calls.push(dayloopOpts);
      return runDayloopSoft(dayloopOpts);
    },
    invoker: () => assert.fail('CLOSED MISS + dayloopSoft must invoke the real dayloop directly'),
  });
  assert.equal(result.decision.action, 'miss');
  assert.equal(result.decision.reason, 'closed_miss');
  assert.equal(result.dayloopSoft, true);
  assert.equal(result.dayloopInvoked, true);
  assert.equal(result.invoked, true);
  assert.equal(calls.length, 1, 'one CLOSED MISS invokes exactly one dayloop round');
  assert.equal(calls[0].fromMiss, true);
  assert.equal(calls[0].runId, seed.runId);
  assert.equal(calls[0].benchLogPath, seed.benchLogPath);
  for (const key of ['l1Mode', 'l1Live', 'model', 'jev', 'l1Subjects', 'transportError', 'liveStatus']) {
    assert.equal(calls[0][key], opts[key], `${key} must pass through unchanged`);
  }
  assert.equal(result.exitCode, 0, result.stderr);
  const summary = result.dayloopSummary;
  assert.equal(summary.phase, 'dayloop-soft');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.baselineFallback, false);
  assert.equal(summary.softSource, 'run-pair');
  assert.equal(summary.softFallback, false);
  assert.deepEqual(summary.baselineJsonlPaths, seed.jsonlPaths);
  assert.deepEqual(summary.softJsonlPaths, seed.softJsonlPaths);
  assert.ok(summary.results.length > 0, 'exercise real L0, bounded L1 and Compose');
  return result;
}

function assertLive(summary) {
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1Bounded, true);
}

function assertStopped(seed, result, reason, rejected) {
  const summary = result.dayloopSummary;
  assert.deepEqual(result.candidatePaths, []);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(fs.existsSync(seed.softDir), false, 'stop before creating a soft worktree');
  assert.deepEqual(fs.readdirSync(summary.outDir).filter((name) => name.startsWith('freeze-candidate')), []);
  for (const row of summary.results) {
    assert.equal(row.adopt, false);
    assert.equal(row.wroteCandidate, false);
    assert.equal(row.candidatePath, null);
    assert.equal(row.l1.skipped, false);
    assert.equal(row.l1.adopt, false);
    assert.equal(row.l1.rejected, rejected);
    assert.equal(row.l1.reason, reason);
    assert.equal(row.l1.softWriteCount ?? 0, 0);
    assert.equal(row.l1.softTreeFileListHash, null);
    assert.equal(fs.existsSync(row.l1.softWorktreeDir), false);
    assert.ok(result.experiencePaths.includes(row.experiencePath));
    assert.match(fs.readFileSync(row.experiencePath, 'utf8'), /^# EXPERIENCE/m);
  }
  assert.ok(JSON.parse(result.stdout).results.every((row) => row.l1.reason === reason));
}

test('T-dlive-1: CLOSED MISS opts into one fixture-backed live round with one or two subjects; default makes zero live calls', (t) => {
  const assertZeroNetwork = forbidNetwork(t);
  for (const requested of [
    { l1Live: true, l1Subjects: Object.freeze(['t3/live-a']) },
    { l1Mode: 'live', l1Subjects: Object.freeze(['t3/live-a', 't3/live-b']) },
  ]) {
    const seed = seedClosedDrive(t);
    const subjectsBefore = [...requested.l1Subjects];
    const result = runMissOnce(seed, { ...CREDS, ...requested });
    const summary = result.dayloopSummary;
    assertLive(summary);
    assert.equal(summary.ok, true);
    assert.equal(summary.tipSha, PIN);
    assert.equal(summary.benchTip, PIN);
    assert.equal(summary.ingestCells, 2);
    assert.deepEqual(requested.l1Subjects, subjectsBefore);
    for (const row of summary.results) {
      assert.equal(row.l1.skipped, false);
      assert.equal(row.l1.rejected, false);
      assert.equal(row.l1.adopt, true);
      assert.equal(row.l1.falseWin, false);
      assert.equal(row.l1.tipShaBaseline, PIN);
      assert.match(row.l1.softTreeFileListHash, /^[a-f0-9]{64}$/);
      assert.ok(row.l1.softWriteCount > 0);
      const artifact = row.wroteCandidate ? row.candidatePath : row.experiencePath;
      const body = fs.readFileSync(artifact, 'utf8');
      assert.ok(body.includes(PIN));
      assert.ok(body.includes(row.l1.softTreeFileListHash));
      assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
      if (row.wroteCandidate) {
        assert.ok(result.candidatePaths.includes(artifact));
        assert.match(body, /CANDIDATE/);
      } else {
        assert.ok(['shipped_duplicate', 'experience_only'].includes(row.reason), row.reason);
        assert.equal(row.candidatePath, null);
        assert.ok(result.experiencePaths.includes(artifact));
        assert.match(body, /^# EXPERIENCE/m);
        assert.ok(body.includes(`**adopted_candidate**: no (${row.reason})`));
      }
    }
  }

  // Credentials alone must never opt the default CLOSED MISS into live mode.
  for (const opts of [{}, CREDS]) {
    const control = runMissOnce(seedClosedDrive(t), opts).dayloopSummary;
    assert.equal(control.l1LiveRequested, false);
    assert.equal(control.l1Mode, 'fixture');
    assert.ok(control.results.every((row) => row.l1.adopt && !row.l1.rejected));
  }
  assertZeroNetwork();
  t.diagnostic(`2 fixture-backed live successes: explicit subjects 1/2; API l1Live/l1Mode; tip=${PIN}; 64-hex soft hashes; frozenWrites=0; exactly one dayloop per MISS`);
  t.diagnostic('2 default controls (without/with credentials): l1Mode=fixture; l1LiveRequested=false; network fetch/socket calls=0');
});

test('T-dlive-2: credentials, subject bounds and transport fail closed; PASS anomaly/noop ignore live flags', (t) => {
  const assertZeroNetwork = forbidNetwork(t);
  for (const opts of [
    { l1Live: true },
    { l1Live: true, model: CREDS.model },
    { l1Mode: 'live', jev: CREDS.jev },
    { l1Live: true, model: '', jev: CREDS.jev },
    { l1Mode: 'live', model: '  ', jev: CREDS.jev },
    { l1Live: true, model: CREDS.model, jev: '' },
    { l1Mode: 'live', model: CREDS.model, jev: '  ' },
  ]) {
    const seed = seedClosedDrive(t);
    const result = runMissOnce(seed, opts);
    assertLive(result.dayloopSummary);
    assertStopped(seed, result, 'live_requires_model_jev', true);
  }

  for (const l1Mode of ['fixture', 'sim', 'live']) {
    const seed = seedClosedDrive(t);
    const l1Subjects = Object.freeze(['t3/live-a', 't3/live-b', 't3/live-c']);
    const result = runMissOnce(seed, { ...CREDS, l1Mode, l1Subjects });
    assert.equal(result.dayloopSummary.l1Mode, l1Mode);
    assert.equal(result.dayloopSummary.l1LiveRequested, l1Mode === 'live');
    assertStopped(seed, result, 'bound_exceeded', true);
    assert.deepEqual(l1Subjects, ['t3/live-a', 't3/live-b', 't3/live-c'], 'never truncate explicit subjects');
  }

  for (const failure of [
    { transportError: 402 },
    { transportError: new Error('timeout') },
    { liveStatus: 'TRANSPORT' },
    { liveStatus: 402 },
    { liveStatus: 'timeout' },
  ]) {
    const seed = seedClosedDrive(t);
    const l1Subjects = Object.freeze(['t3/live-a', 't3/live-b']);
    const result = runMissOnce(seed, { ...CREDS, l1Live: true, l1Subjects, ...failure });
    assertLive(result.dayloopSummary);
    assertStopped(seed, result, 'transport', false);
    assert.deepEqual(l1Subjects, ['t3/live-a', 't3/live-b'], 'transport must preserve the requested matrix');
  }

  for (const [action, notes] of [['path-anomaly', 'agent_miss'], ['noop', 'clean']]) {
    const seed = seedClosedDrive(t, { verdict: 'PASS', notes, artifacts: false });
    let dayloopCalls = 0;
    const missArgvs = [];
    const result = runClosedHook({
      runId: seed.runId,
      drive: seed.root,
      benchLogPath: seed.benchLogPath,
      outDir: seed.outDir,
      softWorktree: seed.softDir,
      dayloopSoft: true,
      l1Live: true,
      l1Mode: 'live',
      ...CREDS,
      dayloopRunner: () => {
        dayloopCalls += 1;
        assert.fail(`${action} must not invoke dayloop`);
      },
      invoker: (argv) => {
        missArgvs.push(argv);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.decision.action, action);
    assert.equal(result.dayloopInvoked, false);
    assert.equal(dayloopCalls, 0);
    assert.deepEqual(result.candidatePaths, []);
    assert.equal(fs.existsSync(seed.softDir), false);
    assert.equal(missArgvs.length, action === 'path-anomaly' ? 1 : 0);
    if (action === 'path-anomaly') {
      assert.ok(missArgvs[0].includes('--path-anomaly'));
      assert.ok(missArgvs[0].includes('--allow-experience-only'));
      for (const arg of ['--dayloop-soft', '--l1-live', '--l1-mode', '--model', '--jev', 'live', CREDS.model, CREDS.jev]) {
        assert.ok(!missArgvs[0].includes(arg), `${arg} must not reach the anomaly EXPERIENCE runner`);
      }
    } else {
      assert.equal(result.invoked, false);
    }
    assert.match(fs.readFileSync(result.logPath, 'utf8'), /dayloop invoked.*no/i);
  }
  assertZeroNetwork();
  t.diagnostic('7 credential rejections; 3 over-bound rejections (fixture/sim/live); 5 TRANSPORT/402/timeout stops: adopt=false, CANDIDATE=0, soft worktrees=0; explicit subjects preserved');
  t.diagnostic('PASS path-anomaly/noop: dayloop calls=0; anomaly EXPERIENCE argv excludes live mode/credentials; network fetch/socket calls=0');
});
