import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChildEnv, buildRuntimeEnv } from '../src/platform/environment-policy.mjs';
import { LinuxPosixExecutor } from '../src/platform/executor.mjs';
import { createPlatformPaths } from '../src/platform/paths.mjs';
import { detectCliHost, policyChannelForRelease, resolvePlatformIdentity } from '../src/platform/platform-identity.mjs';
import { createProcessSupervisor, reclaimRecordedProcesses } from '../src/platform/process-supervisor.mjs';

test('Windows store layout stays under hmCodex unless the Linux platform is selected', () => {
  const windows = createPlatformPaths({
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    HMCODEX_DATA_DIR: 'D:\\data'
  });
  assert.equal(windows.platform, 'windows-desktop');
  assert.equal(windows.resolveStore('threads.json'), 'D:\\data\\hmCodex\\threads.json');
  assert.equal(windows.modelConfigPath(), 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\model-config.json');

  const linux = createPlatformPaths({
    HMCODEX_PLATFORM: 'linux-cli',
    HOME: '/home/tester',
    HMCODEX_DATA_DIR: '/srv/dda'
  });
  assert.equal(linux.dataDir(), '/srv/dda');
  assert.equal(linux.resolveStore('threads.json'), '/srv/dda/threads.json');
  assert.equal(linux.resolveStore('hmcodex.db'), '/srv/dda/hmcodex.db');
  assert.equal(linux.modelConfigPath(), '/home/tester/.config/hmcodex/model-config.json');
  assert.equal(linux.logDir(), '/home/tester/.local/state/hmcodex/logs');
});

test('explicit XDG and config paths outrank defaults', () => {
  const paths = createPlatformPaths({
    HMCODEX_PLATFORM: 'linux-cli',
    HOME: '/home/tester',
    XDG_CONFIG_HOME: '/xdg/config',
    XDG_DATA_HOME: '/xdg/data',
    XDG_STATE_HOME: '/xdg/state',
    XDG_CACHE_HOME: '/xdg/cache',
    HMCODEX_MODEL_CONFIG: '/explicit/model-config.json'
  });
  assert.equal(paths.configDir(), '/xdg/config/hmcodex');
  assert.equal(paths.dataDir(), '/xdg/data/hmcodex');
  assert.equal(paths.stateDir(), '/xdg/state/hmcodex');
  assert.equal(paths.cacheDir(), '/xdg/cache/hmcodex');
  assert.equal(paths.modelConfigPath(), '/explicit/model-config.json');
});

test('runtime environment keeps provider keys only when named and drops other secrets', () => {
  const env = buildRuntimeEnv({
    PATH: '/usr/bin',
    HOME: '/home/tester',
    DISPLAY: ':0',
    AWS_SECRET_ACCESS_KEY: 'nope',
    OPENCODE_GO_API_KEY: 'secret-value',
    HMCODEX_DATA_DIR: '/data',
    HMCODEX_API_KEY: 'hidden'
  }, { extraKeys: ['OPENCODE_GO_API_KEY'] });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HMCODEX_DATA_DIR, '/data');
  assert.equal(env.OPENCODE_GO_API_KEY, 'secret-value');
  assert.equal(env.DISPLAY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.HMCODEX_API_KEY, undefined);
  assert.throws(() => buildChildEnv({ API_TOKEN: 'x' }), /CHILD_ENV_INVALID/);
  assert.deepEqual(buildChildEnv({ LANG: 'C' }), { LANG: 'C' });
});

