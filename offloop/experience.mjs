/**
 * EXPERIENCE (教训库) list + retrieve for off-loop Propose.
 * Runtime must 0× read this directory as unchecked Memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { summarizePathAnomalyFields } from './path-signals.mjs';

/** Soft-layer reject reasons recorded in EXPERIENCE (Compose / dayloop / soft-worktree). */
export const SOFT_REJECT_REASONS = Object.freeze([
  'hard_gate_path',
  'missing_soft_evidence',
  'false_win',
  'fixture-fallback',
  'baseline_fixture_fallback',
]);

/**
 * @param {string} experienceDir
 * @param {{ tags?: string[], slug?: string, reason?: string, query?: string, limit?: number, entries?: object[], dedupe?: boolean }} [filter]
 * @returns {object[]}
 */
export function listExperience(experienceDir, filter = {}) {
  let entries = filter.entries;
  if (!entries) {
    if (!experienceDir || !fs.existsSync(experienceDir)) return [];
    const files = fs.readdirSync(experienceDir).filter((f) => f.endsWith('.md')).sort();
    entries = files.map((file) => {
      const full = path.join(experienceDir, file);
      return parseExperienceBody(fs.readFileSync(full, 'utf8'), { file, full });
    });
  }
  const matches = filterExperience(entries, filter);
  const out = filter.dedupe ? dedupeExperience(matches) : matches;
  return filter.limit == null ? out : out.slice(0, Math.max(0, filter.limit));
}

const normalize = (value) => String(value ?? '').normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const entryReason = (entry) => normalize(entry.rejectReason || entry.reason);
const lessonTokens = (entry) => new Set(normalize(entry.lesson).match(/[\p{L}\p{N}]+/gu) || []);

