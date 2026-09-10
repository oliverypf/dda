import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitObserver } from '../src/git-observer.mjs';
import { createGitAuditStore } from '../src/git-audit-store.mjs';
import { compareGitObservations, createExecutionScopeSnapshot } from '../src/execution-scope-snapshot.mjs';

const runGit = (cwd, args) => new Promise((resolve, reject) => {
  const child = spawn(process.platform === 'win32' ? 'git.exe' : 'git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => {
    if (code !== 0) reject(new Error(`git failed: ${args.join(' ')}: ${stderr}`));
    else resolve(stdout);
  });
});

const initRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-git-audit-'));
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'audit@example.invalid']);
  await runGit(root, ['config', 'user.name', 'Audit Fixture']);
  await writeFile(join(root, 'README.md'), '# audit fixture\n', 'utf8');
  await runGit(root, ['add', 'README.md']);
  await runGit(root, ['commit', '-qm', 'fixture']);
  return root;
};

test('GitObserver returns redacted stable repository state and detects changes', async () => {
  const root = await initRepository();
  const observer = createGitObserver({ workspaceRoot: root, now: () => 1000 });
  const clean = await observer.snapshot({ reason: 'RUN_STARTED' });
  assert.equal(clean.available, true);
  assert.equal(clean.status.entryCount, 0);
  assert.match(clean.repositoryRootDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(clean.headDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(clean.observationDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal('prompt' in clean, false);
  assert.equal('stdout' in clean, false);
  assert.equal('stderr' in clean, false);
  assert.equal(JSON.stringify(clean).includes('README.md'), false);

  await writeFile(join(root, 'README.md'), '# changed\n', 'utf8');
  await writeFile(join(root, 'untracked.txt'), 'untracked\n', 'utf8');
  const dirty = await observer.snapshot({ reason: 'RUN_TERMINAL', now: 2000 });
  assert.equal(dirty.status.entryCount, 2);
  assert.equal(dirty.status.untrackedCount, 1);
  assert.ok(dirty.status.unstagedCount >= 1);
  assert.notEqual(clean.observationDigest, dirty.observationDigest);
  assert.equal(JSON.stringify(dirty).includes('untracked.txt'), false);
});

test('Git metadata fingerprints detect config changes outside an execution scope', async () => {
  const root = await initRepository();
  const observer = createGitObserver({ workspaceRoot: root });
  const before = await observer.snapshot({ reason: 'ACTION_STARTED' });
  await runGit(root, ['config', 'audit.fixture', 'changed']);
  const after = await observer.snapshot({ reason: 'ACTION_COMPLETED' });
  assert.notEqual(before.metadataDigest, after.metadataDigest);
  const result = compareGitObservations(before, after, createExecutionScopeSnapshot({ allowedPathRoots: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.metadataChanged, true);
});

test('GitObserver bounds untracked enumeration by default and can opt into all', async () => {
  const root = await initRepository();
  await mkdir(join(root, 'untracked-dir'));
  await writeFile(join(root, 'untracked-dir', 'a.txt'), 'a\n', 'utf8');
  await writeFile(join(root, 'untracked-dir', 'b.txt'), 'b\n', 'utf8');
  const bounded = await createGitObserver({ workspaceRoot: root }).snapshot();
  assert.equal(bounded.status.untrackedCount, 1);
  const exhaustive = await createGitObserver({ workspaceRoot: root, untrackedFiles: 'all' }).snapshot();
  assert.equal(exhaustive.status.untrackedCount, 2);
  assert.throws(() => createGitObserver({ workspaceRoot: root, untrackedFiles: 'bogus' }), /GIT_OBSERVER_UNTRACKED_INVALID/);
});

test('GitObserver reports a non-repository without exposing command output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-not-git-'));
  const observation = await createGitObserver({ workspaceRoot: root, now: () => 10 }).snapshot();
  assert.equal(observation.available, false);
  assert.equal(observation.status, 'NOT_A_REPOSITORY');
  assert.match(observation.observationDigest, /^sha256:[0-9a-f]{64}$/);
});

test('audit CLI creates and verifies a checkpoint with its default observer timeout', async () => {
  const root = await initRepository();
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-git-audit-cli-'));
  const trajectoryPath = join(directory, 'trajectory.jsonl');
  const auditPath = join(directory, 'audit.json');
  const entrypoint = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const runCli = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd: root,
      env: { ...process.env, HMCODEX_DATA_ROOT: directory },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`CLI failed: ${stderr || stdout}`)));
  });
  const snapshot = await runCli(['audit', 'snapshot', '--workspace', root, '--run-id', 'cli-audit', '--trajectory-store', trajectoryPath, '--audit-store', auditPath]);
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.checkpoint.eventId, snapshot.event.eventId);
  const verification = await runCli(['audit', 'verify', '--trajectory-store', trajectoryPath, '--audit-store', auditPath]);
  assert.deepEqual(verification.verification, {
    ok: true,
    integrityStatus: 'INTEGRITY_UNKNOWN',
    invalidSignatures: [],
    store: 'PERSISTED',
    checkpointCount: 1,
    missingEventIds: [],
    mismatchedEventIds: []
  });
  await writeFile(join(root, 'audit-change.txt'), 'changed' + String.fromCharCode(10));
  const second = await runCli(['audit', 'snapshot', '--workspace', root, '--run-id', 'cli-audit', '--trajectory-store', trajectoryPath, '--audit-store', auditPath]);
  const shown = await runCli(['audit', 'show', '--checkpoint-id', second.checkpoint.checkpointId, '--audit-store', auditPath]);
  assert.equal(shown.checkpoint.checkpointId, second.checkpoint.checkpointId);
  const diff = await runCli(['audit', 'diff', '--from', snapshot.checkpoint.checkpointId, '--to', second.checkpoint.checkpointId, '--audit-store', auditPath]);
  assert.equal(diff.observationChanged, true);
  const violations = await runCli(['audit', 'violations', '--audit-store', auditPath]);
  assert.deepEqual(violations.violations, []);
  const exportPath = join(directory, 'audit-export.json');
  const exported = await runCli(['audit', 'export', '--output', exportPath, '--audit-store', auditPath]);
  assert.equal(exported.checkpointCount, 2);
  assert.equal(JSON.parse(await readFile(exportPath, 'utf8')).checkpoints.length, 2);
  const rebuilt = await runCli(['audit', 'rebuild', '--trajectory-store', trajectoryPath, '--audit-store', auditPath]);
  assert.equal(rebuilt.rebuiltCount, 2);
});

