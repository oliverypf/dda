import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExperienceQuery,
  parseExperienceBody,
  retrieveExperience,
} from '../experience.mjs';
import { proposeFromIngest } from '../propose.mjs';

const DGR_CHECK = 'deterministic-green-jev-behavior-reject-promote';
const TIP_CHECK = 'deterministic-green-jev-uncertain-tip-path';
const ZERO_COUNTS = { dgr: 0, tipPath: 0, postAmt: 0, agentMiss: 0 };

function experience({
  slug,
  lesson = 'Recorded monitoring observations.',
  runId,
  counts,
  pathTags,
  checkIds,
}) {
  const fields = [
    '# EXPERIENCE — Recorded observation',
    '',
    `- **slug**: ${slug}`,
    '- **adopted_candidate**: no (experience_only)',
  ];
  if (runId !== undefined) fields.push(`- **runId**: ${runId}`);
  if (counts !== undefined) {
    fields.push(`- **path_counts**: DGR=${counts.dgr} tip-path=${counts.tipPath} post_amt=${counts.postAmt} agent_miss=${counts.agentMiss}`);
  }
  if (pathTags !== undefined) fields.push(`- **path_tags**: ${pathTags.join(', ') || '(none)'}`);
  if (checkIds !== undefined) fields.push(`- **check_ids**: ${checkIds.join(', ') || '(none)'}`);
  fields.push(`- **lesson**: ${lesson}`, '');
  return parseExperienceBody(fields.join('\n'), { file: `2026-10-25-${slug}.md` });
}

function signals(counts, extra = {}) {
  return {
    dgrPromoteCount: counts.dgr,
    tipPathCount: counts.tipPath,
    postAmtCount: counts.postAmt,
    agentMissCount: counts.agentMiss,
    ...extra,
  };
}

test('T-paec-1: structured path evidence outranks keyword prose in retrieve and Propose priors', () => {
  const counts = { dgr: 2, tipPath: 1, postAmt: 0, agentMiss: 0 };
  const structured = experience({
    slug: 'structured-monitoring-record',
    runId: 'run999', counts, pathTags: ['DGR', 'tip-path'],
    checkIds: [DGR_CHECK, TIP_CHECK],
    lesson: 'Retain these first-hand monitoring observations as library evidence.',
  });
  const legacy = experience({
    slug: 'legacy-monitoring-keywords',
    lesson: 'dgr tip-path promote behavior-reject uncertain monitoring observations.',
  });
  assert.equal(structured.runId, 'run999');
  assert.deepEqual(structured.pathCounts, counts);
  assert.deepEqual(structured.pathTags, ['DGR', 'tip-path']);
  assert.deepEqual(structured.checkIds, [DGR_CHECK, TIP_CHECK]);
  for (const field of ['runId', 'pathCounts', 'pathTags', 'checkIds']) {
    assert.ok(legacy[field] == null, `legacy ${field} stays absent/null`);
  }

  const ingest = {
    runId: 'run999', pathSignals: signals(counts), totals: {},
    cells: [{
      cellId: 't1/run999a',
      evidenceQuotes: [{ kind: 'dgr_promote', text: `verification check ${DGR_CHECK}` }],
    }],
  };
  const entries = [legacy, structured];
  const hits = retrieveExperience(null, {
    entries, query: buildExperienceQuery(ingest),
    pathSignals: ingest.pathSignals, runId: ingest.runId,
  });
  assert.equal(hits.length, 2, 'keyword-only legacy records remain retrievable');
  assert.equal(hits[0].slug, structured.slug);
  assert.ok(hits[0].score > hits[1].score);

  const proposal = proposeFromIngest(ingest, { experienceEntries: entries });
  assert.equal(proposal.experienceContext[0].slug, structured.slug);
  assert.ok(proposal.experienceContext[0].score > proposal.experienceContext[1].score);
  const observation = proposal.accepted.find((hypothesis) => hypothesis.id === 'H-pa2');
  assert.ok(observation, 'first-hand DGR evidence must produce H-pa2');
  assert.equal(observation.prior[0].slug, structured.slug);
  assert.ok(observation.prior[0].score > observation.prior[1].score);
  assert.ok(proposal.accepted.every((hypothesis) => hypothesis.prior.length <= 3));
});

