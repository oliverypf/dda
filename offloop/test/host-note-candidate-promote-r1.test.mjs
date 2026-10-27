import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hashSoftFileList,
  isAllowedSoftRelPath,
  isHardGatePath,
  planSoftFiles,
  prepareSoftWorktree,
} from '../soft-worktree.mjs';

const direction = 'host-note-post-dpr-execute-bias';
const genericHost = '# HOST note — Unrelated soft guidance\n\nKeep the existing soft guidance.\n\n_Soft-layer only. Never edits runtime hard gates._';
const genericSkill = '# Skill — Unrelated soft guidance\n\nKeep the existing soft guidance.\n\nGuidance only (soft harness). No lease/topology/runtime src edits.';
const genericDocs = '# Soft hypothesis — ordinary-soft-docs\n\ntitle: Unrelated soft guidance\n\nKeep the existing soft guidance.\n\n_Isolated soft worktree. Hard gates untouched._';
const richPhrases = /diagnose_probe_exhausted_recover|DIAGNOSE_PROBE_RECOVER|file\.write|file\.patch|shell\.execute|test\.execute|false win/i;

function assertDprHost(body) {
  assert.match(body, /after[^\n]*(?:DPR|diagnose_probe_exhausted_recover|DIAGNOSE_PROBE_RECOVER)/i);
  assert.match(body, /diagnose_probe_exhausted_recover/);
  assert.match(body, /stop[^\n]*read[^\n]*list[^\n]*focus[^\n]*(?:empty|probe)/i);
  assert.match(body, /prefer[^\n]*file\.write[^\n]*file\.patch[^\n]*shell\.execute[^\n]*test\.execute[^\n]*verify/i);
  assert.match(body, /sticky[^\n]*(?:#83|post-dpr-sticky-execute)[^\n]*latch/i);
  assert.match(body, /green[^\n]*poisonLoop\s*!=\s*0[^\n]*false win/i);
  assert.match(body, /soft-layer only[^\n]*never edits runtime hard gates/i);
}

function ordinaryHyp(overrides = {}) {
  return {
    slug: 'ordinary-soft-docs',
    title: 'Unrelated soft guidance',
    summary: 'Keep the existing soft guidance.',
    ...overrides,
  };
}

function assertUnchanged(hyp, expected) {
  const planned = planSoftFiles(hyp);
  assert.equal(planned.ok, true);
  assert.deepEqual(planned.files, expected);
  for (const file of planned.files) assert.doesNotMatch(file.content, richPhrases);
}

const hostFile = { relPath: 'HOST/host-note.md', kind: 'host_note', content: genericHost };
const skillFile = { relPath: 'skill/SKILL.md', kind: 'skill', content: genericSkill };

test('H-promote-1: canonical and underscore slug write measurable DPR HOST with valid soft manifest', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-host-promote-hit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const slug of [direction, 'host_note_post_dpr_execute_bias']) {
    // Slug alone selects the product body; no soft_layer class or host-note tag is required.
    const hyp = { slug, title: 'Post-DPR HOST guidance', summary: 'Preserve this hypothesis context.' };
    const planned = planSoftFiles(hyp);
    assert.equal(planned.ok, true);
    const plannedHost = planned.files.find((file) => file.relPath === 'HOST/host-note.md');
    assert.ok(plannedHost, `${slug} must plan HOST/host-note.md`);
    assertDprHost(plannedHost.content);
    assert.match(plannedHost.content, /Preserve this hypothesis context\./);

    const dir = path.join(root, slug);
    const written = prepareSoftWorktree(hyp, { dir });
    assert.equal(written.ok, true);
    assert.equal(written.wrote, true);
    assert.equal(written.writeCount, planned.files.length);
    assert.equal(fs.readFileSync(path.join(dir, 'HOST/host-note.md'), 'utf8'), plannedHost.content);
    assert.deepEqual(written.files, planned.files);

    const diskList = written.fileList.map((entry) => {
      assert.equal(isAllowedSoftRelPath(entry.relPath), true);
      assert.equal(isHardGatePath(entry.relPath), false);
      const bytes = fs.readFileSync(path.join(dir, entry.relPath));
      return {
        relPath: entry.relPath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      };
    }).sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
    assert.deepEqual(written.fileList, diskList);
    const expectedHash = crypto.createHash('sha256')
      .update(diskList.map((entry) => `${entry.relPath}\0${entry.sha256}\n`).join(''))
      .digest('hex');
    assert.equal(written.fileListHash, expectedHash);
    assert.deepEqual(hashSoftFileList(written.files), { fileList: diskList, fileListHash: expectedHash });

    const manifest = JSON.parse(fs.readFileSync(written.manifestPath, 'utf8'));
    assert.deepEqual(manifest.fileList, diskList);
    assert.equal(manifest.fileListHash, expectedHash);
    assert.equal(manifest.softLayerOnly, true);
    assert.equal(manifest.hardGates, 'untouched');
  }
});

test('H-promote-2: precise direction tags and complete tag aliases select rich HOST without class', () => {
  for (const tags of [
    [direction],
    ['host_note_post_dpr_execute_bias'],
    ['host-note', 'post-dpr-execute-bias'],
    ['host-note', 'post-dpr', 'execute-bias'],
    [' HOST_NOTE ', ' POST_DPR ', ' EXECUTE_BIAS ', 'soft'],
  ]) {
    const planned = planSoftFiles(ordinaryHyp({ tags }));
    assert.equal(planned.ok, true);
    const host = planned.files.find((file) => file.relPath === 'HOST/host-note.md');
    assert.ok(host, `unambiguous tags must plan HOST: ${JSON.stringify(tags)}`);
    assertDprHost(host.content);
  }
});

