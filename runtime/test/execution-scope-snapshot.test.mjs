import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalSerialize,
  compareExecutionScopeSnapshots,
  compareGitObservations,
  createExecutionScopeSnapshot,
  sha256Digest
} from '../src/execution-scope-snapshot.mjs';

const input = {
  runId: 'run-1', operationId: 'op-1', canonicalRootDigest: 'root',
  allowedPathRoots: ['C:\\work\\z', 'C:\\work\\a', 'C:\\work\\a'],
  allowedPathGlobs: ['src/**'], forbiddenPathGlobs: ['.env'],
  allowedCapabilities: ['read'], allowedCommands: ['git status'],
  allowedNetworkTargets: ['api.example.test'], decisionIds: ['d2', 'd1'],
  createdAtMs: 42
};

test('snapshot is deterministic and canonical', () => {
  const a = createExecutionScopeSnapshot(input);
  const b = createExecutionScopeSnapshot({ ...input, allowedPathRoots: ['C:\\work\\a', 'C:\\work\\z'], decisionIds: ['d1', 'd2'] });
  assert.deepEqual(a, b);
  assert.equal(a.snapshotDigest, sha256Digest(canonicalSerialize({ ...a, snapshotDigest: undefined }).replace(',"snapshotDigest":undefined', '')));
});

test('redacts and bounds sensitive arrays', () => {
  const secret = 'password=top-secret';
  const snapshot = createExecutionScopeSnapshot({ allowedCommands: [secret, 'x'.repeat(1000)], allowedCapabilities: ['z'.repeat(1000)] });
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.match(snapshot.allowedCommands[0], /^sha256:[0-9a-f]{64}$/);
  assert.ok(snapshot.allowedCapabilities[0].length <= 512);
  assert.ok(snapshot.allowedCommands.length <= 256);
});

test('digest uses sha256 prefix and 64 hex characters', () => {
  assert.match(sha256Digest('value'), /^sha256:[0-9a-f]{64}$/);
});

test('Git observation comparison isolates approved path changes and metadata changes', () => {
  const path = sha256Digest('src/result.txt');
  const scope = createExecutionScopeSnapshot({ allowedPathRoots: ['src/result.txt'] });
  const before = {
    available: true,
    headDigest: 'head-a', indexDigest: 'index-a', repositoryRootDigest: 'repo-a',
    workingTreeDigest: 'tree-a', untrackedDigest: 'untracked-a',
    status: { pathDigests: [] }
  };
  const after = {
    ...before,
    workingTreeDigest: 'tree-b',
    status: { pathDigests: [path] }
  };
  const allowed = compareGitObservations(before, after, scope);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.outOfScopePathDigests, []);
  const outOfScope = compareGitObservations(before, {
    ...after,
    status: { pathDigests: [sha256Digest('other.txt')] }
  }, scope);
  assert.equal(outOfScope.ok, false);
  assert.equal(outOfScope.outOfScopePathDigests.length, 1);
  const metadata = compareGitObservations(before, { ...after, indexDigest: 'index-b' }, scope);
  assert.equal(metadata.ok, false);
  assert.equal(metadata.metadataChanged, true);
});

test('comparison reports mismatched fields', () => {
  const a = createExecutionScopeSnapshot(input);
  const b = createExecutionScopeSnapshot({ ...input, policyVersion: 'v2' });
  const result = compareExecutionScopeSnapshots(a, b);
  assert.equal(result.ok, false);
  assert.ok(result.mismatchedFields.includes('policyVersion'));
  assert.ok(result.mismatchedFields.includes('snapshotDigest'));
  assert.equal(compareExecutionScopeSnapshots(a, a).ok, true);
});

test('every execution scope field mismatch is detected (S2-02 field matrix)', () => {
  const baseInput = {
    runId: 'run-1', operationId: 'op-1', workspaceRootDigest: 'ws', canonicalRootDigest: 'canonical',
    repositoryRootDigest: 'repo', beforeHead: 'head', allowedPathRoots: ['src/a.txt'], allowedPathGlobs: ['src/**'],
    forbiddenPathGlobs: ['.env'], allowedCapabilities: ['read'], allowedCommands: ['git status'],
    allowedNetworkTargets: ['api.example.test'], executionMode: 'CONTROLLED',
    releaseChannel: 'WINDOWS_PHASE1_5_CONTROLLED', policyVersion: 'runtime-safety-1',
    bindingSnapshotDigest: 'binding', approvalScopeDigest: 'approval', leaseScopeDigest: 'lease',
    decisionIds: ['d1'], createdAtMs: 42
  };
  const base = createExecutionScopeSnapshot(baseInput);
  const fields = Object.keys(base).filter((field) => field !== 'snapshotDigest');
  assert.equal(fields.length, 20);
  for (const field of fields) {
    const current = base[field];
    const mutated = Array.isArray(current)
      ? [...current, 'zz-mismatch']
      : typeof current === 'number' ? current + 1 : `${current}-x`;
    const changed = createExecutionScopeSnapshot({ ...baseInput, [field]: mutated });
    const comparison = compareExecutionScopeSnapshots(base, changed);
    assert.equal(comparison.ok, false, `${field} change must fail the comparison`);
    assert.ok(comparison.mismatchedFields.includes(field), `${field} must be listed as mismatched`);
  }
});
