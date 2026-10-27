/**
 * Propose ≤3 hypotheses from ingest summary. Filter forbidden classes.
 * Harness² wire: EXPERIENCE retrieval → prior refs on hypotheses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPendingCandidate } from './candidate-archive.mjs';
import {
  retrieveExperience,
  dedupeExperience,
  buildExperienceQuery,
  listExperience,
  retrieveSoftPriors,
  isSoftRejectExperience,
  SOFT_REJECT_REASONS,
} from './experience.mjs';
import { matchesMergedDirection } from './merged-directions.mjs';
import { isStealShape } from './path-signals.mjs';

const PRODUCT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function configuredExperienceDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const fromEnv = process.env.OFFLOOP_EXPERIENCE_DIR;
  return typeof fromEnv === 'string' && fromEnv.trim()
    ? fromEnv
    : path.join(PRODUCT_ROOT, 'experience');
}

/**
 * Read the pending-freeze queue from explicit directories (non-recursive).
 * Only regular freeze-candidate-*.md files with current CANDIDATE metadata
 * qualify; archive status semantics belong to candidate-archive.mjs.
 * Results have unique absolute paths in sorted order; I/O errors propagate.
 * @param {string | string[]} roots
 * @returns {{ file: string, path: string, text: string }[]}
 */
export function listPendingCandidateDrafts(roots = []) {
  const files = new Set();
  for (const root of Array.isArray(roots) ? roots : [roots]) {
    const dir = path.resolve(root);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^freeze-candidate-.*\.md$/.test(entry.name)) {
        files.add(path.join(dir, entry.name));
      }
    }
  }
  return [...files].sort().flatMap((full) => {
    const text = fs.readFileSync(full, 'utf8');
    return isPendingCandidate(text) ? [{ file: path.basename(full), path: full, text }] : [];
  });
}

export const FORBIDDEN_CLASSES = Object.freeze({
  LEASE: 'lease',
  HARD_DECISION: 'hardDecision',
  DENYLIST: 'denylist',
  TIP_TOPOLOGY_DEFAULT: 'tip_topology_default',
  JEV_PROVIDER_MAIN: 'jev_provider_as_main_hypothesis',
  HOST_CODE_PATCH: 'host_code_patch_in_mvp_probe',
});

const FORBIDDEN_PATTERNS = [
  { cls: FORBIDDEN_CLASSES.LEASE, re: /\blease\b/i },
  { cls: FORBIDDEN_CLASSES.HARD_DECISION, re: /\bhardDecision\b|\bhard[_\s-]?decision\b/i },
  { cls: FORBIDDEN_CLASSES.DENYLIST, re: /\bdenylist\b/i },
  {
    cls: FORBIDDEN_CLASSES.TIP_TOPOLOGY_DEFAULT,
    re: /tip\s*(product\s*)?default.*topology|topology\s*=\s*on\s*(as\s*)?default|default\s+TOPOLOGY\s*=\s*on/i,
  },
  {
    cls: FORBIDDEN_CLASSES.JEV_PROVIDER_MAIN,
    re: /\b(only\s+)?(switch|change|swap)\s+(jev|provider|zen|openrouter)\b/i,
  },
  {
    cls: FORBIDDEN_CLASSES.HOST_CODE_PATCH,
    re: /\b(patch|edit|modify)\s+(the\s+)?(runtime|host)\s+(code|tree|worktree)\b|\bworktree\s+host\s+patch\b|\bhost\s+code\s+patch\b/i,
  },
];

/**
 * @param {object} hypothesis
 * @returns {{ ok: true } | { ok: false, class: string, reason: string }}
 */
