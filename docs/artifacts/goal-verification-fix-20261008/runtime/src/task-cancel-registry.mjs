import { createHash } from 'node:crypto';
import { persistJsonFile, readPersistentJsonFile } from './persistent-json-store.mjs';

export const TASK_CANCEL_SCHEMA_VERSION = '1.0';

const MAX_REQUESTS = 4096;
const MAX_TEXT = 240;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const STATUSES = new Set(['REQUESTED', 'CONSUMED']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);
const text = (value, fallback = '', max = MAX_TEXT) => typeof value === 'string' && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max)
  : fallback;
const canonical = (value) => {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

export const taskCancelStorePath = (trajectoryPath) => typeof trajectoryPath === 'string' && trajectoryPath.trim()
  ? `${trajectoryPath}.cancels.json`
  : undefined;

const emptySnapshot = () => ({ schemaVersion: TASK_CANCEL_SCHEMA_VERSION, requests: {} });

const normalizeRunId = (runId) => {
  const normalized = text(runId, '', MAX_TEXT);
  if (!normalized) throw new Error('TASK_CANCEL_RUN_ID_REQUIRED');
  return normalized;
};

const validateRequest = (runId, request) => {
  if (!isObject(request) || request.runId !== runId || !STATUSES.has(request.status)
    || !Number.isInteger(request.requestedAtMs) || request.requestedAtMs < 0
    || !DIGEST_PATTERN.test(request.reasonDigest ?? '')
    || typeof request.requestedBy !== 'string' || !request.requestedBy) {
    throw new Error('TASK_CANCEL_STORE_INVALID');
  }
  if (request.status === 'CONSUMED'
    && (!Number.isInteger(request.consumedAtMs) || request.consumedAtMs < 0)) {
    throw new Error('TASK_CANCEL_STORE_INVALID');
  }
  return request;
};

const validateSnapshot = (parsed) => {
  if (!isObject(parsed) || parsed.schemaVersion !== TASK_CANCEL_SCHEMA_VERSION || !isObject(parsed.requests)) {
    throw new Error('TASK_CANCEL_STORE_INVALID');
  }
  for (const [runId, request] of Object.entries(parsed.requests)) validateRequest(runId, request);
  return parsed;
};

// Pending requests are never evicted; consumed history is bounded so a
// long-running installation cannot grow the sidecar without limit.
const pruneRequests = (requests) => {
  const entries = Object.entries(requests);
  if (entries.length <= MAX_REQUESTS) return requests;
  const pending = entries.filter(([, request]) => request.status === 'REQUESTED');
  if (pending.length > MAX_REQUESTS) throw new Error('TASK_CANCEL_STORE_LIMIT');
  const consumed = entries
    .filter(([, request]) => request.status === 'CONSUMED')
    .sort((left, right) => (right[1].consumedAtMs ?? right[1].requestedAtMs) - (left[1].consumedAtMs ?? left[1].requestedAtMs));
  return Object.fromEntries([...pending, ...consumed.slice(0, MAX_REQUESTS - pending.length)]);
};

export const createTaskCancelRegistry = ({ storagePath, now = () => Date.now() } = {}) => {
  const memory = emptySnapshot();

  const read = async () => {
    if (!storagePath) return clone(memory);
    const parsed = await readPersistentJsonFile(storagePath);
    return parsed === undefined ? emptySnapshot() : validateSnapshot(parsed);
  };

  const mutate = async (mutator) => {
    if (!storagePath) {
      mutator(memory.requests);
      memory.requests = pruneRequests(memory.requests);
      return clone(memory);
    }
    let next;
    await persistJsonFile(storagePath, emptySnapshot(), {
      merge: (existing) => {
        const current = existing === undefined ? emptySnapshot() : validateSnapshot(existing);
        mutator(current.requests);
        next = {
          schemaVersion: TASK_CANCEL_SCHEMA_VERSION,
          requests: pruneRequests(current.requests)
        };
        return next;
      }
    });
    return clone(next ?? emptySnapshot());
  };

  return {
    async request(runId, { reason = 'USER_REQUESTED', requestedBy = 'runtime-cli' } = {}) {
      const normalizedRunId = normalizeRunId(runId);
      const requestedAtMs = now();
      const reasonDigest = digest({ reason: text(reason, 'USER_REQUESTED'), requestedBy: text(requestedBy, 'runtime-cli') });
      let created = false;
      const snapshot = await mutate((requests) => {
        const existing = requests[normalizedRunId];
        if (existing?.status === 'REQUESTED') return;
        requests[normalizedRunId] = {
          runId: normalizedRunId,
          status: 'REQUESTED',
          requestedAtMs,
          reasonDigest,
          requestedBy: text(requestedBy, 'runtime-cli')
        };
        created = true;
      });
      return {
        status: created ? 'CANCEL_REQUESTED' : 'CANCEL_ALREADY_REQUESTED',
        idempotent: !created,
        request: clone(snapshot.requests[normalizedRunId])
      };
    },

    async get(runId) {
      const normalizedRunId = normalizeRunId(runId);
      const snapshot = await read();
      const request = snapshot.requests[normalizedRunId];
      return request?.status === 'REQUESTED' ? clone(request) : undefined;
    },

    async consume(runId) {
      const normalizedRunId = normalizeRunId(runId);
      const snapshot = await mutate((requests) => {
        const existing = requests[normalizedRunId];
        if (!existing || existing.status !== 'REQUESTED') return;
        requests[normalizedRunId] = { ...existing, status: 'CONSUMED', consumedAtMs: now() };
      });
      return clone(snapshot.requests[normalizedRunId]);
    },

    async list() {
      const snapshot = await read();
      return Object.values(snapshot.requests)
        .map(clone)
        .sort((left, right) => right.requestedAtMs - left.requestedAtMs || left.runId.localeCompare(right.runId));
    }
  };
};
