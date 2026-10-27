/** Shipped directions are library evidence, never new promotable candidates. */
export const MERGED_REJECT_REASON = 'shipped_duplicate';

export const MERGED_DIRECTIONS = Object.freeze([
  Object.freeze({
    id: 'host-note-post-dpr-execute-bias',
    slugs: Object.freeze(['host-note-post-dpr-execute-bias', 'host_note_post_dpr_execute_bias']),
    pullRequests: Object.freeze([82]),
    // All three phrases must identify the same direction on one line.
    directionPattern: /^(?=[^\n]*\bhost[ \t_-]+note\b)(?=[^\n]*\bpost[ \t_-]+dpr\b)(?=[^\n]*\bexecute[ \t_-]+bias\b)[^\n]+$/im,
    tagSets: Object.freeze([
      Object.freeze(['host-note', 'post-dpr', 'execute-bias']),
      Object.freeze(['host-note', 'post-dpr-execute-bias']),
    ]),
  }),
  Object.freeze({
    id: 'sticky-execute',
    slugs: Object.freeze(['sticky-execute', 'post-dpr-sticky-execute']),
    pullRequests: Object.freeze([83, 84]),
    directionPattern: /\bsticky[\s_-]+(?:execute|pte|latch)\b|\bsticky\b[^\n]*\b(?:execute|pte|latch)\b/i,
    tagSets: Object.freeze([
      Object.freeze(['sticky', '#83']),
      Object.freeze(['sticky', '#84']),
    ]),
  }),
  Object.freeze({
    id: 'steal-post-amt-terminal-replan',
    slugs: Object.freeze(['steal-post-amt-terminal-replan', 'steal_post_amt_terminal_replan']),
    pullRequests: Object.freeze([90]),
    // Same-line steal + terminal-miss wording, or the post_amt terminal-replan proposal title.
    directionPattern: /^(?:(?=[^\n]*\bsteal\b)(?=[^\n]*\b(?:post[ \t_-]+amt|terminal[ \t_-]+replan)\b)|(?=[^\n]*\bpost[ \t_-]+amt\b)(?=[^\n]*\bterminal[ \t_-]+replan\b))[^\n]+$/im,
    tagSets: Object.freeze([
      Object.freeze(['steal', 'post-amt']),
      Object.freeze(['steal', 'post_amt']),
      Object.freeze(['post-amt', 'terminal-replan']),
      Object.freeze(['post_amt', 'terminal-replan']),
    ]),
  }),
]);

/**
 * Match a hypothesis's own direction, including renamed shipped proposals.
 * Evidence and prior EXPERIENCE may cite shipped work without proposing it;
 * deliberately do not scan those inherited references (or their lesson text).
 * Soft HOST notes remain independent unless they explicitly claim a shipped direction.
 */
export function matchesMergedDirection(hypothesis) {
  if (!hypothesis) return false;
  const slug = String(hypothesis.slug || '').toLowerCase();
  const title = String(hypothesis.title || '');
  const tags = (hypothesis.tags || []).map((tag) => String(tag).toLowerCase());
  const directionText = [slug, title, ...tags].join('\n');
  const explicitRefs = [
    hypothesis.pr,
    hypothesis.prs,
    hypothesis.prRef,
    hypothesis.prRefs,
    hypothesis.pullRequest,
    hypothesis.pullRequests,
    hypothesis.pullRequestRefs,
    hypothesis.alignedPr,
    hypothesis.alignedPrs,
  ].flatMap(referenceStrings);

  return MERGED_DIRECTIONS.some((direction) => {
    if (direction.slugs.includes(slug)) return true;
    if (direction.directionPattern.test(directionText.replaceAll('_', '-'))) return true;
    if (direction.tagSets.some((set) => set.every((tag) => tags.includes(tag)))) return true;
    return direction.pullRequests.some((number) => {
      const refPattern = new RegExp(`(?:#|\\bPR[\\s_-]*#?\\s*|/pull/)${number}\\b`, 'i');
      return refPattern.test(directionText) || explicitRefs.some((ref) =>
        refPattern.test(ref) || new RegExp(`^#?${number}$`).test(ref.trim()));
    });
  });
}

function referenceStrings(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(referenceStrings);
  if (typeof value === 'object') {
    return [value.number, value.url, value.ref].flatMap(referenceStrings);
  }
  return [String(value)];
}
