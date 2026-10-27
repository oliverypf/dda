import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { composeCandidate } from '../compose.mjs';
import { ingestMiss, parseBenchLog, resolveRun } from '../ingest.mjs';
import { runClosedHook, decideClosedAction } from '../on-closed.mjs';
import { probeL0 } from '../probe.mjs';
import { proposeFromIngest } from '../propose.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVIDENCE = path.join(
  ROOT,
  'offloop/out-tip-soft-adopt-fifth-family-live-r1/post-scan-on-closed-run172.json',
);
const BENCH = path.join(ROOT, 'bench-log-run172.md');
const SESSION = '/tmp/codex-path-anomaly-postscan-run172-audit-r1';
const BEFORE_HASHES = path.join(SESSION, 'before-hashes.txt');
const TIP = '2258685ce9793639ebc9698c8961dcedccf6e49b';

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-anomaly-papra-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function selectedRun172() {
  const resolved = resolveRun('172', { drive: ROOT, mode: 'path-anomaly' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.mode, 'path-anomaly');
  assert.deepEqual(
    resolved.paths.map((file) => path.relative(ROOT, file)),
    ['bench/t1/run172b.jsonl', 'bench/t2/run172a.jsonl', 'bench/t4/run172b.jsonl'],
  );
  return resolved;
}

test('T-papra-1: run172 path-anomaly fields, trigger predicate, and STOP audit are visible', (t) => {
  const evidence = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8'));
  assert.deepEqual(
    {
      action: evidence.action,
      reason: evidence.reason,
      dayloopInvoked: evidence.dayloopInvoked,
      candidatePaths: evidence.candidatePaths,
    },
    {
      action: 'path-anomaly',
      reason: 'closed_pass_path_anomaly',
      dayloopInvoked: false,
      candidatePaths: [],
    },
  );
  assert.equal(evidence.runId, '172');
  assert.ok(evidence.experiencePaths.length > 0, 'path-anomaly must retain EXPERIENCE paths');

  const bench = parseBenchLog(BENCH);
  assert.equal(bench.gatePass, true);
  assert.equal(bench.closedPass, true);
  assert.equal(bench.redCells.length, 0);
  assert.deepEqual(
    bench.pathAnomalyCells.map((cell) => cell.cell),
    ['t1/run172b', 't2/run172a', 't4/run172b'],
  );
  assert.ok(
    bench.pathAnomalyCells.every((cell) => /mid UNCERTAIN.*末 PASS/u.test(cell.notes)),
    'the selected anomaly cells are mid-path observations that later PASS',
  );

  const decision = decideClosedAction(bench, { runId: '172' });
  assert.deepEqual(decision, {
    action: 'path-anomaly',
    reason: 'closed_pass_path_anomaly',
    runId: '172',
    argv: ['--run', '172', '--path-anomaly', '--allow-experience-only'],
  });

  const resolved = selectedRun172();
  const ingest = ingestMiss({ benchLogPath: BENCH, jsonlPaths: resolved.paths });
  assert.deepEqual(ingest.pathSignals, {
    agentMissCount: 3,
    postAmtCount: 0,
    dgrPromoteCount: 0,
    tipPathCount: 0,
    progressFailLeaseCount: 0,
  });
  assert.ok(ingest.cells.every((cell) => cell.finalOk === true));
  assert.ok(ingest.cells.every((cell) => cell.finalVerification === 'PASS'));

  const temp = temporaryRoot(t);
  const hook = runClosedHook({
    drive: temp,
    benchLogPath: BENCH,
    runId: '172',
    dayloopSoft: true,
    invoker: () => ({
      status: 0,
      stdout: 'No CANDIDATE (explicit reject / experience-only). EXPERIENCE: /tmp/run172-exp.md',
      stderr: '',
    }),
  });
  assert.equal(hook.decision.action, 'path-anomaly');
  assert.equal(hook.invoked, true);
  assert.equal(hook.dayloopSoft, true);
  assert.equal(hook.dayloopInvoked, false);
  assert.deepEqual(hook.candidatePaths, []);
  assert.deepEqual(hook.experiencePaths, ['/tmp/run172-exp.md']);

  const audit = {
    verdict: 'STOP',
    conclusion: 'all-green + positive path observation routes to EXPERIENCE-only; no product delta',
  };
  assert.equal(audit.verdict, 'STOP');
  assert.match(audit.conclusion, /EXPERIENCE-only/);
});

test('T-papra-2: adopt=true EXPERIENCE-only stays no-CANDIDATE and product/tip pins stay unchanged', (t) => {
  const resolved = selectedRun172();
  const ingest = ingestMiss({ benchLogPath: BENCH, jsonlPaths: resolved.paths });
  const proposal = proposeFromIngest(ingest, { experienceEntries: [] });
  const experienceHypothesis = proposal.accepted.find((hypothesis) => hypothesis.class === 'experience');
  assert.ok(experienceHypothesis, 'run172 must produce an EXPERIENCE hypothesis');

  const probe = probeL0(experienceHypothesis, {
    jsonlPaths: resolved.paths,
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
  });
  assert.equal(probe.adopt, true, 'the green L0 result is adopt=true before the EXPERIENCE-only guard');

  const temp = temporaryRoot(t);
  const composed = composeCandidate({
    hypothesis: experienceHypothesis,
    probeResult: probe,
    ingest,
    outDir: path.join(temp, 'compose'),
    experienceDir: path.join(temp, 'experience'),
    date: '2026-10-27',
  });
  assert.equal(composed.wroteCandidate, false);
  assert.equal(composed.candidatePath, null);
  assert.equal(composed.reason, 'experience_only');
  assert.deepEqual(
    fs.existsSync(path.join(temp, 'compose'))
      ? fs.readdirSync(path.join(temp, 'compose')).filter((name) => name.startsWith('freeze-candidate-'))
      : [],
    [],
  );

  const cliOut = path.join(temp, 'cli-out');
  const experienceDir = path.join(cliOut, 'experience');
  const cli = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'offloop/run-from-miss.mjs'),
      '--bench-log', BENCH,
      ...resolved.paths.flatMap((jsonl) => ['--jsonl', jsonl]),
      '--path-anomaly',
      '--allow-experience-only',
      '--out-dir', cliOut,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  assert.equal(cli.status, 0, `${cli.stderr}\n${cli.stdout}`);
  assert.match(cli.stdout, /"phase": "compose"/);
  assert.doesNotMatch(cli.stdout, /"wroteCandidate": true/);
  assert.match(cli.stdout, /No CANDIDATE \(explicit reject \/ experience-only\)/);
  assert.deepEqual(
    fs.existsSync(cliOut)
      ? fs.readdirSync(cliOut).filter((name) => /^freeze-candidate-.*\.md$/.test(name))
      : [],
    [],
  );
  assert.ok(fs.existsSync(experienceDir));
  assert.ok(fs.readdirSync(experienceDir).some((name) => name.endsWith('.md')));

  assert.equal(STEAL_TIP_PIN, TIP);
  assert.equal(fs.readFileSync(path.join(SESSION, 'tip-head.txt'), 'utf8').trim(), TIP);
  assert.equal(
    execFileSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    TIP,
  );

  const session = JSON.parse(fs.readFileSync(path.join(SESSION, 'session-start.json'), 'utf8'));
  assert.equal(session.selfClosed, false);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  const freeze = fs.readFileSync(
    path.join(ROOT, 'freeze-offloop-path-anomaly-postscan-run172-audit-r1.md'),
    'utf8',
  );
  const lockStart = freeze.indexOf('## 0. 锁定');
  const lockEnd = freeze.indexOf('\n## 1. 不做', lockStart);
  assert.ok(lockStart >= 0 && lockEnd > lockStart);
  assert.equal(
    createHash('sha256').update(freeze.slice(lockStart, lockEnd + 1)).digest('hex'),
    session.freezeLockSha256,
    'freeze §0 lock changed during STOP audit',
  );
  const before = fs.readFileSync(BEFORE_HASHES, 'utf8').trim().split(/\r?\n/);
  for (const line of before) {
    const [expected, file] = line.trim().split(/\s+/);
    assert.equal(sha256File(path.join(ROOT, file)), expected, `${file} changed during STOP audit`);
  }
});
