import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExperienceQuery,
  formatPathStructuredFields,
  parseExperienceBody,
  retrieveExperience,
} from '../experience.mjs';
import { proposeFromIngest } from '../propose.mjs';

const DGR_CHECK = 'deterministic-green-jev-behavior-reject-promote';
const TIP_CHECK = 'deterministic-green-jev-uncertain-tip-path';
const ZERO_COUNTS = { dgr: 0, tipPath: 0, postAmt: 0, agentMiss: 0 };

function signals(counts, extra = {}) {
  return {
    dgrPromoteCount: counts.dgr,
    tipPathCount: counts.tipPath,
    postAmtCount: counts.postAmt,
    agentMissCount: counts.agentMiss,
    ...extra,
  };
}

function experience({ slug, title = 'Recorded monitoring observation', lesson, fields = '', prior }) {
  return parseExperienceBody([
    `# EXPERIENCE — ${title}`,
    '',
    `- **slug**: ${slug}`,
    '- **adopted_candidate**: no (experience_only)',
    fields,
    ...(prior ? [`- **prior**: ${prior}`] : []),
    `- **lesson**: ${lesson}`,
    '- **promoted knife**: none',
    '',
  ].join('\n'), { file: `2026-10-25-${slug}.md` });
}

function assertExperienceOnly(proposal) {
  const hypotheses = [...proposal.accepted, ...proposal.rejected];
  assert.ok(hypotheses.length > 0);
  for (const hypothesis of hypotheses) {
    // The existing Compose class contract routes these to EXPERIENCE only.
    // No write-side import or filesystem artifact is needed for this check.
    assert.equal(hypothesis.class, 'experience', hypothesis.id);
    assert.equal(hypothesis.latchDraftMd, null, hypothesis.id);
  }
}

test('T-dmre-1: mid-REJECTED then typed DGR promote is structured, retrieved first and EXPERIENCE-only', () => {
  const counts = { ...ZERO_COUNTS, dgr: 2, agentMiss: 1 };
  const checkIds = [DGR_CHECK, `execute.${DGR_CHECK}`];
  const evidenceQuotes = checkIds.map((id) => ({ kind: 'dgr_promote', text: `verification check ${id}` }));
  const pathSignals = signals(counts, { evidenceQuotes });
  const fields = formatPathStructuredFields({ runId: 'run888', pathSignals });
  assert.equal(fields, [
    '- **runId**: run888',
    '- **path_counts**: DGR=2 tip-path=0 post_amt=0 agent_miss=1',
    '- **path_tags**: DGR',
    `- **check_ids**: ${checkIds.join(', ')}`,
  ].join('\n'));

  for (const [index, prelude] of [
    'mid FAIL(AF+BR)',
    'mid FAIL(AF+BR/RA) / verification REJECTED',
  ].entries()) {
    const structured = experience({
      slug: `structured-mid-reject-observation-${index}`,
      fields,
      lesson: `${prelude} was the prelude; CLOSED tests green then observed terminal DGR promote through ${DGR_CHECK}.`,
    });
    const legacy = experience({
      slug: `keyword-mid-reject-observation-${index}`,
      lesson: 'dgr mid REJECTED behavior-reject promote monitoring observations.',
    });
    assert.equal(structured.runId, 'run888');
    assert.deepEqual(structured.pathCounts, counts);
    assert.deepEqual(structured.pathTags, ['DGR']);
    assert.deepEqual(structured.checkIds, checkIds);
    assert.equal(structured.pathCounts.dgr, structured.checkIds.length);
    assert.ok(structured.tags.includes('dgr'));
    assert.equal(structured.tags.includes('tip-path'), false);
    assert.equal(structured.adopted, false);
    assert.equal(structured.rejectReason, 'experience_only');
    assert.match(structured.body, /^# EXPERIENCE —/);
    assert.doesNotMatch(structured.body, /^#\s+(?:CANDIDATE|FROZEN)\b/m);
    for (const field of ['runId', 'pathCounts', 'pathTags', 'checkIds']) {
      assert.equal(legacy[field], null, `legacy ${field} remains absent`);
    }

    const ingest = {
      runId: 'run888', pathSignals, totals: {},
      cells: [{ cellId: 't1/run888a', evidenceQuotes }],
    };
    const entries = [legacy, structured];
    const hits = retrieveExperience(null, {
      entries, query: buildExperienceQuery(ingest),
      pathSignals, runId: ingest.runId, checkIds,
    });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].slug, structured.slug);
    assert.ok(hits[0].score > hits[1].score);
    const proposal = proposeFromIngest(ingest, { experienceEntries: entries });
    assert.equal(proposal.experienceContext[0].slug, structured.slug);
    const observed = proposal.accepted.find((hypothesis) => hypothesis.id === 'H-pa2');
    assert.ok(observed, 'first-hand terminal promote generates H-pa2');
    assert.equal(observed.prior[0].slug, structured.slug);
    assertExperienceOnly(proposal);
  }

  const both = experience({
    slug: 'both-observed-paths', lesson: 'Two independently observed path checks.',
    fields: formatPathStructuredFields({
      runId: 'run889', pathCounts: { ...ZERO_COUNTS, dgr: 1, tipPath: 1 },
      checkIds: [DGR_CHECK, DGR_CHECK, TIP_CHECK, `prefix.${DGR_CHECK}`, `${DGR_CHECK}-extra`, 'ACTION_FAILED'],
    }),
  });
  assert.deepEqual(both.pathTags, ['DGR', 'tip-path']);
  assert.deepEqual(both.checkIds, [DGR_CHECK, TIP_CHECK], 'only exact typed IDs are retained and duplicates fold');
  const noInventedId = experience({
    slug: 'counter-without-check', lesson: 'First-hand count with no supplied check reference.',
    fields: formatPathStructuredFields({ pathCounts: { ...ZERO_COUNTS, dgr: 1 } }),
  });
  assert.equal(noInventedId.runId, 'n/a');
  assert.deepEqual(noInventedId.pathTags, ['DGR']);
  assert.deepEqual(noInventedId.checkIds, [], 'counts must not invent missing check evidence');
});

