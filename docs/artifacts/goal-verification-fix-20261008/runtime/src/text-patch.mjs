import { createHash } from 'node:crypto';

const MAX_REPLACEMENTS = 32;
export const MAX_PATCH_TEXT = 256 * 1024;
export class TextPatchError extends Error {
  constructor(message) { super(message); this.name = 'TextPatchError'; this.code = message.split(':', 1)[0]; }
}

const digest = (value) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const splitLines = (value) => String(value).split(/(?<=\n)/u);

/**
 * Apply exact, bounded replacements.  The caller supplies the current file
 * digest so a stale SWE-bench style patch cannot silently overwrite a newer
 * edit.  Replacements are intentionally sequential and exact: fuzzy hunks
 * make an agent's write non-deterministic and are difficult to audit.
 */
export const applyTextPatch = (before, replacements, expectedDigest) => {
  if (typeof before !== 'string' || !Array.isArray(replacements) || replacements.length < 1 || replacements.length > MAX_REPLACEMENTS) {
    throw new TextPatchError('PATCH_INVALID');
  }
  if (Buffer.byteLength(before, 'utf8') > MAX_PATCH_TEXT) throw new TextPatchError('PATCH_TOO_LARGE');
  const normalizedDigest = typeof expectedDigest === 'string' && /^[a-f0-9]{64}$/iu.test(expectedDigest)
    ? `sha256:${expectedDigest.toLowerCase()}` : expectedDigest;
  if (expectedDigest !== undefined && normalizedDigest !== digest(before)) throw new TextPatchError('PATCH_STALE_DIGEST');
  let current = before;
  for (const replacement of replacements) {
    if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)
      || typeof replacement.oldText !== 'string' || replacement.oldText.length < 1
      || typeof replacement.newText !== 'string') throw new TextPatchError('PATCH_INVALID');
    if (Buffer.byteLength(replacement.oldText, 'utf8') > MAX_PATCH_TEXT
      || Buffer.byteLength(replacement.newText, 'utf8') > MAX_PATCH_TEXT) throw new TextPatchError('PATCH_TOO_LARGE');
    const expectedCount = replacement.expectedCount === undefined ? 1 : replacement.expectedCount;
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 32) throw new TextPatchError('PATCH_INVALID');
    let count = 0;
    let index = current.indexOf(replacement.oldText);
    while (index >= 0) {
      count += 1;
      index = current.indexOf(replacement.oldText, index + replacement.oldText.length);
    }
    if (count !== expectedCount) throw new TextPatchError(`PATCH_MATCH_COUNT:${count}`);
    if (expectedCount === 1) {
      current = current.replace(replacement.oldText, replacement.newText);
    } else {
      current = current.split(replacement.oldText).join(replacement.newText);
    }
    if (Buffer.byteLength(current, 'utf8') > MAX_PATCH_TEXT) throw new TextPatchError('PATCH_TOO_LARGE');
  }
  return current;
};

/** Produce a compact unified diff with one changed hunk and bounded output. */
export const unifiedTextDiff = (before, after, path = 'file') => {
  if (typeof before !== 'string' || typeof after !== 'string') throw new TextPatchError('PATCH_INVALID');
  if (before === after) return '';
  const left = splitLines(before);
  const right = splitLines(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  const leftEnd = left.length - suffix;
  const rightEnd = right.length - suffix;
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -${prefix + 1},${Math.max(0, leftEnd - prefix)} +${prefix + 1},${Math.max(0, rightEnd - prefix)} @@`];
  for (const line of left.slice(prefix, leftEnd)) lines.push(`-${line.replace(/\n$/u, '')}`);
  for (const line of right.slice(prefix, rightEnd)) lines.push(`+${line.replace(/\n$/u, '')}`);
  return lines.join('\n').slice(0, MAX_PATCH_TEXT);
};

export const textDigest = digest;