test('audit verification rejects cross-run, sequence, and trajectory digest mismatches', async () => {
  const store = createGitAuditStore();
  const checkpoint = await store.append({
    checkpointId: 'mismatch-checkpoint',
    runId: 'run-a',
    eventId: 'event-a',
    eventSequence: 2,
    trajectoryRootDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    observation: { observedAtMs: 1 }
  });
  assert.match(checkpoint.recordDigest, /^sha256:[0-9a-f]{64}$/);
  const verification = await store.verify({ events: [{
    eventId: 'event-a',
    runId: 'run-b',
    sequence: 3,
    recordDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  }] });
  assert.deepEqual(verification, {
    ok: false,
    integrityStatus: 'INTEGRITY_UNKNOWN',
    invalidSignatures: [],
    store: 'MEMORY_ONLY',
    checkpointCount: 1,
    missingEventIds: [],
    mismatchedEventIds: ['event-a']
  });
  await assert.rejects(() => store.append({ observation: { observationDigest: 'not-a-digest' } }), /GIT_AUDIT_INVALID_DIGEST/);
});

test('audit append does not expose an in-memory checkpoint when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-git-audit-rollback-'));
  const storagePath = join(directory, 'audit.json');
  await writeFile(storagePath, JSON.stringify({ schemaVersion: '1.0', checkpoints: [] }));
  const store = createGitAuditStore({ storagePath });
  await store.load();
  await rm(storagePath);
  await mkdir(storagePath);
  await assert.rejects(() => store.append({ runId: 'rollback-run', observation: { observedAtMs: 1 } }));
  assert.deepEqual(await store.list(), []);
});

