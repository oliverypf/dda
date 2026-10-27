import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const ownKnife = 'wave11-closeout-cleanup-r1';
const out = `offloop/out-${ownKnife}`;
const sessionDir = '/tmp/codex-wave11-closeout-cleanup-r1';
const sessionSha256 = '5192f03a4a5d92f313b0411e5c17acfc2c5648cdd5ba6808367b54b3695ca656';
const ownLockSha256 = '6e7ba62b99d13679924e95b815078f4d6e3b98a410c28e5292ff55c1782b92d1';
const wave11 = [
  'lifecycle-wave10-sibling-accept-r1',
  'wave10-closeout-cleanup-r1',
  'tip-soft-multifamily-external-hygiene-r1',
  'experience-transport-prior-live-wire-r1',
  'tip-soft-adopt-fourth-family-live-r1',
  'harness2-compose-experience-gap-audit-r1',
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
  // Keep the out copy usable after the ephemeral session expires.
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
  assert.deepEqual(session.wave11Knives, wave11, 'all six SCAN CLOSED knives are covered');
  assert.equal(session.ownLockSha256, ownLockSha256);
  return session;
}

function freezeBadges(knife) {
  const text = read(`freeze-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^# (.+)$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one H1`);
  // The fourth-family CLOSED title also carries an informational @ PIN suffix.
  const headingBadge = headings[0][1]
    .match(/[：:]\s*\*\*([^*\n]+)\*\*(?:\s+@\s+([a-f0-9]{7,40})(…|\.{3})?)?\s*$/);
  assert.ok(headingBadge, `${knife}: H1 must have its lifecycle badge`);
  if (headingBadge[2]) {
    assert.equal(headingBadge[2], headingBadge[3] ? pin.slice(0, headingBadge[2].length) : pin,
      `${knife}: optional H1 PIN suffix agrees with the pinned baseline`);
  }
  const statuses = [...text.matchAll(/^- \*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, `${knife}: exactly one 状态 badge`);
  // Historical body prose is not a lifecycle badge.
  return [headingBadge[1], statuses[0][1]];
}

function lockSha256(knife) {
  const bytes = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`));
  const start = bytes.indexOf(Buffer.from('\n## 0.')) + 1;
  const end = bytes.indexOf(Buffer.from('\n## 1.'), start) + 1;
  assert.ok(start > 0 && end > start, `${knife}: §0 and §1 boundaries exist`);
  // Include the §0 heading and trailing newlines; exclude the §1 heading.
  return digest(bytes.subarray(start, end));
}

function isFrozenHandoff(badge) {
  return /^FROZEN\s*\/\s*(?:开干|SCAN READY)(?:$|[\s（(·])/.test(badge)
    && !/\bCLOSED\b/.test(badge);
}

function lifecycleHonest(badges, text) {
  const frozenHandoff = badges.every(isFrozenHandoff);
  const scanClosed = badges.every((badge) => closedPass.test(badge) && !/\bFROZEN\b/.test(badge))
    && /\bSCAN\b/.test(badges[1]) && /独立 SCAN/.test(text);
  return frozenHandoff || scanClosed;
}

function externalSection(knife, text = read(`bench-log-offloop-${knife}.md`)) {
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
  assert.equal([...rows.keys()].filter((file) => file.startsWith('offloop/')).length, 15);
  for (const name of ['drive', 'score-topology-run', 'summarize-run']) {
    assert.ok(rows.has(`bench/${name}.mjs`), `${name}: bench product is covered`);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, out, 'after-hashes.txt')), bytes,
    'saved after-hashes equals the verbatim before-hashes');
  return rows;
}

test('T-w11c-1: six wave11 freezes stay SCAN CLOSED; own and sampled wave12 accept FROZEN|SCAN CLOSED; seven locks and tip PIN match', (t) => {
  const session = sessionStart();
  for (const knife of wave11) {
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

  // Codex must not self-CLOSE; a later independent SCAN may close these freezes.
  const sampledSiblings = [
    'lifecycle-wave11-sibling-accept-r1',
    'tip-soft-prior-snapshot-refresh-r1',
  ];
  for (const knife of [ownKnife, ...sampledSiblings]) {
    assert.ok(lifecycleHonest(freezeBadges(knife), read(`freeze-offloop-${knife}.md`)),
      `${knife}: coherent FROZEN handoff or independent SCAN CLOSED — PASS`);
  }
  assert.ok(lifecycleHonest(['FROZEN / 开干', 'FROZEN / SCAN READY'], 'Codex 交卷'));
  assert.ok(lifecycleHonest(['CLOSED — PASS', 'CLOSED — PASS（SCAN · docs）'], '独立 SCAN'));
  assert.equal(lifecycleHonest(['CLOSED — PASS', 'CLOSED — PASS'], 'Codex 自 CLOSED'), false);
  assert.equal(lifecycleHonest(['FROZEN / 开干', 'CLOSED — PASS（SCAN）'], '独立 SCAN'), false);
  assert.equal(lifecycleHonest(['CLOSED — FAIL', 'CLOSED — FAIL（SCAN）'], '独立 SCAN'), false);
  t.diagnostic(`wave12 sibling sample honest: ${sampledSiblings.join(', ')}`);

  assert.equal(lockSha256(ownKnife), ownLockSha256, 'own §0 is byte-intact at the locked SHA');
  for (const knife of [...wave11, ownKnife]) {
    assert.equal(lockSha256(knife), session.freezeMetaAtStart[knife].section0Sha256,
      `${knife}: §0 remains byte-intact against session-start.json`);
  }

  const ownBench = read(`bench-log-offloop-${ownKnife}.md`);
  const benchStatuses = [...ownBench.matchAll(/^- Status: \*\*([^*\n]+)\*\*([^\n]*)/gm)];
  assert.equal(benchStatuses.length, 1, `${ownKnife}: exactly one bench Status`);
  const benchBadge = benchStatuses[0][1];
  assert.ok(/^FROZEN \/ SCAN READY(?:$|[\s（(·])/.test(benchBadge)
    || (closedPass.test(benchBadge) && /独立 SCAN/.test(benchStatuses[0][0])),
  `${ownKnife}: bench FROZEN / SCAN READY or independent SCAN CLOSED`);
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
  assert.equal(preservedSessionFile('tip-head.txt').toString('utf8').trim(), head,
    'saved tip HEAD matches disk');
});

test('T-w11c-2: six EXTERNAL sections, fourth-family authority MATCH, 18 unchanged products, and historical FROZEN closing', () => {
  const session = sessionStart();
  for (const knife of [...wave11, ownKnife]) externalSection(knife);
  const authorityKnife = 'tip-soft-adopt-fourth-family-live-r1';
  const hashes = session.authorityVerified[authorityKnife];
  assert.deepEqual(Object.keys(hashes).sort(), ['adopt-evidence.json', 'adopt-record.json', 'summary.json']);
  for (const [name, expected] of Object.entries(hashes)) {
    const file = `offloop/out-${authorityKnife}/${name}`;
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(sha256(file), expected, `${file}: authority bytes still MATCH session`);
    const expectedRow = `| \`${file}\` | \`${expected}\` | \`${expected}\` | MATCH |`;
    const rows = externalSection(authorityKnife).split(/\r?\n/).filter((line) => line === expectedRow);
    assert.equal(rows.length, 1, `${authorityKnife}: one complete authority MATCH row for ${name}`);
  }

  const before = baseline(session);
  for (const name of requiredProducts) {
    assert.ok(before.has(`offloop/${name}`), `${name}: required product is covered`);
  }
  for (const [file, expected] of before) {
    assert.equal(sha256(file), expected, `${file}: product before=after`);
  }

  const productFootnotes = new Map([
    ['experience-transport-prior-live-wire-r1', ['experience', 'propose']],
    ['harness2-compose-experience-gap-audit-r1', ['experience', 'compose']],
  ]);
  for (const [knife, names] of productFootnotes) {
    const external = externalSection(knife);
    assert.match(external, /无并行漂移|MATCH/);
    const lock = session.freezeMetaAtStart[knife].section0Sha256;
    assert.ok(external.includes(`| \`freeze-offloop-${knife}.md\` §0 | \`${lock}\` | \`${lock}\` | MATCH |`),
      `${knife}: visible session §0 MATCH`);
    for (const name of names) {
      const file = `offloop/${name}.mjs`;
      const expected = before.get(file);
      assert.ok(external.includes(`| \`${file}\` | \`${expected}\` | \`${expected}\` | MATCH |`),
        `${knife}: visible product MATCH for ${name}`);
    }
  }

  for (const knife of ['lifecycle-wave10-sibling-accept-r1', 'harness2-compose-experience-gap-audit-r1']) {
    const bench = read(`bench-log-offloop-${knife}.md`);
    assert.doesNotMatch(bench, /本刀 freeze 仍为\s*\*\*FROZEN[^\n]*等待独立 SCAN/,
      `${knife}: stale present-tense FROZEN awaiting SCAN is gone`);
    assert.doesNotMatch(bench, /freeze remains FROZEN awaiting independent SCAN/i);
    const historicalHandoff = bench.split(/\r?\n\r?\n/).some((paragraph) =>
      paragraph.includes('交卷时') && paragraph.includes('FROZEN / SCAN READY')
      && paragraph.includes('独立 SCAN 已') && paragraph.includes('CLOSED — PASS'));
    assert.ok(historicalHandoff, `${knife}: closing distinguishes handoff history from independent SCAN CLOSED`);
    const original = read(`${out}/before-documents/bench-log-offloop-${knife}.md`);
    for (const hash of original.match(/[a-f0-9]{64}/g) ?? []) {
      assert.ok(bench.includes(hash), `${knife}: preserve historical SHA footnotes`);
    }
  }

  for (const knife of wave11.slice(0, 3)) {
    const original = read(`${out}/before-documents/bench-log-offloop-${knife}.md`);
    assert.equal(externalSection(knife), externalSection(knife, original),
      `${knife}: preserve the existing EXTERNAL section and authority rows verbatim`);
  }
});
