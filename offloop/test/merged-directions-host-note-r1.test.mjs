import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeCandidate } from '../compose.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';

test('T-host-merged-1: host-note aliases, distinctive titles/tags and own #82 refs reject adoption', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-host-merged-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directions = [
    { slug: 'host-note-post-dpr-execute-bias' },
    { slug: 'host_note_post_dpr_execute_bias' },
    { slug: 'renamed-host-note', title: 'HOST note: post-DPR execute bias' },
    { slug: 'renamed-soft-note', title: 'Post-DPR execute-bias HOST note' },
    { slug: 'renamed-soft-note', tags: ['host-note', 'post-dpr', 'execute-bias'] },
    { slug: 'renamed-soft-note', tags: ['host-note', 'post-dpr-execute-bias'] },
    { slug: 'renamed-soft-note', tags: ['host-note-post-dpr-execute-bias'] },
    { slug: 'renamed-soft-note', title: 'Align with PR #82 soft note' },
    { slug: 'renamed-soft-note', tags: ['host-note', '#82'] },
    { slug: 'renamed-soft-note', prRefs: ['https://github.com/oliverypf/dda/pull/82'] },
    { slug: 'renamed-soft-note', pullRequest: { number: 82 } },
    { slug: 'renamed-soft-note', alignedPrs: ['PR-82'] },
  ];
  for (const [index, direction] of directions.entries()) {
    const hypothesis = { title: 'Soft guidance', class: 'soft_layer', ...direction };
    assert.equal(matchesMergedDirection(hypothesis), true, JSON.stringify(direction));
    const outDir = path.join(root, String(index));
    const result = composeCandidate({
      hypothesis,
      probeResult: { adopt: true, falseWin: false, notes: ['clean contrast'] },
      outDir, experienceDir: path.join(outDir, 'experience'), date: '2026-10-25',
    });
    assert.equal(result.wroteCandidate, false);
    assert.equal(result.candidatePath, null);
    assert.equal(result.reason, 'shipped_duplicate');
    assert.deepEqual(fs.readdirSync(outDir).filter((name) => name.startsWith('freeze-candidate-')), []);
    assert.ok(fs.existsSync(result.experiencePath));
    const body = fs.readFileSync(result.experiencePath, 'utf8');
    assert.match(body, /\*\*adopted_candidate\*\*: no \(shipped_duplicate\)/);
    assert.doesNotMatch(body, /already shipped in PR #83\/#84/);
  }
});

test('T-host-merged-2: ordinary HOST notes and unrelated PRs stay outside merged directions', () => {
  for (const hypothesis of [
    null,
    { slug: 'soft-host-note', title: 'Documentation review checklist', tags: ['soft', 'host-note'] },
    { slug: 'soft-host-note', title: 'Post-DPR observation', tags: ['soft', 'host-note'] },
    { slug: 'soft-host-note', title: 'Execute-bias observation', tags: ['soft', 'host-note'] },
    // Separate fields must not accidentally combine into a distinctive title.
    { slug: 'soft-host-note', title: 'Post-DPR observation', tags: ['soft', 'execute-bias'] },
    { slug: 'soft-host-note', title: 'PR #820 unrelated soft note' },
    { slug: 'soft-host-note', tags: ['host-note', '#820'] },
    { slug: 'soft-host-note', prRefs: ['https://github.com/oliverypf/dda/pull/820'] },
    { slug: 'soft-host-note', pullRequest: { number: 820 } },
    { slug: 'soft-host-note', alignedPr: 'PR-820' },
    { slug: 'soft-host-note', title: 'PR #81 unrelated guidance' },
  ]) assert.equal(matchesMergedDirection(hypothesis), false, JSON.stringify(hypothesis));
});
