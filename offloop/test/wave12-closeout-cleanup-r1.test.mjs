import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const ownKnife = 'wave12-closeout-cleanup-r1';
const out = `offloop/out-${ownKnife}`;
const sessionDir = '/tmp/codex-wave12-closeout-cleanup-r1';
const sessionSha256 = 'eca90430658777f2f674010dcf96a53ae23c07e25b78833e9ae5f878dccb83c2';
const ownLockSha256 = '867e2c2c3511a10c5c2ddc60dfd07c9e6caf7e65491b7355aa823f1f0557c231';
const wave12 = [
  'lifecycle-wave11-sibling-accept-r1',
  'tip-soft-prior-snapshot-refresh-r1',
  'wave11-closeout-cleanup-r1',
  'dtsal-write-scope-replay-harden-r1',
  'dayloop-transport-experience-live-persist-r1',
  'tip-soft-adopt-fifth-family-live-r1',
];
const requiredProducts = [
  'candidate-archive.mjs', 'compose.mjs', 'dayloop-soft.mjs', 'experience.mjs',
  'ingest.mjs', 'merged-directions.mjs', 'on-closed.mjs', 'path-signals.mjs',
  'poison-loop.mjs', 'post-scan-on-closed.mjs', 'probe-l1.mjs', 'probe.mjs',
  'propose.mjs', 'run-from-miss.mjs', 'soft-worktree.mjs',
];
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const readBytes = (relativePath) => fs.readFileSync(path.join(root, relativePath));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (relativePath) => digest(readBytes(relativePath));
const closedPass = /^CLOSED\s*—\s*PASS(?:$|[\s（(·])/;

function preservedSessionFile(name) {
  const preserved = readBytes(`${out}/${name}`);
  const original = path.join(sessionDir, name);
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
  assert.deepEqual(session.wave12Knives, wave12, 'all six SCAN CLOSED knives are covered');
  assert.equal(session.ownLockSha256, ownLockSha256);
  assert.equal(session.selfClosed, false);
  assert.equal(session.tipPin, pin);
  assert.equal(session.tipHead, pin);
  return session;
}

function freezeBadges(knife) {
  const text = read(`freeze-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^# (.+)$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one H1`);
  const headingBadge = headings[0][1]
    .match(/[：:]\s*\*\*([^*\n]+)\*\*(?:\s+@\s+([a-f0-9]{7,40})(…|\.{3})?)?\s*$/);
  assert.ok(headingBadge, `${knife}: H1 must have its lifecycle badge`);
  if (headingBadge[2]) {
    assert.equal(
      headingBadge[2],
      headingBadge[3] ? pin.slice(0, headingBadge[2].length) : pin,
      `${knife}: optional H1 PIN suffix agrees with the pinned baseline`,
    );
  }
  const statuses = [...text.matchAll(/^- \*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, `${knife}: exactly one 状态 badge`);
  return [headingBadge[1], statuses[0][1]];
}

function lockSha256(knife) {
  const bytes = readBytes(`freeze-offloop-${knife}.md`);
  const start = bytes.indexOf(Buffer.from('\n## 0.')) + 1;
  const end = bytes.indexOf(Buffer.from('\n## 1.'), start) + 1;
  assert.ok(start > 0 && end > start, `${knife}: §0 and §1 boundaries exist`);
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
  assert.deepEqual(readBytes(`${out}/after-hashes.txt`), bytes,
    'saved after-hashes equals the verbatim before-hashes');
  return rows;
}

function json(name) {
  return JSON.parse(read(`${out}/${name}`));
}

test('T-w12c-1: six wave12 freezes stay SCAN CLOSED; own and sampled wave13 accept FROZEN|SCAN CLOSED; locks and tip PIN match', () => {
  const session = sessionStart();
  for (const knife of wave12) {
    const badges = freezeBadges(knife);
    for (const badge of badges) {
      assert.match(badge, closedPass, `${knife}: preserve independent SCAN CLOSED — PASS`);
      assert.doesNotMatch(badge, /\bFROZEN\b/, `${knife}: no mid-flight lifecycle badge`);
    }
    const statuses = [...read(`bench-log-offloop-${knife}.md`)
      .matchAll(/^(?:- )?Status(?:（状态）)?[：:]\s*\*\*([^*\n]+)\*\*/gm)];
    assert.equal(statuses.length, 1, `${knife}: exactly one bench Status`);
    assert.match(statuses[0][1], closedPass, `${knife}: bench agrees with independent SCAN`);
    assert.doesNotMatch(statuses[0][1], /\bFROZEN\b/);
  }

  const sampledSiblings = [
    'lifecycle-wave12-sibling-accept-r1',
    'post-dtelp-product-pin-hygiene-r1',
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

  assert.equal(lockSha256(ownKnife), ownLockSha256, 'own §0 is byte-intact at the locked SHA');
  for (const knife of [...wave12, ownKnife]) {
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
  assert.ok(read(`freeze-offloop-${ownKnife}.md`).includes(`\`${pin}\``),
    'freeze retains full tip PIN');
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

  for (const name of ['source-integrity-before.json', 'source-integrity.json', 'summary.json']) {
    const evidence = json(name);
    assert.equal(evidence.freezeStatus, 'FROZEN / SCAN READY', `${name}: freeze status`);
    assert.equal(evidence.selfClosed, false, `${name}: selfClosed=false`);
    assert.equal(evidence.productWrites, 0, `${name}: productWrites=0`);
    assert.equal(evidence.tipPin, pin, `${name}: tip PIN`);
    assert.equal(evidence.section0Sha256, ownLockSha256, `${name}: §0 SHA`);
  }
});

test('T-w12c-2: six EXTERNAL sections, fifth-family authority MATCH, 18 unchanged products, and historical FROZEN closing', () => {
  const session = sessionStart();
  for (const knife of [...wave12, ownKnife]) externalSection(knife);

  const authorityKnife = 'tip-soft-adopt-fifth-family-live-r1';
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

  const lifecycle = read('bench-log-offloop-lifecycle-wave11-sibling-accept-r1.md');
  assert.doesNotMatch(lifecycle, /标题仍\s*\*\*FROZEN \/ 开干\*\*，§3 扫收未改/);
  assert.match(lifecycle, /Codex 交卷时标题为\s*\*\*FROZEN \/ 开干\*\*.*独立 SCAN 已.*CLOSED — PASS/);
  const dtsal = read('bench-log-offloop-dtsal-write-scope-replay-harden-r1.md');
  assert.doesNotMatch(dtsal, /冻结仍 FROZEN 等待独立 SCAN/);
  assert.match(dtsal, /交卷时冻结为 FROZEN \/ 开干.*独立 SCAN 已.*CLOSED — PASS/);

  const dtelpExternal = externalSection('dayloop-transport-experience-live-persist-r1');
  assert.match(dtelpExternal, /无并行漂移|MATCH/);
  assert.match(dtelpExternal, /liveWritePathProven=true/);
  const fifthExternal = externalSection(authorityKnife);
  assert.match(fifthExternal, /无漂移|MATCH/);

  const originalWave11 = read(`${out}/before-documents/bench-log-offloop-wave11-closeout-cleanup-r1.md`);
  assert.equal(
    externalSection('wave11-closeout-cleanup-r1'),
    externalSection('wave11-closeout-cleanup-r1', originalWave11),
    'wave11-closeout existing EXTERNAL body remains verbatim',
  );

  const ownBench = read(`bench-log-offloop-${ownKnife}.md`);
  for (const gloss of [
    'EXTERNAL_DRIFT=外部并行漂移',
    'PIN=钉死基线哈希',
    'NO_PRODUCT_DELTA=无产品差分',
    'TRANSPORT=传输层失败',
    'SCAN=独立扫收',
    'MATCH=权威证据哈希一致',
    'PRODUCT_DELTA=有产品差分',
  ]) assert.match(ownBench, new RegExp(gloss));
});
