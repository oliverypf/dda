import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMissBaseline, runDayloopSoft } from '../dayloop-soft.mjs';
import { runClosedHook } from '../on-closed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const DRIVE = path.resolve(__dirname, '../..');
const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';

function seedMissDrive(root, { runId = '77', tip = PIN } = {}) {
  const benchDir = path.join(root, 'bench', 't3');
  fs.mkdirSync(benchDir, { recursive: true });
  const benchLogPath = path.join(root, `bench-log-run${runId}.md`);
  fs.writeFileSync(
    benchLogPath,
    `# Bench log — run${runId} dayloop-from-miss fixture

- **Tip**: \`${tip}\`
- **GATE**: **MISS**

## Results

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run${runId}a | t3-dfm | **MISS** | poison-loop |
| t3/run${runId}b | t3-dfm | **MISS** | companion |
`,
    'utf8',
  );
  const src = path.join(FIXTURES, 'e2e-soft-baseline.jsonl');
  const a = path.join(benchDir, `run${runId}a.jsonl`);
  const b = path.join(benchDir, `run${runId}b.jsonl`);
  fs.copyFileSync(src, a);
  fs.copyFileSync(src, b);
  // ensure above min size for void gate if used
  assert.ok(fs.statSync(a).size >= 100);
  return { benchLogPath, jsonlPaths: [a, b], tip };
}

/** T-dfm-1: MISS+dayloop-soft with run artifacts → baseline from that run, not silent soft-clean */
test('T-dfm-1: MISS+dayloop-soft + run artifacts → baselineSource=run (not silent soft-clean)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dfm1-'));
  const { benchLogPath, jsonlPaths, tip } = seedMissDrive(root, { runId: '77', tip: PIN });
  const outDir = path.join(root, 'out');
  const softDir = path.join(root, 'swt');

  const resolved = resolveMissBaseline({
    runId: 77,
    drive: root,
    tipSha: PIN,
    fromMiss: true,
    minJsonlBytes: 1,
  });
  assert.equal(resolved.source, 'run');
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.benchLogPath, benchLogPath);
  assert.ok(resolved.baselineJsonlPaths.some((p) => p.endsWith(`run77a.jsonl`)));
  assert.ok(!resolved.baselineJsonlPaths[0].includes('test/fixtures/e2e-soft-baseline.jsonl'));

  let seenOpts = null;
  const r = runClosedHook({
    runId: 77,
    drive: root,
    benchLogPath,
    outDir,
    dayloopSoft: true,
    softWorktree: softDir,
    tipSha: PIN,
    minJsonlBytes: 1,
    dayloopRunner: (opts) => {
      seenOpts = opts;
      return runDayloopSoft(opts);
    },
  });

  assert.equal(r.decision.action, 'miss');
  assert.equal(r.dayloopInvoked, true);
  assert.ok(seenOpts);
  assert.equal(String(seenOpts.runId), '77');
  assert.equal(seenOpts.fromMiss, true);
  assert.equal(seenOpts.benchLogPath, benchLogPath);
  assert.equal(r.baselineSource, 'run');
  assert.equal(r.baselineFallback, false);
  assert.deepEqual(r.candidatePaths, []);
  assert.equal(r.dayloopSummary.wroteCandidate, false);
  assert.equal(r.dayloopSummary.frozenWrites, 0);
  const steal = r.dayloopSummary.results.find((result) => result.hypothesis === 'steal-post-amt-terminal-replan');
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.equal(steal.l1.adopt, true);
  assert.ok(r.experiencePaths.includes(steal.experiencePath));
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.match(body, /tipShaBaseline/);
  assert.ok(body.includes(PIN));
  assert.match(body, /softTreeFileListHash/);
  assert.ok(/[a-f0-9]{64}/i.test(body));
  // summary paths came from seeded run, not default fixture poison path alone
  assert.ok(
    r.dayloopSummary.baselineJsonlPaths.some((p) => p.includes(`run77`)),
    `paths=${JSON.stringify(r.dayloopSummary.baselineJsonlPaths)}`,
  );
  assert.equal(tip, PIN);
  assert.ok(jsonlPaths.length >= 1);
});

/** T-dfm-2: missing artifacts → visible fixture-fallback + EXPERIENCE */
test('T-dfm-2: missing artifacts → visible fallback reason + EXPERIENCE (not silent)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-dfm2-'));
  // bench-log exists (MISS) but NO jsonl under bench/
  const benchLogPath = path.join(root, 'bench-log-run88.md');
  fs.writeFileSync(
    benchLogPath,
    `# Bench log — run88

- **Tip**: \`4439768\`
- **GATE**: **MISS**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run88a | t3-x | **MISS** | missing jsonl on purpose |
`,
    'utf8',
  );
  fs.mkdirSync(path.join(root, 'bench', 't3'), { recursive: true });

  const resolved = resolveMissBaseline({
    runId: 88,
    drive: root,
    tipSha: '4439768',
    fromMiss: true,
  });
  assert.equal(resolved.source, 'fixture-fallback');
  assert.equal(resolved.fallback, true);
  assert.ok(resolved.reason && /missing|void|jsonl/i.test(resolved.reason));
  assert.ok(resolved.baselineJsonlPaths[0].includes('e2e-soft-baseline.jsonl'));

  const outDir = path.join(root, 'out');
  const r = runClosedHook({
    runId: 88,
    drive: root,
    benchLogPath,
    outDir,
    dayloopSoft: true,
    softWorktree: path.join(root, 'swt'),
    tipSha: '4439768',
    dayloopRunner: (opts) => runDayloopSoft(opts),
  });

  assert.equal(r.decision.action, 'miss');
  assert.equal(r.dayloopInvoked, true);
  assert.equal(r.baselineFallback, true);
  assert.ok(r.baselineFallbackReason);
  assert.equal(r.dayloopSummary.baselineSource, 'fixture-fallback');
  assert.ok(
    r.experiencePaths.some(
      (p) => p.includes('dayloop-baseline-fixture-fallback') && fs.existsSync(p),
    ),
    `experiencePaths=${JSON.stringify(r.experiencePaths)}`,
  );
  const exp = fs.readFileSync(
    r.experiencePaths.find((p) => p.includes('dayloop-baseline-fixture-fallback')),
    'utf8',
  );
  assert.match(exp, /baseline_fixture_fallback|fixture-fallback/);
  assert.match(exp, /Not\*\* a silent fake-green|not a silent/i);
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /VISIBLE fixture-fallback|fixture-fallback/i);
});

/** resolveMissBaseline pure unit: explicit paths stay explicit */
test('T-dfm-explicit: explicit baseline paths → source=explicit (e2e mode)', () => {
  const r = resolveMissBaseline({
    baselineJsonl: path.join(FIXTURES, 'poison-loop-yes.jsonl'),
    benchLogPath: path.join(FIXTURES, 'e2e-soft-bench-log.md'),
    tipSha: '4439768',
  });
  assert.equal(r.source, 'explicit');
  assert.equal(r.fallback, false);
});
