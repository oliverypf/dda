import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashSoftFileList, planSoftFiles, prepareSoftWorktree } from '../soft-worktree.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const direction = 'post-dpr-sticky-execute';
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const hostBodySha = '07fa8f80bab3ee0ed92199ce86a082323a9dae4b33b2d700eb48000025c113ea';
const hostFileSha = '22d45c195a837d8d36d0184f9fd9f495f63dce887ec42cef22808ea5dbcc5c62';
const dedicatedSticky = /does not reimplement (?:the )?runtime latch table/i;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function assertSticky(body) {
  assert.match(body, /After DPR[^\n]*PLAN_THEN_EXECUTE/);
  assert.match(body, /probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE/);
  assert.match(body, /post_dpr_sticky_execute/);
  assert.match(body, /soft HOST\/latch guidance/i);
  assert.match(body, dedicatedSticky);
  assert.match(body, /#83\/#84 code/);
  assert.match(body, /_Soft-layer only\. Never edits runtime hard gates\._$/);
  assert.equal((body.match(/post_dpr_sticky_execute/g) || []).length, 1, 'sticky guidance must appear once');
}

test('T-shnp-1: precise sticky HITs append measurable latch guidance once; misses and write gates stay intact', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-sticky-promote-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const hits = [
    { slug: direction },
    { slug: ' POST_DPR_STICKY_EXECUTE ' },
    { slug: 'sticky-execute' },
    { slug: ' STICKY_EXECUTE ' },
    { slug: 'post-dpr-sticky' },
    { slug: ' POST_DPR_STICKY ' },
    { slug: 'tag-directed', tags: [direction] },
    { slug: 'tag-directed', tags: [' POST_DPR_STICKY_EXECUTE '] },
    { slug: 'tag-directed', tags: ['sticky', 'post-dpr', 'execute'] },
    { slug: 'tag-directed', tags: [' STICKY ', ' POST_DPR ', ' PTE '] },
    { slug: 'tag-directed', tags: ['sticky', 'post-dpr', 'sticky_execute'] },
  ];
  for (const [i, hypothesis] of hits.entries()) {
    const planned = planSoftFiles(hypothesis);
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.files.map((file) => file.relPath), ['latch-md/latch-draft.md']);
    assert.equal(planned.files[0].kind, 'latch_md');
    assertSticky(planned.files[0].content);

    const written = prepareSoftWorktree(hypothesis, { dir: path.join(tmp, `hit-${i}`) });
    assert.equal(written.ok, true);
    assert.equal(written.writeCount, planned.files.length);
    assert.deepEqual(written.files, planned.files);
    assert.deepEqual(written.fileList, hashSoftFileList(planned.files).fileList);
    assert.equal(written.fileListHash, hashSoftFileList(planned.files).fileListHash);
    for (const file of planned.files) {
      assert.equal(fs.readFileSync(path.join(written.dir, file.relPath), 'utf8'), file.content);
    }
  }

  for (const overrides of [{ class: 'soft_layer' }, { tags: ['skill'] }]) {
    const planned = planSoftFiles({ slug: direction, ...overrides });
    assert.equal(planned.ok, true);
    assertSticky(planned.files.find((file) => file.kind === 'latch_md').content);
    assert.ok(planned.files.some((file) => file.relPath === 'skill/SKILL.md'), 'existing implied skill must remain');
  }

  const supplied = '## Caller latch\n\nKeep this caller instruction.\n';
  const withDraft = planSoftFiles({ slug: direction, latchDraftMd: supplied });
  const latch = withDraft.files.find((file) => file.kind === 'latch_md');
  assert.ok(latch.content.startsWith(`${supplied}\n\n`));
  assertSticky(latch.content);
  assert.deepEqual(planSoftFiles({ slug: direction, latchDraftMd: latch.content }).files, withDraft.files);

  for (const relPath of ['latch-md/custom.md', './LATCH-MD/custom.md', 'docs/LATCH-DRAFT.MD', 'latch-md\\custom.txt']) {
    const docs = { relPath: 'docs/context.md', kind: 'docs', content: '# Keep context\n' };
    const declared = { relPath, kind: 'caller_latch', content: supplied };
    const planned = planSoftFiles({ slug: direction, softFiles: [docs, declared] });
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.files[0], docs);
    assert.deepEqual(planned.files.map((file) => file.relPath), [docs.relPath, relPath.replace(/\\/g, '/').replace(/^\.\//, '')]);
    assert.equal(planned.files[1].kind, declared.kind);
    assert.ok(planned.files[1].content.startsWith(`${supplied}\n\n`));
    assertSticky(planned.files[1].content);
    assert.deepEqual(planSoftFiles({ slug: direction, softFiles: planned.files }).files, planned.files);
  }
  const docsOnly = [{ relPath: 'docs/context.md', kind: 'docs', content: '# Explicit docs remain caller-owned\n' }];
  assert.deepEqual(planSoftFiles({ slug: direction, softFiles: docsOnly }).files, docsOnly);

  for (const hypothesis of [
    { slug: 'ordinary-soft-docs' },
    { slug: 'steal-shaped-soft-guidance', class: 'soft_layer', tags: ['steal', 'sticky', 'host-note', 'skill'] },
    { slug: 'host-note-post-dpr-execute-bias' },
    { slug: `${direction}-unrelated` },
    { slug: `unrelated-${direction}` },
    { tags: ['sticky'] },
    { tags: ['sticky', 'execute'] },
    { tags: ['sticky', 'post-dpr'] },
    { tags: ['post-dpr', 'execute'] },
    { tags: ['sticky', 'post-dpr', 'execute-bias'] },
    { tags: [`${direction}-unrelated`] },
  ]) {
    const planned = planSoftFiles(hypothesis);
    assert.equal(planned.ok, true);
    assert.equal(planned.files.some((file) => file.kind === 'latch_md'), false);
    for (const file of planned.files) assert.doesNotMatch(file.content, dedicatedSticky);
    const explicit = planSoftFiles({ ...hypothesis, softFiles: [{ relPath: 'latch-md/caller.md', content: supplied }] });
    assert.equal(explicit.files[0].content, supplied);
  }

  for (const [i, [overrides, reason]] of [
    [{ targetPaths: ['src/runtime/lease.ts'] }, 'hard_gate_path'],
    [{ softFiles: [{ relPath: 'docs/../escape.md', content: supplied }] }, 'disallowed_soft_path'],
  ].entries()) {
    const hypothesis = { slug: direction, ...overrides };
    const planned = planSoftFiles(hypothesis);
    assert.equal(planned.ok, false);
    assert.equal(planned.reason, reason);
    assert.deepEqual(planned.files, []);
    const dir = path.join(tmp, `reject-${i}`);
    const written = prepareSoftWorktree(hypothesis, { dir, writeExperience: false });
    assert.equal(written.rejected, true);
    assert.equal(written.reason, reason);
    assert.equal(written.writeCount, 0);
    assert.equal(written.fileListHash, null);
    assert.equal(fs.existsSync(dir), false);
  }
});

test('T-shnp-2: host-note NO_PRODUCT_DELTA record preserves #82 body, protected sources and locked PIN', () => {
  const record = JSON.parse(fs.readFileSync(path.join(rootDir, 'out-sticky-host-note-promote-r1/host-note-no-product-delta.json'), 'utf8'));
  assert.equal(record.knife, 'sticky-host-note-promote-r1');
  assert.equal(record.host_note, 'NO_PRODUCT_DELTA');
  assert.equal(record.tip_pin, pin);
  assert.equal(record.host_note_body_sha256, hostBodySha);

  const host = planSoftFiles({ slug: 'host-note-post-dpr-execute-bias' }).files.find((file) => file.kind === 'host_note');
  assert.equal(sha256(host.content), hostFileSha, 'host-note planned bytes must remain byte-identical to the pre-knife output');
  const body = host.content.slice(host.content.indexOf('HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER:'));
  assert.equal(sha256(body), hostBodySha);
  assert.match(body, /HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER: Probe budget exhausted under DIAGNOSE_PROBE_RECOVER/);
  assert.match(body, /After DPR \(diagnose_probe_exhausted_recover\)/);
  assert.match(body, /stop further read\/list\/focus empty probes/);
  assert.match(body, /bounded file\.write\/file\.patch or shell\.execute\/test\.execute\/verify/);
  assert.match(body, /probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE \(post_dpr_sticky_execute\)/);
  assert.match(body, /At most a small number of diagnose-probe-exhausted recovers per run/);
  assert.match(body, /green \+ poisonLoop != 0 = false win/);
  assert.match(body, /verification is green and poisonLoop == 0/);
  assert.match(body, /_Soft-layer only\. Never edits runtime hard gates\._$/);
  assert.doesNotMatch(body, dedicatedSticky);

  for (const [name, expected] of Object.entries({
    'compose.mjs': 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f',
    'dayloop-soft.mjs': 'fc2b79d71186132d41910afa0f29e26f15fbf5b0d4d9d1562c2f8754a2ec5c8a',
    'path-signals.mjs': '0015ecd052983c354a4db1aa1d77919751d3793b99008826d0963d5e2e762732',
  })) {
    assert.equal(sha256(fs.readFileSync(path.join(rootDir, name))), expected, `${name} must retain the frozen baseline`);
  }
  assert.equal(STEAL_TIP_PIN, pin);
});
