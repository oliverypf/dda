import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const ownKnife = 'wave10-closeout-cleanup-r1';
const out = `offloop/out-${ownKnife}`;
const sessionDir = `/tmp/codex-${ownKnife}`;
const sessionSha256 = '01cf314682ad5f1c548ff45501a070bb80d5f95a07e36fb528325aa0b7f54fd8';
const ownLockSha256 = '14f67502fb5ffbca36959fcf4fa3d5af1f859b6a096ec83a9677cc2e080e3b9d';
const wave10 = [
  'wave9-closeout-cleanup-r1',
  'test-git-eperm-env-harden-r1',
  'aepp-experience-date-fixture-r1',
  'tip-soft-adopt-t4-retry-live-r1',
  'tip-soft-adopt-third-family-live-r1',
  'transport-timeout-experience-prior-r1',
];
const requiredProducts = [
  'soft-worktree.mjs', 'dayloop-soft.mjs', 'on-closed.mjs', 'probe-l1.mjs',
  'compose.mjs', 'experience.mjs', 'propose.mjs', 'path-signals.mjs',
];
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (relativePath) => digest(fs.readFileSync(path.join(root, relativePath)));
const closedPass = /^CLOSED\s*—\s*PASS(?:$|[\s（(·])/;

function preservedSessionFile(name) {
  const preserved = fs.readFileSync(path.join(root, out, name));
  const original = path.join(sessionDir, name);
  // The verbatim out copy remains usable after the ephemeral session expires.
  if (fs.existsSync(original)) {
    assert.deepEqual(preserved, fs.readFileSync(original), `${name}: verbatim session copy`);
  }
  return preserved;
}

function sessionStart() {
  const bytes = preservedSessionFile('session-start.json');
  assert.equal(digest(bytes), sessionSha256, 'session-start metadata remains immutable');
  const session = JSON.parse(bytes.toString('utf8'));
  assert.equal(session.knife, ownKnife);
  assert.deepEqual(session.wave10Knives, wave10, 'all six SCAN CLOSED knives are covered');
  return session;
}

function freezeBadges(knife) {
  const text = read(`freeze-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^# (.+)$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one H1`);
  const headingBadge = headings[0][1].match(/[：:]\s*\*\*([^*\n]+)\*\*\s*$/);
  assert.ok(headingBadge, `${knife}: H1 must have its lifecycle badge`);
  const statuses = [...text.matchAll(/^- \*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, `${knife}: exactly one 状态 badge`);
  // Historical body prose and knife names are not lifecycle badges.
  return [headingBadge[1], statuses[0][1]];
}

function lockSha256(knife) {
  const bytes = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`));
  const start = bytes.indexOf(Buffer.from('\n## 0.')) + 1;
  const end = bytes.indexOf(Buffer.from('\n## 1.'), start) + 1;
  assert.ok(start > 0 && end > start, `${knife}: §0 and §1 boundaries exist`);
  // Session convention: include §0 heading and trailing newlines; exclude §1 heading.
  return digest(bytes.subarray(start, end));
}

function isFrozenHandoff(badge) {
  return /^FROZEN\s*\/\s*(?:开干|SCAN READY)/.test(badge) && !/\bCLOSED\b/.test(badge);
}

function externalSection(knife) {
  const text = read(`bench-log-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^## EXTERNAL \/ 并行哈希[\t ]*\r?$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one EXTERNAL section`);
  return text.slice(headings[0].index + headings[0][0].length).split(/\r?\n## /, 1)[0];
}

function baseline(session) {
  const bytes = preservedSessionFile('before-hashes.txt');
  assert.equal(digest(bytes), session.beforeHashesSha256, 'product baseline remains immutable');
  const rows = new Map();
  for (const line of bytes.toString('utf8').trim().split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})  ((?:offloop|bench)\/[a-z0-9-]+\.mjs)$/);
    assert.ok(match, `invalid sha256sum baseline row: ${line}`);
    assert.ok(!rows.has(match[2]), `duplicate baseline row: ${match[2]}`);
    rows.set(match[2], match[1]);
  }
  assert.equal(rows.size, 18, 'cover all 15 offloop and 3 bench products');
  assert.deepEqual(fs.readFileSync(path.join(root, out, 'after-hashes.txt')), bytes,
    'saved after-hashes equals the verbatim before-hashes');
  return rows;
}

