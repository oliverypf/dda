import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  dedupeExperience, listExperience, retrieveExperience, parseExperienceBody,
} from '../experience.mjs';
import {
  proposeFromIngest, attachPrior, selectPriorsForHypothesis,
} from '../propose.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';

function experience(slug, {
  lesson = 'Keep independent observations in the off-loop experience library.',
  reason = 'experience_only', adopted = false, date = '2026-10-25',
  file = `${date}-${slug}.md`, title = slug,
} = {}) {
  return parseExperienceBody([
    `# EXPERIENCE — ${title}`,
    `- **slug**: ${slug}`,
    `- **date**: ${date}`,
    `- **adopted_candidate**: ${adopted ? 'yes' : 'no'} (${reason})`,
    `- **lesson**: ${lesson}`,
  ].join('\n'), { file });
}

function ingest() {
  return {
    totals: { poisonLoopCount: 1, dprCount: 1 },
    cells: [{
      cellId: 'edr/fixture', poisonLoopCount: 1, dprCount: 1,
      evidenceQuotes: [
        { kind: 'poison_loop', sequence: 2, text: 'probe-only loop observed' },
        { kind: 'dpr', sequence: 1, text: 'DPR demote observed' },
      ],
    }],
  };
}

const emptyIngest = { totals: {}, cells: [] };
const softHypothesis = { slug: 'host-note-observation', class: 'soft_layer', tags: ['soft'] };

test('T-edr-1: same-slug fold prefers adoption, recency and detail with stable provenance', () => {
  const adopted = experience('host-note-repeat', { adopted: true, date: '2026-10-20' });
  const newerReject = experience('host-note-repeat', { date: '2026-10-25' });
  const entries = [newerReject, adopted];
  const before = structuredClone(entries);
  const folded = dedupeExperience(entries);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].file, adopted.file);
  assert.equal(folded[0].duplicateCount, 2);
  assert.ok(folded[0].foldedFrom.includes(newerReject.file));
  assert.deepEqual(entries, before, 'fold must not mutate its inputs');
  assert.deepEqual(dedupeExperience([...entries].reverse()), folded);
  assert.deepEqual(dedupeExperience(folded), folded, 'fold is idempotent');
  assert.deepEqual(dedupeExperience([...folded, ...folded]), folded, 'repeated retrieval of a folded source is not a new duplicate');

  const older = experience('same-direction', { date: '2026-10-23' });
  const newer = experience('same-direction', { date: '2026-10-24' });
  assert.equal(dedupeExperience([older, newer])[0].file, newer.file);
  const byFilename = [older, newer].map((e) => ({ ...e, date: '' }));
  assert.equal(dedupeExperience(byFilename)[0].file, newer.file);
  const detail = [{ slug: 'detail', lesson: 'short' }, { slug: 'detail', lesson: 'a longer useful lesson' }];
  assert.equal(dedupeExperience(detail)[0].lesson, detail[1].lesson);
});