export function rejectForbidden(hypothesis) {
  const blob = [
    hypothesis.id,
    hypothesis.slug,
    hypothesis.title,
    hypothesis.summary,
    hypothesis.probeKind,
    hypothesis.latchDraftMd,
    ...(hypothesis.tags || []),
  ]
    .filter(Boolean)
    .join('\n');

  for (const { cls, re } of FORBIDDEN_PATTERNS) {
    if (re.test(blob)) {
      return { ok: false, class: cls, reason: `matched forbidden pattern for ${cls}` };
    }
  }

  if (hypothesis.forbiddenClass) {
    return {
      ok: false,
      class: hypothesis.forbiddenClass,
      reason: 'explicit forbiddenClass on hypothesis',
    };
  }

  if (hypothesis.probeKind === 'host_code_patch') {
    return {
      ok: false,
      class: FORBIDDEN_CLASSES.HOST_CODE_PATCH,
      reason: 'MVP Probe forbids host code patches; latch draft md only',
    };
  }

  if (
    hypothesis.class === 'host_code_patch' ||
    hypothesis.class === 'host_latch_adopt' ||
    hypothesis.class === 'host_code_patch_adopt'
  ) {
    return {
      ok: false,
      class: FORBIDDEN_CLASSES.HOST_CODE_PATCH,
      reason: 'hard-gate / host EXPERIENCE must not promote to host_code_patch adopt hypothesis',
    };
  }

  // Soft reject reasons must not be used as a pretext to adopt a host patch
  const priorReasons = (hypothesis.prior || [])
    .map((p) => String(p.reason || p.rejectReason || '').toLowerCase())
    .filter(Boolean);
  const priorSaysHardGate = priorReasons.some((r) => r === 'hard_gate_path');
  const wantsHostAdopt =
    /host.?code.?patch|patch.?runtime|adopt.?host.?latch|host.?latch.?adopt/i.test(blob);
  if (priorSaysHardGate && wantsHostAdopt) {
    return {
      ok: false,
      class: FORBIDDEN_CLASSES.HOST_CODE_PATCH,
      reason: 'hard_gate_path EXPERIENCE prior must not promote host_code_patch / host latch adopt',
    };
  }

  return { ok: true };
}

/**
 * Soft-layer / latch / soft dayloop hypotheses that may carry soft-reject priors.
 * @param {object} h
 */
export function isSoftHypothesis(h) {
  if (!h) return false;
  if (h.class === 'soft_layer' || h.class === 'latch_draft_md') return true;
  const tags = (h.tags || []).map((t) => String(t).toLowerCase());
  if (tags.includes('soft') || tags.includes('host-note') || tags.includes('soft-dayloop')) {
    return true;
  }
  const blob = `${h.slug || ''} ${h.title || ''} ${h.probeKind || ''}`.toLowerCase();
  if (h.probeKind === 'soft_or_latch_md' && /soft|latch|dayloop|sticky|host-note/.test(blob)) {
    return true;
  }
  return false;
}

function isShippedExperience(entry) {
  return Boolean(entry.shippedDuplicate) || matchesMergedDirection(entry) ||
    String(entry.rejectReason || entry.reason || '').toLowerCase() === 'shipped_duplicate';
}

function foldPriors(entries) {
  return dedupeExperience(entries.map((entry) =>
    isShippedExperience(entry) ? { ...entry, shippedDuplicate: true } : entry,
  ));
}

/** Rank by retrieval score within each priority group; fold before applying caps. */
function rankPriors(entries, { soft = false } = {}) {
  return foldPriors(entries).sort((a, b) =>
    Number(isShippedExperience(a)) - Number(isShippedExperience(b)) ||
    (soft ? Number(isSoftRejectExperience(b)) - Number(isSoftRejectExperience(a)) : 0) ||
    (b.score ?? 0) - (a.score ?? 0),
  );
}

/**
 * Select EXPERIENCE hits for a hypothesis prior.
 * Non-shipped lessons first; soft hyps favor soft rejects within each group.
 * Non-soft: general hits; hard_gate soft-rejects are omitted so they are not
 * misread as host-adopt priors.
 * @param {object} h
 * @param {object[]} experienceContext
 * @param {object[]} [softPriors]
 */
export function selectPriorsForHypothesis(h, experienceContext, softPriors = []) {
  const ctx = experienceContext || [];
  if (isSoftHypothesis(h)) {
    return rankPriors([...(softPriors || []), ...ctx], { soft: true });
  }
  return rankPriors(ctx).filter((e) => {
    const reason = String(e.rejectReason || e.reason || '').toLowerCase();
    if (reason === 'hard_gate_path' && (e.softReject || isSoftRejectExperience(e))) {
      return false;
    }
    return true;
  });
}

