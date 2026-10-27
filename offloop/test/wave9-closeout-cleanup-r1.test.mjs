import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freezeLifecycleHonest, benchLifecycleHonest } from './lifecycle-wave10-sibling-accept-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const ownKnife = 'wave9-closeout-cleanup-r1';
const out = `offloop/out-${ownKnife}`;
const wave9 = [
  'test-lifecycle-scan-closed-accept-r1',
  'wave8-closeout-cleanup-r1',
  'adopt-experience-propose-prior-r1',
  'observational-candidateAllowed-gate-r1',
  'sticky-latch-dayloop-smoke-r1',
  'tip-soft-adopt-second-family-live-r1',
];
const requiredProducts = [
  'soft-worktree.mjs',
  'dayloop-soft.mjs',
  'on-closed.mjs',
  'probe-l1.mjs',
  'compose.mjs',
  'experience.mjs',
  'propose.mjs',
  'path-signals.mjs',
];
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (relativePath) => digest(fs.readFileSync(path.join(root, relativePath)));
const snapshot = JSON.parse(read(`${out}/source-integrity-before.json`));
const closedPass = /^CLOSED\s*—\s*PASS(?:$|[\s（(·])/;

function freezeBadges(knife) {
  const text = read(`freeze-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^# (.+)$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one H1`);
  const headingBadge = headings[0][1].match(/[：:]\s*\*\*([^*\n]+)\*\*\s*$/);
  assert.ok(headingBadge, `${knife}: H1 must have its lifecycle badge`);
  const statuses = [...text.matchAll(/^- \*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, `${knife}: exactly one 状态 badge`);
  // Historical body text and knife titles can mention other lifecycle states.
  return [headingBadge[1], statuses[0][1]];
}

function baseline() {
  const sessionPath = '/tmp/codex-wave9-closeout-cleanup-r1/before-hashes.txt';
  const preserved = fs.readFileSync(path.join(root, out, 'before-hashes.txt'));
  // Keep the preserved baseline usable after ephemeral /tmp evidence expires.
  const bytes = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath) : preserved;
  assert.deepEqual(preserved, bytes, 'before-hashes preserves the session file verbatim');
  assert.equal(digest(bytes), snapshot.providedBeforeHashesSha256, 'session baseline is immutable');
  const rows = new Map();
  for (const line of bytes.toString('utf8').trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  ((?:offloop|bench)\/[a-z0-9-]+\.mjs)$/);
    assert.ok(match, `invalid sha256sum baseline row: ${line}`);
    assert.ok(!rows.has(match[2]), `duplicate baseline row: ${match[2]}`);
    rows.set(match[2], match[1]);
  }
  return rows;
}

