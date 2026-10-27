import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMissBaseline } from '../dayloop-soft.mjs';
import { runClosedHook } from '../on-closed.mjs';
import { parseBenchLog } from '../ingest.mjs';

const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('T-PR91-P1-TIP64: parseBenchLog preserves a full 64-character backtick tip', () => {
  const expectedTip = '0123456789abcdef'.repeat(4);
  const bench = parseBenchLog(path.join(FIXTURES, 'bench-log-tip64.md'));
  assert.equal(expectedTip.length, 64);
  assert.equal(bench.tip, expectedTip);
  assert.equal(bench.tip.length, 64);
  assert.notEqual(bench.tip, bench.tip.slice(0, 40));
});

function tempDrive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-tip-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function seedMissBench(root, tip) {
  const benchLogPath = path.join(root, 'bench-log-run77.md');
  fs.writeFileSync(benchLogPath, `# Bench log — run77

${tip ? `- **Tip**: \`${tip}\`\n` : ''}- **GATE**: **MISS**

| Cell | Subject | Result | Notes |
| --- | --- | --- | --- |
| t3/run77a | tip-baseline | **MISS** | poison-loop |
`, 'utf8');
  return benchLogPath;
}

test('tip baseline: explicit jsonl without bench metadata uses post-#90 PIN', () => {
  const result = resolveMissBaseline({
    baselineJsonl: path.join(FIXTURES, 'poison-loop-yes.jsonl'),
  });
  assert.equal(result.source, 'explicit');
  assert.equal(result.benchTip, null, 'implicit fixture metadata is not a seeded tip');
  assert.equal(result.tipSha, PIN);
});

test('tip baseline: caller bench alone overrides default; explicit tip overrides bench', (t) => {
  const root = tempDrive(t);
  const benchLogPath = seedMissBench(root, '0123456789abcdef');
  const seeded = resolveMissBaseline({ benchLogPath });
  assert.equal(seeded.benchTip, '0123456789abcdef');
  assert.equal(seeded.tipSha, '0123456789abcdef');

  const explicit = resolveMissBaseline({ benchLogPath, tipSha: '4439768' });
  assert.equal(explicit.tipSha, '4439768', 'historical explicit overrides remain valid');
});

test('tip baseline: CLOSED hook preserves seeded bench tip without explicit tip', (t) => {
  const root = tempDrive(t);
  const benchLogPath = seedMissBench(root, '4439768');
  let seenTip;
  const result = runClosedHook({
    runId: 77,
    drive: root,
    benchLogPath,
    outDir: path.join(root, 'out'),
    dayloopSoft: true,
    dayloopRunner: (opts) => {
      seenTip = opts.tipSha;
      return { wroteCandidate: false, frozenWrites: 0, results: [] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dayloopInvoked, true);
  assert.equal(seenTip, '4439768');
});

test('tip baseline: CLOSED hook without seeded or explicit tip uses post-#90 PIN', (t) => {
  const root = tempDrive(t);
  const benchLogPath = seedMissBench(root);
  let seenTip;
  const result = runClosedHook({
    runId: 77,
    drive: root,
    benchLogPath,
    outDir: path.join(root, 'out'),
    dayloopSoft: true,
    dayloopRunner: (opts) => {
      seenTip = opts.tipSha;
      return { wroteCandidate: false, frozenWrites: 0, results: [] };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dayloopInvoked, true);
  assert.equal(seenTip, PIN);
});
