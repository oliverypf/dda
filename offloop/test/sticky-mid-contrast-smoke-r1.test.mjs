import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSoftFileList, planSoftFiles, prepareSoftWorktree } from '../soft-worktree.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, 'out-sticky-mid-contrast-smoke-r1');
const fixtures = JSON.parse(fs.readFileSync(path.join(out, 'fixtures.json'), 'utf8'));
const dedicatedSticky = /does not reimplement (?:the )?runtime latch table/i;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const softSha = '45d3119e9a2f4ceae239f16ff61b863d67c20880786b561979ae9c9cb2c21316';
const hostBodySha = '07fa8f80bab3ee0ed92199ce86a082323a9dae4b33b2d700eb48000025c113ea';
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';

// Exactly three hypotheses; replays reuse them without expanding the hit matrix.
assert.deepEqual(fixtures.map(({ id }) => id), ['A', 'B', 'C']);
const [hit, bare, hostOnly] = fixtures;

function checkMidProduct(t, fixture, expectedPaths) {
  const planned = planSoftFiles(fixture.hypothesis);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.hardGatePaths, []);
  assert.deepEqual(planned.files.map(({ relPath }) => relPath), expectedPaths);
  assert.deepEqual(planSoftFiles(fixture.hypothesis), planned, 'replanning must be reproducible');

  // Scratch writes and retained evidence both stay inside this knife's out dir.
  const scratch = fs.mkdtempSync(path.join(out, `.T-smcs-${fixture.id}-`));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const dir = path.join(scratch, 'soft-product');
  const dry = prepareSoftWorktree(fixture.hypothesis, { dir, write: false, writeExperience: false });
  assert.equal(dry.ok, true);
  assert.equal(dry.wrote, false);
  assert.equal(dry.writeCount, 0);
  assert.equal(dry.experiencePath, null);
  assert.equal(fs.existsSync(dir), false, 'dry mid plan must not write its product');
  assert.deepEqual(dry.files, planned.files);

  const written = prepareSoftWorktree(fixture.hypothesis, { dir, write: true, writeExperience: false });
  assert.equal(written.ok, true);
  assert.equal(written.wrote, true);
  assert.equal(written.dir, dir);
  assert.equal(written.writeCount, planned.files.length);
  assert.equal(written.experiencePath, null);
  assert.deepEqual(written.files, planned.files);

  const fileList = planned.files.map((file) => {
    assert.match(file.relPath, /^(?:latch-md|HOST|skill)\/[^/]+\.md$/);
    const bytes = fs.readFileSync(path.join(dir, file.relPath));
    assert.deepEqual(bytes, Buffer.from(file.content, 'utf8'), `${fixture.id}: written bytes match plan`);
    return { relPath: file.relPath, sha256: sha256(bytes), bytes: bytes.length };
  }).sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  // Compute from actual bytes, independently of hashSoftFileList's result.
  const fileListHash = sha256(fileList.map(({ relPath, sha256: hash }) => `${relPath}\0${hash}\n`).join(''));
  assert.deepEqual(hashSoftFileList(planned.files), { fileList, fileListHash });
  assert.deepEqual(hashSoftFileList([...planned.files].reverse()), { fileList, fileListHash });
  for (const result of [dry, written]) {
    assert.deepEqual(result.fileList, fileList);
    assert.equal(result.fileListHash, fileListHash);
  }
  const manifest = JSON.parse(fs.readFileSync(written.manifestPath, 'utf8'));
  assert.deepEqual(manifest, {
    slug: fixture.hypothesis.slug,
    tipShaHint: null,
    fileListHash,
    fileList,
    softLayerOnly: true,
    hardGates: 'untouched',
  });
  const pathsOnDisk = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
  assert.deepEqual(pathsOnDisk, ['.soft-worktree-manifest.json', ...expectedPaths].sort(),
    'only the soft manifest and planned markdown may be written; no live tip/jsonl output');
  return planned;
}

test('T-smcs-1: A sticky soft_layer HIT has reproducible mid plan, sticky body and matching written bytes', (t) => {
  assert.deepEqual(hit.hypothesis, {
    slug: 'post-dpr-sticky-execute', class: 'soft_layer', tags: ['sticky', 'post-dpr', 'execute'],
  });
  const planned = checkMidProduct(t, hit, ['latch-md/latch-draft.md', 'skill/SKILL.md']);
  const latch = planned.files.find(({ kind }) => kind === 'latch_md');
  assert.ok(latch);
  assert.match(latch.content, /After DPR[^\n]*PLAN_THEN_EXECUTE/);
  assert.match(latch.content, /probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE/);
  assert.match(latch.content, /post_dpr_sticky_execute/);
  assert.match(latch.content, /soft HOST\/latch guidance/i);
  assert.match(latch.content, dedicatedSticky);
  assert.match(latch.content, /#83\/#84 code/);
  assert.match(latch.content, /_Soft-layer only\. Never edits runtime hard gates\._$/);
});

test('T-smcs-2: B bare/incomplete sticky and C host-only miss dedicated inject; HOST, soft, protected hashes and PIN stay fixed', (t) => {
  assert.deepEqual(bare.hypothesis, { slug: 'sticky', class: 'soft_layer', tags: ['sticky', 'post-dpr'] });
  assert.deepEqual(hostOnly.hypothesis, { slug: 'host-note-post-dpr-execute-bias' });
  for (const fixture of [bare, hostOnly]) {
    const planned = checkMidProduct(t, fixture, fixture.id === 'B'
      ? ['HOST/host-note.md', 'skill/SKILL.md'] : ['HOST/host-note.md']);
    assert.equal(planned.files.some(({ kind }) => kind === 'latch_md'), false);
    for (const file of planned.files) assert.doesNotMatch(file.content, dedicatedSticky);
    if (fixture.id === 'C') {
      const host = planned.files.find(({ kind }) => kind === 'host_note');
      const bodyStart = host.content.indexOf('HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER:');
      assert.ok(bodyStart >= 0, 'HOST recovery body must remain present');
      assert.equal(sha256(host.content.slice(bodyStart)), hostBodySha);
      assert.equal(sha256(host.content), '22d45c195a837d8d36d0184f9fd9f495f63dce887ec42cef22808ea5dbcc5c62');
    }
  }

  for (const [name, expected] of Object.entries({
    'soft-worktree.mjs': softSha,
    'compose.mjs': 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f',
    'dayloop-soft.mjs': 'fc2b79d71186132d41910afa0f29e26f15fbf5b0d4d9d1562c2f8754a2ec5c8a',
    'path-signals.mjs': '0015ecd052983c354a4db1aa1d77919751d3793b99008826d0963d5e2e762732',
    'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
    'on-closed.mjs': '6181dea75e82b3ecbe47e0132a99d026438a8a7aef97243f0a23f16d282f6995',
    'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
    'probe.mjs': '11a3885d4ed05494f670f62cce86f078a495d185d7576b2611d23aee99929a1b',
    'probe-l1.mjs': 'd4d5059e5e048c5090a3f866c3fd72e8828b2f93a61c2bc27bd7d5402d77b0de',
  })) {
    assert.equal(sha256(fs.readFileSync(path.join(root, name))), expected, `${name}: frozen bytes`);
  }
  // Read the PIN without importing any runtime/dayloop/path-signals module.
  const source = fs.readFileSync(path.join(root, 'path-signals.mjs'), 'utf8');
  assert.equal(source.match(/export const STEAL_TIP_PIN = '([^']+)'/)?.[1], pin);
});
