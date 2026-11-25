import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RepairRetest } from '../src/repair-retest.mjs';

const productPath = 'src/product.mjs';
const testPath = 'test/product.test.mjs';
const product = 'export const product = () => \'ok\';\n';
const testSource = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { product } from '../src/product.mjs';",
  "test('product remains valid', () => {",
  "  const actual = product();",
  "  assert.equal(actual, 'ok');",
  "});",
  ''
].join('\n');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-unverified-crosscase-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, productPath), product);
  await writeFile(join(root, testPath), testSource);
  const workspace = new ReadonlyWorkspace(root);
  const targetDigest = (await workspace.read(testPath)).digest;
  return { root, workspace, target: {
    cwd: '.', request: { command: 'node', args: ['--test', testPath], cwd: '.' },
    targetPath: testPath, targetDigest, assertionLine: 6
  } };
}

async function candidateRun({ root, targetPath, attempts, mode }) {
  return async ({ cwd }) => {
    attempts.count++;
    const target = await readFile(join(root, cwd, targetPath), 'utf8');
    const marker = target.match(/DDA_ASSERT_[a-f0-9]{32}=/u)?.[0];
    assert.ok(marker);
    const incomplete = mode === 'always-unverified' || (mode === 'retry-then-pass' && attempts.count === 1);
    return {
      ok: true,
      exitCode: 0,
      truncated: incomplete,
      stdout: marker + JSON.stringify({ passed: true, operands: ['ok', 'ok'] }) + '\n'
    };
  };
}

test('assertion receipt retries once and only the final pass can authorize a candidate', async t => {
  const { root, workspace, target } = await fixture(t);
  const attempts = { count: 0 };
  const result = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: productPath, content: product
  }, await candidateRun({ root, targetPath: testPath, attempts, mode: 'retry-then-pass' }), undefined,
  { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts.count, 2);
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.retest, { attempts: 2, initialStatus: 'unverified', finalStatus: 'passed', resolved: true });
  assert.equal(await readFile(join(root, productPath), 'utf8'), product);
});

test('record and file-type preservation uncertainty remains blocked after one retry', async t => {
  const cases = [
    ['records', { kind: 'records' }],
    ['file-types', { fileTypes: [{ key: 'primary', from: 'file', to: 'symlink', distinguished: true }] }]
  ];
  for (const [name, preservation] of cases) {
    await test.test(name, async inner => {
      const { root, workspace, target } = await fixture(inner);
      target.baseline = { preservation: {
        status: 'observed', site: { path: productPath, line: 1, field: 'product' },
        key: 'primary', otherKey: 'secondary', branch: { field: 'kind', literal: 'non-null' },
        aggregateConstant: true, checks: { additional: true, relocated: true }, ...preservation
      } };
      const attempts = { count: 0 };
      const result = await new RepairRetest(workspace).checkCandidate(target, {
        workspace, path: productPath, content: product
      }, await candidateRun({ root, targetPath: testPath, attempts, mode: 'always-unverified' }), undefined,
      { retryUnverified: true, retryLimit: 1 });
      assert.equal(attempts.count, 2);
      assert.equal(result.status, 'unverified');
      assert.deepEqual(result.retest, { attempts: 2, initialStatus: 'unverified', finalStatus: 'unverified', resolved: false });
      assert.equal(await readFile(join(root, productPath), 'utf8'), product);
    });
  }
});

test('a hard assertion rejection is not retried across verifier categories', async t => {
  const { root, workspace, target } = await fixture(t);
  const attempts = { count: 0 };
  const result = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: productPath, content: product
  }, async ({ cwd }) => {
    attempts.count++;
    const source = await readFile(join(root, cwd, testPath), 'utf8');
    const marker = source.match(/DDA_ASSERT_[a-f0-9]{32}=/u)?.[0];
    assert.ok(marker);
    return { ok: false, exitCode: 1, truncated: false,
      stdout: marker + JSON.stringify({ passed: false, operands: ['wrong', 'ok'] }) + '\n' };
  }, undefined, { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts.count, 1);
  assert.equal(result.status, 'rejected');
  assert.equal(result.retest, undefined);
  assert.equal(await readFile(join(root, productPath), 'utf8'), product);
});