test('T-dmre-2: mid-only structured zeros and negated legacy prose never forge DGR or tip-path', () => {
  const counts = { ...ZERO_COUNTS, agentMiss: 1 };
  const pathSignals = signals(counts, { progressFailLeaseCount: 1 });
  const structured = experience({
    slug: 'structured-mid-only-observation',
    lesson: 'agent_miss replan on mid FAIL(AF+BR) alone ≠ DGR; verification REJECTED alone ≠ tip-path; 非 DGR.',
    fields: formatPathStructuredFields({
      runId: 'run890', pathCounts: counts,
      // Explicit counts, including zeros, outrank conflicting signal values/IDs.
      pathSignals: signals({ dgr: 2, tipPath: 1, postAmt: 1, agentMiss: 4 }),
      checkIds: [DGR_CHECK, `execute.${DGR_CHECK}`, TIP_CHECK],
    }),
  });
  assert.deepEqual(structured.pathCounts, counts);
  assert.deepEqual(structured.pathTags, []);
  assert.deepEqual(structured.checkIds, []);
  assert.match(structured.body, /^- \*\*path_tags\*\*: \(none\)$/m);
  assert.match(structured.body, /^- \*\*check_ids\*\*: \(none\)$/m);
  assert.equal(structured.adopted, false);
  assert.ok(structured.tags.includes('agent-miss'));
  for (const tag of ['dgr', 'tip-path', 'post-amt']) assert.equal(structured.tags.includes(tag), false, tag);

  const legacyCases = [
    { lesson: 'agent_miss on progress FAIL is not DGR.' },
    { lesson: 'mid FAIL(AF+BR) alone ≠ DGR.' },
    { lesson: 'mid FAIL(AF+BR) alone != DGR.' },
    { lesson: 'verification REJECTED ≠ DGR.' },
    { lesson: 'mid FAIL(AF+BR/RA) alone ≠ tip-path/DGR.' },
    { lesson: 'mid REJECTED alone ≠ tip-path.' },
    { lesson: 'agent_miss 中段拒升前奏，非 DGR。' },
    { lesson: 'mid FAIL(AF+BR) is a DGR prelude only.' },
    { lesson: 'mid_REJECTED DGR only.' },
    { lesson: 'mid FAIL(AF+BR) 只是 DGR 前奏。' },
    { lesson: 'mid UNCERTAIN alone ≠ DGR or tip-path.' },
    { lesson: `No verification check ${DGR_CHECK} was observed.` },
    { lesson: `No verification check execute.${DGR_CHECK} was observed.` },
    { lesson: 'DGR promote was not observed; mid REJECTED alone.' },
    { lesson: `Verification check execute.${DGR_CHECK} was not observed.` },
    { title: 'agent_miss when progress FAIL (not DGR)', lesson: 'Recorded mid rejection only.' },
    { slug: 'progress-fail-not-dgr', lesson: 'Recorded mid rejection only.' },
    {
      slug: 'experience-agent-miss-progress-fail-not-dgr',
      title: 'EXPERIENCE: agent_miss when progress FAIL (not DGR)',
      prior: 'experience-agent-miss-progress-fail-not-dgr, experience-dgr-promote-observed, post-dpr-sticky-execute (adopted)',
      lesson: 'agent_miss_replan fired first on mid FAIL(AF+BR) while actions.progress was FAIL. Record as EXPERIENCE only — do not rewrite as 「非 DGR」product claim, do not promote to host latch.',
    },
  ];
  for (const [index, fixture] of legacyCases.entries()) {
    const entry = experience({ slug: `legacy-negative-${index}`, ...fixture });
    assert.equal(entry.pathCounts, null);
    for (const tag of ['dgr', 'tip-path']) {
      assert.equal(entry.tags.includes(tag), false, `${tag} forged for ${JSON.stringify(fixture)}`);
    }
  }

  for (const lesson of [
    `Observed verification check ${DGR_CHECK} after the mid FAIL(AF+BR) prelude.`,
    `Observed verification check execute.${DGR_CHECK} after verification REJECTED.`,
    'CLOSED cell showed deterministic-green-jev-behavior-reject promote after mid FAIL(AF+BR)+tests绿.',
    'Observed deterministic-green-jev-behavior-reject after mid FAIL(AF+BR).',
    'DGR promote observed after successful verification.',
    `mid FAIL(AF+BR) alone ≠ DGR; terminal observed verification check ${DGR_CHECK}.`,
    `agent_miss was not DGR. Later observed verification check ${DGR_CHECK}.`,
  ]) {
    const entry = experience({ slug: 'legacy-positive-observation', lesson });
    assert.ok(entry.tags.includes('dgr'), `clear positive claim lost: ${lesson}`);
    assert.equal(entry.tags.includes('tip-path'), false);
  }

  const legacy = experience({
    slug: 'legacy-false-keywords',
    lesson: 'agent-miss replan monitoring: mid FAIL(AF+BR) alone ≠ tip-path/DGR; not DGR promote.',
  });
  const monitoring = experience({
    slug: 'structured-monitoring-only', lesson: 'Recorded monitoring observation.',
    fields: formatPathStructuredFields({ runId: 'run890', pathSignals }),
  });
  const ingest = {
    runId: 'run890', pathSignals, totals: {},
    cells: [{
      cellId: 't1/run890a', pathSignals,
      evidenceQuotes: [
        { kind: 'agent_miss', text: 'agent_miss_replan after mid verification REJECTED' },
        { kind: 'progress_fail_lease', text: 'actions.progress FAIL' },
      ],
    }],
  };
  const query = buildExperienceQuery(ingest);
  for (const aligned of [structured, monitoring]) {
    for (const hints of [{ pathSignals, runId: 'run890', checkIds: [] }, {}]) {
      const hits = retrieveExperience(null, { entries: [legacy, aligned], query, ...hints });
      assert.equal(hits.length, 2);
      assert.equal(hits[0].slug, aligned.slug);
      assert.ok(hits[0].score > hits[1].score, 'mid-only structured alignment outranks keyword false positives');
    }
  }
  for (const tag of ['dgr', 'tip-path']) {
    assert.deepEqual(retrieveExperience(null, { entries: [structured, monitoring, legacy], tags: [tag] }), [],
      `zero-count and negated records must not satisfy the ${tag} filter`);
  }
  const proposal = proposeFromIngest(ingest, { experienceEntries: [legacy, structured] });
  assert.equal(proposal.experienceContext[0].slug, structured.slug);
  assert.ok(proposal.accepted.some((hypothesis) => hypothesis.id === 'H-pa1'));
  assert.equal([...proposal.accepted, ...proposal.rejected].some((hypothesis) => hypothesis.id === 'H-pa2'), false);
  assertExperienceOnly(proposal);
});