/**
 * Attach prior EXPERIENCE refs to a hypothesis (≤3).
 * Soft reject lessons include `reason` (hard_gate_path / missing_soft_evidence / …).
 * Soft rejects never mark `adopted: true` — they are warn/prior lessons only.
 * @param {object} h
 * @param {object[]} hits from retrieveExperience / retrieveSoftPriors
 */
export function attachPrior(h, hits) {
  const seen = new Set();
  const prior = [];
  for (const e of selectPriorsForHypothesis(h, hits)) {
    const key = e.slug || e.file;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const reason = e.rejectReason || e.reason || null;
    const softReject = Boolean(e.softReject || isSoftRejectExperience(e));
    prior.push({
      slug: e.slug,
      file: e.file,
      adopted: softReject ? false : Boolean(e.adopted),
      lesson: (e.lesson || '').slice(0, 240),
      score: e.score,
      reason,
      softReject,
      tags: Array.isArray(e.tags) ? e.tags.slice(0, 12) : [],
    });
    if (prior.length >= 3) break;
  }
  return { ...h, prior };
}

/** Reuse a recorded non-sticky lesson as library evidence, never as host adoption. */
function lessonHypothesis(entry) {
  if (!entry?.lesson?.trim()) return null;
  // A shipped lesson stays a prior even when its tags also name a soft reject
  // or HOST note; those branches must not rename it into a new hypothesis.
  if (isShippedExperience(entry)) return null;
  const blob = `${entry.slug || ''} ${entry.title || ''} ${(entry.tags || []).join(' ')}`;
  let slug;
  let title;
  if (/agent[-_ ]miss|progress[-_ ]fail|not[-_]dgr/i.test(blob)) {
    slug = 'experience-agent-miss-progress-fail-not-dgr';
    title = 'EXPERIENCE: agent_miss when progress FAIL (not DGR)';
  } else if (isSoftRejectExperience(entry)) {
    slug = 'experience-soft-reject-lesson';
    title = 'EXPERIENCE: retain soft rejection evidence and constraints';
  } else if (/dgr[-_ ]promote|\bdgr\b/i.test(blob)) {
    slug = 'experience-dgr-promote-observed';
    title = 'EXPERIENCE: DGR promote path observed';
  } else if (/host[-_ ]note/i.test(blob)) {
    slug = 'experience-host-note-lesson';
    title = 'EXPERIENCE: observed HOST note guidance';
  } else if (/poison[-_ ]loop[-_ ]lesson/i.test(blob)) {
    slug = 'experience-poison-loop-lesson';
    title = 'EXPERIENCE: poison loop after dpr';
  } else {
    // A shipped sticky prior alone is not evidence of a new direction.
    if (/sticky/i.test(blob)) return null;
    // Source text remains evidence, not a proposed action or product title.
    slug = 'experience-recorded-residual-lesson';
    title = 'EXPERIENCE: recorded residual observation';
  }
  return {
    id: 'H-prior',
    slug,
    title,
    summary:
      'Retain the sourced lesson in the off-loop EXPERIENCE library. This is an observation only; it does not authorize a host latch or change hard gates.',
    class: 'experience',
    probeKind: 'soft_or_latch_md',
    tags: ['experience'],
    evidence: [{
      kind: 'experience',
      cellId: 'EXPERIENCE',
      experienceSlug: entry.slug,
      experienceTitle: entry.title || null,
      file: entry.file || entry.path || null,
      text: entry.lesson,
    }],
    latchDraftMd: null,
  };
}

/**
 * Build ≤3 hypotheses from ingest. Deterministic heuristics (no judge model).
 * @param {object} ingestResult from ingestMiss()
 * @param {{ experienceDir?: string, experienceEntries?: object[], skipExperience?: boolean }} [opts]
 * @returns {{ accepted: object[], rejected: object[], experienceContext: object[] }}
 */
