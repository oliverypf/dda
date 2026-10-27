import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeExperience, listExperience, retrieveExperience, parseExperienceBody,
} from '../experience.mjs';

function experience(slug, {
  lesson = 'Soft evidence must include exact source hashes before any candidate comparison',
  reason = 'missing_soft_evidence', adopted = false, date = '2026-10-25',
  file = `${date}-${slug}.md`,
} = {}) {
  return parseExperienceBody([
    `# EXPERIENCE — ${slug}`,
    `- **slug**: ${slug}`,
    `- **date**: ${date}`,
    `- **adopted_candidate**: ${adopted ? 'yes' : 'no'} (${reason})`,
    `- **lesson**: ${lesson}`,
  ].join('\n'), { file });
}

function poisonAndHost() {
  const host = experience('host-note-source-check', { date: '2026-10-24' });
  const poison = experience('poison-source-check', {
    adopted: true, lesson: `${host.lesson} safely`,
  });
  return [poison, host];
}

test('T-sfd-1: near lessons with the same reason retain separate poison and host-note slugs', () => {
  const entries = poisonAndHost();
  const before = structuredClone(entries);
  for (const input of [entries, [...entries].reverse()]) {
    for (const hits of [
      dedupeExperience(input),
      retrieveExperience(null, { entries: input }),
      listExperience(null, { entries: input, dedupe: true }),
    ]) {
      assert.deepEqual(hits.map((e) => e.slug).sort(), entries.map((e) => e.slug).sort());
      assert.ok(hits.every((e) => e.duplicateCount === undefined && e.foldedFrom === undefined));
    }
  }
  assert.deepEqual(entries, before, 'dedupe and retrieval must not mutate inputs');
});

test('T-sfd-2: slug-filtered retrieval retains the host-note beside a preferred near poison entry', () => {
  const entries = poisonAndHost();
  const host = entries[1];
  for (const retrieve of [listExperience, retrieveExperience]) {
    const hits = retrieve(null, {
      entries, slug: ' HOST-NOTE-SOURCE-CHECK ', dedupe: true,
    });
    assert.deepEqual(hits.map((e) => e.file), [host.file]);
    assert.equal(hits[0].slug, host.slug);
    assert.equal(hits[0].duplicateCount, undefined);
    assert.equal(hits[0].foldedFrom, undefined);
  }
});

test('T-sfd-3: list and retrieve apply tags, reason and query before same-slug dedupe', () => {
  const selected = experience('host-note-filter-order', {
    date: '2026-10-24', lesson: 'Checksum observations belong to an independent source record.',
  });
  const excluded = experience(selected.slug, {
    adopted: true, reason: 'false_win', lesson: 'Keep baseline timing observations separate.',
  });
  const entries = [excluded, selected];
  assert.equal(dedupeExperience(entries)[0].file, excluded.file, 'full-library folding would discard the match');
  const filters = [
    { tags: ['rejected'] },
    { reason: 'MISSING_SOFT_EVIDENCE' },
    { query: 'checksum' },
    { slug: selected.slug, tags: ['soft', 'rejected'], reason: selected.reason, query: 'checksum' },
  ];
  for (const retrieve of [listExperience, retrieveExperience]) {
    for (const filter of filters) {
      const hits = retrieve(null, { entries, dedupe: true, ...filter });
      assert.deepEqual(hits.map((e) => e.file), [selected.file]);
      assert.equal(hits[0].duplicateCount, undefined, 'excluded entries must not contribute to the fold');
      assert.equal(hits[0].foldedFrom, undefined);
    }
  }
});

test('T-sfd-4: same-slug adoption, recency and provenance survive while dedupe:false stays raw', () => {
  const adopted = experience('host-note-repeat', { adopted: true, date: '2026-10-23' });
  const newer = experience('host-note-repeat', { date: '2026-10-25', lesson: 'A separate later observation.' });
  const entries = [newer, adopted];
  const folded = dedupeExperience(entries);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].file, adopted.file);
  assert.equal(folded[0].duplicateCount, 2);
  assert.deepEqual(folded[0].foldedFrom, entries.map((e) => e.file).sort());
  assert.deepEqual(dedupeExperience(folded), folded);
  const older = { ...adopted, adopted: false };
  assert.equal(dedupeExperience([older, newer])[0].file, newer.file);
  for (const retrieve of [listExperience, retrieveExperience]) {
    assert.equal(retrieve(null, { entries, dedupe: true }).length, 1);
    const raw = retrieve(null, { entries, dedupe: false });
    assert.deepEqual(raw.map((e) => e.file).sort(), entries.map((e) => e.file).sort());
    assert.ok(raw.every((e) => e.duplicateCount === undefined && e.foldedFrom === undefined));
  }
});

test('T-sfd-5: slugless near lessons still fold without bridging distinct nonempty slugs', () => {
  const entries = poisonAndHost();
  const first = { ...entries[1], slug: '', file: 'slugless-a.md' };
  const second = { ...entries[0], slug: '', file: 'slugless-b.md' };
  const slugless = dedupeExperience([first, second]);
  assert.equal(slugless.length, 1);
  assert.equal(slugless[0].duplicateCount, 2);
  const hits = dedupeExperience([...entries, first, second]);
  assert.deepEqual(hits.map((e) => e.slug).sort(), ['', ...entries.map((e) => e.slug)].sort());
  assert.deepEqual(hits.find((e) => e.slug === '').foldedFrom, [first.file, second.file]);
  assert.ok(hits.filter((e) => e.slug).every((e) => e.foldedFrom === undefined));
});
