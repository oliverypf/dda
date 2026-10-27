/**
 * Path-anomaly (路径异常) counters from cell jsonl events.
 * Complements poison-loop: works on GATE-green cells that still show mid-path shapes.
 */

const DGR_CHECK_RE = /deterministic-green-jev-behavior-reject/;
const TIP_PATH_CHECK_RE = /deterministic-green-jev-uncertain-tip-path/;

// Script-locked steal kinds. Hyphenated slugs/tags and the harness. event prefix
// are spellings of these same kinds, not additional steal-isomorphic directions.
export const STEAL_EVIDENCE_KINDS = Object.freeze([
  'post_amt',
  'post_agent_miss_terminal_replan',
]);
export const STEAL_TIP_PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';

const STEAL_KIND_RE = new RegExp(
  `(?:^|[^a-z0-9_])(?:${STEAL_EVIDENCE_KINDS.map((kind) => kind.replaceAll('_', '[_-]')).join('|')})(?=$|[^a-z0-9_])`,
  'i',
);

/**
 * Positive allowlisted evidence only. A bare steal label, agent_miss, or
 * post_miss_uncertain* / postMissUncertainCount alone is not steal evidence.
 * Do not scan summary/title/prior prose: observations can mention a future
 * post_amt condition without having observed it.
 */
export function isStealShape(input) {
  if (typeof input === 'string') return STEAL_KIND_RE.test(input);
  if (Array.isArray(input)) return input.some(isStealShape);
  if (!input || typeof input !== 'object') return false;
  if (Number.isFinite(Number(input.postAmtCount)) && Number(input.postAmtCount) > 0) return true;
  return [
    input.kind, input.tags, input.notes,
    // A typed DGR/UNCERTAIN quote may discuss post_amt without observing it.
    input.kind ? null : input.text,
    input.slug,
    input.evidence, input.evidenceQuotes, input.pathSignals, input.totals, input.cells,
  ].some(isStealShape);
}

/** Incidental evidence in a library lesson does not make it a product proposal. */
export function hypothesisIsSteal(hypothesis) {
  if (!isStealShape(hypothesis)) return false;
  if (!isLibraryLesson(hypothesis)) return true;
  return isStealShape({
    kind: hypothesis.kind, tags: hypothesis.tags, slug: hypothesis.slug, notes: hypothesis.notes,
  });
}

function isLibraryLesson(hypothesis) {
  return hypothesis?.class === 'experience' ||
    hypothesis?.tags?.includes('experience') || hypothesis?.slug?.startsWith('experience-');
}

const OBSERVATION_RE = /(?:^|[^a-z0-9])(?:path[-_]anomaly|tip[-_]path|dgr|dgr[-_]promote|agent[-_]miss|post[-_]miss[-_]uncertain|progress[-_]fail[-_]lease|steal)(?=$|[^a-z0-9])/i;

function hasPathObservation(input) {
  if (Array.isArray(input)) return input.some(hasPathObservation);
  if (!input || typeof input !== 'object') return false;
  if (input.isPathAnomaly === true) return true;
  if (['agentMissCount', 'postMissUncertainCount', 'dgrPromoteCount', 'tipPathCount', 'progressFailLeaseCount']
    .some((key) => Number(input[key]) > 0)) return true;
  if ([input.kind, input.slug, ...(input.tags || [])].some((value) => OBSERVATION_RE.test(String(value || '')))) return true;
  return [input.evidence, input.evidenceQuotes, input.pathSignals, input.totals].some(hasPathObservation);
}

/** Shared default gate for Compose and its callers; only allowlisted steal lifts it. */
export function isExperienceOnlyHypothesis(hypothesis) {
  if (hypothesisIsSteal(hypothesis)) return false;
  return Boolean(isLibraryLesson(hypothesis) ||
    hypothesis?.class === 'path-anomaly' ||
    hasPathObservation(hypothesis));
}

/**
 * @param {Iterable<object>|object[]} events
 */