test('T-paec-2: path-anomaly and residual hypotheses stay EXPERIENCE-only; zero counts govern tags', () => {
  const pathSignals = signals({ dgr: 1, tipPath: 1, postAmt: 0, agentMiss: 1 }, {
    progressFailLeaseCount: 1,
  });
  const proposal = proposeFromIngest({
    runId: 'run-monitor', pathSignals, totals: {},
    cells: [{
      cellId: 't1/run-monitor', pathSignals,
      evidenceQuotes: [
        { kind: 'progress_fail_lease', text: 'actions.progress FAIL observed' },
        { kind: 'agent_miss', text: 'agent_miss_replan observed' },
        { kind: 'dgr_promote', text: `verification check ${DGR_CHECK}` },
      ],
    }],
  }, { experienceEntries: [] });
  const hypotheses = [...proposal.accepted, ...proposal.rejected];
  for (const id of ['H-pa1', 'H-pa2']) {
    assert.ok(hypotheses.some((hypothesis) => hypothesis.id === id), `${id} must be generated`);
  }
  const pathHypotheses = hypotheses.filter((hypothesis) => hypothesis.tags.includes('path-anomaly'));
  assert.equal(pathHypotheses.length, 2);
  for (const hypothesis of pathHypotheses) {
    // Compose's unchanged class=experience contract yields EXPERIENCE-only,
    // hence 0 new CANDIDATE; consume tests do not import the write-side module.
    assert.equal(hypothesis.class, 'experience');
    assert.equal(hypothesis.latchDraftMd, null);
  }
  assert.ok(proposal.accepted.length > 0);
  assert.ok(proposal.accepted.every((hypothesis) => hypothesis.class === 'experience'));

  const residual = proposeFromIngest({
    pathSignals: signals(ZERO_COUNTS), totals: {},
    cells: [{ cellId: 't1/run-zero', evidenceQuotes: [{ kind: 'observation', text: 'CLOSED PASS monitoring sample' }] }],
  }, { experienceEntries: [] });
  assert.ok(residual.accepted.some((hypothesis) => hypothesis.id === 'H3'));
  assert.ok(residual.accepted.every((hypothesis) => hypothesis.class === 'experience'));
  assert.ok(residual.accepted.every((hypothesis) => hypothesis.latchDraftMd === null));

  for (const agentMiss of [0, 1]) {
    const entry = experience({
      slug: `authoritative-zero-${agentMiss}`,
      counts: { ...ZERO_COUNTS, agentMiss }, pathTags: [], checkIds: [],
      lesson: 'dgr tip-path promote and post_amt are words in this lesson, not observed promotion counts.',
    });
    assert.equal(entry.tags.includes('agent-miss'), agentMiss > 0);
    for (const tag of ['dgr', 'tip-path', 'post-amt']) assert.equal(entry.tags.includes(tag), false, tag);
    assert.deepEqual(entry.pathTags, []);
    assert.deepEqual(entry.checkIds, []);
  }
});

test('T-paec-3: all-zero structured monitoring beats keyword false positives using options or query alone', () => {
  const structured = experience({ slug: 'zero-monitoring-record', counts: ZERO_COUNTS, pathTags: [], checkIds: [] });
  const legacy = experience({ slug: 'legacy-positive-keywords', lesson: 'dgr tip-path promote observed.' });
  const ingest = { pathSignals: signals(ZERO_COUNTS) };
  const query = buildExperienceQuery(ingest);
  assert.match(query, /soft latch/);
  assert.match(query, /DGR=0/);
  assert.match(query, /tip-path=0/);
  assert.doesNotMatch(query, /dgr promote|tip-path uncertain/i);
  for (const opts of [{ pathSignals: ingest.pathSignals }, {}]) {
    const hits = retrieveExperience(null, { entries: [legacy, structured], query, ...opts });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].slug, structured.slug);
    assert.ok(hits[0].score > hits[1].score);
  }
});

