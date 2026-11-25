import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const releaseRoot = process.env.DDA_LINKS_RELEASE;
const records = process.env.DDA_LINKS_RECORDS;
const names = ['index', 'FETCH_HEAD'];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const nativeLstat = fs.lstat;

async function git(root, args) {
  await run('git', args, { cwd: root, windowsHide: true, timeout: 15000, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0'
  } });
}

async function linkMode(root) {
  const target = join(root, 'permission-target');
  const link = join(root, 'permission-link');
  await fs.writeFile(target, 'fixture');
  try {
    await fs.symlink('permission-target', link, 'file');
    assert.equal((await nativeLstat(link)).isSymbolicLink(), true);
    return { kind: 'native-file-symlinks' };
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    return { kind: 'synthetic-lstat', nativeError: error.code };
  }
}

async function scenario(name, endLinks) {
  const root = await fs.mkdtemp(join(tmpdir(), 'dda-link-scenario-'));
  const repo = join(root, 'repo');
  const gitDir = join(repo, '.git');
  const originals = join(gitDir, 'grade-fixtures');
  const record = { name };
  try {
    record.mode = await linkMode(root);
    await fs.mkdir(repo);
    await git(repo, ['init', '-q']);
    await fs.writeFile(join(repo, 'fixture.txt'), 'tracked\n');
    await git(repo, ['add', 'fixture.txt']);
    await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
    await fs.writeFile(join(gitDir, 'FETCH_HEAD'), '');
    await fs.mkdir(originals);
    for (const key of names) await fs.copyFile(join(gitDir, key), join(originals, key));

    // Native fixtures only point to the identical bytes inside this temporary repository.
    // Without link privileges, only lstat's entry type is supplied by the fixture.
    // Real Git commands, repository data, snapshot code and public return values stay live.
    const representedLinks = new Set();
    if (record.mode.kind === 'synthetic-lstat') {
      fs.lstat = async function (path, ...options) {
        const info = await nativeLstat(path, ...options);
        if (typeof path !== 'string' || !representedLinks.has(resolve(path))) return info;
        const result = Object.create(info);
        Object.defineProperty(result, 'mode', { value: (info.mode & 0o7777) | 0o120000 });
        return result;
      };
      syncBuiltinESMExports();
    }
    const { createGitObserver } = await import(pathToFileURL(join(releaseRoot, 'runtime/src/git-observer.mjs')));
    const observer = createGitObserver({ workspaceRoot: repo });
    async function setLinks(selected) {
      for (const key of names) {
        const path = join(gitDir, key);
        const wantLink = selected.includes(key);
        if (record.mode.kind === 'native-file-symlinks') {
          const actual = (await nativeLstat(path)).isSymbolicLink();
          if (wantLink !== actual) {
            await fs.unlink(path);
            if (wantLink) await fs.symlink(relative(gitDir, join(originals, key)), path, 'file');
            else await fs.copyFile(join(originals, key), path);
          }
        } else if (wantLink) representedLinks.add(path);
        else representedLinks.delete(path);
        assert.equal((await fs.lstat(path)).isSymbolicLink(), wantLink);
        assert.deepEqual(await fs.readFile(path), await fs.readFile(join(originals, key)));
      }
    }
    async function snapshot() {
      const s = await observer.snapshot({ reason: 'ACTION_STARTED', now: 1 });
      const links = [];
      const fileDigests = {};
      for (const key of names) {
        const path = join(gitDir, key);
        if ((await fs.lstat(path)).isSymbolicLink()) links.push(key);
        fileDigests[key] = hash(await fs.readFile(path));
      }
      return { links, fileDigests, available: s.available, metadataLinkDetected: s.metadataLinkDetected,
        metadataDigest: s.metadataDigest, headDigest: s.headDigest, indexDigest: s.indexDigest };
    }
    await setLinks(['index']);
    record.before = await snapshot();
    record.control = await snapshot();
    await setLinks(endLinks);
    record.after = await snapshot();
    const { before, control, after } = record;
    assert.deepEqual(control, before, 'same link layout must have a reproducible observation');
    assert.deepEqual(before.fileDigests, after.fileDigests);
    assert.deepEqual(before.links, ['index']);
    assert.deepEqual(after.links, endLinks);
    const rows = [before, control, after];
    const checks = {
      available: rows.every(s => s.available === true),
      linksDetectedBothTimes: rows.every(s => s.metadataLinkDetected === true),
      unchangedHead: typeof before.headDigest === 'string' && before.headDigest === after.headDigest,
      unchangedStaging: typeof before.indexDigest === 'string' && before.indexDigest === after.indexDigest,
      metadataFingerprintsDiffer: rows.every(s => typeof s.metadataDigest === 'string') && before.metadataDigest !== after.metadataDigest
    };
    record.checks = checks;
    record.status = Object.values(checks).every(Boolean) ? 'passed' : 'failed';
    assert.equal(record.status, 'passed', JSON.stringify(checks));
  } catch (error) {
    if (!record.status) record.status = 'error';
    record.message = error.message;
    throw error;
  } finally {
    fs.lstat = nativeLstat;
    syncBuiltinESMExports();
    await fs.writeFile(join(records, name + '.json'), JSON.stringify(record));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (releaseRoot && records) {
  test('additional_link_with_existing_link', () => scenario('additional_link_with_existing_link', ['index', 'FETCH_HEAD']));
  test('move_link_between_metadata_paths', () => scenario('move_link_between_metadata_paths', ['FETCH_HEAD']));
}
