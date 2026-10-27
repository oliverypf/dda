import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { composeCandidate } from '../compose.mjs';
import { ingestMiss, parseBenchLog, parseCellRow, resolveRun } from '../ingest.mjs';
import { runClosedHook, decideClosedAction } from '../on-closed.mjs';
import { probeL0 } from '../probe.mjs';
import { proposeFromIngest } from '../propose.mjs';
import { countPathSignals, STEAL_TIP_PIN } from '../path-signals.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(ROOT, 'offloop/out-path-anomaly-experience-only-followup-r1');
const FIXTURE_BENCH = path.join(OUT, 'fixtures/bench-log-run914.md');
const FIXTURE_JSONL = path.join(OUT, 'fixtures/path-signal-run914.jsonl');
const RUN172_EVIDENCE = path.join(
  ROOT,
  'offloop/out-tip-soft-adopt-fifth-family-live-r1/post-scan-on-closed-run172.json',
);
const SESSION = '/tmp/codex-path-anomaly-experience-only-followup-r1';
const BEFORE_HASHES = path.join(SESSION, 'before-hashes.txt');
const TIP = '2258685ce9793639ebc9698c8961dcedccf6e49b';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-anomaly-paex-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function materializeRun(t) {
  const drive = temporaryRoot(t);
  fs.mkdirSync(path.join(drive, 'bench/t2'), { recursive: true });
  fs.copyFileSync(FIXTURE_BENCH, path.join(drive, 'bench-log-run914.md'));
  fs.copyFileSync(FIXTURE_JSONL, path.join(drive, 'bench/t2/run914b.jsonl'));
  return {
    drive,
    benchLogPath: path.join(drive, 'bench-log-run914.md'),
    jsonlPath: path.join(drive, 'bench/t2/run914b.jsonl'),
  };
}

function candidateFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => /^freeze-candidate-.*\.md$/.test(name));
}

function protectedHashes() {
  return fs.readFileSync(BEFORE_HASHES, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [expected, file] = line.trim().split(/\s+/);
      return { expected, file, actual: sha256File(path.join(ROOT, file)) };
    });
}

function freezeLockSha() {
  const freeze = fs.readFileSync(
    path.join(ROOT, 'freeze-offloop-path-anomaly-experience-only-followup-r1.md'),
    'utf8',
  );
  const start = freeze.indexOf('## 0. 锁定');
  const end = freeze.indexOf('\n## 1. 不做', start);
  assert.ok(start >= 0 && end > start, 'freeze §0 lock must be present');
  return createHash('sha256').update(freeze.slice(start, end + 1)).digest('hex');
}

test('T-w14-paex-1: full-width/ASCII/bare parsing plus independent signal keep path-anomaly decision', (t) => {
  const run172Evidence = JSON.parse(fs.readFileSync(RUN172_EVIDENCE, 'utf8'));
  assert.deepEqual(
    {
      action: run172Evidence.action,
      dayloopInvoked: run172Evidence.dayloopInvoked,
      candidatePaths: run172Evidence.candidatePaths,
    },
    { action: 'path-anomaly', dayloopInvoked: false, candidatePaths: [] },
    'the real run172 post-scan contract is the first-hand baseline for this followup',
  );
  assert.ok(run172Evidence.experiencePaths.length > 0);

  const text = fs.readFileSync(FIXTURE_BENCH, 'utf8');
  const rows = text.split('\n').filter((line) => /^\| t[1-3]\/run914[abc] \|/u.test(line));
  assert.equal(rows.length, 3);

  const fullWidth = parseCellRow(rows.find((line) => line.includes('PASS（DGR）')));
  const ascii = parseCellRow(rows.find((line) => line.includes('PASS (DGR)')));
  const bare = parseCellRow(rows.find((line) => /\| PASS \|/u.test(line)));
  assert.equal(fullWidth, null, 'the known full-width suffix remains an observability caveat');
  assert.deepEqual(
    { cell: ascii.cell, result: ascii.result, notes: ascii.notes },
    {
      cell: 't2/run914b',
      result: 'PASS (DGR)',
      notes: 'mid UNCERTAIN→末 PASS; runtime agent_miss observed',
    },
  );
  assert.deepEqual(
    { cell: bare.cell, result: bare.result, notes: bare.notes },
    { cell: 't3/run914c', result: 'PASS', notes: 'direct PASS; no path signal' },
  );

  const bench = parseBenchLog(FIXTURE_BENCH);
  assert.equal(bench.gatePass, true);
  assert.equal(bench.closedPass, true);
  assert.deepEqual(bench.redCells, []);
  assert.deepEqual(bench.pathAnomalyCells.map((cell) => cell.cell), ['t2/run914b']);

  const signalEvents = fs.readFileSync(FIXTURE_JSONL, 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line));
  const signalSummary = countPathSignals(signalEvents);
  assert.equal(signalSummary.agentMissCount, 1);
  assert.equal(signalSummary.dgrPromoteCount, 0);
  assert.equal(signalSummary.tipPathCount, 0);
  assert.equal(signalSummary.postAmtCount, 0);
  assert.equal(signalSummary.isPathAnomaly, true);

  const run = materializeRun(t);
  const resolved = resolveRun('914', { drive: run.drive, mode: 'path-anomaly' });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.paths, [run.jsonlPath]);
  const ingest = ingestMiss({ benchLogPath: run.benchLogPath, jsonlPaths: resolved.paths });
  assert.deepEqual(ingest.pathSignals, {
    agentMissCount: 1,
    postAmtCount: 0,
    dgrPromoteCount: 0,
    tipPathCount: 0,
    progressFailLeaseCount: 0,
  });
  assert.equal(ingest.cells[0].finalOk, true);
  assert.equal(ingest.cells[0].finalVerification, 'PASS');

  const decision = decideClosedAction(bench, { runId: '914' });
  assert.deepEqual(decision, {
    action: 'path-anomaly',
    reason: 'closed_pass_path_anomaly',
    runId: '914',
    argv: ['--run', '914', '--path-anomaly', '--allow-experience-only'],
  });

  const asciiBenchPath = path.join(run.drive, 'bench-log-run914-ascii.md');
  fs.writeFileSync(
    asciiBenchPath,
    text.replace('PASS（DGR）', 'PASS (DGR)'),
    'utf8',
  );
  const asciiDecision = decideClosedAction(parseBenchLog(asciiBenchPath), { runId: '914' });
  assert.equal(asciiDecision.action, decision.action);
  assert.equal(asciiDecision.reason, decision.reason);
});

