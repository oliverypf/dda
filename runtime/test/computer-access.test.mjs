import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAccessMode, computerAccessInternals } from '../src/computer-access.mjs';

const FILE = 'computer-access.json';
const valid = (mode, updatedAtMs = 10) => JSON.stringify({ version: 1, scope: 'USER_FILESYSTEM', mode, updatedAtMs });

const dir = async (t) => {
  const d = await mkdtemp(join(tmpdir(), 'computer-access-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return join(d, FILE);
};

test('missing file => REQUIRE_APPROVAL', async (t) => {
  assert.equal(await readAccessMode({ policyPath: await dir(t) }), 'REQUIRE_APPROVAL');
});

test('corrupt, wrong version/scope/mode and unknown keys => REQUIRE_APPROVAL', async (t) => {
  const file = await dir(t);
  const cases = [
    'not-json',
    '{}',
    '{"version":9,"scope":"USER_FILESYSTEM","mode":"FULL_ACCESS","updatedAtMs":1}',
    '{"version":1,"scope":"MACHINE","mode":"FULL_ACCESS","updatedAtMs":1}',
    '{"version":1,"scope":"USER_FILESYSTEM","mode":"FULL_ACCESS","updatedAtMs":1,"extra":true}',
    '{"version":1,"scope":"USER_FILESYSTEM","mode":"BANANA","updatedAtMs":1}',
    '{"version":1,"scope":"USER_FILESYSTEM","mode":"FULL_ACCESS","updatedAtMs":"1"}',
    '[]',
    'null'
  ];
  for (const body of cases) {
    await writeFile(file, body);
    assert.equal(await readAccessMode({ policyPath: file }), 'REQUIRE_APPROVAL', body);
  }
});

test('valid FULL_ACCESS and REQUIRE_APPROVAL persist; re-reads see revocation', async (t) => {
  const file = await dir(t);
  await writeFile(file, valid('FULL_ACCESS', 42));
  assert.equal(await readAccessMode({ policyPath: file }), 'FULL_ACCESS');
  await writeFile(file, valid('REQUIRE_APPROVAL', 43));
  assert.equal(await readAccessMode({ policyPath: file }), 'REQUIRE_APPROVAL');
});

test('oversized and symlinked policy files => REQUIRE_APPROVAL', async (t) => {
  const file = await dir(t);
  await writeFile(file, 'x'.repeat(65 * 1024));
  assert.equal(await readAccessMode({ policyPath: file }), 'REQUIRE_APPROVAL');
  const real = join(file, '..', 'real.json');
  const link = join(file, '..', 'link.json');
  await writeFile(real, valid('FULL_ACCESS'));
  let linked = true;
  try {
    await symlink(real, link);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    linked = false;
  }
  if (linked) assert.equal(await readAccessMode({ policyPath: link }), 'REQUIRE_APPROVAL');
});

test('read failure via injected deps => REQUIRE_APPROVAL', async () => {
  assert.equal(await readAccessMode({ policyPath: 'x', readFileImpl: async () => { throw new Error('EACCES'); } }), 'REQUIRE_APPROVAL');
  let reads2 = 0;
  const lstatOk2 = async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 1 });
  assert.equal(await readAccessMode({ policyPath: 'x', lstatImpl: lstatOk2, readFileImpl: async () => { reads2 += 1; throw new Error('EIO'); } }), 'REQUIRE_APPROVAL');
  assert.equal(reads2, 1);
});

test('configDir comes from platform paths (LOCALAPPDATA / XDG)', () => {
  const cfg = computerAccessInternals.configDir({ LOCALAPPDATA: 'C:/LocalApp' });
  assert.equal(cfg, join('C:/LocalApp', 'hmCodex'));
  const xdg = computerAccessInternals.configDir({ DDA_PLATFORM: 'linux-cli', XDG_CONFIG_HOME: '/tmp/xdg' });
  assert.equal(xdg, join('/tmp/xdg', 'hmcodex'));
});
