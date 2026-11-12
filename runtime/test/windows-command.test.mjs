import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWindowsProcessCommand } from '../src/platform/windows-command.mjs';
import { spawnErrorReason } from '../src/platform/process-error.mjs';

// Fake provisioned Node with a space in the path: only regular files are
// created; no command is ever executed by these tests.
const fakeNode = async ({ npmCli = true, npxCli = true, npmCliIsDir = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), 'Node With Spaces '));
  const execDir = join(root, 'bin');
  await mkdir(join(execDir, 'node_modules', 'npm', 'bin'), { recursive: true });
  const execPath = join(execDir, 'node.exe');
  await writeFile(execPath, 'not-a-real-binary');
  const cliDir = join(execDir, 'node_modules', 'npm', 'bin');
  if (npmCliIsDir) await mkdir(join(cliDir, 'npm-cli.js'));
  else if (npmCli) await writeFile(join(cliDir, 'npm-cli.js'), '// fake\n');
  if (npxCli) await writeFile(join(cliDir, 'npx-cli.js'), '// fake\n');
  return {
    root,
    execPath,
    npmCli: join(cliDir, 'npm-cli.js'),
    npxCli: join(cliDir, 'npx-cli.js'),
    cleanup: () => rm(root, { recursive: true, force: true })
  };
};

test('maps bare npm/npx spellings to the provisioned Node CLI', async () => {
  const fake = await fakeNode();
  try {
    const args = ['run', 'build', '--', 'a & b', '$(not-executed)', 'a"b', '100%'];
    for (const [command, cli] of [['npm', fake.npmCli], ['npm.cmd', fake.npmCli], ['NPM.CMD', fake.npmCli], ['npx', fake.npxCli], ['npx.cmd', fake.npxCli]]) {
      const resolved = await resolveWindowsProcessCommand({ command, args }, { platform: 'win32', execPath: fake.execPath });
      assert.equal(resolved.command, fake.execPath, command);
      assert.equal(resolved.args[0], cli, command);
      assert.deepEqual(resolved.args.slice(1), args, command);
      assert.notEqual(resolved.args, args);
    }
    assert.deepEqual(args, ['run', 'build', '--', 'a & b', '$(not-executed)', 'a"b', '100%']);
  } finally {
    await fake.cleanup();
  }
});

test('does not map on non-Windows or for non-bare commands', async () => {
  const fake = await fakeNode();
  try {
    for (const command of ['npm', 'npm.cmd', 'npx', 'npx.cmd']) {
      const resolved = await resolveWindowsProcessCommand({ command, args: ['--version'] }, { platform: 'linux', execPath: fake.execPath });
      assert.deepEqual(resolved, { command, args: ['--version'] });
    }
    for (const command of ['C:\\tools\\npm.cmd', './npm.cmd', 'dir\\npm.cmd', 'npm.ps1', 'npm.exe', 'npmx', 'cargo', 'node']) {
      const resolved = await resolveWindowsProcessCommand({ command, args: ['--version'] }, { platform: 'win32', execPath: fake.execPath });
      assert.deepEqual(resolved, { command, args: ['--version'] }, command);
    }
  } finally {
    await fake.cleanup();
  }
});

test('throws EXECUTOR_NODE_CLI_UNAVAILABLE without paths when the CLI is missing', async () => {
  const fake = await fakeNode({ npmCli: false, npxCli: false });
  try {
    for (const command of ['npm', 'npx']) {
      await assert.rejects(
        resolveWindowsProcessCommand({ command, args: [] }, { platform: 'win32', execPath: fake.execPath }),
        (error) => {
          assert.equal(error.code, 'EXECUTOR_NODE_CLI_UNAVAILABLE');
          assert.ok(error.message.includes(command));
          assert.equal(error.message.includes(fake.execPath), false);
          assert.equal(error.message.includes('node_modules'), false);
          return true;
        }
      );
    }
  } finally {
    await fake.cleanup();
  }
});

test('rejects a CLI path that exists but is not a regular file', async () => {
  const fake = await fakeNode({ npmCliIsDir: true });
  try {
    await assert.rejects(
      resolveWindowsProcessCommand({ command: 'npm', args: [] }, { platform: 'win32', execPath: fake.execPath }),
      { code: 'EXECUTOR_NODE_CLI_UNAVAILABLE' }
    );
  } finally {
    await fake.cleanup();
  }
});

test('spawnErrorReason exposes only a bounded OS error code', () => {
  assert.equal(spawnErrorReason({ code: 'EINVAL', message: 'spawn C:\\secret\\dir EINVAL' }), 'EINVAL');
  assert.equal(spawnErrorReason({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(spawnErrorReason({ code: 'enoent' }), 'UNKNOWN');
  assert.equal(spawnErrorReason({ code: 'relative/path' }), 'UNKNOWN');
  assert.equal(spawnErrorReason({ code: 'X'.repeat(64) }), 'UNKNOWN');
  assert.equal(spawnErrorReason(new Error('spawn failed with secret arg --token=abc')), 'UNKNOWN');
  assert.equal(spawnErrorReason(undefined), 'UNKNOWN');
});