export function proposeFromIngest(ingestResult, opts = {}) {
  const raw = [];
  const totals = ingestResult?.totals || {};
  const pathSignals = ingestResult?.pathSignals || ingestResult?.totals || {};
  const cells = ingestResult?.cells || [];
  const poisonCells = cells.filter((c) => c.poisonLoopCount > 0);
  const quotes = (sourceCells) => sourceCells.flatMap((c) =>
    (c.evidenceQuotes || []).map((q) => ({ cellId: c.cellId, ...q })),
  );
  // Keep non-poison cells available: their DPR/path evidence must not disappear
  // just because a different cell contains a poison-loop quote.
  const evidence = quotes(cells);
  const poisonEvidence = quotes(poisonCells);

  /** @type {object[]} */
  let experienceContext = [];
  /** @type {object[]} */
  let softPriors = [];
  /** Deduped, uncapped selection pool; experienceContext retains diagnostic hits. */
  let priorContext = [];
  let experienceEntries = [];
  if (!opts.skipExperience) {
    const query = buildExperienceQuery(ingestResult);
    const pathHints = { pathSignals: ingestResult?.pathSignals, runId: ingestResult?.runId };
    try {
      experienceEntries = opts.experienceEntries || listExperience(
        configuredExperienceDir(opts.experienceDir),
      );
    } catch (err) {
      if (opts.experienceDir) throw err;
    }
    experienceContext = retrieveExperience(null, {
      ...pathHints,
      query, entries: experienceEntries, limit: 5, dedupe: false,
    });
    const foldedEntries = foldPriors(experienceEntries);
    const retrieved = retrieveExperience(null, {
      ...pathHints,
      query, entries: foldedEntries, limit: Infinity, dedupe: false,
    });
    const retrievedKeys = new Set(retrieved.map((e) => e.slug || e.file));
    priorContext = rankPriors([
      ...retrieved,
      ...foldedEntries.filter((e) => !retrievedKeys.has(e.slug || e.file)),
    ]);
    // Rank before the public three-hit cap so repeated shipped soft rejects
    // cannot hide a distinct, unshipped lesson elsewhere in the library.
    softPriors = rankPriors(retrieveSoftPriors(null, {
      ...pathHints,
      entries: foldedEntries, query, limit: Infinity,
    }), { soft: true }).slice(0, 3);
  }

  const stickyAdopted = experienceContext.some(
    (e) => e.adopted && /sticky|post-dpr-sticky/.test(`${e.slug} ${e.tags?.join(' ')}`),
  );

  // Keep the productizable steal direction inside the cap even when poison,
  // DPR and observational paths all coexist. Counter-only ingest is evidence,
  // but retain its source instead of inventing a runtime event or sequence.
  const stealSources = [
    { cellId: 'ingest', source: ingestResult },
    { cellId: 'ingest.totals', source: totals },
    { cellId: 'ingest.pathSignals', source: ingestResult?.pathSignals },
    ...cells.flatMap((c) => [
      { cellId: c.cellId, source: c },
      { cellId: c.cellId, source: c.pathSignals },
    ]),
  ];
  const stealEvidence = stealSources.flatMap(({ cellId, source }) => {
    const quoted = [...(source?.evidenceQuotes || []), ...(source?.evidence || [])]
      .filter((quote) => isStealShape(quote))
      .map((quote) => ({ cellId, ...quote }));
    const count = Number(source?.postAmtCount);
    if (quoted.length === 0 && Number.isFinite(count) && count > 0) {
      quoted.push({ cellId, kind: 'post_amt', source: 'postAmtCount', count, text: `post_amt count=${count}` });
    }
    return quoted;
  });
  if (stealEvidence.length > 0) {
    raw.push({
      id: 'H-steal',
      slug: 'steal-post-amt-terminal-replan',
      title: 'Soft guidance after post_amt terminal replan',
      summary:
        'After post_agent_miss_terminal_replan, soft-layer HOST / skill guidance should carry terminal-miss evidence into the next plan and prefer a concrete write/execute/verify step over repeating the same recovery probes.',
      class: 'soft_layer',
      probeKind: 'soft_or_latch_md',
      tags: ['steal', 'soft', 'post-amt'],
      evidence: stealEvidence.slice(0, 4),
      latchDraftMd: null,
    });
  }

  if (poisonCells.length > 0 || totals.poisonLoopCount > 0) {
    raw.push({
      id: 'H1',
      slug: 'post-dpr-sticky-execute',
      title: 'Sticky PTE after diagnose_probe_exhausted_recover',
      summary:
        'After #82 demote, suppress topology.upgraded PTE→DIAGNOSE when failure is probe-budget-only (TOPOLOGY_BUDGET_PROBES / ACTION_FAILED with that in progress message). Aligns with PR #83 sticky execute.' +
        (stickyAdopted ? ' Prior EXPERIENCE already adopted sticky — reinforce if poison loop recurs.' : ''),
      class: 'latch_draft_md',
      probeKind: 'soft_or_latch_md',
      tags: ['poison-loop', 'sticky', '#83'],
      evidence: (poisonEvidence.length ? poisonEvidence : evidence).slice(0, 4),
      latchDraftMd: [
        '## Latch draft (markdown only — MVP Probe does not patch host)',
        '',
        'When recover≥1 and topology is PLAN_THEN_EXECUTE:',
        '- Do NOT upgrade to DIAGNOSE_PROBE_RECOVER for probe-budget-only failureCodes.',
        '- Emit harness.post_dpr_sticky_execute when suppressing.',
        '- Keep #82 recover ≤2×/run; do not raise maxProbes.',
      ].join('\n'),
    });
  }

  if (totals.dprCount > 0 || cells.some((c) => c.dprCount > 0)) {
    raw.push({
      id: 'H2',
      slug: 'host-note-post-dpr-execute-bias',
      title: 'HOST note: prefer write/execute/verify after demote',
      summary:
        'Soft-layer HOST / skill guidance: after diagnose_probe_exhausted_recover, next actions should prefer file.write/file.patch/shell.execute/test.execute/verify over further read/list/focus probes.',
      class: 'soft_layer',
      probeKind: 'soft_or_latch_md',
      tags: ['soft', 'host-note'],
      evidence: evidence.filter((e) => e.kind === 'dpr' || e.kind === 'budget_blocked').slice(0, 3),
      latchDraftMd: null,
    });
  }

  // Path-anomaly: AF+BR + actions.progress FAIL (lease) → agent_miss, not DGR
  const progressFailCells = cells.filter(
    (c) =>
      (c.pathSignals?.progressFailLeaseCount || 0) > 0 &&
      (c.pathSignals?.agentMissCount || 0) > 0,
  );
  if (progressFailCells.length > 0 || (pathSignals.progressFailLeaseCount > 0 && pathSignals.agentMissCount > 0)) {
    const pe = [];
    for (const c of progressFailCells.length ? progressFailCells : cells) {
      for (const q of c.evidenceQuotes || []) {
        if (q.kind === 'progress_fail_lease' || q.kind === 'agent_miss') {
          pe.push({ cellId: c.cellId, ...q });
        }
      }
    }
    raw.push({
      id: 'H-pa1',
      slug: 'experience-agent-miss-progress-fail-not-dgr',
      title: 'EXPERIENCE: agent_miss when progress FAIL (not DGR)',
      summary:
        'Path-anomaly (BOT2 calibrate): agent_miss_replan fired first on mid FAIL(AF+BR) while actions.progress was FAIL (e.g. SAFETY_*_EXPIRED). Record as EXPERIENCE only — do not rewrite as 「非 DGR」product claim, do not promote to host latch, hard gates untouched.',
      class: 'experience',
      probeKind: 'soft_or_latch_md',
      tags: ['experience', 'path-anomaly', 'agent-miss', 'not-dgr'],
      evidence: (pe.length ? pe : evidence).slice(0, 4),
      latchDraftMd: null,
    });
  }

  // Path-anomaly: DGR promote observed (monitoring lesson)
  if ((pathSignals.dgrPromoteCount || 0) > 0) {
    const de = [];
    for (const c of cells) {
      for (const q of c.evidenceQuotes || []) {
        if (q.kind === 'dgr_promote' || q.kind === 'agent_miss') de.push({ cellId: c.cellId, ...q });
      }
    }
    raw.push({
      id: 'H-pa2',
      slug: 'experience-dgr-promote-observed',
      title: 'EXPERIENCE: DGR promote path observed',
      summary:
        'CLOSED cell showed deterministic-green-jev-behavior-reject promote after mid FAIL(AF+BR)+tests绿. Record for Harness² library; no new latch unless steal/post_amt appears.',
      class: 'experience',
      probeKind: 'soft_or_latch_md',
      tags: ['experience', 'path-anomaly', 'dgr'],
      evidence: (de.length ? de : evidence).slice(0, 4),
      latchDraftMd: null,
    });
  }

  // Use the full folded library so a retrieval cap cannot hide a distinct lesson.
  for (const entry of rankPriors([...softPriors, ...priorContext], { soft: true })) {
    const lesson = lessonHypothesis(entry);
    if (!lesson || !rejectForbidden(lesson).ok) continue;
    const existing = raw.find((h) => h.slug === lesson.slug);
    if (existing) existing.evidence.push(...lesson.evidence);
    else raw.push(lesson);
    break;
  }

  // Always offer an observational EXPERIENCE capture for residual cell evidence.
  if (cells.length > 0 && raw.filter((h) => h.class === 'experience').length === 0) {
    const hasPoison = poisonCells.length > 0 || totals.poisonLoopCount > 0;
    raw.push({
      id: 'H3',
      slug: hasPoison ? 'experience-poison-loop-lesson' : 'experience-residual-cell-lesson',
      title: hasPoison ? 'EXPERIENCE: poison loop after dpr' : 'EXPERIENCE: residual cell observations',
      summary:
        hasPoison
          ? 'Record the observed probe-only loop: a green cell with a remaining poison loop is a false win. Keep the evidence for future comparisons; this library lesson proposes no new latch.'
          : 'Record residual cell evidence for the off-loop library without proposing a host latch or changing hard gates.',
      class: 'experience',
      probeKind: 'soft_or_latch_md',
      tags: ['experience'],
      evidence: evidence.slice(0, 2),
      latchDraftMd: null,
    });
  }

  // Never invent host_code_patch / host latch adopt from hard-gate EXPERIENCE
  for (const e of softPriors) {
    if ((e.rejectReason || e.reason) === 'hard_gate_path') {
      // soft prior only — do not push a host_code_patch hyp
      break;
    }
  }

  const accepted = [];
  const rejected = [];
  for (const h0 of raw) {
    // Soft hyps get soft-reject lessons in prior; never promote hard_gate → host patch
    if (h0.probeKind === 'host_code_patch' || h0.class === 'host_code_patch') {
      rejected.push({
        ...h0,
        prior: [],
        rejectReason: 'hard-gate EXPERIENCE must not become host_code_patch adopt hypothesis',
        forbiddenClass: FORBIDDEN_CLASSES.HOST_CODE_PATCH,
      });
      continue;
    }
    const hits = selectPriorsForHypothesis(h0, priorContext, softPriors);
    const h = attachPrior(h0, hits);
    if (!h.evidence || h.evidence.length < 1) {
      rejected.push({ ...h, rejectReason: 'no_evidence' });
      continue;
    }
    const gate = rejectForbidden(h);
    if (!gate.ok) {
      rejected.push({ ...h, rejectReason: gate.reason, forbiddenClass: gate.class });
      continue;
    }
    accepted.push(h);
  }

  const selected = accepted.slice(0, 3);
  // Preserve diversity if more shipped-direction aliases are added later.
  const nonMerged = accepted.find((h) => !matchesMergedDirection(h));
  if (nonMerged && selected.every(matchesMergedDirection)) {
    selected[selected.length - 1] = nonMerged;
  }

  return {
    accepted: selected,
    rejected,
    truncated: accepted.length > 3,
    experienceContext,
    softPriors,
  };
}

/**
 * Test helper: attempt to accept a custom hypothesis through the same gate + cap.
 */
export function filterHypotheses(hypotheses, { max = 3 } = {}) {
  const accepted = [];
  const rejected = [];
  for (const h of hypotheses) {
    if (!h.evidence || h.evidence.length < 1) {
      rejected.push({ ...h, rejectReason: 'no_evidence' });
      continue;
    }
    const gate = rejectForbidden(h);
    if (!gate.ok) {
      rejected.push({ ...h, rejectReason: gate.reason, forbiddenClass: gate.class });
      continue;
    }
    if (accepted.length >= max) {
      rejected.push({ ...h, rejectReason: 'over_cap_gt_3' });
      continue;
    }
    accepted.push(h);
  }
  return { accepted, rejected };
}

export { listExperience, retrieveSoftPriors, isSoftRejectExperience, SOFT_REJECT_REASONS };