export function countPathSignals(events) {
  let agentMissCount = 0;
  let postAmtCount = 0;
  let postMissUncertainCount = 0;
  let dprCount = 0;
  let stickyCount = 0;
  let dgrPromoteCount = 0;
  let tipPathCount = 0;
  let progressFailLeaseCount = 0;
  /** @type {object[]} */
  const evidenceQuotes = [];
  const seenPromote = new Set();

  for (const raw of events) {
    if (!raw || raw.type !== 'runtime_event') {
      if (raw?.harness?.verification?.checks) {
        scanChecks(raw.harness.verification.checks, seenPromote, evidenceQuotes, null, {
          onDgr: () => {
            dgrPromoteCount += 1;
          },
          onTip: () => {
            tipPathCount += 1;
          },
        });
      }
      continue;
    }

    const kind = raw.kind;
    const payload = raw.payload || {};
    const seq = raw.sequence;

    if (kind === 'harness.agent_miss_replan') {
      agentMissCount += 1;
      evidenceQuotes.push({
        kind: 'agent_miss',
        sequence: seq,
        text: `agent_miss_replan status=${payload.status || ''} codes=${JSON.stringify(payload.failureCodes || [])}`,
      });
    } else if (kind === 'harness.post_agent_miss_terminal_replan') {
      postAmtCount += 1;
      evidenceQuotes.push({
        kind: 'post_amt',
        sequence: seq,
        text: `post_agent_miss_terminal_replan codes=${JSON.stringify(payload.failureCodes || [])}`,
      });
    } else if (
      kind === 'harness.post_miss_uncertain_replan' ||
      kind === 'harness.post_miss_uncertain_exhausted_replan' ||
      kind === 'harness.post_miss_evidence_delta_replan'
    ) {
      postMissUncertainCount += 1;
      evidenceQuotes.push({
        kind: 'post_miss_uncertain',
        sequence: seq,
        text: kind,
      });
    } else if (kind === 'harness.diagnose_probe_exhausted_recover') {
      dprCount += 1;
    } else if (kind === 'harness.post_dpr_sticky_execute') {
      stickyCount += 1;
    } else if (kind === 'verification.completed') {
      const checks = payload.checks || [];
      scanChecks(checks, seenPromote, evidenceQuotes, seq, {
        onDgr: () => {
          dgrPromoteCount += 1;
        },
        onTip: () => {
          tipPathCount += 1;
        },
      });
      const progress = checks.find((c) => c.id === 'actions.progress');
      if (
        progress?.status === 'FAIL' &&
        /SAFETY_LEASE_EXPIRED|LEASE_EXPIRED/i.test(String(progress.message || ''))
      ) {
        progressFailLeaseCount += 1;
        evidenceQuotes.push({
          kind: 'progress_fail_lease',
          sequence: seq,
          text: `actions.progress FAIL: ${progress.message}`,
        });
      }
    }
  }

  return {
    agentMissCount,
    postAmtCount,
    postMissUncertainCount,
    dprCount,
    stickyCount,
    dgrPromoteCount,
    tipPathCount,
    progressFailLeaseCount,
    evidenceQuotes: evidenceQuotes.slice(0, 16),
    isPathAnomaly:
      agentMissCount > 0 ||
      postAmtCount > 0 ||
      dgrPromoteCount > 0 ||
      tipPathCount > 0 ||
      progressFailLeaseCount > 0,
  };
}

function scanChecks(checks, seenPromote, evidenceQuotes, seq, { onDgr, onTip }) {
  for (const c of checks || []) {
    const id = String(c.id || c.name || '');
    if (!id) continue;
    if (DGR_CHECK_RE.test(id)) {
      const key = `dgr:${id}`;
      if (!seenPromote.has(key)) {
        seenPromote.add(key);
        onDgr(id);
        evidenceQuotes.push({
          kind: 'dgr_promote',
          sequence: seq,
          text: `verification check ${id}`,
        });
      }
    }
    if (TIP_PATH_CHECK_RE.test(id)) {
      const key = `tip:${id}`;
      if (!seenPromote.has(key)) {
        seenPromote.add(key);
        onTip(id);
        evidenceQuotes.push({
          kind: 'tip_path',
          sequence: seq,
          text: `verification check ${id}`,
        });
      }
    }
  }
}