test('T-paec-4: runId normalization boosts matching identity without boosting a different run', () => {
  const same = experience({ slug: 'matching-identity', runId: 'run999' });
  const other = experience({ slug: 'different-identity', runId: 'run998' });
  const entries = [other, same];
  for (const runId of ['999', 'run999']) {
    const hits = retrieveExperience(null, { entries, query: 'monitoring', runId });
    assert.equal(hits[0].slug, same.slug);
    assert.ok(hits[0].score > hits[1].score);
  }
  const baseline = retrieveExperience(null, { entries, query: 'monitoring' });
  const mismatch = retrieveExperience(null, { entries, query: 'monitoring', runId: 'run997' });
  assert.deepEqual(mismatch.map(({ slug, score }) => ({ slug, score })), baseline.map(({ slug, score }) => ({ slug, score })));
  const queryOnly = retrieveExperience(null, { entries, query: 'run999' });
  assert.equal(queryOnly[0]?.slug, same.slug, 'structured runId must be searchable without a prose token match');
});

test('T-paec-5: structured path_tags and check_ids contribute independent matching boosts', () => {
  const same = experience({ slug: 'matching-tokens', pathTags: ['DGR'], checkIds: [DGR_CHECK] });
  const other = experience({ slug: 'different-tokens', pathTags: ['tip-path'], checkIds: [TIP_CHECK] });
  for (const hints of [{ pathTags: ['dgr'] }, { checkIds: [DGR_CHECK] }]) {
    const hits = retrieveExperience(null, { entries: [other, same], ...hints });
    assert.equal(hits[0].slug, same.slug);
    assert.ok(hits[0].score > hits[1].score);
  }
  const queryOnly = retrieveExperience(null, { entries: [other, same], query: DGR_CHECK });
  assert.equal(queryOnly[0]?.slug, same.slug, 'structured check_ids must be searchable when the lesson omits them');
});

test('T-paec-6: exact and nearby count profiles outrank keyword-only records', () => {
  const counts = { dgr: 2, tipPath: 1, postAmt: 0, agentMiss: 0 };
  const lesson = 'dgr tip-path promote monitoring observations.';
  const exact = experience({ slug: 'exact-profile', counts, lesson });
  const nearby = experience({ slug: 'nearby-profile', counts: { ...counts, dgr: 3 }, lesson });
  const legacy = experience({ slug: 'legacy-profile', lesson });
  const hits = retrieveExperience(null, {
    entries: [legacy, nearby, exact], query: 'dgr tip-path promote', pathCounts: counts,
  });
  assert.deepEqual(hits.map((entry) => entry.slug), [exact.slug, nearby.slug, legacy.slug]);
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(hits[1].score > hits[2].score);

  const neutralExact = experience({ slug: 'neutral-exact-profile', counts });
  const neutralNearby = experience({ slug: 'neutral-nearby-profile', counts: { ...counts, dgr: 3 } });
  const richLegacy = experience({ slug: 'rich-keyword-profile', lesson: 'dgr tip-path promote behavior-reject uncertain' });
  const ranked = retrieveExperience(null, {
    entries: [richLegacy, neutralNearby, neutralExact],
    query: buildExperienceQuery({ pathSignals: signals(counts) }),
  });
  assert.deepEqual(ranked.map((entry) => entry.slug), [neutralExact.slug, neutralNearby.slug, richLegacy.slug]);
  assert.ok(ranked[1].score > ranked[2].score, 'nearby counts outrank richer prose even without optional path_tags');
});

test('T-paec-7: count-aware queries retain run identity, exact vocabulary, tags and soft hints', () => {
  const query = buildExperienceQuery({
    runId: 'run999',
    pathSignals: signals({ dgr: 2, tipPath: 1, postAmt: 0, agentMiss: 0 }),
  });
  for (const token of ['run999', 'DGR=2', 'tip-path=1', 'post_amt=0', 'agent_miss=0']) {
    assert.ok(query.includes(token), token);
  }
  assert.match(query, /dgr promote/);
  assert.match(query, /tip-path uncertain/);
  assert.match(query, /soft latch/);
  assert.doesNotMatch(query, /agent-miss replan|post-amt post_agent_miss/);
  const legacy = experience({
    slug: 'historical-keyword-observation',
    lesson: 'DGR, tip-path, post_amt and agent_miss observed.',
  });
  for (const tag of ['dgr', 'tip-path', 'post-amt', 'agent-miss']) assert.ok(legacy.tags.includes(tag), tag);
  const hits = retrieveExperience(null, { entries: [legacy], query });
  assert.equal(hits[0]?.slug, legacy.slug);
  assert.ok(hits[0].score > 0);
});

