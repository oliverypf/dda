/**
 * T-scp-1/2: soft contrast prefers run-pair soft jsonl; missing → visible fixture-fallback + EXPERIENCE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSoftContrast, resolveMissBaseline, runDayloopSoft } from '../dayloop-soft.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';

function seedMissDrive(root, { runId = '91', tip = PIN, withSoftPair = false } = {}) {
  const benchDir = path.join(root, 'bench', 't3');
  fs.mkdirSync(benchDir, { recursive: true });
  const benchLogPath = path.join(root, `bench-log-run${runId}.md`);
  fs.writeFileSync(
    benchLogPath,
    `# Bench log — run${runId} soft-contrast-pair fixture

- **Tip**: \`${tip}\`
- **GATE**: **MISS**

## Results

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run${runId}a | t3-scp | **MISS** | poison-loop |
| t3/run${runId}b | t3-scp | **MISS** | companion |
`,
    'utf8',
  );
  const poison = path.join(FIXTURES, 'e2e-soft-baseline.jsonl');
  const a = path.join(benchDir, `run${runId}a.jsonl`);
  const b = path.join(benchDir, `run${runId}b.jsonl`);
  fs.copyFileSync(poison, a);
  fs.copyFileSync(poison, b);

  /** @type {string[]} */
  let softPaths = [];
  if (withSoftPair) {
    const softSrc = path.join(FIXTURES, 'l1-soft-clean.jsonl');
    const sa = path.join(benchDir, `run${runId}a-soft.jsonl`);
    const sb = path.join(benchDir, `run${runId}b-soft.jsonl`);
    fs.copyFileSync(softSrc, sa);
    fs.copyFileSync(softSrc, sb);
    softPaths = [sa, sb];
  }
  return { benchLogPath, jsonlPaths: [a, b], softPaths, tip };
}

test('T-scp-1: soft/pair jsonl present → softSource=run-pair', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-scp1-'));
  const { softPaths, tip } = seedMissDrive(root, { runId: '91', withSoftPair: true });

  const resolved = resolveSoftContrast({
    runId: 91,
    drive: root,
    fromMiss: true,
    fixture: 'soft-clean',
    minJsonlBytes: 1,
  });
  assert.equal(resolved.softSource, 'run-pair');
  assert.equal(resolved.fallback, false);
  assert.equal(resolved.reason, null);
  assert.ok(resolved.softJsonlPaths.length >= 1);
  assert.ok(
    resolved.softJsonlPaths.every((p) => p.includes('run91') && p.includes('soft')),
    `paths=${JSON.stringify(resolved.softJsonlPaths)}`,
  );
  assert.ok(!resolved.softJsonlPaths[0].includes('test/fixtures/l1-soft'));

  // baseline still from run (unchanged)
  const baseline = resolveMissBaseline({
    runId: 91,
    drive: root,
    tipSha: tip,
    fromMiss: true,
    minJsonlBytes: 1,
  });
  assert.equal(baseline.source, 'run');

  const outDir = path.join(root, 'out');
  const summary = runDayloopSoft({
    runId: 91,
    drive: root,
    fromMiss: true,
    fixture: 'soft-clean',
    tipSha: tip,
    softWorktreeDir: path.join(root, 'swt'),
    outDir,
    experienceDir: path.join(outDir, 'experience'),
    minJsonlBytes: 1,
  });

  assert.equal(summary.softSource, 'run-pair');
  assert.equal(summary.softFallback, false);
  assert.ok(summary.softJsonlPaths.some((p) => p.includes('run91a-soft')));
  assert.equal(summary.baselineSource, 'run');
  // Shipped steal retains the run-pair tip+hash evidence without a CANDIDATE.
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  const steal = summary.results.find((r) => r.hypothesis === 'steal-post-amt-terminal-replan');
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.equal(steal.l1.adopt, true);
  assert.equal(summary.results.find((r) => r.hypothesis === 'experience-poison-loop-lesson').reason, 'experience_only');
  assert.equal(summary.results.find((r) => r.hypothesis === 'post-dpr-sticky-execute').reason, 'shipped_duplicate');
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.match(body, /tipShaBaseline/);
  assert.ok(body.includes(PIN));
  assert.match(body, /softTreeFileListHash/);
  assert.ok(/[a-f0-9]{64}/i.test(body));
  assert.ok(softPaths.length >= 2);
});

test('T-scp-2: missing soft pair → visible fixture-fallback + EXPERIENCE (not claim run-pair)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-scp2-'));
  // baseline present; soft pair ABSENT
  seedMissDrive(root, { runId: '92', withSoftPair: false });

  const resolved = resolveSoftContrast({
    runId: 92,
    drive: root,
    fromMiss: true,
    fixture: 'soft-clean',
  });
  assert.equal(resolved.softSource, 'fixture-fallback');
  assert.equal(resolved.fallback, true);
  assert.ok(resolved.reason && /missing_soft_pair/i.test(resolved.reason));
  assert.ok(resolved.softJsonlPaths[0].includes('l1-soft-clean.jsonl'));
  assert.notEqual(resolved.softSource, 'run-pair');

  const outDir = path.join(root, 'out');
  const summary = runDayloopSoft({
    runId: 92,
    drive: root,
    fromMiss: true,
    fixture: 'soft-clean',
    tipSha: PIN,
    softWorktreeDir: path.join(root, 'swt'),
    outDir,
    experienceDir: path.join(outDir, 'experience'),
  });

  assert.equal(summary.softSource, 'fixture-fallback');
  assert.equal(summary.softFallback, true);
  assert.ok(summary.softFallbackReason);
  assert.notEqual(summary.softSource, 'run-pair');
  assert.ok(
    summary.softFallbackExperiencePath &&
      fs.existsSync(summary.softFallbackExperiencePath),
    `softFallbackExperiencePath=${summary.softFallbackExperiencePath}`,
  );
  const exp = fs.readFileSync(summary.softFallbackExperiencePath, 'utf8');
  assert.match(exp, /softSource.*fixture-fallback|fixture-fallback/);
  assert.match(exp, /dayloop-soft-contrast-fixture-fallback/);
  assert.match(exp, /Not\*\* a silent fake-green|not a silent/i);
  assert.doesNotMatch(exp, /softSource\*\*: run-pair/);

  // baseline still from run when artifacts present
  assert.equal(summary.baselineSource, 'run');
  assert.equal(summary.baselineFallback, false);
  // The clean fallback passes L1; all default directions have already shipped.
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  const steal = summary.results.find((r) => r.hypothesis === 'steal-post-amt-terminal-replan');
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.equal(steal.l1.adopt, true);
  assert.equal(summary.results.find((r) => r.hypothesis === 'experience-soft-reject-lesson').reason, 'experience_only');
  assert.equal(summary.results.find((r) => r.hypothesis === 'post-dpr-sticky-execute').reason, 'shipped_duplicate');
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.ok(body.includes(PIN));
  assert.match(body, /softTreeFileListHash/);
});

test('T-scp-explicit: explicit --soft path stays softSource=explicit', () => {
  const soft = path.join(FIXTURES, 'l1-soft-clean.jsonl');
  const r = resolveSoftContrast({
    softJsonl: soft,
    fixture: 'soft-clean',
  });
  assert.equal(r.softSource, 'explicit');
  assert.equal(r.fallback, false);
  assert.equal(r.softJsonlPaths[0], soft);
});
