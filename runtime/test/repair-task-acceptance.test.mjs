import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RepairRetest } from '../src/repair-retest.mjs';
import { createTaskAcceptanceHook } from '../src/repair-task-acceptance.mjs';

const execute = promisify(execFile);
const fixtures = fileURLToPath(new URL('../../docs/artifacts/repair-breadth-2026-11-21/', import.meta.url));

async function checkpoint(t, kind) {
  const archive = join(fixtures, kind);
  const root = await mkdtemp(join(tmpdir(), 'dda-prewrite-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(archive, 'workspace'), root, { recursive: true });
  const { product, test: testPath, oldText, newText } = JSON.parse(await readFile(join(archive, 'warmup.json'), 'utf8'));
  const { assertion } = JSON.parse(await readFile(join(archive, 'preflight.json'), 'utf8'));
  const original = await readFile(join(root, product), 'utf8');
  const wrong = original.replace(oldText, newText);
  await writeFile(join(root, product), wrong);
  const workspace = new ReadonlyWorkspace(root);
  const target = {
    cwd: '.', request: { command: 'node', args: ['--test', testPath] },
    targetPath: testPath, targetDigest: assertion.digest, assertionLine: assertion.line
  };
  async function run({ cwd, args, timeoutMs = 10_000 }) {
    assert.notEqual(cwd, '.');
    try {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_OPTIONS;
      const output = await execute(process.execPath, args, { cwd: join(root, cwd), timeout: timeoutMs, env });
      return { ok: true, exitCode: 0, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      return { ok: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr, timedOut: error.killed };
    }
  }
  const candidate = async name => ({
    workspace, path: product, content: await readFile(join(archive, 'controls', name + '.mjs'), 'utf8')
  });
  return { workspace, target, product, run, candidate, root, wrong };
}

for (const kind of ['history', 'paging', 'queue']) {
  test(kind + ' blocks the frozen overbroad candidate and admits its reference', async t => {
    const state = await checkpoint(t, kind);
    const candidateAcceptance = createTaskAcceptanceHook({ kind, productPath: state.product });
    const repair = new RepairRetest(state.workspace, undefined, { candidateAcceptance });
    for (const [candidateName, expected] of [['overbroad', 'rejected'], ['reference', 'passed']]) {
      const verdict = await repair.checkCandidate(state.target, await state.candidate(candidateName), state.run,
        undefined, { retryUnverified: true, retryLimit: 1 });
      assert.equal(verdict.assertionPassed, true, JSON.stringify(verdict));
      assert.equal(verdict.exitCode, 0);
      assert.equal(verdict.status, expected, JSON.stringify(verdict));
      assert.equal(verdict.retest, undefined);
      assert.equal(verdict.acceptance.status, candidateName === 'overbroad' ? 'failed' : 'passed');
      assert.equal(Object.values(verdict.acceptance.checks).every(Boolean), candidateName === 'reference');
      assert.equal(await readFile(join(state.root, state.product), 'utf8'), state.wrong);
    }
  });
}

test('incomplete or conflicting acceptance never authorizes a candidate on the bounded retry', async t => {
  const state = await checkpoint(t, 'paging');
  const invalid = { status: 'passed', checks: { cursor: false }, detail: 'private test output' };
  let attempts = 0;
  const repair = new RepairRetest(state.workspace, undefined, { candidateAcceptance: async () => {
    if (++attempts === 1) throw new Error('private exception output');
    return invalid;
  } });
  const candidate = await state.candidate('reference');
  const verdict = await repair.checkCandidate(state.target, candidate, state.run, undefined,
    { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts, 2);
  assert.equal(verdict.status, 'unverified');
  assert.deepEqual(verdict.acceptance, { status: 'unverified' });
  assert.deepEqual(verdict.retest, { attempts: 2, initialStatus: 'unverified', finalStatus: 'unverified', resolved: false });
  repair.rememberRejection(state.target, verdict, state.product);
  assert.equal(state.target.lastRejected.status, 'unverified');
  assert.doesNotMatch(JSON.stringify(state.target.lastRejected), /private/);
  assert.equal(await readFile(join(state.root, state.product), 'utf8'), state.wrong);
});
