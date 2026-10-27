import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClosedHook } from '../on-closed.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';

function seedClosedDrive(t, { verdict = 'MISS', notes = 'poison-loop', artifacts = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-closed-miss-bounded-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = '177';
  const benchLogPath = path.join(root, `bench-log-run${runId}.md`);
  fs.writeFileSync(benchLogPath, `# Bench log — run${runId} bounded acceptance fixture

- **Tip**: \`${PIN}\`
- **Status**: CLOSED ${verdict}
- GATE: **${verdict}**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run${runId}a | t3-cmb-a | **${verdict}** | ${notes} |
| t3/run${runId}b | t3-cmb-b | **${verdict}** | companion |
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
    invoker: () => assert.fail('CLOSED MISS + dayloopSoft must not invoke run-from-miss'),
  });
  assert.equal(result.decision.action, 'miss');
  assert.equal(result.decision.reason, 'closed_miss');
  assert.equal(result.dayloopSoft, true);
  assert.equal(result.dayloopInvoked, true);
  assert.equal(result.invoked, true);
  assert.equal(calls.length, 1, 'one CLOSED MISS must invoke exactly one dayloop round');
  assert.equal(calls[0].fromMiss, true);
  assert.equal(calls[0].runId, seed.runId);
  assert.equal(calls[0].benchLogPath, seed.benchLogPath);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(result.dayloopSummary);
  assert.equal(result.dayloopSummary.phase, 'dayloop-soft');
  assert.equal(result.dayloopSummary.l1Bounded, true);
  assert.equal(result.dayloopSummary.frozenWrites, 0);
  assert.ok(result.dayloopSummary.results.length > 0, 'exercise L0, L1 and Compose');
  return result;
}

function assertNoCandidate(result) {
  assert.deepEqual(result.candidatePaths, []);
  assert.equal(result.dayloopSummary.wroteCandidate, false);
  assert.equal(result.dayloopSummary.candidatePath, null);
  assert.deepEqual(
    fs.readdirSync(result.dayloopSummary.outDir).filter((name) => name.startsWith('freeze-candidate')),
    [],
  );
}

test('T-cmb-1: true CLOSED MISS ingests its run and completes exactly one bounded fixture round', (t) => {
  const seed = seedClosedDrive(t);
  const result = runMissOnce(seed);
  const summary = result.dayloopSummary;
  assert.equal(summary.ok, true);
  assert.equal(summary.l1Mode, 'fixture');
  assert.equal(summary.l1LiveRequested, false);
  assert.equal(result.baselineSource, 'run');
  assert.equal(result.baselineFallback, false);
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.baselineFallback, false);
  assert.equal(summary.baselineFallbackReason, null);
  assert.equal(summary.benchLogPath, seed.benchLogPath);
  assert.equal(summary.runId, seed.runId);
  assert.deepEqual(summary.baselineJsonlPaths, seed.jsonlPaths);
  assert.equal(summary.softSource, 'run-pair');
  assert.equal(summary.softFallback, false);
  assert.deepEqual(summary.softJsonlPaths, seed.softJsonlPaths);
  assert.equal(summary.tipSha, PIN, 'inherit the MISS bench tip without an explicit override');
  assert.equal(summary.benchTip, PIN);
  assert.equal(summary.ingestCells, 2);
  assert.ok(summary.poisonLoop > 0, 'ingest actual baseline events');
  assert.ok(summary.proposed.length > 0);

  for (const row of summary.results) {
    assert.equal(row.l1.skipped, false);
    assert.equal(row.l1.rejected, false);
    assert.equal(row.l1.adopt, true);
    assert.equal(row.l1.falseWin, false);
    assert.equal(row.l1.tipShaBaseline, PIN);
    assert.match(row.l1.softTreeFileListHash, /^[a-f0-9]{64}$/);
    assert.ok(row.l1.softWriteCount > 0, 'bounded L1 prepares the isolated soft worktree');
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
  if (!summary.wroteCandidate) assertNoCandidate(result);
  const log = fs.readFileSync(result.logPath, 'utf8');
  assert.match(log, /dayloop invoked.*yes/i);
  assert.match(log, /baselineSource=run/);
});

test('T-cmb-2: missing live credentials reject before writes; path-anomaly and noop skip dayloop', (t) => {
  // The real hook forwards these requests, but L1 rejects before any live contrast or soft write.
  for (const opts of [
    { l1Live: true },
    { l1Mode: 'live', jev: 'fixture-jev' },
    { l1Live: true, model: 'fixture-model', jev: '  ' },
  ]) {
    const seed = seedClosedDrive(t);
    const result = runMissOnce(seed, opts);
    const summary = result.dayloopSummary;
    assert.equal(summary.baselineSource, 'run');
    assert.equal(summary.l1Mode, 'live');
    assert.equal(summary.l1LiveRequested, true);
    assertNoCandidate(result);
    for (const row of summary.results) {
      assert.equal(row.adopt, false);
      assert.equal(row.wroteCandidate, false);
      assert.equal(row.candidatePath, null);
      assert.equal(row.l1.skipped, false);
      assert.equal(row.l1.rejected, true);
      assert.equal(row.l1.adopt, false);
      assert.equal(row.l1.reason, 'live_requires_model_jev');
      assert.equal(row.l1.softWriteCount ?? 0, 0);
      assert.equal(fs.existsSync(row.l1.softWorktreeDir), false);
      assert.ok(result.experiencePaths.includes(row.experiencePath));
      const body = fs.readFileSync(row.experiencePath, 'utf8');
      assert.match(body, /^# EXPERIENCE/m);
      assert.ok(body.includes(`**adopted_candidate**: no (${row.reason})`));
    }
    // Compose keeps its own EXPERIENCE reason; the hook exposes the precise L1 rejection in JSON.
    assert.ok(JSON.parse(result.stdout).results.every((row) => row.l1.reason === 'live_requires_model_jev'));
    assert.equal(fs.existsSync(seed.softDir), false, 'reject before creating any soft worktree');
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
      model: 'fixture-model',
      jev: 'fixture-jev',
      dayloopRunner: () => {
        dayloopCalls += 1;
        return { wroteCandidate: false, frozenWrites: 0, results: [] };
      },
      invoker: (argv) => {
        missArgvs.push(argv);
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(result.decision.action, action);
    assert.equal(result.dayloopSoft, true);
    assert.equal(result.dayloopInvoked, false);
    assert.equal(dayloopCalls, 0, `${action} must ignore the dayloop and live flags`);
    assert.deepEqual(result.candidatePaths, []);
    assert.equal(fs.existsSync(seed.softDir), false);
    assert.equal(missArgvs.length, action === 'path-anomaly' ? 1 : 0);
    if (action === 'path-anomaly') {
      assert.ok(missArgvs[0].includes('--path-anomaly'));
      assert.ok(missArgvs[0].includes('--allow-experience-only'));
      for (const arg of ['--dayloop-soft', '--l1-live', '--model', '--jev', 'fixture-model', 'fixture-jev']) {
        assert.ok(!missArgvs[0].includes(arg), `${arg} must not reach the path-anomaly runner`);
      }
    } else {
      assert.equal(result.invoked, false);
    }
    assert.match(fs.readFileSync(result.logPath, 'utf8'), /dayloop invoked.*no/i);
  }
});

test('T-cmb-3: CLOSED MISS missing run artifacts records visible fixture-fallback and EXPERIENCE', (t) => {
  const seed = seedClosedDrive(t, { artifacts: false });
  const result = runMissOnce(seed);
  const summary = result.dayloopSummary;
  assert.equal(summary.l1Mode, 'fixture');
  assert.equal(summary.l1LiveRequested, false);
  assert.equal(result.baselineSource, 'fixture-fallback');
  assert.equal(result.baselineFallback, true);
  assert.equal(summary.baselineSource, 'fixture-fallback');
  assert.equal(summary.baselineFallback, true);
  assert.match(result.baselineFallbackReason, /missing|void|jsonl/i);
  assert.equal(summary.baselineFallbackReason, result.baselineFallbackReason);
  assert.deepEqual(summary.baselineJsonlPaths, [path.join(FIXTURES, 'e2e-soft-baseline.jsonl')]);
  assert.equal(summary.tipSha, PIN);
  assert.ok(result.experiencePaths.includes(summary.fallbackExperiencePath));
  const body = fs.readFileSync(summary.fallbackExperiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /baseline_fixture_fallback/);
  assert.ok(body.includes(result.baselineFallbackReason));
  assert.ok(body.includes(PIN));
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /VISIBLE baseline fixture-fallback/);
  assertNoCandidate(result);
});
