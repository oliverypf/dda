import test from 'node:test';
import assert from 'node:assert/strict';
import { planSoftFiles } from '../soft-worktree.mjs';

const direction = 'host-note-post-dpr-execute-bias';

test('T-align82-1: matching HOST direction aligns A/B/D/E with #82 and keeps soft guidance', () => {
  const suppliedHost = '# Custom HOST\n\nKeep caller guidance.\n';
  for (const overrides of [
    {},
    { softFiles: [{ relPath: 'HOST/host-note.md', content: suppliedHost }] },
  ]) {
    const planned = planSoftFiles({ slug: direction, ...overrides });
    assert.equal(planned.ok, true);
    const host = planned.files.find((file) => file.relPath === 'HOST/host-note.md');
    assert.ok(host, 'the matching slug must generate HOST content');
    const body = host.content;

    assert.match(body, /HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER/);
    assert.match(body, /Probe[ -]budget exhausted under DIAGNOSE_PROBE_RECOVER/i);
    assert.match(body, /After DPR \(diagnose_probe_exhausted_recover\)/);
    assert.match(body, /stop further read\/list\/focus empty probes/i);
    for (const action of ['file.write', 'file.patch', 'shell.execute', 'test.execute', 'verify']) {
      assert.ok(body.includes(action), `HOST must retain ${action}`);
    }
    assert.match(body, /probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE \(post_dpr_sticky_execute\)/);
    assert.match(body, /(?:at most|bounded)[^\n]*diagnose-probe-exhausted recovers per run/i);
    assert.match(body, /Sticky execute \(#83 \/ post-dpr-sticky-execute\)[^\n]*latch[^\n]*PLAN_THEN_EXECUTE[^\n]*soft guidance only/);
    assert.match(body, /green \+ poisonLoop != 0 = false win/);
    assert.match(body, /verification is green and poisonLoop == 0/);
    assert.match(body, /_Soft-layer only\. Never edits runtime hard gates\._$/);
    if (overrides.softFiles) assert.ok(body.startsWith(suppliedHost));
  }
});

test('T-align82-2: sticky keeps its own latch guidance; docs, steal-shaped soft and generic HOST avoid alignment injection', () => {
  const cases = [
    {
      hypothesis: {
        slug: 'post-dpr-sticky-execute',
        class: 'latch_draft_md',
        tags: ['sticky'],
        latchDraftMd: '## Sticky execute latch\n\nKeep the existing latch draft.\n',
      },
      paths: ['latch-md/latch-draft.md'],
    },
    {
      hypothesis: { slug: 'ordinary-soft-docs' },
      paths: ['docs/soft-hypothesis.md'],
    },
    {
      hypothesis: {
        slug: 'steal-shaped-soft-guidance',
        class: 'soft_layer',
        tags: ['steal', 'host-note', 'skill'],
      },
      paths: ['HOST/host-note.md', 'skill/SKILL.md'],
    },
    {
      hypothesis: { slug: 'generic-host-note', tags: ['host-note'] },
      paths: ['HOST/host-note.md'],
    },
  ];
  const alignment = /HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER|Probe[ -]budget exhausted|probe-budget-only|JEV_EVIDENCE_REQUIRED-only|must not re-upgrade|diagnose-probe-exhausted recovers|green \+ poisonLoop != 0 = false win/i;
  const suppliedHost = '# Existing HOST\n\nKeep unrelated caller guidance.\n';
  for (const { hypothesis, paths } of cases) {
    const planned = planSoftFiles(hypothesis);
    assert.equal(planned.ok, true, hypothesis.slug);
    assert.deepEqual(planned.files.map((file) => file.relPath), paths, hypothesis.slug);
    for (const file of planned.files) {
      // Sticky now has its own soft latch body with shared #83 phrases; #82 HOST recovery remains absent.
      const forbidden = hypothesis.slug === 'post-dpr-sticky-execute'
        ? /HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER|Probe[ -]budget exhausted|diagnose-probe-exhausted recovers|green \+ poisonLoop != 0 = false win/i
        : alignment;
      assert.doesNotMatch(file.content, forbidden, `${hypothesis.slug}: ${file.relPath}`);
    }

    const explicit = planSoftFiles({
      ...hypothesis,
      softFiles: [{ relPath: 'HOST/host-note.md', content: suppliedHost }],
    });
    assert.equal(explicit.ok, true, hypothesis.slug);
    assert.deepEqual(explicit.files, [
      { relPath: 'HOST/host-note.md', kind: 'host_note', content: suppliedHost },
    ], hypothesis.slug);
  }
});