test('T-edr-2: list and retrieve AND tag, slug, reason and query filters', (t) => {
  const smoke = fileURLToPath(new URL('../out-experience-dedupe-retrieve-r1/', import.meta.url));
  fs.mkdirSync(smoke, { recursive: true });
  const dir = fs.mkdtempSync(`${smoke}filters-`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const selected = experience('host-note-check', { reason: 'missing_soft_evidence', lesson: 'Checksum evidence must accompany a soft result.', file: 'selected.md' });
  const entries = [
    selected,
    experience('host-note-other', { reason: 'missing_soft_evidence', lesson: 'Checksum belongs to a different independent lesson about replay timing.', file: 'wrong-slug.md' }),
    experience('host-note-check', { reason: 'false_win', lesson: selected.lesson, file: 'wrong-reason.md' }),
    experience('host-note-check', { adopted: true, reason: 'missing_soft_evidence', lesson: selected.lesson, file: 'wrong-tag.md' }),
  ];
  for (const entry of entries) fs.writeFileSync(`${dir}/${entry.file}`, entry.body);
  const filter = { tags: ['SOFT', 'rejected'], slug: 'HOST-NOTE-CHECK', reason: 'MISSING_SOFT_EVIDENCE', query: 'checksum', dedupe: true };
  assert.equal(listExperience(dir).length, 4, 'unfiltered list remains raw');
  for (const retrieve of [listExperience, retrieveExperience]) {
    assert.deepEqual(retrieve(dir, filter).map((e) => e.file), ['selected.md']);
    assert.deepEqual(retrieve(null, { ...filter, entries }).map((e) => e.file), ['selected.md']);
    assert.deepEqual(retrieve(null, { ...filter, entries, query: 'unrelated-token' }), []);
    assert.deepEqual(retrieve(null, { ...filter, entries, tags: ['soft', 'missing-tag'] }), []);
    assert.deepEqual(retrieve(null, { ...filter, entries, limit: 0 }), []);
    const reasonAlias = { ...selected, rejectReason: null };
    assert.equal(retrieve(null, { ...filter, entries: [reasonAlias] }).length, 1);
  }
  assert.equal(listExperience(null, { entries, dedupe: true }).length, 2);
  assert.equal(retrieveExperience(null, { entries, limit: 10 }).length, 2);
  assert.equal(retrieveExperience(null, { entries, dedupe: false, limit: 10 }).length, 4);
});

test('T-edr-3: duplicate shipped sticky priors leave the first slot for a distinct soft lesson', () => {
  const sticky = Array.from({ length: 8 }, (_, i) => experience('post-dpr-sticky-execute', {
    adopted: true, reason: 'probe_adopt',
    file: `sticky-source-${i}.md`,
    lesson: 'Poison-loop sticky post-dpr soft latch dayloop recurrence remains an observation.',
  }));
  const foldedSticky = dedupeExperience(sticky);
  assert.equal(foldedSticky.length, 1);
  assert.equal(foldedSticky[0].duplicateCount, 8, 'the shipped survivor retains all eight distinct sources');
  const soft = experience('soft-evidence-check', {
    reason: 'missing_soft_evidence', lesson: 'Record the exact source hash before comparing independent soft runs.',
  });
  const result = proposeFromIngest(ingest(), { experienceEntries: [...sticky, soft] });
  const host = result.accepted.find((h) => h.slug === 'host-note-post-dpr-execute-bias');
  assert.ok(host);
  assert.equal(host.prior[0].slug, soft.slug);
  assert.equal(host.prior[0].adopted, false);
  assert.equal(host.prior.filter(matchesMergedDirection).length, 1);
  assert.ok(result.accepted.every((h) => h.prior.length <= 3));
  const library = proposeFromIngest(emptyIngest, { experienceEntries: [...sticky, soft] });
  assert.equal(library.accepted.length, 1);
  assert.equal(library.accepted[0].evidence[0].experienceSlug, soft.slug);
  assert.equal(matchesMergedDirection(library.accepted[0]), false);
});

test('T-edr-4: slugless same-reason near lessons fold but unrelated or opposing lessons remain distinct', () => {
  const base = 'Soft evidence must include exact source hashes before any candidate comparison';
  const near = experience('host-note-copy-a', { reason: 'missing_soft_evidence', lesson: base });
  const normalized = experience('host-note-copy-b', { reason: 'missing_soft_evidence', lesson: `  ${base.toUpperCase().replaceAll(' ', '  ')}  ` });
  const extended = experience('host-note-copy-c', { reason: 'missing_soft_evidence', lesson: `${base} safely` });
  const distinct = experience('host-note-distinct', { reason: 'missing_soft_evidence', lesson: 'Store separate baseline timestamps to reproduce the failed comparison later.' });
  const opposing = experience('host-note-opposing', { reason: 'missing_soft_evidence', lesson: base.replace('must include', 'must not include') });
  const otherReason = experience('host-note-other-reason', { reason: 'false_win', lesson: base });
  const entries = [near, normalized, extended, distinct, opposing, otherReason]
    .map((entry) => ({ ...entry, slug: '' }));
  const folded = dedupeExperience(entries);
  assert.equal(folded.length, 4);
  assert.equal(folded.find((e) => e.duplicateCount === 3)?.foldedFrom.length, 3);
  for (const entry of [distinct, opposing, otherReason]) assert.ok(folded.some((e) => e.file === entry.file));
  assert.equal(attachPrior(softHypothesis, entries.slice(0, 4)).prior.length, 2);
  assert.equal(dedupeExperience([{ lesson: '' }, { lesson: '' }]).length, 2, 'empty keys are not duplicates');
});

test('T-edr-5: shipped soft and HOST-note aliases alone never seed a new library hypothesis', () => {
  const entries = [
    experience('post-dpr-sticky-execute', { reason: 'false_win' }),
    experience('host-note-alias', { title: 'HOST note aligned with PR #83', reason: 'missing_soft_evidence' }),
    experience('renamed-observation', { reason: 'shipped_duplicate' }),
  ];
  for (const entry of entries) {
    const result = proposeFromIngest(emptyIngest, { experienceEntries: [entry] });
    assert.deepEqual(result.accepted, [], entry.slug);
  }
});

test('T-edr-6: unshipped lessons outrank distinct shipped soft rejects before retrieval caps', () => {
  const lessons = [
    'Record timestamps for replay.', 'Hash the source files.', 'Keep verification results.',
    'Count recurrent poison events.', 'Compare independent baselines.', 'Inspect bounded action traces.',
  ];
  const shipped = lessons.map((lesson, i) => experience(`sticky-execute-soft-latch-${i}`, {
    reason: 'false_win', lesson,
  }));
  const residual = experience('independent-observation', {
    reason: 'experience_only', lesson: 'An independent residual observation remains available for future reference.',
  });
  const result = proposeFromIngest(ingest(), { experienceEntries: [...shipped, residual] });
  const host = result.accepted.find((h) => h.slug === 'host-note-post-dpr-execute-bias');
  assert.equal(host.prior[0].slug, residual.slug);
  const source = result.accepted.find((h) => h.class === 'experience');
  assert.equal(source.evidence[0].experienceSlug, residual.slug);
  assert.ok(host.prior.length <= 3);

  const high = { ...residual, slug: 'high-relevance', file: 'high.md', score: 10 };
  const low = { ...residual, slug: 'low-relevance', file: 'low.md', lesson: 'A distinct unrelated observation.', score: 1, adopted: true };
  assert.equal(selectPriorsForHypothesis(softHypothesis, [low, high])[0].slug, high.slug);
});

test('T-edr-7: folded hard-gate lessons stay warn-only and never become host adoption', () => {
  const hard = experience('soft-hard-gate-observation', {
    reason: 'hard_gate_path', adopted: true, lesson: 'A runtime path was touched; retain rejection evidence only.',
  });
  const rejected = { ...hard, adopted: false, file: 'later-rejection.md' };
  const hits = [hard, rejected];
  const soft = attachPrior(softHypothesis, hits);
  assert.equal(soft.prior.length, 1);
  assert.equal(soft.prior[0].reason, 'hard_gate_path');
  assert.equal(soft.prior[0].adopted, false);
  assert.equal(soft.prior[0].softReject, true);
  assert.deepEqual(attachPrior({ slug: 'observation', class: 'experience' }, hits).prior, []);
  const result = proposeFromIngest(ingest(), { experienceEntries: hits });
  assert.ok(result.accepted.every((h) => !['host_code_patch', 'host_latch_adopt'].includes(h.class)));
  assert.ok(result.accepted.every((h) => h.probeKind !== 'host_code_patch'));
});

test('T-edr-8: a newer same-slug generic record retains its folded source shipped status', () => {
  const shipped = experience('generic-observation', {
    title: 'Sticky execute',
    date: '2026-10-24', lesson: 'Retain completed action observations for later inspection.',
  });
  const alias = experience('generic-observation', {
    date: '2026-10-25', lesson: shipped.lesson,
  });
  const entries = [shipped, alias];
  assert.equal(dedupeExperience(entries)[0].file, alias.file, 'generic survivor wins on recency');
  assert.equal(matchesMergedDirection(alias), false);
  const selected = selectPriorsForHypothesis(softHypothesis, entries);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].slug, alias.slug);
  assert.equal(selected[0].shippedDuplicate, true);
  assert.deepEqual(proposeFromIngest(emptyIngest, { experienceEntries: entries }).accepted, []);
  const independent = experience('independent-source', { lesson: 'Preserve separate replay timing measurements.' });
  const result = proposeFromIngest(emptyIngest, { experienceEntries: [...entries, independent] });
  assert.equal(result.accepted[0].evidence[0].experienceSlug, independent.slug);
  assert.equal(result.accepted[0].prior[0].slug, independent.slug);
});
