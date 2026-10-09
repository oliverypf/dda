import { spawn } from 'node:child_process';
import { rename, unlink, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ExecutorPort } from './executor-port.mjs';
import {
  ACTIONS,
  RuntimeSafetyMonitor,
  SAFETY_ERROR_CODES,
  SafetyError,
  boundOutput,
  digest
} from './runtime-safety-monitor.mjs';

const MAX_TIMEOUT_MS = 60 * 1000;
const MAX_INPUT_BYTES = 64 * 1024;
const SECRET_ENV = /(?:key|token|secret|password|credential|private|authorization)/i;

const fail = (code, message = '') => { throw new SafetyError(code, message); };

const safeEnvironment = (provided) => {
  const inherited = {};
  // Keep only process-discovery and temporary-directory variables. In
  // particular, API keys and arbitrary user configuration are not inherited.
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (typeof process.env[key] === 'string') inherited[key] = process.env[key];
  }
  if (provided === undefined) return inherited;
  if (!provided || typeof provided !== 'object' || Array.isArray(provided) || Object.keys(provided).length > 32) {
    fail(SAFETY_ERROR_CODES.COMMAND_INVALID, 'env');
  }
  for (const [key, value] of Object.entries(provided)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || SECRET_ENV.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
      fail(SAFETY_ERROR_CODES.COMMAND_INVALID, 'env');
    }
    inherited[key] = value;
  }
  return inherited;
};

const boundedLimit = (value, maximum, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(SAFETY_ERROR_CODES.COMMAND_INVALID, 'limit');
  return value;
};

const runCleanupProcess = (command, args) => new Promise((resolve) => {
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  let stdout = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.once('error', () => resolve(stdout));
  child.once('close', () => resolve(stdout));
});

const listDescendantPids = async (pid) => {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return [];
  const stdout = await runCleanupProcess('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Select-Object -ExpandProperty ProcessId`
  ]);
  return stdout.split(/\r?\n/u)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
};

const killPid = async (pid) => {
  if (process.platform !== 'win32' || !Number.isInteger(pid) || pid <= 0) return;
  await runCleanupProcess('taskkill', ['/PID', String(pid), '/F']);
};

const terminateProcessTree = async (rootPid) => {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) return;
  const discovered = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const descendant of await listDescendantPids(pid)) {
      if (!discovered.has(descendant)) {
        discovered.add(descendant);
        queue.push(descendant);
      }
    }
  }
  for (const pid of [...discovered].reverse()) await killPid(pid);
};

const collectProcessOutput = ({ command, args, cwd, env, timeoutMs, input, signal, maxOutputBytes, maxOutputChars }) => new Promise((resolve, reject) => {
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES)) {
    reject(new SafetyError(SAFETY_ERROR_CODES.COMMAND_INVALID, 'input'));
    return;
  }
  if (signal?.aborted) {
    reject(new SafetyError('EXECUTOR_ABORTED'));
    return;
  }
  if (signal !== undefined && (typeof signal !== 'object' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    reject(new SafetyError(SAFETY_ERROR_CODES.COMMAND_INVALID, 'signal'));
    return;
  }
  const startedAt = performance.now();
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    reject(new SafetyError('EXECUTOR_SPAWN_FAILED'));
    return;
  }
  const rawLimit = Math.max(maxOutputBytes * 2, 128 * 1024);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let cleanupPromise;
  const append = (target, chunk) => {
    const next = Buffer.concat([target, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (next.byteLength > rawLimit) {
      truncated = true;
      return next.subarray(0, rawLimit);
    }
    return next;
  };
  const startProcessTreeCleanup = () => {
    cleanupPromise ??= terminateProcessTree(child.pid);
    return cleanupPromise;
  };
  const timer = setTimeout(() => {
    timedOut = true;
    truncated = true;
    void startProcessTreeCleanup();
  }, timeoutMs);
  const onAbort = () => {
    aborted = true;
    truncated = true;
    void startProcessTreeCleanup();
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
  child.once('close', async (exitCode, terminationSignal) => {
    if (settled) return;
    clearTimeout(timer);
    if (cleanupPromise) await cleanupPromise.catch(() => {});
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    const stdoutBound = boundOutput(stdout.toString('utf8'), { maxOutputBytes, maxOutputChars });
    const stderrBound = boundOutput(stderr.toString('utf8'), { maxOutputBytes, maxOutputChars });
    resolve({
      ok: !timedOut && !aborted && exitCode === 0,
      exitCode: Number.isInteger(exitCode) ? exitCode : null,
      signal: terminationSignal ?? null,
      aborted,
      timedOut,
      truncated: truncated || stdoutBound.truncated || stderrBound.truncated,
      stdout: stdoutBound.text,
      stderr: stderrBound.text,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt))
    });
  });
  if (input !== undefined) {
    child.stdin.end(input);
  } else {
    child.stdin.end();
  }
});