test('T-paec-8: structured matching permits a thin query while preserving explicit filters', () => {
  const counts = { dgr: 2, tipPath: 1, postAmt: 0, agentMiss: 0 };
  const structured = experience({
    slug: 'filtered-monitoring-record', runId: 'run999', counts,
    pathTags: ['DGR', 'tip-path'],
  });
  const legacy = experience({ slug: 'unrelated-legacy-record', lesson: 'opaque-query-term' });
  const opts = {
    entries: [legacy, structured], query: 'opaque-query-term',
    pathSignals: signals(counts), runId: 'run999',
  };
  assert.equal(retrieveExperience(null, opts)[0].slug, structured.slug,
    'first-hand alignment retrieves the record even when its prose lacks the query');
  const filtered = retrieveExperience(null, {
    ...opts, slug: structured.slug, tags: ['dgr'], reason: 'experience_only',
  });
  assert.deepEqual(filtered.map((entry) => entry.slug), [structured.slug]);
  for (const filter of [
    { slug: 'missing-slug' },
    { tags: ['missing-tag'] },
    { reason: 'missing-reason' },
  ]) {
    assert.deepEqual(retrieveExperience(null, { ...opts, ...filter }), [],
      `alignment must not bypass ${Object.keys(filter)[0]}`);
  }
});

test('T-paec-9: missing counters remain unknown, explicit signals win, and zero labels add no prose boost', () => {
  const zero = experience({ slug: 'zero-profile', counts: ZERO_COUNTS });
  const scoreWith = (pathSignals) => retrieveExperience(null, {
    entries: [zero], query: 'monitoring', pathSignals,
  })[0].score;
  const unknownScore = scoreWith({});
  const partialScore = scoreWith({ dgrPromoteCount: 0 });
  const exactScore = scoreWith(signals(ZERO_COUNTS));
  assert.ok(exactScore > partialScore, 'a partial profile must not receive the complete exact-match boost');
  assert.ok(partialScore > unknownScore, 'an explicit known zero still supplies alignment evidence');
  const partialQuery = buildExperienceQuery({ pathSignals: { dgrPromoteCount: 0 } });
  assert.match(partialQuery, /DGR=0/);
  assert.doesNotMatch(partialQuery, /tip-path=|post_amt=|agent_miss=/,
    'query construction must not fill missing counters with zeros');

  const positive = experience({
    slug: 'positive-profile', counts: { dgr: 2, tipPath: 1, postAmt: 0, agentMiss: 0 },
    pathTags: ['DGR', 'tip-path'],
  });
  const conflictingQuery = 'path_counts:DGR=2 tip-path=1 post_amt=0 agent_miss=0';
  const fromQuery = retrieveExperience(null, { entries: [zero, positive], query: conflictingQuery });
  assert.equal(fromQuery[0].slug, positive.slug);
  const fromSignals = retrieveExperience(null, {
    entries: [zero, positive], query: conflictingQuery, pathSignals: signals(ZERO_COUNTS),
  });
  assert.equal(fromSignals[0].slug, zero.slug);
  assert.ok(fromSignals[0].score > fromSignals[1].score,
    'first-hand options must override conflicting free-text counters');

  const prose = experience({ slug: 'keyword-prose', lesson: 'dgr tip-path promote monitoring observations.' });
  const plain = retrieveExperience(null, { entries: [prose], query: 'monitoring' });
  const zeroLabels = retrieveExperience(null, {
    entries: [prose], query: 'monitoring path_counts:DGR=0 tip-path=0 post_amt=0 agent_miss=0',
  });
  assert.equal(zeroLabels[0].score, plain[0].score,
    'zero-valued field names must not score as positive DGR/tip-path prose matches');
});
