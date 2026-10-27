import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const ownKnife = 'wave8-closeout-cleanup-r1';
const wave8 = [
  'propose-external-hygiene-r1',
  'sticky-mid-contrast-smoke-r1',
  'experience-compose-deepen-r1',
  'dayloop-tip-soft-adopt-live-r1',
  'agent-miss-path-product-knife-r1',
];
// tip-soft / sticky-latch may be FROZEN|SCAN CLOSED (independent SCAN owns CLOSED).
// Other knives have independent SCAN lifecycles outside this closeout's scope.
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
const sha256 = (relativePath) => createHash('sha256')
  .update(fs.readFileSync(path.join(root, relativePath))).digest('hex');

function freezeBadges(knife) {
  const text = read(`freeze-offloop-${knife}.md`);
  const headings = [...text.matchAll(/^# (.+)$/gm)];
  assert.equal(headings.length, 1, `${knife}: exactly one H1`);
  const headingBadge = headings[0][1].match(/[：:]\s*\*\*([^*\n]+)\*\*\s*$/);
  assert.ok(headingBadge, `${knife}: H1 must have its lifecycle badge`);
  const statuses = [...text.matchAll(/^- \*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, `${knife}: exactly one 状态 badge`);
  // Body history and even a knife's title can mention other lifecycle states.
  // Only the actual H1/status badges define its current state.
  return [headingBadge[1], statuses[0][1]];
}

function baseline() {
  const sessionPath = '/tmp/codex-wave8-closeout-cleanup-r1/before-hashes.txt';
  const preservedPath = path.join(root, `offloop/out-${ownKnife}/before-hashes.txt`);
  const preserved = fs.readFileSync(preservedPath);
  const bytes = fs.existsSync(sessionPath) ? fs.readFileSync(sessionPath) : preserved;
  assert.deepEqual(preserved, bytes, 'before-hashes artifact preserves the session file verbatim');
  const rows = new Map();
  for (const line of bytes.toString('utf8').trim().split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+([a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.ok(match, `invalid before-hashes row: ${line}`);
    assert.ok(!rows.has(match[1]), `duplicate before-hashes row: ${match[1]}`);
    rows.set(match[1], match[2]);
  }
  return rows;
}

test('T-w8c-1: wave8 stays SCAN CLOSED; this knife FROZEN|SCAN CLOSED; sticky-latch/tip-soft FROZEN|SCAN CLOSED; tip PIN is unchanged', () => {
  for (const knife of wave8) {
    for (const badge of freezeBadges(knife)) {
      assert.match(badge, /^CLOSED — PASS(?:\b|[（·])/, `${knife}: retain independent SCAN PASS`);
      assert.doesNotMatch(badge, /\bFROZEN\b/, `${knife}: no mid-flight lifecycle badge`);
    }
  }
  // Codex must not self-CLOSE; independent SCAN may flip ownKnife to CLOSED — PASS.
  {
    const [heading, status] = freezeBadges(ownKnife);
    const title = read(`freeze-offloop-${ownKnife}.md`).split(/\r?\n/)[0];
    const frozenHonesty = /^FROZEN\s*\/\s*(?:开干|SCAN READY)/.test(heading)
      && /^FROZEN\s*\/\s*/.test(status)
      && !/\bCLOSED\b/.test(heading);
    const scanClosed = /CLOSED — PASS/.test(title)
      && /^CLOSED — PASS/.test(heading)
      && /^CLOSED — PASS/.test(status);
    assert.ok(frozenHonesty || scanClosed, `${ownKnife}: stay FROZEN (Codex) or SCAN CLOSED`);
  }
  // sticky-latch / tip-soft: independent SCAN may flip CLOSED — PASS (TRANSPORT / NO_PRODUCT_DELTA ok).
  for (const knife of ['sticky-latch-dayloop-smoke-r1', 'tip-soft-adopt-second-family-live-r1']) {
    const [heading, status] = freezeBadges(knife);
    const title = read(`freeze-offloop-${knife}.md`).split(/\r?\n/)[0];
    const frozenHonesty = /^FROZEN\s*\/\s*(?:开干|SCAN READY)/.test(heading)
      && /^FROZEN\s*\/\s*/.test(status)
      && !/\bCLOSED\b/.test(heading);
    const scanClosed = /CLOSED — PASS/.test(title)
      && /^CLOSED — PASS/.test(heading)
      && /^CLOSED — PASS/.test(status);
    assert.ok(frozenHonesty || scanClosed, `${knife}: stay FROZEN (Codex) or SCAN CLOSED`);
  }

  assert.equal(baseline().get('tip'), pin, 'session tip PIN is unchanged');
  const pinDeclaration = read('offloop/path-signals.mjs')
    .match(/export\s+const\s+STEAL_TIP_PIN\s*=\s*(['"])([a-f0-9]{40})\1\s*;/);
  assert.ok(pinDeclaration, 'STEAL_TIP_PIN must remain explicitly declared in the product source');
  assert.equal(pinDeclaration[2], pin, 'STEAL_TIP_PIN is unchanged');
  const tip = '/workspace/dda-tip-r25';
  if (fs.existsSync(tip)) {
    const head = execFileSync('git', ['-C', tip, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
    assert.equal(head, pin, 'tip checkout HEAD remains pinned');
  }
});

test('T-w8c-2: all five EXTERNAL footnotes and authoritative adoptedL1Rows=1 are present; all baseline products match', () => {
  for (const knife of wave8) {
    const text = read(`bench-log-offloop-${knife}.md`);
    const sections = [...text.matchAll(/^## EXTERNAL \/ 并行哈希[\t ]*\r?$/gm)];
    assert.equal(sections.length, 1, `${knife}: exactly one EXTERNAL section`);
  }

  const tipSoft = read('bench-log-offloop-dayloop-tip-soft-adopt-live-r1.md');
  const correction = tipSoft.split(/\r?\n\s*\r?\n/).find((paragraph) => (
    /adoptedL1Rows\s*(?:=|:|：)\s*1\b/.test(paragraph)
    && /权威|一手|为准|authoritative/i.test(paragraph)
    && /summary\.json/.test(paragraph)
  ));
  assert.ok(correction,
    'a sourced authoritative adoptedL1Rows=1 footnote must correct any historical “2 条” wording');
  const summary = JSON.parse(read('offloop/out-dayloop-tip-soft-adopt-live-r1/summary.json'));
  assert.equal(summary.adoptedL1Rows, 1, 'one-hand evidence remains adoptedL1Rows=1');
  assert.equal(summary.adopt, true, 'the corrected count still satisfies the successful-adopt path');

  const before = baseline();
  for (const file of requiredProducts) {
    assert.ok(before.has(file), `${file}: required product must be in the session baseline`);
  }
  // Check every supplied product row, including the scorer outside offloop/.
  for (const [file, expected] of before) {
    if (file === 'tip') continue;
    assert.match(file, /^[a-z0-9-]+\.mjs$/, `${file}: expected a product basename`);
    assert.match(expected, /^[a-f0-9]{64}$/, `${file}: baseline must be SHA-256`);
    const relativePath = file === 'score-topology-run.mjs' ? `bench/${file}` : `offloop/${file}`;
    assert.equal(sha256(relativePath), expected, `${relativePath}: product before=after`);
  }
});
