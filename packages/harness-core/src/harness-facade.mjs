import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  exitCodeForResult,
  EXIT_CODES,
  isRuntimeEventEnvelope
} from '../../harness-model/src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// Default location of the monolithic runtime entry, relative to this package.
// The facade drives the runtime as a supervised child process rather than
// importing runtime/src/index.mjs — that module runs its CLI dispatch at import
// time (top-level await), so it cannot be imported as a library. Spawning it
// matches the documented topology: "运行时可以是同进程模块，也可以是客户端拉起的受监管子进程"
// (docs/MULTI_PLATFORM_ARCHITECTURE.md §3). As behaviour is extracted out of the
// monolith into @dda/harness-core, individual methods can switch from spawning
// to in-process calls without changing this facade's surface.
const DEFAULT_RUNTIME_ENTRY = resolve(HERE, '../../../runtime/src/index.mjs');

const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

const toFlag = (key) => `--${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;

/**
 * Convert an options object to runtime CLI flags.
 * - `true` becomes a bare presence flag (`--resume`).
 * - `false`, `null` and `undefined` are skipped.
 * - everything else becomes `--flag value`.
 */
export const optionsToArgs = (options = {}) => {
  const args = [];
  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === null || value === undefined) continue;
    const flag = toFlag(key);
    if (value === true) {
      args.push(flag);
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
};

const parseStdout = (stdout) => {
  const events = [];
  let result;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON on stdout violates the contract; ignore it here and let the
      // missing result surface as a PROTOCOL_ERROR.
      continue;
    }
    if (isRuntimeEventEnvelope(parsed)) {
      events.push(parsed);
    } else {
      // The runtime prints exactly one result object; the last one wins.
      result = parsed;
    }
  }
  return { events, result };
};

/**
 * HarnessFacade is the stable entry surface for platform shells.
 *
 * It deliberately exposes a small, contract-shaped API (invoke + a few named
 * commands) and never reaches into runtime internals. Safety is owned by the
 * runtime: the facade only forwards caller intent. In particular it never
 * injects an auto-approval and defaults to READ_ONLY, preserving the
 * fail-closed approval semantics required by docs/LINUX_CLI_CONTRACT.md.
 */
export class HarnessFacade {
  constructor(options = {}) {
    this.runtimeEntry = options.runtimeEntry ?? DEFAULT_RUNTIME_ENTRY;
    this.nodeBinary = options.nodeBinary ?? process.execPath;
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.spawn = options.spawn ?? nodeSpawn;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Invoke a runtime command and return a frozen, contract-shaped result.
   *
   * Resolves (never rejects) with:
   *   { command, args, ok, result, events, exitCode, childExitCode,
   *     signal, stdout, stderr, timedOut }
   *
   * `exitCode` is the stable CLI code from @dda/harness-model. It is derived
   * from the runtime result (fail-closed): a missing/garbled result is a
   * PROTOCOL_ERROR and a timeout is a RUNTIME_ERROR, never SUCCESS.
   */
  invoke(command, options = {}) {
    if (typeof command !== 'string' || command.length === 0) {
      throw new TypeError('HarnessFacade.invoke requires a command string');
    }
    const extraArgs = Array.isArray(options.args) ? options.args : [];
    const emitEvents = options.events === true;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const argv = [this.runtimeEntry, command, ...extraArgs];
    if (emitEvents) argv.push('--events', 'stdout');

    return new Promise((resolvePromise) => {
      const child = this.spawn(this.nodeBinary, argv, {
        cwd: options.cwd ?? this.cwd,
        env: options.env ?? this.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let settled = false;
      let timedOut = false;

      const finish = (childExitCode, signal) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const { events, result } = parseStdout(stdout);
        const exitCode = timedOut
          ? EXIT_CODES.RUNTIME_ERROR
          : exitCodeForResult(result);
        resolvePromise(Object.freeze({
          command,
          args: Object.freeze([...extraArgs]),
          ok: result?.ok === true && !timedOut,
          result: result ?? null,
          events: Object.freeze(events),
          exitCode,
          childExitCode,
          signal: signal ?? null,
          stdout,
          stderr,
          timedOut
        }));
      };

      child.stdout?.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= MAX_BUFFER_BYTES) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        // Spawn failure (e.g. missing node/runtime) is a dependency problem.
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise(Object.freeze({
          command,
          args: Object.freeze([...extraArgs]),
          ok: false,
          result: null,
          events: Object.freeze([]),
          exitCode: EXIT_CODES.DEPENDENCY_ERROR,
          childExitCode: null,
          signal: null,
          stdout,
          stderr: stderr + String(error?.message ?? error),
          timedOut: false
        }));
      });
      child.on('close', (code, signal) => finish(code, signal));

      const timer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            // A CLI timeout does not mean the action was cancelled; we stop the
            // child but the caller must treat side-effect state as unknown.
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;
      timer?.unref?.();

      if (options.stdin !== undefined && child.stdin) {
        child.stdin.end(options.stdin);
      }
    });
  }

  health(options = {}) {
    return this.invoke('health', options);
  }

  supportInfo(options = {}) {
    return this.invoke('support-info', options);
  }

  /**
   * Run a task. Defaults to READ_ONLY and never supplies an approval decision;
   * callers that need CONTROLLED execution must pass an explicit approvalMode
   * and (for non-interactive use) a jsonl approval stream, exactly as the
   * linux-cli contract requires.
   */
  task(task = {}, options = {}) {
    const { prompt, workspace, executionMode = 'READ_ONLY', ...rest } = task;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new TypeError('HarnessFacade.task requires a non-empty prompt');
    }
    const args = optionsToArgs({ prompt, workspace, executionMode, ...rest });
    return this.invoke('task', { ...options, args });
  }

  thread(subcommand, options = {}) {
    const args = subcommand ? [subcommand, ...(options.args ?? [])] : (options.args ?? []);
    return this.invoke('thread', { ...options, args });
  }

  recovery(options = {}) {
    return this.invoke('recovery', options);
  }
}

export const createHarnessFacade = (options) => new HarnessFacade(options);