/**
 * Windows-oriented executor with a shell:false process boundary. It also
 * works on other hosts for tests, but never delegates a command to cmd.exe or
 * PowerShell implicitly.
 */
export class RestrictedWindowsExecutor extends ExecutorPort {
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
    const authorization = await this.#monitor.authorize(action, request, options.lease);
    if (authorization.action === ACTIONS.WRITE_FILE) return this.#write(authorization, request);
    return this.#process(authorization, request, options);
  }

  async #write(authorization, request) {
    if (authorization.path.exists && authorization.path.metadata?.isDirectory()) fail(SAFETY_ERROR_CODES.PATH_INVALID, 'target is a directory');
    // Write beside the target and rename into place so readers never observe
    // a partially written file. A Windows rename can reject replacement of an
    // existing file; the bounded fallback keeps that platform behavior
    // functional while retaining the atomic path for new files.
    const temporaryPath = `${authorization.path.absolutePath}.hmcodex-${randomUUID()}.tmp`;
    const checkSource = async () => {
      const refreshed = await this.#monitor.canonicalPath(request.path, { forWrite: true });
      if (refreshed.absolutePath !== authorization.path.absolutePath) throw new SafetyError('EXECUTOR_WRITE_TARGET_CHANGED');
      if (request.expectedDigest !== undefined) {
        const expected = typeof request.expectedDigest === 'string'
          ? request.expectedDigest.toLowerCase().replace(/^(?!sha256:)/, 'sha256:') : request.expectedDigest;
        const actual = refreshed.exists ? `sha256:${createHash('sha256').update(await readFile(refreshed.absolutePath)).digest('hex')}` : null;
        if (actual !== expected) throw new SafetyError('WRITE_STALE_DIGEST');
      }
      return refreshed;
    };
    try {
      await checkSource();
      await writeFile(temporaryPath, request.content, { encoding: 'utf8', flag: 'wx' });
      try {
        await checkSource();
        await rename(temporaryPath, authorization.path.absolutePath);
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
        // Re-resolve before the non-atomic Windows replacement fallback so a
        // race cannot swap the target for a link after authorization.
        const refreshed = await checkSource();
        await writeFile(refreshed.absolutePath, request.content, { encoding: 'utf8', flag: 'w' });
      }
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
      lease: authorization.lease?.id ?? null
    };
  }

  async #process(authorization, request, options = {}) {
    const limits = this.#monitor.limits;
    const timeoutMs = boundedLimit(request.timeoutMs, MAX_TIMEOUT_MS, 15 * 1000);
    const maxOutputBytes = boundedLimit(request.maxOutputBytes, limits.maxOutputBytes, limits.maxOutputBytes);
    const maxOutputChars = boundedLimit(request.maxOutputChars, limits.maxOutputChars, limits.maxOutputChars);
    const result = await collectProcessOutput({
      command: authorization.command.command,
      args: authorization.command.args,
      cwd: authorization.cwd.absolutePath,
      env: safeEnvironment(request.env),
      timeoutMs,
      input: request.input,
      signal: options.signal,
      maxOutputBytes,
      maxOutputChars
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

export const createRestrictedWindowsExecutor = (options) => new RestrictedWindowsExecutor(options);