/**
 * EXPERIENCE path identity from first-hand counters, never notes prose.
 * Aggregate values (including zero) take precedence; missing values fall back
 * to cell counters. Promote counts retain countPathSignals' distinct-id unit.
 */
export function summarizePathAnomalyFields(ingestOrSignals = {}, opts = {}) {
  const ingest = ingestOrSignals || {};
  const signals = ingest.pathSignals || ingest;
  const cells = ingest.cells || [];
  const count = (value) => value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0
    ? Number(value) : null;
  const keys = {
    dgr: 'dgrPromoteCount',
    tipPath: 'tipPathCount',
    postAmt: 'postAmtCount',
    agentMiss: 'agentMissCount',
    postMissUncertain: 'postMissUncertainCount',
    progressFailLease: 'progressFailLeaseCount',
  };
  const counts = Object.fromEntries(Object.entries(keys).map(([name, key]) => [
    name,
    count(signals[key]) ?? cells.reduce((sum, cell) => sum + (count(cell.pathSignals?.[key]) ?? 0), 0),
  ]));
  // Same ordering and vocabulary as score-topology-run.mjs; mid-only firing
  // and post_amt are separate counts and cannot manufacture promote tags.
  const path_tags = [counts.dgr > 0 ? 'DGR' : null, counts.tipPath > 0 ? 'tip-path' : null].filter(Boolean);
  const quotes = [
    ...(ingest.evidenceQuotes || []),
    ...(ingest.pathSignals?.evidenceQuotes || []),
    ...cells.flatMap((cell) => [
      ...(cell.evidenceQuotes || []), ...(cell.pathSignals?.evidenceQuotes || []),
    ]),
  ];
  const checkIds = [...new Set(quotes
    .filter((quote) => quote?.kind === 'dgr_promote' || quote?.kind === 'tip_path')
    .flatMap((quote) => [...String(quote.text || '').matchAll(/\bverification check (\S+)/g)]
      .map((match) => match[1])))];
  const normalizeRunId = (id) => String(id ?? '').trim();
  const cellRunIds = [...new Set(cells.map((cell) => normalizeRunId(cell.runId)).filter(Boolean))];
  const runId = [ingest.runId, opts.runId].map(normalizeRunId).find(Boolean) || cellRunIds.join(', ') || null;
  return { runId, counts, path_tags, checkIds };
}

/**
 * Detect positive path observations in one bench-log cell's notes.
 * Negated comparisons describe the boundary between signals, not observations.
 * @param {string} notes
 */
export function notesPathAnomaly(notes) {
  const n = String(notes || '')
    .replace(/[*`]/g, '')
    .split(/[;；，,。\n]|\bbut\b|但是|但/iu)
    .map((clause) => clause.split(/≠|!=|非|无|未命中|\b(?:no|not)(?:\s+|-)/iu)[0])
    .join('\n');
  const agentMiss = /agent_miss/i.test(n);
  const dgr = /\bDGR\b|确定性绿路径拒升/i.test(n);
  const tipPath = /tip-path|不确定 tip 晋升/i.test(n);
  const postAmt = /post_amt|post_agent_miss_terminal/i.test(n);
  const progressFail = /actions\.progress\s*FAIL|SAFETY_LEASE_EXPIRED/i.test(n);
  // Keep mid-only cells in the observation scan after excluding their negated
  // DGR/tip-path labels. These notes do not assert an agent_miss firing.
  const midObservation = /\bmid\b[^\n]*\b(?:UNCERTAIN|AF|BR|RA|STALLED)\b|post_miss_\w*replan|mid harness replan/i.test(n);
  return {
    agentMiss,
    dgr,
    tipPath,
    postAmt,
    progressFail,
    any: agentMiss || dgr || tipPath || postAmt || progressFail || midObservation,
  };
}