function externalSection(knife) {
  const text = read(`bench-log-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^## EXTERNAL \/ 并行哈希[\t ]*\r?$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one EXTERNAL section`);
  return text.slice(headings[0].index + headings[0][0].length).split(/\r?\n## /, 1)[0];
}

test('T-w9c-1: six wave9 freezes stay SCAN CLOSED; own freeze/bench and wave10 samples accept FROZEN|SCAN CLOSED; tip PIN is unchanged', () => {
  for (const knife of wave9) {
    for (const badge of freezeBadges(knife)) {
      assert.match(badge, closedPass, `${knife}: retain independent SCAN PASS`);
      assert.doesNotMatch(badge, /\bFROZEN\b/, `${knife}: no mid-flight lifecycle badge`);
    }
    const bench = read(`bench-log-offloop-${knife}.md`);
    const statuses = [...bench.matchAll(/^(?:- )?Status: \*\*([^*\n]+)\*\*/gm)];
    assert.equal(statuses.length, 1, `${knife}: exactly one bench Status`);
    assert.match(statuses[0][1], closedPass, `${knife}: bench agrees with independent SCAN`);
    assert.doesNotMatch(statuses[0][1], /\bFROZEN\b/);
  }

  // This knife and siblings may independently SCAN CLOSED after FROZEN handoff.
  for (const knife of [ownKnife, 'test-git-eperm-env-harden-r1', 'aepp-experience-date-fixture-r1']) {
    const badges = freezeBadges(knife);
    const frozenHonesty = badges.every((badge) => /^FROZEN\s*\/\s*(?:开干|SCAN READY)/.test(badge)
      && !/\bCLOSED\b/.test(badge));
    const scanClosed = badges.every((badge) => closedPass.test(badge)
      && !/\bFROZEN\b/.test(badge));
    assert.ok(frozenHonesty || scanClosed, `${knife}: stay FROZEN (handoff) or independent SCAN CLOSED`);
  }
  const ownFreeze = read(`freeze-offloop-${ownKnife}.md`);
  assert.ok(freezeLifecycleHonest(ownFreeze), 'own freeze requires FROZEN honesty or independent SCAN PASS');
  const lock = ownFreeze.split('## 0.')[1]?.split('\n## 1.')[0];
  assert.ok(lock, 'own freeze has its §0 lock');
  assert.equal(digest(lock), snapshot.freezes[`freeze-offloop-${ownKnife}.md`].lockSha256,
    'own §0 remains byte-intact');
  const ownBench = read(`bench-log-offloop-${ownKnife}.md`);
  assert.ok(benchLifecycleHonest(ownBench), 'own bench requires FROZEN handoff or independent SCAN PASS');
  assert.match(ownBench, /`selfClosed=false`/);
  assert.ok(ownFreeze.includes(`\`${pin}\``), 'own freeze retains the full tip PIN');
  assert.match(ownBench, new RegExp(`^- Tip PIN / HEAD / STEAL_TIP_PIN: .*${pin}`, 'm'));

  const pinDeclaration = read('offloop/path-signals.mjs')
    .match(/export\s+const\s+STEAL_TIP_PIN\s*=\s*(['"])([a-f0-9]{40})\1\s*;/);
  assert.ok(pinDeclaration, 'STEAL_TIP_PIN remains explicitly declared in product source');
  assert.equal(pinDeclaration[2], pin, 'STEAL_TIP_PIN is unchanged');
  assert.equal(snapshot.tipHead, pin, 'session tip HEAD matches the locked PIN');
  const head = execFileSync('git', ['--no-optional-locks', '-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
  assert.equal(head, pin, 'tip checkout HEAD remains pinned');
});

test('T-w9c-2: six EXTERNAL sections, four documented dtsal drifts, three authority MATCH hashes, and every baseline product match disk', () => {
  for (const knife of wave9) externalSection(knife);

  const manifestBytes = fs.readFileSync(path.join(root, out, 'dtsal-drift.json'));
  const sessionManifest = '/tmp/codex-wave9-closeout-cleanup-r1/dtsal-drift.json';
  if (fs.existsSync(sessionManifest)) {
    assert.deepEqual(manifestBytes, fs.readFileSync(sessionManifest), 'drift manifest is preserved verbatim');
  }
  assert.equal(digest(manifestBytes), snapshot.dtsalManifestSha256, 'supplied drift manifest is immutable');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const prefix = 'offloop/out-dayloop-tip-soft-adopt-live-r1/';
  assert.deepEqual(manifest.drift.map((row) => row.file).sort(), [
    'replay-cli-output.json', 'replay-evidence.json', 'secret-scan.json',
    'temporary-miss-drive-t2H55F/stdout.json',
  ].map((name) => prefix + name).sort(), 'exactly the four authoritative drift files');
  const authority = {
    'summary.json': '5f7d91d06000fab3eafe61fe6796db3a496d4c0697a1e6db10e4bbeb1d06f0e3',
    'adopt-record.json': '480e2d3e9edfb9a17ac43918065a52abda151f65f0bd39002399721f866f948e',
    'adopt-evidence.json': 'c04cb13cfcd9c9042ff9386c00be431a52d86da81e485b79665d9735a2d0f09f',
  };
  assert.deepEqual(manifest.authority.map((row) => row.file).sort(),
    Object.keys(authority).map((name) => prefix + name).sort(), 'exactly three authority files');
  const historical = JSON.parse(read('offloop/out-wave8-closeout-cleanup-r1/source-integrity-before.json')).wave8Artifacts;
  for (const [group, rows] of [['drift', manifest.drift], ['authority', manifest.authority]]) {
    for (const row of rows) {
      assert.match(row.historical, /^[a-f0-9]{64}$/);
      assert.match(row.current, /^[a-f0-9]{64}$/);
      assert.equal(row.historical, historical[row.file], `${row.file}: authentic w8c historical hash`);
      assert.equal(sha256(row.file), row.current, `${row.file}: current hash matches disk`);
      if (group === 'drift') {
        assert.notEqual(row.historical, row.current, `${row.file}: historical drift is visible`);
        assert.equal(row.verdict, 'EXTERNAL_DRIFT');
      } else {
        assert.equal(row.current, authority[row.file.slice(prefix.length)], `${row.file}: authority unchanged`);
        assert.equal(row.historical, row.current);
        assert.equal(row.verdict, 'MATCH');
      }
      const expected = `| \`${row.file}\` | \`${row.historical}\` | \`${row.current}\` | ${row.verdict} |`;
      for (const knife of [ownKnife, 'wave8-closeout-cleanup-r1']) {
        const documented = externalSection(knife).split(/\r?\n/).filter((line) => line === expected);
        assert.equal(documented.length, 1, `${knife}: document the full sourced row for ${row.file}`);
      }
    }
  }

  const before = baseline();
  for (const file of requiredProducts) {
    assert.ok(before.has(`offloop/${file}`), `${file}: required product is in the session baseline`);
  }
  // Check every supplied file, not merely the eight minimum spot checks.
  for (const [file, expected] of before) {
    assert.equal(sha256(file), expected, `${file}: product before=after`);
  }
});