test('windows and HarmonyOS CLI hosts keep their own data roots', () => {
  const windows = createPlatformPaths({
    HMCODEX_PLATFORM: 'windows-cli',
    USERPROFILE: 'C:\\Users\\tester'
  });
  assert.equal(windows.platform, 'windows-cli');
  assert.equal(windows.dataDir(), 'C:\\Users\\tester\\AppData\\Local\\hmCodex');
  assert.equal(windows.configDir(), 'C:\\Users\\tester\\AppData\\Local\\hmCodex');
  assert.equal(windows.modelConfigPath(), 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\model-config.json');
  assert.equal(windows.resolveStore('threads.json'), 'C:\\Users\\tester\\AppData\\Local\\hmCodex\\threads.json');

  const shared = createPlatformPaths({
    HMCODEX_PLATFORM: 'windows-cli',
    LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
    HMCODEX_DATA_DIR: 'D:\\data'
  });
  assert.equal(shared.resolveStore('threads.json'), 'D:\\data\\hmCodex\\threads.json');

  const harmony = createPlatformPaths({
    HMCODEX_PLATFORM: 'harmonyos-cli',
    HOME: '/home/tester',
    HMCODEX_DATA_DIR: '/srv/dda'
  });
  assert.equal(harmony.platform, 'harmonyos-cli');
  assert.equal(harmony.dataDir(), '/srv/dda');
  assert.equal(harmony.modelConfigPath(), '/home/tester/.config/hmcodex/model-config.json');
  assert.equal(resolvePlatformIdentity({ HMCODEX_PLATFORM: 'harmonyos-cli' }).executor, 'harmonyos-posix');
  assert.equal(resolvePlatformIdentity({ HMCODEX_PLATFORM: 'windows-cli' }).executor, 'restricted-windows');
});

test('CLI host detection follows Windows, Linux, and HarmonyOS markers', () => {
  assert.equal(detectCliHost({ env: {}, platform: 'win32', release: '10.0.22631' }), 'windows-cli');
  assert.equal(detectCliHost({ env: {}, platform: 'linux', release: '6.8.0-generic' }), 'linux-cli');
  assert.equal(detectCliHost({
    env: {},
    platform: 'linux',
    release: '5.10.97-ohos'
  }), 'harmonyos-cli');
  assert.equal(detectCliHost({
    env: { OHOS_SDK_HOME: '/opt/ohos' },
    platform: 'linux',
    release: '6.8.0'
  }), 'harmonyos-cli');
  assert.equal(detectCliHost({
    env: { HMCODEX_PLATFORM: 'linux-cli' },
    platform: 'win32',
    release: 'OpenHarmony 5.0'
  }), 'linux-cli');
  assert.equal(detectCliHost({ env: { HMCODEX_PLATFORM: 'windows-desktop' }, platform: 'linux' }), 'windows-desktop');
});

test('platform identity stays windows-desktop until linux-cli is requested', () => {
  assert.equal(resolvePlatformIdentity({}).platform, 'windows-desktop');
  assert.equal(resolvePlatformIdentity({ HMCODEX_PLATFORM: 'linux-cli', HMCODEX_RELEASE_CHANNEL: 'LINUX_CLI_READ_ONLY' }).executor, 'linux-posix');
  assert.equal(policyChannelForRelease('LINUX_CLI_CONTROLLED'), 'CONTROLLED');
  assert.equal(policyChannelForRelease('WINDOWS_PHASE1_READ_ONLY'), 'READ_ONLY');
});

test('Linux executor rejects shell interpretation before any process starts', async () => {
  const executor = new LinuxPosixExecutor({ workspaceRoot: tmpdir() });
  await assert.rejects(
    () => executor.execute('shell', { shell: true, command: 'echo', args: ['hi'] }, {}),
    /SHELL_INTERPRETED_DENIED/
  );
});

test('process supervisor terminates the child process group', async () => {
  const supervisor = createProcessSupervisor();
  const record = supervisor.spawn({
    executable: process.execPath,
    argv: ['-e', 'setInterval(() => {}, 1000)'],
    marker: 'setInterval'
  });
  assert.equal(typeof record.pid, 'number');
  await supervisor.terminateGroup(record.processId, 300);
  assert.notEqual(record.child.exitCode ?? record.child.signalCode, null);
  assert.throws(() => process.kill(record.pid, 0));
});

test('reclaim only signals a recorded pid whose command line contains the marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-reclaim-'));
  const registryPath = join(directory, 'processes.json');
  const marker = `hmcodex-reclaim-${process.pid}`;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], { detached: true, stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  await writeFile(registryPath, JSON.stringify({
    schemaVersion: '1.0',
    processes: [{ pid: child.pid, pgid: child.pid, startedAtMs: Date.now(), marker, processId: 'reclaim-test' }]
  }));
  try {
    const result = await reclaimRecordedProcesses(registryPath, { graceMs: 200 });
    assert.deepEqual(result.reclaimed.map((item) => item.pid), [child.pid]);
    await exited;
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