test('signs audit checkpoints when an external signing key is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-git-audit-signature-'));
  const storagePath = join(directory, 'audit.json');
  const store = createGitAuditStore({ storagePath, signingKey: 'fixture-signing-key', signingKeyRef: 'FIXTURE_KEY' });
  const checkpoint = await store.append({ runId: 'signed-run', checkpointKind: 'RUN_STARTED', observation: { observationDigest: 'sha256:' + 'a'.repeat(64) } });
  assert.equal(checkpoint.signature.algorithm, 'HMAC-SHA256');
  assert.equal(checkpoint.signature.keyRef, 'FIXTURE_KEY');
  assert.deepEqual((await store.verify()).integrityStatus, 'SIGNED');
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  persisted.checkpoints[0].signature.value = 'sha256:' + 'f'.repeat(64);
  await writeFile(storagePath, JSON.stringify(persisted));
  const tampered = createGitAuditStore({ storagePath, signingKey: 'fixture-signing-key', signingKeyRef: 'FIXTURE_KEY' });
  await tampered.load();
  const verification = await tampered.verify();
  assert.equal(verification.ok, false);
  assert.deepEqual(verification.invalidSignatures, [checkpoint.checkpointId]);
});

test('observer accepts only bounded audit reason values', async () => {
  const root = await initRepository();
  await assert.rejects(() => createGitObserver({ workspaceRoot: root }).snapshot({ reason: 'token=secret' }), /GIT_OBSERVER_REASON_INVALID/);
});

test('GitAuditStore persists redacted checkpoints, rejects forbidden fields, and verifies trajectory references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-git-audit-store-'));
  const storagePath = join(directory, 'git-audit.json');
  const store = createGitAuditStore({ storagePath });
  const checkpoint = await store.append({
    runId: 'run-audit',
    eventId: 'event-git-1',
    eventSequence: 4,
    checkpointKind: 'RUN_STARTED',
    observation: {
      schemaVersion: '1.0',
      repositoryRootDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      indexDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      workingTreeDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      untrackedDigest: 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      status: { entryCount: 0, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, statusCodes: [], pathDigests: [] },
      observedAtMs: 100
    }
  });
  assert.match(checkpoint.recordDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await store.verify({ events: [{ eventId: 'event-git-1', runId: 'run-audit', sequence: 4 }] }), {
    ok: true,
    integrityStatus: 'INTEGRITY_UNKNOWN',
    invalidSignatures: [],
    store: 'PERSISTED',
    checkpointCount: 1,
    missingEventIds: [],
    mismatchedEventIds: []
  });
  assert.equal(JSON.stringify(await store.list()).includes('README.md'), false);
  const persisted = JSON.parse(await readFile(storagePath, 'utf8'));
  assert.equal(persisted.checkpoints.length, 1);

  await assert.rejects(() => store.append({ runId: 'run-audit', observation: { prompt: 'must not persist' } }), /GIT_AUDIT_FORBIDDEN_FIELD/);

  const reopened = createGitAuditStore({ storagePath });
  await reopened.load();
  assert.equal((await reopened.list({ runId: 'run-audit' })).length, 1);
  assert.deepEqual(await reopened.verify({ events: [] }), {
    ok: false,
    integrityStatus: 'INTEGRITY_UNKNOWN',
    invalidSignatures: [],
    store: 'PERSISTED',
    checkpointCount: 1,
    missingEventIds: ['event-git-1'],
    mismatchedEventIds: []
  });
});
