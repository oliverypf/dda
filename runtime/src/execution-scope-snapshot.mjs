import { createHash } from 'node:crypto';

const FIELDS = [
  'runId', 'operationId', 'workspaceRootDigest', 'canonicalRootDigest',
  'repositoryRootDigest', 'beforeHead', 'allowedPathRoots', 'allowedPathGlobs',
  'forbiddenPathGlobs', 'allowedCapabilities', 'allowedCommands',
  'allowedNetworkTargets', 'executionMode', 'releaseChannel', 'policyVersion',
  'bindingSnapshotDigest', 'approvalScopeDigest', 'leaseScopeDigest',
  'decisionIds', 'createdAtMs'
];
const ARRAY_FIELDS = new Set([
  'allowedPathRoots', 'allowedPathGlobs', 'forbiddenPathGlobs',
  'allowedCapabilities', 'allowedCommands', 'allowedNetworkTargets', 'decisionIds'
]);
const SENSITIVE_ARRAY_FIELDS = new Set([
  'allowedPathRoots', 'allowedPathGlobs', 'forbiddenPathGlobs',
  'allowedCommands', 'allowedNetworkTargets'
]);
const MAX_ITEMS = 256;
const MAX_STRING = 512;

const digest = (value) => `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
const cleanString = (value) => typeof value === 'string' ? value.normalize('NFC').trim().slice(0, MAX_STRING) : String(value ?? '').slice(0, MAX_STRING);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
};
const serialize = (value) => JSON.stringify(canonicalize(value));
const normalizeArray = (field, value) => [...new Set((Array.isArray(value) ? value : []).slice(0, MAX_ITEMS)
  .map(cleanString).filter(Boolean).map((item) => SENSITIVE_ARRAY_FIELDS.has(field) ? digest(item) : item))].sort();

export const sha256Digest = digest;
export const canonicalSerialize = serialize;

export function createExecutionScopeSnapshot(input = {}) {
  const snapshot = {};
  for (const field of FIELDS) {
    if (ARRAY_FIELDS.has(field)) snapshot[field] = normalizeArray(field, input[field]);
    else if (field === 'createdAtMs') snapshot[field] = Number.isFinite(input[field]) ? Math.trunc(input[field]) : 0;
    else snapshot[field] = cleanString(input[field]);
  }
  snapshot.snapshotDigest = digest(serialize(snapshot));
  return Object.freeze(snapshot);
}

export function compareExecutionScopeSnapshots(left, right) {
  const mismatchedFields = [];
  for (const field of [...FIELDS, 'snapshotDigest']) {
    if (serialize(left?.[field]) !== serialize(right?.[field])) mismatchedFields.push(field);
  }
  return { ok: mismatchedFields.length === 0, mismatchedFields };
}

export function compareGitObservations(before, after, scopeSnapshot = {}) {
  const beforeStatus = before?.status ?? {};
  const afterStatus = after?.status ?? {};
  const beforePaths = new Set(Array.isArray(beforeStatus.pathDigests) ? beforeStatus.pathDigests : []);
  const afterPaths = new Set(Array.isArray(afterStatus.pathDigests) ? afterStatus.pathDigests : []);
  const changedPathDigests = [...new Set([
    ...[...afterPaths].filter((path) => !beforePaths.has(path)),
    ...[...beforePaths].filter((path) => !afterPaths.has(path))
  ])].sort();
  const allowedPathDigests = new Set(Array.isArray(scopeSnapshot.allowedPathRoots) ? scopeSnapshot.allowedPathRoots : []);
  const outOfScopePathDigests = changedPathDigests.filter((path) => !allowedPathDigests.has(path));
  const observationComplete = before?.available === true && after?.available === true
    && beforeStatus.pathDigestTruncated !== true && afterStatus.pathDigestTruncated !== true;
  const metadataChanged = Boolean(
    before?.headDigest !== after?.headDigest
    || before?.indexDigest !== after?.indexDigest
    || before?.repositoryRootDigest !== after?.repositoryRootDigest
    || before?.metadataDigest !== after?.metadataDigest
    || before?.metadataLinkDetected !== after?.metadataLinkDetected
  );
  const workingTreeChanged = before?.workingTreeDigest !== after?.workingTreeDigest;
  const untrackedChanged = before?.untrackedDigest !== after?.untrackedDigest;
  return {
    ok: !observationComplete || (!metadataChanged && outOfScopePathDigests.length === 0),
    auditDegraded: !observationComplete,
    observationComplete,
    metadataChanged,
    workingTreeChanged,
    untrackedChanged,
    changedPathDigests,
    outOfScopePathDigests
  };
}

export const createScopeSnapshot = createExecutionScopeSnapshot;
export const compareScopeSnapshots = compareExecutionScopeSnapshots;
