import { createHash } from 'node:crypto';

const MAX_STATEMENT = 2000;
const MAX_SOURCES = 32;
const SECRET_TEXT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer|private\s+key)\s*[:=]/i;

const clone = (value) => structuredClone(value);
const normalize = (value) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const digest = (value) => `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
const identity = (candidate) => `${String(candidate?.scope ?? 'workspace').trim().toLowerCase()}::${normalize(candidate?.statement)}`;

const reject = (candidate, codes) => ({
  ...clone(candidate ?? {}),
  verification: {
    status: 'REJECTED',
    accepted: false,
    codes: [...new Set(codes)]
  }
});

/**
 * Deterministic boundary for Memory proposals. It only accepts bounded,
 * source-backed statements and never treats a model's self-evaluation as
 * evidence. Semantic conflicts are surfaced for review instead of silently
 * selecting one candidate.
 */
export class MemoryVerifier {
  verify({ candidates = [], sourceEvents = [], existingMemories = [] } = {}) {
    if (!Array.isArray(candidates)) throw new Error('MEMORY_CANDIDATES_INVALID');
    if (!Array.isArray(sourceEvents) || !Array.isArray(existingMemories)) throw new Error('MEMORY_SOURCES_INVALID');
    const sourceIds = new Set(sourceEvents.map((event) => event?.eventId).filter((id) => typeof id === 'string'));
    const existingByIdentity = new Map();
    const existingByKey = new Map();
    for (const memory of existingMemories) {
      if (!memory || !['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(memory.status)) continue;
      existingByIdentity.set(identity(memory), memory);
      if (memory.key !== undefined) existingByKey.set(`${String(memory.scope ?? 'workspace')}::${String(memory.key)}`, memory);
    }
    const seen = new Map();
    return candidates.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return reject({}, ['CANDIDATE_INVALID']);
      const statement = typeof candidate.statement === 'string' ? candidate.statement.trim() : '';
      const sourceEventIds = Array.isArray(candidate.sourceEventIds)
        ? candidate.sourceEventIds.filter((id) => typeof id === 'string').slice(0, MAX_SOURCES)
        : [];
      const codes = [];
      if (!statement || statement.length > MAX_STATEMENT) codes.push('STATEMENT_INVALID');
      if (SECRET_TEXT.test(statement)) codes.push('SENSITIVE_CONTENT');
      if (sourceEventIds.length === 0) codes.push('SOURCE_REQUIRED');
      if (new Set(sourceEventIds).size !== sourceEventIds.length) codes.push('DUPLICATE_SOURCE');
      if (sourceEventIds.some((id) => !sourceIds.has(id))) codes.push('SOURCE_NOT_FOUND');
      const key = identity({ ...candidate, statement });
      if (seen.has(key) || existingByIdentity.has(key)) codes.push('DUPLICATE_MEMORY');
      seen.set(key, candidate);
      if (candidate.key !== undefined) {
        const keyIdentity = `${String(candidate.scope ?? 'workspace')}::${String(candidate.key)}`;
        const prior = existingByKey.get(keyIdentity);
        if (prior && normalize(prior.statement) !== normalize(statement)) codes.push('CONFLICTING_MEMORY');
      }
      const result = {
        ...clone(candidate),
        statement,
        sourceEventIds,
        contentDigest: digest(statement),
        verification: {
          status: codes.length ? 'REJECTED' : 'ACCEPTED',
          accepted: codes.length === 0,
          codes: [...new Set(codes)]
        }
      };
      return result;
    });
  }
}

export const createMemoryVerifier = () => new MemoryVerifier();
export const memoryStatementDigest = digest;
export const memoryIdentity = identity;
