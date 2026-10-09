import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { boundedPrompt, recoveryAttemptLimit, recoveryPrompt, focusedPrompt, summarizeEvents, scopedPath, approveWrite, prepare, adoptionPlan, digest } from './supervise-dda-task.mjs';

test('oversized task instructions are rejected rather than silently losing the tail', () => {
  assert.equal(boundedPrompt('  需求  '), '需求');
  assert.equal(boundedPrompt('中'.repeat(8000)).length, 8000);
  assert.throws(() => boundedPrompt('中'.repeat(8000) + '必须保留归档数据'), /PROMPT_SIZE/);
  assert.throws(() => boundedPrompt(' '), /PROMPT_SIZE/);
});
test('workspace path cannot escape or target the root', () => {
  const root = resolve('fixture');
  assert.equal(scopedPath(root, 'src/main.ts'), resolve(root, 'src/main.ts'));
  for (const path of ['..', '../elsewhere', '.', root]) assert.throws(() => scopedPath(root, path), /PATH_OUTSIDE/);
});
test('supervised runs use one execution-and-verification attempt by default', () => {
  assert.equal(recoveryAttemptLimit(), 1);
  assert.equal(recoveryAttemptLimit({ maxRecoveryAttempts: 2 }), 2);
  for (const maxRecoveryAttempts of [0, -1, 9, 1.5, '2']) assert.throws(() => recoveryAttemptLimit({ maxRecoveryAttempts }), /INVALID_RECOVERY/);
});
test('unknown verification provider errors remain visible and are never marked as a pass', () => {
  const summary = summarizeEvents(JSON.stringify({ kind: 'verification.completed', payload: { status: 'UNCERTAIN', checks: [{ status: 'UNKNOWN', message: 'JEV_HTTP_451' }] } }));
  assert.deepEqual(summary.verification, { status: 'UNCERTAIN', providerErrors: ['JEV_HTTP_451'] });
  assert.equal(summary.runtimeResult, null);
});
test('recovery carries the real failure and existing edits forward without claiming success', () => {
  const result = { code: 1, finalResult: { ok: false, error: 'fetch failed' }, changedFiles: ['src/main.ts'], validationStatus: 'not_independently_verified' };
  const prompt = recoveryPrompt('Move archives into settings.', result, 'Build found an unresolved old renderer reference.');
  assert.match(prompt, /Move archives into settings/);
  assert.match(prompt, /"previousRuntimeOk":false/);
  assert.match(prompt, /fetch failed/);
  assert.match(prompt, /src\/main.ts/);
  assert.match(prompt, /unresolved old renderer/);
  assert.throws(() => recoveryPrompt('goal', result, ''), /RECOVERY_FEEDBACK_REQUIRED/);
  assert.throws(() => recoveryPrompt('x'.repeat(7999), result, 'remaining work'), /PROMPT_SIZE/);
});
test('heartbeats are not confused with implementation progress or successful completion', () => {
  const events = [
    { kind: 'tool.result', emittedAtMs: 1, payload: { name: 'workspace.read', ok: true } },
    { kind: 'runtime.heartbeat', emittedAtMs: 2 },
    { kind: 'tool.result', emittedAtMs: 3, payload: { name: 'file.patch', ok: true } },
    { kind: 'tool.result', emittedAtMs: 4, payload: { name: 'workspace.read', ok: true } },
    { kind: 'runtime.heartbeat', emittedAtMs: 5 },
    { ok: false, error: 'fetch failed' }
  ].map(e => JSON.stringify(e)).join('\n');
  const summary = summarizeEvents(events + '\n{"partial":');
  assert.equal(summary.heartbeats, 2);
  assert.equal(summary.inspectionsSinceWrite, 1);
  assert.equal(summary.successfulWrites, 1);
  assert.equal(summary.latestActivity.atMs, 4);
  assert.deepEqual(summary.runtimeResult, { ok: false, error: 'fetch failed' });
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-supervision-'));
  // root comes directly from mkdtemp and remains within the OS temporary directory.
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source'), evidenceRoot = join(root, 'evidence'), workspace = join(evidenceRoot, 'workspace');
  await mkdir(join(sourceRoot, 'src'), { recursive: true }); await mkdir(evidenceRoot);
  await writeFile(join(sourceRoot, 'src/main.ts'), 'existing uncommitted work');
  await writeFile(join(sourceRoot, 'src/styles.css'), 'existing styles');
  const spec = { sourceRoot, evidenceRoot, workspace, copyPaths: ['src'], allowedFiles: ['src/main.ts', 'src/styles.css'] };
  await prepare(spec);
  return spec;
}
test('prepare preserves current working bytes and refuses to overwrite an existing run', async t => {
  const spec = await fixture(t);
  assert.equal(await readFile(join(spec.workspace, 'src/main.ts'), 'utf8'), 'existing uncommitted work');
  await assert.rejects(prepare(spec), /EEXIST/);
});
test('focused handoff quotes actual uniquely located source with its hash', async t => {
  const spec = await fixture(t);
  const task = { goal: 'Fix the remaining error', instructions: 'Preserve previous work', excerpts: [{ path: 'src/main.ts', findText: 'existing', maxChars: 80 }] };
  const prompt = await focusedPrompt(spec, task);
  assert.match(prompt, /existing uncommitted work/);
  assert.ok(prompt.includes(digest('existing uncommitted work')));
  await assert.rejects(focusedPrompt(spec, { ...task, excerpts: [{ ...task.excerpts[0], findText: 'missing' }] }), /EXCERPT_NOT_FOUND/);
  await writeFile(join(spec.workspace, 'src/main.ts'), 'existing existing');
  await assert.rejects(focusedPrompt(spec, task), /EXCERPT_AMBIGUOUS/);
});
test('only explicitly allowed existing file writes receive approval', async t => {
  const spec = await fixture(t);
  const p = { capability: 'file.write', requestId: 'r1', requestDigest: 'd1', path: 'src/main.ts' };
  assert.equal(await approveWrite(spec.workspace, spec.allowedFiles, p), true);
  for (const patch of [{ capability: 'shell.execute' }, { path: '../source/src/main.ts' }, { path: 'src/other.ts' }, { requestDigest: '' }]) {
    assert.equal(await approveWrite(spec.workspace, spec.allowedFiles, { ...p, ...patch }), false);
  }
  const external = join(spec.sourceRoot, 'src');
  await symlink(external, join(spec.workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await approveWrite(spec.workspace, ['linked/main.ts'], { ...p, path: 'linked/main.ts' }), false);
});
test('unverified candidate bytes are not adopted', async t => {
  const spec = await fixture(t);
  await writeFile(join(spec.workspace, 'src/main.ts'), 'dda changes');
  await assert.rejects(adoptionPlan(spec, {}), /UNVERIFIED_CANDIDATE/);
  assert.equal(await readFile(join(spec.sourceRoot, 'src/main.ts'), 'utf8'), 'existing uncommitted work');
});
test('concurrent destination edits block adoption while preserving both versions', async t => {
  const spec = await fixture(t);
  await writeFile(join(spec.workspace, 'src/main.ts'), 'dda changes');
  await writeFile(join(spec.sourceRoot, 'src/main.ts'), 'another chat changed this');
  await assert.rejects(adoptionPlan(spec, { 'src/main.ts': digest('dda changes') }), /ADOPTION_CONFLICT/);
  assert.equal(await readFile(join(spec.sourceRoot, 'src/main.ts'), 'utf8'), 'another chat changed this');
  assert.equal(await readFile(join(spec.workspace, 'src/main.ts'), 'utf8'), 'dda changes');
});
test('accepted hash permits a plan only for changed files; no write happens during preflight', async t => {
  const spec = await fixture(t);
  await writeFile(join(spec.workspace, 'src/main.ts'), 'dda changes');
  const plan = await adoptionPlan(spec, { 'src/main.ts': digest('dda changes') });
  assert.deepEqual(plan.map(x => x.path), ['src/main.ts']);
  assert.equal(await readFile(join(spec.sourceRoot, 'src/main.ts'), 'utf8'), 'existing uncommitted work');
});
