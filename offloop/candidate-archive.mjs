/** Read current title/status metadata, excluding historical draft body text. */
function statusMetadata(mdText) {
  const preamble = String(mdText ?? '').split(/^#{2,6}\s/m, 1)[0];
  const title = preamble.match(/^#\s+.*?\*\*([^*\n]+)\*\*\s*$/m)?.[1] || '';
  const banner = preamble.match(/^\s*-\s*\*\*状态[：:]\s*([^*\n]+)\*\*/m)?.[1] || '';
  return `${title}\n${banner}`;
}

/** Archive/shipped metadata overrides any stale CANDIDATE title or banner. */
export function isArchivedOrShipped(mdText) {
  return /\bARCHIVED\b|\bSHIPPED\b|挂着/i.test(statusMetadata(mdText));
}

/** Pure filter for a pending-freeze list; no runtime or promote integration. */
export function isPendingCandidate(mdText) {
  return !isArchivedOrShipped(mdText) && /\bCANDIDATE\b/.test(statusMetadata(mdText));
}