function nearLesson(a, b) {
  const first = normalize(a.lesson);
  const second = normalize(b.lesson);
  if (!first || !second) return false;
  if (first === second) return true;
  const negations = (text) => [...new Set(text.match(/\b(?:no|not|never|without|cannot|[a-z]+n't)\b/g) || [])].sort().join(' ');
  if (negations(first) !== negations(second)) return false;
  const left = lessonTokens(a);
  const right = lessonTokens(b);
  // A reason is a broad category: only fold substantial, nearly identical text.
  if (Math.min(left.size, right.size) < 6) return false;
  const shared = [...left].filter((token) => right.has(token)).length;
  return shared / (left.size + right.size - shared) >= 0.85;
}

function experienceDate(entry) {
  const value = entry.date || String(entry.file || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sourceIdentity(entry) {
  return String(entry.path || entry.file || JSON.stringify([
    normalize(entry.slug), entryReason(entry), normalize(entry.lesson),
    normalize(entry.title), entry.date || '', entry.adopted === true,
  ]));
}

function compareSurvivors(a, b) {
  return Number(b.adopted === true) - Number(a.adopted === true) ||
    experienceDate(b) - experienceDate(a) ||
    String(b.file || '').localeCompare(String(a.file || '')) ||
    String(b.lesson || '').length - String(a.lesson || '').length ||
    sourceIdentity(a).localeCompare(sourceIdentity(b)) ||
    JSON.stringify(a).localeCompare(JSON.stringify(b));
}

/**
 * Fold repeated slugs, or slugless entries with the same reason and nearly
 * identical lesson text. Different slugs must never share a survivor.
 * This is a pure, scriptable fold: no files are changed. Connected duplicates
 * share one survivor (adopted, then newest date/file, then longest lesson).
 * duplicateCount includes the survivor; foldedFrom lists its source records.
 */
export function dedupeExperience(entries = []) {
  const ordered = [...entries].sort(compareSurvivors);
  const roots = ordered.map((_, index) => index);
  const root = (index) => {
    while (roots[index] !== index) index = roots[index];
    return index;
  };
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const leftSlug = normalize(ordered[i].slug);
      const rightSlug = normalize(ordered[j].slug);
      const sameSlug = leftSlug && leftSlug === rightSlug;
      const sameReason = entryReason(ordered[i]) && entryReason(ordered[i]) === entryReason(ordered[j]);
      if (sameSlug || (!leftSlug && !rightSlug && sameReason && nearLesson(ordered[i], ordered[j]))) {
        roots[root(j)] = root(i);
      }
    }
  }
  const groups = new Map();
  for (const [index, entry] of ordered.entries()) {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].map((group) => {
    const survivor = { ...group[0] };
    // Propose marks shipped sources before folding. A renamed survivor must
    // retain that status so an old direction cannot masquerade as a new prior.
    if (group.some((entry) => entry.shippedDuplicate)) survivor.shippedDuplicate = true;
    const sources = [...new Set(group.flatMap((entry) => [
      sourceIdentity(entry), ...(entry.foldedFrom || []),
    ]))].sort();
    // Scored and raw copies can coexist in a prior pool. Count their shared
    // provenance once, including when already-folded pools overlap.
    const duplicateCount = Math.max(sources.length, ...group.map((entry) => entry.duplicateCount || 1));
    if (group.length > 1 || duplicateCount > 1) {
      survivor.duplicateCount = duplicateCount;
      survivor.foldedFrom = sources;
    }
    return survivor;
  }).sort(compareSurvivors);
}

function queryTokens(query) {
  return normalize(query).split(/[^a-z0-9\u4e00-\u9fff#+.-]+/i).filter((token) => token.length >= 2);
}

function experienceHaystack(entry) {
  return normalize(`${entry.slug || ''}\n${entry.title || ''}\n${entry.lesson || ''}\n${entry.rejectReason || ''}\n${entry.reason || ''}\n${(entry.tags || []).join(' ')}`);
}

function filterExperience(entries, filter, structuredMatch = () => false) {
  const tags = (filter.tags || []).map(normalize);
  const slug = normalize(filter.slug);
  const reason = normalize(filter.reason);
  const tokens = queryTokens(filter.query);
  return entries.filter((entry) => {
    const entryTags = (entry.tags || []).map(normalize);
    return tags.every((tag) => entryTags.includes(tag)) &&
      (!slug || normalize(entry.slug) === slug) &&
      (!reason || [entry.rejectReason, entry.reason].some((value) => normalize(value) === reason)) &&
      (!tokens.length || tokens.some((token) => experienceHaystack(entry).includes(token)) || structuredMatch(entry));
  });
}

const PATH_COUNTERS = [
  ['dgr', 'dgrPromoteCount', 'DGR'],
  ['tipPath', 'tipPathCount', 'tip-path'],
  ['postAmt', 'postAmtCount', 'post_amt'],
  ['agentMiss', 'agentMissCount', 'agent_miss'],
];

/** Complete write-side counts are authoritative, including explicit zeros. */
function parsePathCountsFromBody(body) {
  const match = String(body || '').match(
    /^- \*\*path_counts\*\*: DGR=(\d+) tip-path=(\d+) post_amt=(\d+) agent_miss=(\d+)[ \t]*$/m,
  );
  return match ? Object.fromEntries(PATH_COUNTERS.map(([key], i) => [key, Number(match[i + 1])])) : null;
}

function csvValues(value) {
  if (value == null) return null;
  return [...new Set((Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item).trim())
    .filter((item) => item && !/^(?:\(none\)|none|n\/a)$/i.test(item)))];
}

// Missing counters are unknown, never inferred as zero for an exact match.
function suppliedPathCounts(counts, signals) {
  const result = {};
  for (const [key, signal] of PATH_COUNTERS) {
    const value = counts?.[key] ?? signals?.[signal];
    if (value !== '' && value != null && Number.isSafeInteger(Number(value)) && Number(value) >= 0) {
      result[key] = Number(value);
    }
  }
  return result;
}

/**
 * Format first-hand EXPERIENCE fields using the existing path-anomaly summary.
 * Counts, including explicit zeros, govern tags and supplied typed check IDs;
 * mid rejection prose and requested tags never manufacture promote evidence.
 * Missing IDs stay empty, even when a positive count is known.
 */
export function formatPathStructuredFields(input = {}) {
  const pathSignals = { ...input.pathSignals };
  const supplied = suppliedPathCounts(input.pathCounts, input.pathSignals);
  for (const [key, signal] of PATH_COUNTERS) {
    if (supplied[key] != null) pathSignals[signal] = supplied[key];
  }
  const summary = summarizePathAnomalyFields({ ...input, pathSignals });
  const checkIds = (csvValues(input.checkIds ?? pathSignals.checkIds ?? pathSignals.check_ids ?? summary.checkIds) || [])
    .filter((id) =>
      (summary.counts.dgr > 0 && /^(?:execute\.)?deterministic-green-jev-behavior-reject-promote$/.test(id)) ||
      (summary.counts.tipPath > 0 && /^(?:execute\.)?deterministic-green-jev-uncertain-tip-path$/.test(id)));
  return [
    `- **runId**: ${summary.runId || 'n/a'}`,
    `- **path_counts**: ${PATH_COUNTERS.map(([key, , label]) => `${label}=${summary.counts[key]}`).join(' ')}`,
    `- **path_tags**: ${summary.path_tags.join(', ') || '(none)'}`,
    `- **check_ids**: ${checkIds.join(', ') || '(none)'}`,
  ].join('\n');
}

function pathQueryHints(opts) {
  let query = String(opts.query || '');
  const queryCounts = {};
  for (const [key, , label] of PATH_COUNTERS) {
    query = query.replace(new RegExp(`\\b${label}=(\\d+)\\b`, 'gi'), (_, count) => {
      queryCounts[key] = Number(count);
      return '';
    });
  }
  const counts = { ...queryCounts, ...suppliedPathCounts(opts.pathCounts, opts.pathSignals) };
  const tokens = queryTokens(query);
  const pathTags = new Set([
    ...(csvValues(opts.pathTags ?? opts.pathSignals?.pathTags ?? opts.pathSignals?.path_tags) || []).map(normalize),
    ...tokens.filter((token) => token === 'dgr' || token === 'tip-path'),
  ]);
  for (const [key, tag] of [['dgr', 'dgr'], ['tipPath', 'tip-path']]) {
    if (counts[key] > 0) pathTags.add(tag);
    if (counts[key] === 0) pathTags.delete(tag);
  }
  const queryRuns = [...query.matchAll(/\brunId\s*[:=]\s*([\w.-]+)|\b(run\d+[a-z]?)\b/gi)]
    .map((match) => match[1] || match[2]);
  const runIds = (csvValues(opts.runId ?? queryRuns) || []).map(normalizeRunId);
  const checkIds = new Set([
    ...(csvValues(opts.checkIds ?? opts.pathSignals?.checkIds ?? opts.pathSignals?.check_ids) || []).map(normalize),
    ...tokens,
  ]);
  // Count labels describe observations; DGR=0 must not earn a prose DGR hit.
  const keywordQuery = query.replace(/\bpath_counts\s*:/gi, '')
    .replace(/\bpath_tags\s*:\s*(?:\(none\)|[\w-]+(?:\s*,\s*[\w-]+)*)/gi, '');
  return { counts, pathTags, runIds, checkIds, keywordQuery };
}

const normalizeRunId = (value) => normalize(value).replace(/^run(?=\d)/, '');

function scorePathAnomalyAlignment(entry, hints) {
  let score = 0;
  const keys = Object.keys(hints.counts);
  if (entry.pathCounts && keys.length && keys.every((key) => Number.isSafeInteger(entry.pathCounts[key]))) {
    const distance = keys.reduce((sum, key) => sum + Math.abs(entry.pathCounts[key] - hints.counts[key]), 0);
    const samePresence = keys.every((key) => (entry.pathCounts[key] > 0) === (hints.counts[key] > 0));
    if (keys.length === 4 && distance === 0) score += 12;
    else if (samePresence) score += distance <= 1 ? (keys.length === 4 ? 10 : 8) : 6;
  }
  if ((csvValues(entry.runId) || []).some((id) => hints.runIds.includes(normalizeRunId(id)))) score += 8;
  for (const tag of new Set((entry.pathTags || []).map(normalize))) {
    if (hints.pathTags.has(tag)) score += 4;
  }
  for (const id of new Set((entry.checkIds || []).map(normalize))) {
    if (hints.checkIds.has(id)) score += 2;
  }
  return score;
}

/**
 * @param {string} body
 * @param {{ file?: string, full?: string }} meta
 */
export function parseExperienceBody(body, meta = {}) {
  const title = (body.match(/^#\s*EXPERIENCE\s*—\s*(.+)$/m) || [])[1]?.trim() || '';
  const field = (key) => {
    const re = new RegExp(`^-\\s*\\*\\*${key}\\*\\*:\\s*(.+)$`, 'mi');
    const m = body.match(re);
    return m ? m[1].trim() : null;
  };
  const slug = field('slug') || (meta.file || '').replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const adoptedRaw = field('adopted_candidate') || '';
  const adopted = /^yes\b/i.test(adoptedRaw);
  const rejectReason = parseRejectReason(adoptedRaw, body);
  const lesson = field('lesson') || '';
  const sourceRuns = field('source runs') || field('source_runs') || '';
  const poison = field('poison loop') || '';
  const promoted = field('promoted knife') || field('promoted_knife') || '';
  const date = field('date') || '';
  const softEvidence = field('soft_evidence') || field('missing_soft_evidence') || '';
  const runId = field('runId');
  const pathCounts = parsePathCountsFromBody(body);
  const pathTags = csvValues(field('path_tags'));
  const checkIds = csvValues(field('check_ids'));
  const tags = deriveTags({
    slug,
    lesson,
    title,
    adopted,
    promoted,
    rejectReason,
    body,
    softEvidence,
  });
  return {
    file: meta.file || null,
    path: meta.full || null,
    title,
    slug,
    adopted,
    adoptedRaw,
    rejectReason,
    reason: rejectReason,
    lesson,
    sourceRuns,
    poison,
    promoted,
    date,
    softEvidence,
    runId,
    pathCounts,
    pathTags,
    checkIds,
    body,
    tags,
    softReject: tags.some((t) => SOFT_REJECT_REASONS.includes(t) || t === 'soft-reject'),
  };
}

/** Extract parenthetical reason from `no (hard_gate_path)` / body markers. */
export function parseRejectReason(adoptedRaw, body = '') {
  const m = String(adoptedRaw || '').match(/\(\s*([a-z0-9_\-]+)\s*\)/i);
  if (m) return m[1].toLowerCase();
  const blob = `${adoptedRaw}\n${body}`;
  for (const r of SOFT_REJECT_REASONS) {
    if (new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(blob)) return r;
  }
  if (/false\s*win/i.test(blob)) return 'false_win';
  if (/hard.?gate/i.test(blob)) return 'hard_gate_path';
  if (/missing.?soft.?evidence/i.test(blob)) return 'missing_soft_evidence';
  if (/fixture.?fallback|baseline_fixture_fallback/i.test(blob)) return 'fixture-fallback';
  return null;
}

/** Legacy observations only: references to prior lessons are not path evidence. */
function legacyPathTags({ slug, title, lesson, body }) {
  const prose = `${slug}\n${title}\n${lesson}\n${String(body || '')
    .replace(/^-\s*\*\*(?!lesson\*\*:)[^\n]*$/gmi, '')}`;
  const clauses = prose.replace(/[*`]/g, '')
    .split(/[;；，,。\n?！？]|!(?!=)|\.(?=\s|$)|\b(?:but|however)\b|但是|但/iu);
  let dgr = false;
  let tipPath = false;
  for (const clause of clauses) {
    if (/\b(?:not|never)[- ]+(?:observed|seen|present|promoted)\b|未(?:观察到|出现|命中)/iu.test(clause)) continue;
    // A negated comparison (including not-dgr slugs) cannot assert its RHS.
    const positive = clause.split(/≠|!=|非|无|未命中|\b(?:no|not|never|without|cannot)(?:\s+|-)/iu)[0];
    const preludeOnly = /\bmid(?:\b|_)|\bprelude\b|前奏/iu.test(positive);
    const promote = /behavior[- ]reject[- ]promote\b|\bdgr[- ]promote\b/iu.test(positive) ||
      (/deterministic-green-jev-behavior-reject\b/iu.test(positive) && /\b(?:observed|promote)\b/iu.test(positive));
    if (promote || (!preludeOnly && /\bdgr\b|确定性绿路径拒升/iu.test(positive))) dgr = true;
    if ((!preludeOnly || /(?:uncertain-tip-path|tip-path)[- ](?:promote|observed)\b/iu.test(positive)) && /tip-path|uncertain-tip/iu.test(positive)) tipPath = true;
  }
  return { dgr, tipPath };
}

function deriveTags({ slug, lesson, title, adopted, promoted, rejectReason, body, softEvidence }) {
  const blob = `${slug}\n${lesson}\n${title}\n${promoted}\n${rejectReason || ''}\n${softEvidence || ''}\n${body || ''}`.toLowerCase();
  const tags = new Set();
  if (adopted) tags.add('adopted');
  else tags.add('rejected');
  if (/sticky|post-dpr|poison/.test(blob)) tags.add('sticky');
  if (/poison/.test(blob)) tags.add('poison-loop');
  // New structured counts are authoritative, including zero. Otherwise their
  // field labels and negated lesson prose would create false retrieval tags.
  // Legacy observations exclude negations and mid-only preludes.
  const pathCounts = parsePathCountsFromBody(body);
  const legacy = pathCounts ? null : legacyPathTags({ slug, lesson, title, body });
  if (pathCounts ? pathCounts.dgr > 0 : legacy.dgr) tags.add('dgr');
  if (pathCounts ? pathCounts.tipPath > 0 : legacy.tipPath) tags.add('tip-path');
  if (pathCounts ? pathCounts.agentMiss > 0 : /agent_miss|agent-miss/.test(blob)) tags.add('agent-miss');
  if (pathCounts ? pathCounts.postAmt > 0 : /post_amt|post_agent_miss/.test(blob)) tags.add('post-amt');
  if (/lease|progress fail/.test(blob)) tags.add('progress-fail');
  // Soft-layer reject / dayloop lessons
  if (/soft|latch|dayloop|host-note|filelisthash|tipshabaseline/.test(blob)) tags.add('soft');
  for (const r of SOFT_REJECT_REASONS) {
    const needle = r.toLowerCase();
    if (rejectReason === r || blob.includes(needle) || blob.includes(needle.replace(/-/g, '_'))) {
      tags.add(r);
      tags.add('soft-reject');
    }
  }
  // Normalize fixture-fallback alias
  if (tags.has('baseline_fixture_fallback')) {
    tags.add('fixture-fallback');
    tags.add('soft-reject');
  }
  if (slug) tags.add(slug);
  return [...tags];
}

/**
 * Keyword / tag retrieve with structured path alignment (no embedding).
 * @param {string} experienceDir
 * @param {{ query?: string, tags?: string[], slug?: string, reason?: string, limit?: number, entries?: object[], dedupe?: boolean, pathSignals?: object, pathCounts?: object, runId?: string|number, pathTags?: string[], checkIds?: string[] }} opts
 */
export function retrieveExperience(experienceDir, opts = {}) {
  const limit = opts.limit ?? 5;
  const hints = pathQueryHints(opts);
  const matches = filterExperience(opts.entries || listExperience(experienceDir), opts,
    (entry) => scorePathAnomalyAlignment(entry, hints) > 0);
  const entries = opts.dedupe === false ? matches : dedupeExperience(matches);
  const query = normalize(opts.query);
  const wantTags = (opts.tags || []).map(normalize);
  const tokens = queryTokens(hints.keywordQuery);

  const scored = entries.map((e) => {
    let score = scorePathAnomalyAlignment(e, hints);
    const hay = experienceHaystack(e);
    for (const t of tokens) {
      if (hay.includes(t)) score += t.length >= 4 ? 3 : 1;
    }
    for (const tag of wantTags) {
      if ((e.tags || []).map(normalize).includes(tag)) score += 5;
    }
    if (e.adopted) score += 1; // prefer reusable adopted lessons slightly
    // Soft-reject lessons: boost when query/tags ask for soft
    if (e.softReject || e.tags?.includes('soft-reject')) {
      if (wantTags.some((t) => SOFT_REJECT_REASONS.includes(t) || t === 'soft' || t === 'soft-reject')) {
        score += 4;
      }
      if (/soft|latch|dayloop|hard_gate|missing_soft|false_win|fixture/.test(query)) {
        score += 3;
      }
    }
    return { ...e, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || String(a.slug).localeCompare(String(b.slug)))
    .slice(0, Math.max(0, limit));
}

/**
 * Build a retrieval query from ingest / path-signal totals.
 */
export function buildExperienceQuery(ingest) {
  const parts = [];
  const totals = ingest?.totals || {};
  const path = ingest?.pathSignals || {};
  if (totals.poisonLoopCount > 0) parts.push('poison-loop sticky post-dpr');
  if (path.dgrPromoteCount > 0) parts.push('dgr promote behavior-reject');
  if (path.tipPathCount > 0) parts.push('tip-path uncertain');
  if (path.agentMissCount > 0) parts.push('agent-miss replan');
  if (path.postAmtCount > 0) parts.push('post-amt post_agent_miss');
  if (path.progressFailLeaseCount > 0) parts.push('progress-fail lease SAFETY_LEASE_EXPIRED not-dgr');
  if (parts.length === 0) parts.push('experience lesson harness');
  if (ingest?.runId != null && String(ingest.runId).trim()) parts.push(`runId:${String(ingest.runId).trim()}`);
  const counts = suppliedPathCounts(ingest?.pathCounts, ingest?.pathSignals);
  const countTerms = PATH_COUNTERS.filter(([key]) => counts[key] != null)
    .map(([key, , label]) => `${label}=${counts[key]}`);
  if (countTerms.length) parts.push(`path_counts:${countTerms.join(' ')}`);
  const pathTags = [counts.dgr > 0 ? 'DGR' : null, counts.tipPath > 0 ? 'tip-path' : null].filter(Boolean);
  if (countTerms.length) parts.push(`path_tags:${pathTags.join(',') || '(none)'}`);
  // Soft-layer dayloop priors — light hint so soft rejects can surface alongside sticky
  parts.push('soft latch dayloop soft-reject');
  return parts.join(' ');
}

/**
 * @param {object} e parsed EXPERIENCE
 */
export function isSoftRejectExperience(e) {
  if (!e) return false;
  if (e.softReject) return true;
  const reason = (e.rejectReason || e.reason || '').toLowerCase();
  if (SOFT_REJECT_REASONS.includes(reason)) return true;
  const tags = (e.tags || []).map((t) => String(t).toLowerCase());
  return tags.some((t) => SOFT_REJECT_REASONS.includes(t) || t === 'soft-reject');
}

/**
 * Retrieve soft-layer reject lessons for Propose prior (≤3).
 * Keyword/tag only — no embeddings.
 * @param {string|null} experienceDir
 * @param {{ entries?: object[], query?: string, tags?: string[], slug?: string, reason?: string, limit?: number, dedupe?: boolean }} [opts]
 */
export function retrieveSoftPriors(experienceDir, opts = {}) {
  const limit = opts.limit ?? 3;
  const entries = opts.entries || listExperience(experienceDir);
  const softEntries = entries.filter(isSoftRejectExperience);
  const query =
    opts.query ||
    'soft latch dayloop hard_gate_path missing_soft_evidence false_win fixture-fallback';
  const hits = retrieveExperience(null, {
    ...opts,
    entries: softEntries,
    query,
    limit: Math.max(limit, 5),
  });
  return hits.slice(0, Math.max(0, limit));
}
