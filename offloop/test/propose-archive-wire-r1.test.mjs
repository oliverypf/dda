import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listPendingCandidateDrafts, proposeFromIngest } from '../propose.mjs';

const drive = new URL('../../', import.meta.url);
const archivedTargets = [
  'freeze-candidate-post-dpr-sticky-execute-r1.md',
  'offloop/out-true-candidate-r1/freeze-candidate-post-dpr-sticky-execute-r1.md',
  'offloop/out-propose-diversity-dedupe-r1/freeze-candidate-host-note-post-dpr-execute-bias-r1.md',
  'offloop/out-steal-path-anomaly-candidate-r1/dayloop/freeze-candidate-host-note-post-dpr-execute-bias-r1.md',
  'offloop/out-steal-path-anomaly-candidate-r1/dayloop/freeze-candidate-steal-post-amt-terminal-replan-r1.md',
  'offloop/out-steal-path-anomaly-candidate-r1/run-from-miss/freeze-candidate-steal-post-amt-terminal-replan-r1.md',
  'offloop/out-merged-directions-host-note-r1/freeze-candidate-steal-post-amt-terminal-replan-r1.md',
];

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-paw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('T-paw-1: Propose pending queue excludes durable and conflicting archive statuses, retaining a pure CANDIDATE', (t) => {
  const root = temporaryRoot(t);
  for (const [index, target] of archivedTargets.entries()) {
    fs.copyFileSync(new URL(target, drive), path.join(root, `freeze-candidate-durable-${index}.md`));
  }
  for (const [index, marker] of ['ARCHIVED', '挂着', 'SHIPPED'].entries()) {
    for (const [slot, title, banner] of [
      ['title', marker, 'CANDIDATE'],
      ['banner', 'CANDIDATE', marker],
    ]) {
      fs.writeFileSync(path.join(root, `freeze-candidate-conflict-${index}-${slot}.md`),
        `# Draft：**${title}**\n\n- **状态：${banner}（勿开干）。**\n`);
    }
  }
  const file = 'freeze-candidate-pending-control.md';
  const text = '# New draft：**CANDIDATE**\n\n- **状态：CANDIDATE（勿开干）。** 待点名冻。\n\n## History\nOlder drafts were ARCHIVED / 挂着 / SHIPPED.\n- **状态：SHIPPED。** Historical banner only.\n';
  fs.writeFileSync(path.join(root, file), text);
  fs.writeFileSync(path.join(root, 'freeze-candidate-frozen.md'), '# Draft：**FROZEN**\n');
  fs.writeFileSync(path.join(root, 'freeze-candidate-prose.md'), '# Notes\n\nCANDIDATE is mentioned in prose.\n');

  assert.deepEqual(listPendingCandidateDrafts(root), [{ file, path: path.join(root, file), text }]);
});

test('T-paw-2: non-allowlist progress FAIL plus agent_miss stays EXPERIENCE-only with no CANDIDATE write path', () => {
  const result = proposeFromIngest({
    totals: {},
    pathSignals: { progressFailLeaseCount: 1, agentMissCount: 1, postAmtCount: 0 },
    cells: [{
      cellId: 'path-only',
      pathSignals: { progressFailLeaseCount: 1, agentMissCount: 1 },
      evidenceQuotes: [
        { kind: 'progress_fail_lease', text: 'actions.progress FAIL observed' },
        { kind: 'agent_miss', text: 'agent_miss_replan observed' },
      ],
    }],
  }, { skipExperience: true });

  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.accepted.map((h) => h.slug), ['experience-agent-miss-progress-fail-not-dgr']);
  for (const hypothesis of result.accepted) {
    assert.equal(hypothesis.class, 'experience');
    assert.match(hypothesis.title, /^EXPERIENCE:/);
    assert.ok(hypothesis.tags.includes('experience'));
    assert.ok(hypothesis.tags.includes('path-anomaly'));
    assert.equal(hypothesis.latchDraftMd, null);
    assert.equal(hypothesis.candidatePath, undefined);
    assert.equal(hypothesis.wroteCandidate, undefined);
    assert.deepEqual(hypothesis.evidence.map((e) => e.kind), ['progress_fail_lease', 'agent_miss']);
  }
  assert.equal(result.candidatePath, undefined);
  assert.equal(result.wroteCandidate, undefined);
});

test('T-paw-3: explicit roots yield sorted unique paths, preserve same basenames, and ignore unrelated entries', (t) => {
  const root = temporaryRoot(t);
  const nested = path.join(root, 'dayloop');
  fs.mkdirSync(nested);
  const file = 'freeze-candidate-shared.md';
  const titleOnly = '# Draft：**CANDIDATE**\n';
  const bannerOnly = '# Draft\n\n- **状态：CANDIDATE（勿开干）。**\n';
  fs.writeFileSync(path.join(root, file), titleOnly);
  fs.writeFileSync(path.join(nested, file), bannerOnly);
  fs.writeFileSync(path.join(root, 'notes.md'), titleOnly);
  fs.writeFileSync(path.join(root, 'freeze-candidate-backup.md.bak'), titleOnly);
  fs.mkdirSync(path.join(root, 'freeze-candidate-directory.md'));
  const direct = { file, path: path.join(root, file), text: titleOnly };
  const child = { file, path: path.join(nested, file), text: bannerOnly };

  assert.deepEqual(listPendingCandidateDrafts(root), [direct], 'nested roots must be explicit');
  assert.deepEqual(listPendingCandidateDrafts([root, nested, path.join(root, '.')]), [child, direct]);
  assert.deepEqual(listPendingCandidateDrafts([nested, root]), [child, direct], 'root order does not change queue order');
  assert.deepEqual(listPendingCandidateDrafts([]), []);
});
