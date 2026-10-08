import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export const findCodexCli = async (explicit = process.env.HMCODEX_CODEX_CLI) => {
  const candidates = explicit ? [explicit] : (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
    .flatMap(path => [join(path, process.platform === 'win32' ? 'codex.exe' : 'codex'), join(path, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]);
  for (const path of candidates) {
    try { await access(path); return path.endsWith('.js') ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] }; } catch { /* next location */ }
  }
  throw Error('CODEX_CLI_NOT_FOUND: install the ordinary Codex CLI or set HMCODEX_CODEX_CLI');
};

export const runEvidenceProcess = (command, args, { cwd, env = {}, dropEnv = [], inheritEnv = true, timeoutMs = 180000 } = {}) => new Promise((done, reject) => {
  const start = Date.now();
  const childEnv = { ...(inheritEnv ? process.env : {}), ...env };
  // A child is a separate run. Inheriting Node's private test-worker marker
  // makes `node --test` silently skip discovery instead of testing the task.
  delete childEnv.NODE_TEST_CONTEXT;
  for (const name of dropEnv) delete childEnv[name];
  const child = spawn(command, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', timedOut = false, settled = false, drainTimer;
  const finish = (code, outputTruncated = false) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(drainTimer);
    const end = Date.now();
    done({ code, timedOut, stdout, stderr, outputTruncated, wallMs: end - start, startedAtMs: start, endedAtMs: end });
  };
  const timer = setTimeout(() => {
    timedOut = true;
    // Detached sandbox descendants can keep inherited pipes open after the
    // client exits. Do not let a missing `close` event defeat the case deadline.
    drainTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(child.exitCode, true);
    }, 1000);
    if (process.platform === 'win32' && child.exitCode === null && Number.isInteger(child.pid)) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    }
    else child.kill('SIGTERM');
  }, timeoutMs);
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => {
    if (settled) return;
    settled = true;
    clearTimeout(timer); clearTimeout(drainTimer); reject(error);
  });
  child.once('close', code => finish(code));
});

export const codexEvidenceArgs = ({ prefix = [], endpoint, workspace, model = 'evidence-fixture', prompt, finalPath, mode = 'READ_ONLY' }) => [
  ...prefix, 'exec', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--json', '--color', 'never',
  '--disable', 'plugins', '--disable', 'remote_plugin',
  '--sandbox', mode === 'CONTROLLED' ? 'workspace-write' : 'read-only', '-C', workspace, '-m', model, '-o', finalPath,
  '-c', 'approval_policy="never"', '-c', 'model_provider="goal-evidence"',
  '-c', 'windows.sandbox="unelevated"',
  '-c', 'model_providers.goal-evidence.name="Goal evidence same model"',
  '-c', `model_providers.goal-evidence.base_url=${JSON.stringify(endpoint.replace(/\/responses$/u, ''))}`,
  '-c', 'model_providers.goal-evidence.env_key="EVIDENCE_FIXTURE_KEY"',
  '-c', 'model_providers.goal-evidence.wire_api="responses"',
  '-c', 'model_providers.goal-evidence.requires_openai_auth=false',
  '-c', 'model_providers.goal-evidence.supports_websockets=false', prompt
];
