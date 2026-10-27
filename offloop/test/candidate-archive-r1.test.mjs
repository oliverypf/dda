import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isArchivedOrShipped, isPendingCandidate } from '../candidate-archive.mjs';

const root = new URL('../../', import.meta.url);
const targets = [
  ['sticky', 'freeze-candidate-post-dpr-sticky-execute-r1.md'],
  ['sticky', 'offloop/out-true-candidate-r1/freeze-candidate-post-dpr-sticky-execute-r1.md'],
  ['host-note-bias', 'offloop/out-propose-diversity-dedupe-r1/freeze-candidate-host-note-post-dpr-execute-bias-r1.md'],
  ['host-note-bias', 'offloop/out-steal-path-anomaly-candidate-r1/dayloop/freeze-candidate-host-note-post-dpr-execute-bias-r1.md'],
  ['steal', 'offloop/out-steal-path-anomaly-candidate-r1/dayloop/freeze-candidate-steal-post-amt-terminal-replan-r1.md'],
  ['steal', 'offloop/out-steal-path-anomaly-candidate-r1/run-from-miss/freeze-candidate-steal-post-amt-terminal-replan-r1.md'],
  ['steal', 'offloop/out-merged-directions-host-note-r1/freeze-candidate-steal-post-amt-terminal-replan-r1.md'],
];

function readTargets() {
  return targets.map(([slug, file]) => ({ slug, file, text: fs.readFileSync(new URL(file, root), 'utf8') }));
}

test('T-arch-1: durable candidate titles and banners explicitly prevent reopening', () => {
  for (const { slug, file, text } of readTargets()) {
    const title = text.split('\n')[0];
    const banner = text.match(/^- \*\*状态[：:].*$/m)?.[0];
    assert.ok(banner, `${file}: current status banner is required`);
    assert.doesNotMatch(title, /\*\*CANDIDATE\*\*/, file);
    assert.doesNotMatch(banner, /CANDIDATE|待 BOT2 SCAN 升格|点名「冻」后改 FROZEN/, file);
    assert.match(banner, /ARCHIVED|挂着|SHIPPED/, file);
    assert.match(banner, /勿开干/, file);
    assert.match(banner, /防误升格|不再升格|勿重复开刀/, file);
    if (slug === 'steal') {
      assert.match(title, /\*\*SHIPPED\*\*/, file);
      assert.match(banner, /SHIPPED.*#90/, file);
      assert.match(banner, /已合入.*勿重复开刀/, file);
    } else {
      assert.match(title, /\*\*ARCHIVED\*\*/, file);
      assert.match(banner, /ARCHIVED.*挂着/, file);
      assert.match(banner, /不作为待冻升格队列/, file);
      if (slug === 'sticky') assert.match(banner, /#83\/#84.*shipped/, file);
      else {
        assert.match(banner, /soft HOST.*host-note-candidate-promote-r1/, file);
        assert.match(banner, /本稿不再升格/, file);
      }
    }
  }
});

test('T-arch-2: archived/shipped/hanging drafts never enter a pending-freeze list', () => {
  const pending = '# New draft：**CANDIDATE**\n\n- **状态：CANDIDATE（勿开干）。** 待点名冻。\n\n## History\nOlder drafts were ARCHIVED / SHIPPED / 挂着.\n- **状态：SHIPPED。** Historical banner only.\n';
  const drafts = [...readTargets(), { file: 'new-pending-control.md', text: pending }];
  assert.deepEqual(drafts.filter(({ text }) => isPendingCandidate(text)).map(({ file }) => file),
    ['new-pending-control.md']);
  assert.equal(isArchivedOrShipped(pending), false, 'historical body text does not close a current candidate');

  for (const marker of ['ARCHIVED', 'SHIPPED', '挂着']) {
    for (const text of [
      `# Draft：**${marker}**\n\n- **状态：CANDIDATE（勿开干）。**\n`,
      `# Draft：**CANDIDATE**\n\n- **状态：${marker}（勿开干）。**\n`,
    ]) {
      assert.equal(isArchivedOrShipped(text), true, `${marker}: title or banner closes a stale candidate`);
      assert.equal(isPendingCandidate(text), false, `${marker}: excluded from pending-freeze queue`);
    }
  }
  for (const text of ['', '# Notes\n\nCANDIDATE is mentioned in prose.', '# Draft：**FROZEN**']) {
    assert.equal(isPendingCandidate(text), false, 'only current CANDIDATE metadata enters the queue');
  }
});
