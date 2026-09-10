import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = fileURLToPath(new URL('.', import.meta.url));
const runtimeRoot = join(scriptRoot, '..', '..', 'runtime');
const srcTauriRoot = join(scriptRoot, '..', 'src-tauri');
const executable = join(srcTauriRoot, 'binaries', 'openviking-server-x86_64-pc-windows-msvc.exe');

const freePort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once('error', rejectPort);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const ready = async (url) => {
  try {
    const response = await fetch(`${url}/ready`);
    const body = await response.json();
    return response.ok && body?.status === 'ok' && body?.result?.ready === true;
  } catch {
    return false;
  }
};

const waitReady = async (url, deadlineMs = 15_000) => {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await ready(url)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
};

const listeningPid = (port) => {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length >= 5 && fields[1] === `127.0.0.1:${port}` && fields[3] === 'LISTENING') {
      return Number(fields[4]);
    }
  }
  return undefined;
};

const killTree = (pid) => {
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
};

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(scriptPathDataRoot(), 'hmcodex-openviking-supervisor-'));
const supervisor = spawn(process.execPath, [join(runtimeRoot, 'src', 'openviking-sidecar-supervisor.mjs')], {
  env: {
    ...process.env,
    HMCODEX_OPENVIKING_EXECUTABLE: executable,
    HMCODEX_OPENVIKING_URL: url,
    HMCODEX_OPENVIKING_DATA_DIR: dataDir,
    HMCODEX_OPENVIKING_API_KEY: 'supervisor-e2e-key',
    HMCODEX_OPENVIKING_START_TIMEOUT_MS: '10000',
    HMCODEX_OPENVIKING_HEALTH_INTERVAL_MS: '250',
    HMCODEX_OPENVIKING_HEALTH_FAILURE_THRESHOLD: '1',
    HMCODEX_OPENVIKING_MAX_RESTARTS: '2'
  },
  stdio: 'ignore',
  windowsHide: true
});

try {
  assert.equal(await waitReady(url), true, 'supervisor did not start sidecar');
  const firstPid = listeningPid(port);
  assert.ok(Number.isInteger(firstPid), 'sidecar listener PID not found');
  killTree(firstPid);
  assert.equal(await waitReady(url), true, 'supervisor did not restore sidecar');
  const secondPid = listeningPid(port);
  assert.ok(Number.isInteger(secondPid) && secondPid !== firstPid, 'sidecar restart PID did not change');
  killTree(supervisor.pid);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  assert.ok(!listeningPid(port), 'supervisor exit left a listener behind');
  console.log(JSON.stringify({ status: 'passed', restarted: true, firstPid, secondPid, cleanup: true }));
} finally {
  if (supervisor.exitCode === null) killTree(supervisor.pid);
  await rm(dataDir, { recursive: true, force: true });
}

function scriptPathDataRoot() {
  return process.platform === 'win32' ? process.env.TEMP : '/tmp';
}
