import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadArkTS } from './sdk-host.mjs';

const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
const { parseProjectCommand, runProjectCommand } = loadArkTS('services/LocalCommandExecutor');

test('manual input preserves quoted project paths and rejects shell composition', () => {
  assert.deepEqual(parseProjectCommand('  git hash-object "/My Notes/中.txt"  '),
    { command: 'git', args: ['hash-object', '/My Notes/中.txt'] });
  assert.deepEqual(parseProjectCommand("wc -l 'my note.txt'"), { command: 'wc', args: ['-l', 'my note.txt'] });
  for (const line of ['cat "/open', 'cat ""', 'ls | wc', 'pwd && ls', 'cat x;ls', 'cat `foo`',
    'cat "$(pwd)"', 'pwd\nls', 'cat /../etc/f']) { assert.throws(() => parseProjectCommand(line)); }
});

test('git hash-object returns the same unfiltered text blob ID as Windows Git', async t => {
  const filesDir = await mkdtemp(join(tmpdir(), 'dda-blob-'));
  t.after(() => rm(filesDir, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir });
  await workspace.initialize();
  for (const [name, text] of [['empty.txt', ''], ['unicode.txt', '\uFEFF中文🙂\r\nnext\n']]) {
    await workspace.createFile('/' + name, text);
    const { stdout } = await promisify(execFile)('git', ['-c', 'core.autocrlf=false', 'hash-object', name],
      { cwd: join(filesDir, 'workspace') });
    assert.deepEqual(await runProjectCommand(workspace, 'git', ['hash-object', name]), {
      exitCode: 0, stdout: stdout.trim() + '\n', stderr: '', truncated: false
    });
  }
  assert.equal((await runProjectCommand(workspace, 'git', ['status'])).exitCode, 2);
  assert.equal((await runProjectCommand(workspace, 'git', ['hash-object', '-w'])).exitCode, 2);
});

test('project commands inspect the current project and return real exit status', async t => {
  const filesDir = await mkdtemp(join(tmpdir(), 'dda-commands-'));
  t.after(() => rm(filesDir, { recursive: true, force: true }));
  const workspace = new LocalWorkspace({ filesDir }, 'p-1');
  await workspace.initialize();
  await workspace.createFile('/docs/中.txt', '甲 beta\n乙');
  await workspace.createFile('/settings.json', '{"name":1}');
  const run = (command, ...args) => runProjectCommand(workspace, command, args);
  assert.equal((await run('pwd')).stdout, '/\n');
  assert.equal((await run('ls')).stdout, 'docs/\nsettings.json\n');
  assert.equal((await run('ls', './docs')).stdout, '中.txt\n');
  assert.equal((await run('cat', 'docs/中.txt')).stdout, '甲 beta\n乙');
  assert.equal((await run('wc', '/docs/中.txt')).stdout, '1 3 12 /docs/中.txt\n');
  assert.equal((await run('wc', '-c', '/docs/中.txt')).stdout, '12 /docs/中.txt\n');
  assert.equal((await run('check-json', '/settings.json')).exitCode, 0);
  assert.equal((await run('check-json', '/docs/中.txt')).exitCode, 1);
  await workspace.createFile('/script.js', 'throw new Error("must never run");\n');
  await workspace.createFile('/bad.js', 'const broken = ;\n');
  assert.equal((await run('check-js', '/script.js')).exitCode, 0);
  const invalidScript = await run('check-js', '/bad.js');
  assert.equal(invalidScript.exitCode, 1);
  assert.equal(invalidScript.stdout, '');
  assert.match(invalidScript.stderr, /\/bad\.js:1:\d+/);
  assert.equal((await run('cat', '/missing.txt')).exitCode, 1);
  const other = new LocalWorkspace({ filesDir }, 'p-2');
  await other.initialize();
  assert.equal((await runProjectCommand(other, 'cat', ['/settings.json'])).exitCode, 1);
  const prefix = 'a'.repeat(16383);
  await workspace.createFile('/long.txt', prefix + '🙂tail');
  assert.deepEqual(await run('cat', '/long.txt'), { exitCode: 0, stdout: prefix, stderr: '', truncated: true });
});

test('unavailable files and unsupported command forms cannot access host resources', async () => {
  let reads = 0;
  const denied = { read() { reads++; throw Object.assign(new Error('private device path'), { code: 13900013 }); } };
  const failure = await runProjectCommand(denied, 'cat', ['/protected']);
  assert.equal(failure.exitCode, 1);
  assert.match(failure.stderr, /没有读取权限/);
  assert.doesNotMatch(failure.stderr, /private device path/);
  for (const [cmd, argv] of [['sh', ['-c', 'pwd']], ['pwd;ls', []], ['cat', ['/../x']],
    ['cat', ['file:///outside']], ['cat', ['C:\\external']], ['cat', ['/x; pwd']], ['cat', ['/x|wc']],
    ['ls', ['/x', '&&']], ['wc', ['-x', '/x']], ['pwd', ['/x']], ['cat', [42]],
    ['cat', ['/.pending-stage']], ['cat', ['/x\ny']]]) {
    const result = await runProjectCommand(denied, cmd, argv);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, '');
  }
  assert.equal(reads, 1);
});
