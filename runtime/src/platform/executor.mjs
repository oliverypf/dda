import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { rename, unlink, writeFile, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { ExecutorPort } from '../executor-port.mjs';
import { RestrictedWindowsExecutor } from '../restricted-windows-executor.mjs';
import {
  ACTIONS,
  RuntimeSafetyMonitor,
  SAFETY_ERROR_CODES,
  SafetyError,
  boundOutput,
  digest
} from '../runtime-safety-monitor.mjs';
import { buildChildEnv } from './environment-policy.mjs';
import { isLinuxCliPlatform } from './paths.mjs';

const MAX_TIMEOUT_MS = 60 * 1000;
const BLOCKED_PREFIXES = [/^\/proc(?:\/|$)/u, /^\/sys(?:\/|$)/u, /^\/dev(?:\/|$)/u, /^\/run\/secrets(?:\/|$)/u];
const CREDENTIAL_SUFFIXES = ['.ssh', '.gnupg', '.aws', '.config/gcloud'];
const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ'];

const fail = (code, message = '') => { throw new SafetyError(code, message); };

const assertLinuxPath = (absolutePath) => {
  if (typeof absolutePath !== 'string' || !absolutePath) return;
  if (BLOCKED_PREFIXES.some((pattern) => pattern.test(absolutePath))) fail('LINUX_PATH_FORBIDDEN', absolutePath);
  const home = process.env.HOME;
  if (!home) return;
  for (const suffix of CREDENTIAL_SUFFIXES) {
    const blocked = join(home, suffix);
    if (absolutePath === blocked || absolutePath.startsWith(`${blocked}/`)) fail('LINUX_PATH_FORBIDDEN', suffix);
  }
};

const executionEnv = (provided) => {
  const base = {};
  for (const key of BASE_ENV_KEYS) {
    if (typeof process.env[key] === 'string') base[key] = process.env[key];
  }
  if (provided === undefined) return base;
  return { ...base, ...buildChildEnv(provided) };
};

const boundedLimit = (value, maximum, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(SAFETY_ERROR_CODES.COMMAND_INVALID, 'limit');
  return value;
};

const collectPosixOutput = ({ command, args, cwd, env, timeoutMs, input, signal, maxOutputBytes, maxOutputChars }) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    reject(new SafetyError('EXECUTOR_SPAWN_FAILED'));
    return;
  }
  const startedAt = performance.now();
  const rawLimit = Math.max(maxOutputBytes * 2, 128 * 1024);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  const append = (target, chunk) => {
    const next = Buffer.concat([target, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (next.byteLength > rawLimit) {
      truncated = true;
      return next.subarray(0, rawLimit);
    }
    return next;
  };
  const killGroup = (signalName) => {
    if (process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, signalName); return; } catch { /* fall through */ }
    }
    child.kill(signalName);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    truncated = true;
    killGroup('SIGKILL');
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    truncated = true;
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), 500).unref?.();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
  child.once('error', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new SafetyError('EXECUTOR_SPAWN_FAILED'));
  });
  child.once('close', (exitCode, terminationSignal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    const stdoutBound = boundOutput(stdout.toString('utf8'), { maxOutputBytes, maxOutputChars });
    const stderrBound = boundOutput(stderr.toString('utf8'), { maxOutputBytes, maxOutputChars });
    const unknown = timedOut || aborted;
    resolve({
      ok: !unknown && exitCode === 0,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: terminationSignal ?? null,
      aborted,
      timedOut,
      state: unknown ? 'UNKNOWN' : 'OBSERVED',
      truncated: truncated || stdoutBound.truncated || stderrBound.truncated,
      stdout: stdoutBound.text,
      stderr: stderrBound.text,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
  });
  if (input !== undefined) child.stdin.end(input);
  else child.stdin.end();
});

export class LinuxPosixExecutor extends ExecutorPort {
  #monitor;

  constructor({ monitor, workspaceRoot, ...options } = {}) {
    super();
    this.#monitor = monitor instanceof RuntimeSafetyMonitor
      ? monitor
      : new RuntimeSafetyMonitor({ workspaceRoot, ...options });
  }

  get monitor() { return this.#monitor; }

  async execute(action, request = {}, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS);
    if (request?.shell === true || request?.interpretation === 'SHELL_INTERPRETED') fail('SHELL_INTERPRETED_DENIED');
    const authorization = await this.#monitor.authorize(action, request, options.lease);
    assertLinuxPath(authorization.path?.absolutePath);
    assertLinuxPath(authorization.cwd?.absolutePath);
    if (authorization.action === ACTIONS.WRITE_FILE) return this.#write(authorization, request);
    return this.#process(authorization, request, options);
  }

  async #write(authorization, request) {
    if (authorization.path.exists && authorization.path.metadata?.isDirectory()) fail(SAFETY_ERROR_CODES.PATH_INVALID, 'target is a directory');
    const temporaryPath = `${authorization.path.absolutePath}.hmcodex-${randomUUID()}.tmp`;
    const refreshed = await this.#monitor.canonicalPath(request.path, { forWrite: true });
    if (refreshed.absolutePath !== authorization.path.absolutePath) throw new SafetyError('EXECUTOR_WRITE_TARGET_CHANGED');
    assertLinuxPath(refreshed.absolutePath);
    if (request.expectedDigest !== undefined) {
      const expected = typeof request.expectedDigest === 'string'
        ? request.expectedDigest.toLowerCase().replace(/^(?!sha256:)/u, 'sha256:')
        : request.expectedDigest;
      const actual = refreshed.exists
        ? `sha256:${createHash('sha256').update(await readFile(refreshed.absolutePath)).digest('hex')}`
        : null;
      if (actual !== expected) throw new SafetyError('WRITE_STALE_DIGEST');
    }
    try {
      await writeFile(temporaryPath, request.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, authorization.path.absolutePath);
    } catch (error) {
      if (error instanceof SafetyError) throw error;
      throw new SafetyError('EXECUTOR_WRITE_FAILED');
    } finally {
      await unlink(temporaryPath).catch(() => {});
    }
    return {
      ok: true,
      action: ACTIONS.WRITE_FILE,
      path: authorization.path.path,
      bytesWritten: Buffer.byteLength(request.content, 'utf8'),
      contentDigest: digest(request.content),
      lease: authorization.lease?.id ?? null,
      state: 'OBSERVED'
    };
  }

  async #process(authorization, request, options = {}) {
    const limits = this.#monitor.limits;
    const result = await collectPosixOutput({
      command: authorization.command.command,
      args: authorization.command.args,
      cwd: authorization.cwd.absolutePath,
      env: executionEnv(request.env),
      timeoutMs: boundedLimit(request.timeoutMs, MAX_TIMEOUT_MS, 15 * 1000),
      input: request.input,
      signal: options.signal,
      maxOutputBytes: boundedLimit(request.maxOutputBytes, limits.maxOutputBytes, limits.maxOutputBytes),
      maxOutputChars: boundedLimit(request.maxOutputChars, limits.maxOutputChars, limits.maxOutputChars)
    });
    return {
      ...result,
      action: authorization.action,
      commandDigest: digest(JSON.stringify({ command: authorization.command.commandName, args: authorization.command.args })),
      cwd: authorization.cwd.path || '.',
      lease: authorization.lease?.id ?? null
    };
  }
}

export const createPlatformExecutor = (options = {}, env = process.env) => isLinuxCliPlatform(env)
  ? new LinuxPosixExecutor(options)
  : new RestrictedWindowsExecutor(options);