test('T-w14-paex-2: path-anomaly is EXPERIENCE-only, skips dayloop, and leaves protected product/tip/freeze pins unchanged', (t) => {
  const run = materializeRun(t);
  const directOut = path.join(run.drive, 'direct-compose');
  const ingest = ingestMiss({ benchLogPath: run.benchLogPath, jsonlPaths: [run.jsonlPath] });
  const proposal = proposeFromIngest(ingest, { experienceEntries: [] });
  const experienceHypothesis = proposal.accepted.find((hypothesis) => hypothesis.class === 'experience');
  assert.ok(experienceHypothesis, 'fixture must produce an EXPERIENCE hypothesis');
  const probe = probeL0(experienceHypothesis, {
    jsonlPaths: [run.jsonlPath],
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
  });
  assert.equal(probe.adopt, true, 'green L0 may look adoptable before the EXPERIENCE-only guard');
  const composed = composeCandidate({
    hypothesis: experienceHypothesis,
    probeResult: probe,
    ingest,
    outDir: directOut,
    experienceDir: path.join(directOut, 'experience'),
    date: '2026-10-26',
  });
  assert.equal(composed.wroteCandidate, false);
  assert.equal(composed.candidatePath, null);
  assert.equal(composed.reason, 'experience_only');
  assert.deepEqual(candidateFiles(directOut), []);
  assert.match(fs.readFileSync(composed.experiencePath, 'utf8'), /adopted_candidate\*\*: no \(experience_only\)/);

  const outDir = path.join(run.drive, 'hook-out');
  let dayloopCalls = 0;
  const hook = runClosedHook({
    drive: run.drive,
    benchLogPath: run.benchLogPath,
    runId: '914',
    dayloopSoft: true,
    outDir,
    dayloopRunner: () => {
      dayloopCalls += 1;
      throw new Error('path-anomaly must not enter dayloop-soft');
    },
    invoker: () => {
      const cli = spawnSync(process.execPath, [
        path.join(ROOT, 'offloop/run-from-miss.mjs'),
        '--bench-log', run.benchLogPath,
        '--jsonl', run.jsonlPath,
        '--path-anomaly', '--allow-experience-only',
        '--out-dir', outDir,
        '--experience-dir', path.join(outDir, 'experience'),
      ], { encoding: 'utf8', timeout: 30_000 });
      return { status: cli.status ?? 1, stdout: cli.stdout, stderr: cli.stderr };
    },
  });
  assert.equal(hook.decision.action, 'path-anomaly');
  assert.equal(hook.invoked, true);
  assert.equal(hook.dayloopSoft, true);
  assert.equal(hook.dayloopInvoked, false);
  assert.equal(dayloopCalls, 0);
  assert.deepEqual(hook.candidatePaths, []);
  assert.ok(hook.experiencePaths.length > 0);
  assert.match(hook.stdout, /"reason": "experience_only"/);
  assert.match(hook.stdout, /No CANDIDATE \(explicit reject \/ experience-only\)/);
  assert.deepEqual(candidateFiles(outDir), []);
  const experienceDir = path.join(outDir, 'experience');
  assert.ok(fs.existsSync(experienceDir));
  assert.ok(fs.readdirSync(experienceDir).some((name) => name.endsWith('.md')));
  for (const file of fs.readdirSync(experienceDir).filter((name) => name.endsWith('.md'))) {
    assert.match(fs.readFileSync(path.join(experienceDir, file), 'utf8'), /adopted_candidate\*\*: no \(experience_only\)/);
  }

  assert.equal(STEAL_TIP_PIN, TIP);
  assert.equal(fs.readFileSync(path.join(OUT, 'tip-head.txt'), 'utf8').trim(), TIP);
  assert.equal(
    execFileSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    TIP,
  );
  const session = JSON.parse(fs.readFileSync(path.join(OUT, 'session-start.json'), 'utf8'));
  assert.equal(session.selfClosed, false);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  assert.equal(freezeLockSha(), session.freezeLockSha256);
  for (const row of protectedHashes()) {
    assert.equal(row.actual, row.expected, `${row.file} changed during STOP probe`);
  }
});