test('T-w10c-1: six wave10 freezes stay SCAN CLOSED; own and sampled wave11 accept FROZEN|SCAN CLOSED; seven locks and tip PIN match', (t) => {
  const session = sessionStart();
  for (const knife of wave10) {
    for (const badge of freezeBadges(knife)) {
      assert.match(badge, closedPass, `${knife}: preserve independent SCAN CLOSED — PASS`);
      assert.doesNotMatch(badge, /\bFROZEN\b/, `${knife}: no mid-flight lifecycle badge`);
    }
    const statuses = [...read(`bench-log-offloop-${knife}.md`)
      .matchAll(/^(?:- )?Status: \*\*([^*\n]+)\*\*/gm)];
    assert.equal(statuses.length, 1, `${knife}: exactly one bench Status`);
    assert.match(statuses[0][1], closedPass, `${knife}: bench agrees with independent SCAN`);
    assert.doesNotMatch(statuses[0][1], /\bFROZEN\b/);
  }

  // Codex must not self-CLOSE; independent SCAN may flip to CLOSED — PASS (NO_PRODUCT_DELTA).
  for (const badge of freezeBadges(ownKnife)) {
    const frozenHonesty = isFrozenHandoff(badge);
    const scanClosed = closedPass.test(badge);
    assert.ok(frozenHonesty || scanClosed,
      `${ownKnife}: FROZEN handoff or independent SCAN CLOSED — PASS; no unscanned self-CLOSED`);
  }
  // Pack A siblings may independently SCAN CLOSED while this knife is still FROZEN handoff.
  const sampledSiblings = [
    'lifecycle-wave10-sibling-accept-r1',
    'tip-soft-multifamily-external-hygiene-r1',
  ];
  for (const knife of sampledSiblings) {
    const badges = freezeBadges(knife);
    const frozenHonesty = badges.every(isFrozenHandoff);
    const scanClosed = badges.every((badge) => closedPass.test(badge));
    assert.ok(frozenHonesty || scanClosed,
      `${knife}: stay FROZEN handoff or independent SCAN CLOSED — PASS`);
  }
  t.diagnostic(`wave11 sibling sample honest: ${sampledSiblings.join(', ')}`);

  assert.equal(lockSha256(ownKnife), ownLockSha256, 'own §0 is byte-intact at the locked SHA');
  for (const knife of [...wave10, ownKnife]) {
    assert.equal(lockSha256(knife), session.freezeMetaAtStart[knife].section0Sha256,
      `${knife}: §0 remains byte-intact against session-start.json`);
  }

  const ownBench = read(`bench-log-offloop-${ownKnife}.md`);
  const benchStatuses = [...ownBench.matchAll(/^- Status: \*\*([^\*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, `${ownKnife}: exactly one bench Status`);
  const benchBadge = benchStatuses[0][1];
  assert.ok(
    /^FROZEN \/ SCAN READY/.test(benchBadge) || closedPass.test(benchBadge),
    `${ownKnife}: bench FROZEN / SCAN READY or independent SCAN CLOSED`,
  );
  assert.match(ownBench, /`selfClosed=false`/);
  assert.ok(read(`freeze-offloop-${ownKnife}.md`).includes(`\`${pin}\``), 'freeze retains full tip PIN');
  assert.match(ownBench, new RegExp(`^- Tip PIN / HEAD / STEAL_TIP_PIN: .*${pin}`, 'm'));
  assert.equal(session.tipPin, pin);
  assert.equal(session.tipHead, pin);

  const pinDeclaration = read('offloop/path-signals.mjs')
    .match(/export\s+const\s+STEAL_TIP_PIN\s*=\s*(['"])([a-f0-9]{40})\1\s*;/);
  assert.ok(pinDeclaration, 'STEAL_TIP_PIN remains explicitly declared in product source');
  assert.equal(pinDeclaration[2], pin, 'STEAL_TIP_PIN is unchanged');
  const head = execFileSync('git', ['--no-optional-locks', '-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  }).trim();
  assert.equal(head, pin, 'tip checkout HEAD remains pinned');
  assert.equal(read(`${out}/tip-head.txt`).trim(), head, 'saved tip HEAD matches disk');
});

test('T-w10c-2: six EXTERNAL sections, visible authority MATCH rows, all baseline products unchanged, and residual FROZEN prose is historical', () => {
  const session = sessionStart();
  for (const knife of wave10) externalSection(knife);
  const documentedAuthorities = new Map([
    ['dayloop-tip-soft-adopt-live-r1', 'wave9-closeout-cleanup-r1'],
    ['tip-soft-adopt-third-family-live-r1', 'tip-soft-adopt-third-family-live-r1'],
    ['tip-soft-adopt-t4-retry-live-r1', 'tip-soft-adopt-t4-retry-live-r1'],
  ]);
  for (const knife of [...documentedAuthorities.keys(), 'tip-soft-adopt-second-family-live-r1']) {
    const hashes = session.authorityVerified[knife];
    assert.deepEqual(Object.keys(hashes).sort(), ['adopt-evidence.json', 'adopt-record.json', 'summary.json']);
    for (const [name, expected] of Object.entries(hashes)) {
      const file = `offloop/out-${knife}/${name}`;
      assert.match(expected, /^[a-f0-9]{64}$/);
      assert.equal(sha256(file), expected, `${file}: authority bytes still MATCH session`);
      const benchKnife = documentedAuthorities.get(knife);
      if (benchKnife) {
        const expectedRow = `| \`${file}\` | \`${expected}\` | \`${expected}\` | MATCH |`;
        const rows = externalSection(benchKnife).split(/\r?\n/).filter((line) => line === expectedRow);
        assert.equal(rows.length, 1, `${benchKnife}: one complete authority MATCH row for ${name}`);
      }
    }
  }

  const before = baseline(session);
  for (const name of requiredProducts) {
    assert.ok(before.has(`offloop/${name}`), `${name}: required product is covered`);
  }
  for (const [file, expected] of before) {
    assert.equal(sha256(file), expected, `${file}: product before=after`);
  }

  for (const knife of ['test-git-eperm-env-harden-r1', 'transport-timeout-experience-prior-r1']) {
    assert.match(externalSection(knife), /无并行漂移/);
    assert.ok(externalSection(knife).includes(session.freezeMetaAtStart[knife].section0Sha256),
      `${knife}: visible session §0 MATCH`);
  }
  for (const knife of [
    'test-git-eperm-env-harden-r1',
    'transport-timeout-experience-prior-r1',
    'aepp-experience-date-fixture-r1',
  ]) {
    const bench = read(`bench-log-offloop-${knife}.md`);
    assert.doesNotMatch(bench, /freeze remains FROZEN awaiting independent SCAN/i,
      `${knife}: stale present-tense closing is gone`);
    assert.doesNotMatch(bench, /(?:本刀 freeze H1\/状态保持|冻结文件保持)\s*\*{0,2}FROZEN/,
      `${knife}: no stale present-tense FROZEN hold`);
    const historicalHandoff = bench.split(/\r?\n\r?\n/).some((paragraph) =>
      paragraph.includes('交卷') && paragraph.includes('FROZEN / SCAN READY')
      && paragraph.includes('独立 SCAN 已') && paragraph.includes('CLOSED — PASS'));
    assert.ok(historicalHandoff, `${knife}: closing distinguishes historical handoff from SCAN CLOSED`);
    const original = read(`${out}/before-documents/bench-log-offloop-${knife}.md`);
    for (const hash of original.match(/[a-f0-9]{64}/g) ?? []) {
      assert.ok(bench.includes(hash), `${knife}: preserve historical SHA footnotes`);
    }
  }
});
