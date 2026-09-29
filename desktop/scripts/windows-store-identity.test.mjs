import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aliasPathFor, describeStorePath, packageLocalCacheTwins } from './windows-store-identity.mjs';

const makeLayout = async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-store-identity-'));
  const profileRoot = join(root, 'hmcodex');
  await mkdir(profileRoot, { recursive: true });
  return { root, profileRoot, localAppData: root };
};

test('a real profile file lists the package copy as a different physical file', async () => {
  const { profileRoot, localAppData } = await makeLayout();
  const requested = join(profileRoot, 'hmcodex.db');
  await writeFile(requested, 'real-profile-store', 'utf8');
  const twin = join(localAppData, 'Packages', 'Example.App_123', 'LocalCache', 'Local', 'hmcodex', 'hmcodex.db');
  await mkdir(join(twin, '..'), { recursive: true });
  await writeFile(twin, 'package-local-copy-store-longer', 'utf8');

  const described = describeStorePath(requested, { localAppData, aliasRoot: null });
  assert.equal(described.exists, true);
  assert.equal(described.redirection, undefined);
  assert.equal(described.packageLocalCacheCopies.length, 1);
  assert.equal(described.packageLocalCacheCopies[0].packageFamily, 'Example.App_123');
  assert.equal(described.packageLocalCacheCopies[0].sizeBytes, 'package-local-copy-store-longer'.length);
});

test('the same inode identifies a store read through the package local cache', async () => {
  const { profileRoot, localAppData } = await makeLayout();
  const requested = join(profileRoot, 'hmcodex.db');
  await writeFile(requested, 'shared-physical-store', 'utf8');
  const twin = join(localAppData, 'Packages', 'Example.App_123', 'LocalCache', 'Local', 'hmcodex', 'hmcodex.db');
  await mkdir(join(twin, '..'), { recursive: true });
  await link(requested, twin);

  const described = describeStorePath(requested, { localAppData, aliasRoot: null });
  assert.equal(described.redirection?.kind, 'MSIX_PACKAGE_LOCAL_CACHE');
  assert.equal(described.redirection.packageFamily, 'Example.App_123');
  assert.equal(described.redirection.localCachePath, twin);
  assert.deepEqual(described.packageLocalCacheCopies, []);
});

test('the unredacted profile alias is reported only when it is another file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-store-alias-'));
  const aliasRoot = join(root, 'localhost-c');
  const aliasPath = join(aliasRoot, 'Users', 'Nobody', 'AppData', 'Local', 'hmCodex', 'hmcodex.db');
  await mkdir(join(aliasPath, '..'), { recursive: true });
  await writeFile(aliasPath, 'host-profile-store', 'utf8');

  assert.equal(
    aliasPathFor('C:\\Users\\Nobody\\AppData\\Local\\hmCodex\\hmcodex.db'),
    '\\\\localhost\\C$\\Users\\Nobody\\AppData\\Local\\hmCodex\\hmcodex.db'
  );
  const described = describeStorePath('C:\\Users\\Nobody\\AppData\\Local\\hmCodex\\hmcodex.db', { aliasRoot });
  assert.equal(described.exists, false);
  assert.equal(described.unredactedProfileAlias.path, aliasPath);
  assert.equal(described.unredactedProfileAlias.sizeBytes, 'host-profile-store'.length);
  assert.equal(await readFile(aliasPath, 'utf8'), 'host-profile-store');

  const withoutAlias = describeStorePath('C:\\Users\\Nobody\\AppData\\Local\\hmCodex\\hmcodex.db', { aliasRoot: null });
  assert.equal(withoutAlias.unredactedProfileAlias, undefined);
  assert.deepEqual(describeStorePath(undefined), { requestedPath: null, exists: false });
});

test('paths outside the profile root have no package twins', () => {
  assert.deepEqual(packageLocalCacheTwins('C:\\work\\hmcodex.db', { localAppData: 'C:\\Users\\User\\AppData\\Local' }), []);
  const rootTwins = packageLocalCacheTwins('C:\\Users\\User\\AppData\\Local\\hmcodex.db', { localAppData: 'C:\\Users\\User\\AppData\\Local' });
  assert.ok(rootTwins.length > 0);
  assert.ok(rootTwins.every((twin) => twin.path.includes('LocalCache')));
});