test('H-promote-3: sticky gets latch guidance only; docs, steal soft-layer and generic HOST stay byte-identical', () => {
  const latchDraftMd = '## Sticky execute latch\n\nKeep the existing latch draft.\n';
  const sticky = planSoftFiles(ordinaryHyp({
    slug: 'post-dpr-sticky-execute',
    class: 'latch_draft_md',
    tags: ['sticky'],
    latchDraftMd,
  }));
  assert.equal(sticky.ok, true);
  assert.deepEqual(sticky.files.map(({ relPath, kind }) => ({ relPath, kind })), [
    { relPath: 'latch-md/latch-draft.md', kind: 'latch_md' },
  ]);
  assert.ok(sticky.files[0].content.startsWith(`${latchDraftMd}\n\n`));
  assert.match(sticky.files[0].content, /post_dpr_sticky_execute/);
  assert.doesNotMatch(sticky.files[0].content, richPhrases);
  assertUnchanged(ordinaryHyp(), [
    { relPath: 'docs/soft-hypothesis.md', kind: 'docs', content: genericDocs },
  ]);
  assertUnchanged(ordinaryHyp({
    slug: 'steal-shaped-soft-guidance',
    class: 'soft_layer',
    tags: ['steal', 'host-note', 'skill'],
  }), [hostFile, skillFile]);
  assertUnchanged(ordinaryHyp({ tags: ['host-note'] }), [hostFile]);
  assertUnchanged(ordinaryHyp({ class: 'soft_layer' }), [hostFile, skillFile]);
});

test('H-promote-4: incomplete direction tags and slug/tag substrings do not inject the DPR body', () => {
  for (const overrides of [
    { slug: `${direction}-unrelated` },
    { slug: `unrelated-${direction}` },
    { tags: ['host-note', 'post-dpr'] },
    { tags: ['host-note', 'execute-bias'] },
    { tags: ['post-dpr', 'execute-bias'] },
    { tags: ['post-dpr-execute-bias'] },
    { tags: [`${direction}-unrelated`] },
    { tags: [`unrelated-${direction}`] },
  ]) {
    assertUnchanged(ordinaryHyp({ class: 'soft_layer', ...overrides }), [hostFile, skillFile]);
  }
});

test('H-promote-5: a matching HOST direction still rejects declared hard-gate paths before any writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-host-promote-reject-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hyp = ordinaryHyp({ slug: direction, targetPaths: ['runtime/src/execution-topology.mjs'] });
  const planned = planSoftFiles(hyp);
  assert.equal(planned.ok, false);
  assert.equal(planned.reason, 'hard_gate_path');
  assert.deepEqual(planned.files, []);
  assert.deepEqual(planned.hardGatePaths, hyp.targetPaths);

  const dir = path.join(root, 'must-not-exist');
  const written = prepareSoftWorktree(hyp, { dir, writeExperience: false });
  assert.equal(written.ok, false);
  assert.equal(written.reason, 'hard_gate_path');
  assert.equal(written.rejected, true);
  assert.equal(written.wrote, false);
  assert.equal(written.writeCount, 0);
  assert.equal(written.fileListHash, null);
  assert.deepEqual(written.files, []);
  assert.deepEqual(written.fileList, []);
  assert.equal(fs.existsSync(dir), false);
});

test('H-promote-6: explicit HOST content gains guidance only on HIT while explicit paths and other contents stay intact', () => {
  const suppliedHost = '# Custom HOST\n\nKeep this caller-supplied instruction.\n';
  const suppliedDocs = '# Custom docs\n\nKeep this independent document.\n';
  for (const hostPath of ['HOST/host-note.md', './host/HOST-NOTE.md', 'HOST\\host-note.md']) {
    const softFiles = [
      { path: hostPath, content: suppliedHost },
      { relPath: 'docs/context.md', content: suppliedDocs },
    ];
    const planned = planSoftFiles(ordinaryHyp({ slug: direction, softFiles }));
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.files.map((file) => file.relPath), [
      hostPath.replace(/\\/g, '/').replace(/^\.\//, ''),
      'docs/context.md',
    ]);
    assert.equal(planned.files[0].content.startsWith(suppliedHost), true);
    assertDprHost(planned.files[0].content);
    assert.equal(planned.files[1].content, suppliedDocs);

    const miss = planSoftFiles(ordinaryHyp({ tags: ['host-note'], softFiles }));
    assert.equal(miss.ok, true);
    assert.equal(miss.files[0].content, suppliedHost);
    assert.equal(miss.files[1].content, suppliedDocs);
    for (const file of miss.files) assert.doesNotMatch(file.content, richPhrases);
  }

  const docsOnly = planSoftFiles(ordinaryHyp({
    slug: direction,
    softFiles: [{ relPath: 'docs/context.md', content: suppliedDocs }],
  }));
  assert.equal(docsOnly.ok, true);
  assert.deepEqual(docsOnly.files, [{ relPath: 'docs/context.md', kind: 'docs', content: suppliedDocs }]);
});
