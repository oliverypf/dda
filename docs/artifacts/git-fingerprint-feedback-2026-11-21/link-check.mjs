// Run with Node 24 and --experimental-vm-modules. Reads the four saved source
// trees, adds an export in memory, and supplies synthetic Git and filesystem
// responses. No workspace or repository is created or modified by the check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const base = process.argv[2] ?? fileURLToPath(new URL('../../../.codex-tmp/fp-feedback-live-20261121/', import.meta.url));
const fixtures = [
  ['seed', true, true],
  ['dda-1/work', false, false],
  ['dda-2/work', true, true],
  ['dda-3/work', false, false]
];

async function inspect(source) {
  const files = new Map();
  const fs = {
    realpath: async file => file,
    readdir: async () => files.has('hook-a') ? ['hook-a'] : [],
    readFile: async () => Buffer.from('fixed content'),
    lstat: async file => {
      const type = files.get(path.basename(file));
      if (!type) throw new Error('ENOENT');
      return { isFile: () => type === 'file', isSymbolicLink: () => type === 'link',
        isDirectory: () => false, size: 13, mode: 0o644, mtimeMs: 5 };
    }
  };
  fs.stat = fs.lstat;
  function spawn(_command, args) {
    assert.deepEqual([...args], ['--no-optional-locks', 'rev-parse', '--git-dir']);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('.git\n'));
      child.emit('close', 0, null);
    });
    return child;
  }
  const bindings = { 'node:fs/promises': fs, 'node:crypto': { createHash },
    'node:child_process': { spawn }, 'node:path': path };
  const context = vm.createContext({ Buffer, URL, setTimeout, clearTimeout, process: { platform: process.platform, env: {} } });
  const mod = new vm.SourceTextModule(source + '\nexport { readGitMetadata as __check };', { context });
  await mod.link(async id => {
    const exports = bindings[id];
    assert.ok(exports, 'Unexpected import ' + id);
    const names = Object.keys(exports);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, exports[name]);
    }, { context });
  });
  await mod.evaluate({ timeout: 2000 });
  const observe = () => mod.namespace.__check(path.resolve('synthetic-workspace'), 1000);
  const changed = (a, b) => a.metadataDigest !== b.metadataDigest || a.metadataLinkDetected !== b.metadataLinkDetected;

  const absent = await observe();
  files.set('FETCH_HEAD', 'link');
  const single = await observe();
  files.clear();
  files.set('hook-a', 'link');
  const one = await observe();
  files.set('FETCH_HEAD', 'link');
  const two = await observe();
  files.delete('FETCH_HEAD');
  files.set('index', 'link');
  const moved = await observe();
  return { singleLink: !absent.metadataLinkDetected && single.metadataLinkDetected,
    additionalLink: changed(one, two), changedLinkPath: changed(two, moved) };
}

for (const [name, additionalLink, changedLinkPath] of fixtures) {
  const source = await readFile(path.join(base, name, 'runtime/src/git-observer.mjs'));
  const actual = await inspect(source.toString('utf8'));
  console.log(JSON.stringify({ name, sourceSha256: createHash('sha256').update(source).digest('hex'), ...actual }));
  assert.deepEqual(actual, { singleLink: true, additionalLink, changedLinkPath });
}
