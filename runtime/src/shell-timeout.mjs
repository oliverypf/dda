import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';

// shell.execute timeout layers (audit):
// - Tool schema maximum is HARD_BUILD_TIMEOUT_CAP_MS so a build can ask for it.
//   Non-build commands are still rejected above LEGACY_SHELL_TIMEOUT_CAP_MS (60s)
//   inside the executor. That 60s figure is the cap agents were told about.
// - Executor default is 15s, or DDA_BUILD_TIMEOUT_MS (default 15 min) for
//   cargo build/test, npm/pnpm/yarn install and run build, and tauri build.
//   A requested timeout of exactly 60s on those commands is the old schema
//   ceiling, not a chosen deadline, so it is raised to the build limit.
// - Lease TTL defaults to 60s and does not kill a running process. The host
//   raises it to cover the command timeout. maxLeaseMs must allow that.
// - Approval TTL is 15 min and only bounds how long the card waits.
// - Runtime heartbeats stay at 2s. The desktop watchdog is 30s without a
//   heartbeat; it watches the runtime, not the child command.
// - Task timeout (DDA_TASK_TIMEOUT_MS) defaults to 0 (disabled).
export const LEGACY_SHELL_TIMEOUT_CAP_MS = 60 * 1000;
export const DEFAULT_SHELL_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;
export const HARD_BUILD_TIMEOUT_CAP_MS = 60 * 60 * 1000;

const invalidLimit = () => {
  const error = new Error('SAFETY_COMMAND_INVALID:limit');
  error.code = 'SAFETY_COMMAND_INVALID';
  throw error;
};

const integerIn = (value, min, max) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return undefined;
  return parsed;
};

export const shellTimeoutConfig = (env = process.env) => {
  const buildMs = integerIn(env?.DDA_BUILD_TIMEOUT_MS, 1000, HARD_BUILD_TIMEOUT_CAP_MS) ?? DEFAULT_BUILD_TIMEOUT_MS;
  return {
    shellDefaultMs: DEFAULT_SHELL_TIMEOUT_MS,
    shellMaxMs: LEGACY_SHELL_TIMEOUT_CAP_MS,
    buildDefaultMs: buildMs,
    buildMaxMs: buildMs
  };
};

const commandStem = (command) => String(command ?? '')
  .replace(/^.*[\\/]/u, '')
  .toLowerCase()
  .replace(/\.(?:exe|cmd|bat|com)$/iu, '');

const positionalArgs = (args) => (Array.isArray(args) ? args : [])
  .map((item) => String(item).toLowerCase())
  .filter((item) => item !== '--' && !item.startsWith('-'));

export const isBuildClassCommand = (command, args = []) => {
  const name = commandStem(command);
  const positional = positionalArgs(args);
  if (name === 'cargo') {
    const sub = positional[0];
    if (sub === 'build' || sub === 'test') return true;
    return sub === 'tauri' && positional.includes('build');
  }
  if (name === 'tauri') return positional.includes('build');
  if (name === 'npx') return positional.includes('tauri') && positional.includes('build');
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    if (positional.includes('install') || positional.includes('ci')) return true;
    if (positional.includes('tauri') && positional.includes('build')) return true;
    const script = positional[0] === 'run' ? positional[1] : ((name === 'yarn' || name === 'pnpm') ? positional[0] : '');
    return script === 'build' || script.startsWith('build:');
  }
  return false;
};

export const resolveShellTimeout = ({ command, args, requested, env } = {}) => {
  const config = shellTimeoutConfig(env);
  const build = isBuildClassCommand(command, args);
  const maxMs = build ? config.buildMaxMs : config.shellMaxMs;
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) invalidLimit();
  let timeoutMs;
  let raisedFromLegacyCap = false;
  if (build && (requested === undefined || requested === LEGACY_SHELL_TIMEOUT_CAP_MS)) {
    timeoutMs = config.buildDefaultMs;
    raisedFromLegacyCap = requested === LEGACY_SHELL_TIMEOUT_CAP_MS;
  } else if (requested === undefined) {
    timeoutMs = config.shellDefaultMs;
  } else if (requested > maxMs) {
    if (!build) invalidLimit();
    timeoutMs = maxMs;
  } else {
    timeoutMs = requested;
  }
  return { timeoutMs, build, maxMs, raisedFromLegacyCap };
};

export const timeoutFailureLine = (timeoutMs, { build = false } = {}) => (build
  ? `EXECUTOR_TIMEOUT: 构建命令已超过 ${timeoutMs} 毫秒上限并被终止。该上限由环境变量 DDA_BUILD_TIMEOUT_MS 配置，当前值是 ${timeoutMs} 毫秒。`
  : `EXECUTOR_TIMEOUT: 命令已超过 ${timeoutMs} 毫秒上限并被终止。`);

const LOCK_TEXT = [
  /os error 32/i,
  /LNK1104/i,
  /being used by another process/i,
  /另一个程序正在使用此文件/,
  /The process cannot access the file/i,
  /failed to remove file[\s\S]{0,400}\.exe[\s\S]{0,200}(Access is denied|os error 5)/i
];

export const explainLockedExecutable = ({ stderr = '', stdout = '', hostPath = '' } = {}) => {
  const text = `${stderr}\n${stdout}`;
  if (!LOCK_TEXT.some((pattern) => pattern.test(text))) return null;
  const base = hostPath ? path.basename(hostPath) : '';
  const mentionsHost = Boolean(base) && text.toLowerCase().includes(base.toLowerCase());
  const shown = mentionsHost ? base : '可执行文件';
  return {
    code: 'EXECUTOR_OUTPUT_LOCKED',
    message: `EXECUTOR_OUTPUT_LOCKED: 目标${shown}正在被占用，构建无法覆盖它。${mentionsHost ? `当前正在运行的程序就是 ${base}。` : ''}请先退出占用该文件的程序，或设置 CARGO_TARGET_DIR 指向其他目录后再构建。`
  };
};

export const annotateProcessFailure = ({
  stderr = '',
  stdout = '',
  timedOut = false,
  timeoutMs,
  build = false,
  hostPath = ''
} = {}) => {
  let text = String(stderr ?? '');
  if (timedOut && !text.includes('EXECUTOR_TIMEOUT:')) {
    const line = timeoutFailureLine(timeoutMs, { build });
    text = text ? `${line}\n${text}` : line;
  }
  const lock = explainLockedExecutable({ stderr: text, stdout, hostPath });
  if (lock && !text.includes('EXECUTOR_OUTPUT_LOCKED:')) text = text ? `${lock.message}\n${text}` : lock.message;
  return text;
};

const packageNameFromToml = (text) => {
  if (typeof text !== 'string') return null;
  const section = text.split(/\[package\]/i)[1]?.split(/\n\s*\[/u)[0] ?? '';
  const match = section.match(/^\s*name\s*=\s*"([^"]+)"/mu);
  return match?.[1] || null;
};

const tauriRelease = (command, args) => {
  const name = commandStem(command);
  const positional = (Array.isArray(args) ? args : []).map((item) => String(item).toLowerCase());
  if (positional.includes('--release')) return true;
  if (name === 'tauri' || name === 'npx') return positional.includes('build');
  return positional.includes('tauri') && positional.includes('build');
};

export const predictBuildOutputs = ({ command, args = [], cwd, readText } = {}) => {
  if (!cwd || !isBuildClassCommand(command, args)) return [];
  const name = commandStem(command);
  const positional = (Array.isArray(args) ? args : []).map((item) => String(item).toLowerCase());
  const cargoLike = name === 'cargo' || name === 'tauri' || (positional.includes('tauri') && positional.includes('build'));
  if (!cargoLike) return [];
  const argv = (Array.isArray(args) ? args : []).map((item) => String(item));
  const manifestFlag = argv.indexOf('--manifest-path');
  const manifest = manifestFlag >= 0 && argv[manifestFlag + 1]
    ? path.resolve(cwd, argv[manifestFlag + 1])
    : path.join(cwd, 'Cargo.toml');
  let text = '';
  try {
    text = readText ? readText(manifest) : readFileSync(manifest, 'utf8');
  } catch {
    return [];
  }
  const packageName = packageNameFromToml(text);
  if (!packageName || packageName.includes('/') || packageName.includes('\\')) return [];
  const targetFlag = argv.indexOf('--target-dir');
  const profile = tauriRelease(command, args) ? 'release' : 'debug';
  const targetDir = targetFlag >= 0 && argv[targetFlag + 1]
    ? path.resolve(cwd, argv[targetFlag + 1], profile)
    : path.join(path.dirname(manifest), 'target', profile);
  return [path.join(targetDir, `${packageName}.exe`), path.join(targetDir, packageName)];
};

const samePath = (left, right, platform) => {
  if (!left || !right) return false;
  const api = platform === 'win32' ? path.win32 : path;
  try {
    const a = api.resolve(left);
    const b = api.resolve(right);
    return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
};

export const hostExecutableCandidates = (env = process.env, execPath = '') => {
  const list = [];
  if (typeof env?.DDA_HOST_EXECUTABLE === 'string' && env.DDA_HOST_EXECUTABLE.trim()) list.push(env.DDA_HOST_EXECUTABLE.trim());
  if (typeof execPath === 'string' && execPath.trim()) list.push(execPath.trim());
  return list;
};

const lockMessage = (output, running) => (running
  ? `EXECUTOR_OUTPUT_LOCKED: 目标可执行文件正在使用中，无法覆盖正在运行的 ${path.basename(output)}（${output}）。请先退出该程序，或设置 CARGO_TARGET_DIR 指向其他目录后再构建。`
  : `EXECUTOR_OUTPUT_LOCKED: 目标可执行文件正在被其他进程占用，构建无法覆盖 ${path.basename(output)}（${output}）。请先退出占用该文件的程序，或设置 CARGO_TARGET_DIR 指向其他目录后再构建。`);

export const detectBuildOutputLock = ({
  command,
  args,
  cwd,
  hostExecutables = [],
  readText,
  probeLock,
  platform = process.platform
} = {}) => {
  const outputs = predictBuildOutputs({ command, args, cwd, readText });
  for (const output of outputs) {
    if (hostExecutables.some((host) => samePath(host, output, platform))) {
      return { code: 'EXECUTOR_OUTPUT_LOCKED', path: output, message: lockMessage(output, true) };
    }
  }
  if (typeof probeLock === 'function') {
    for (const output of outputs) {
      if (probeLock(output) === true) return { code: 'EXECUTOR_OUTPUT_LOCKED', path: output, message: lockMessage(output, false) };
    }
  }
  return null;
};

export const defaultProbeLock = (file) => {
  if (!existsSync(file)) return false;
  let fd;
  try {
    fd = openSync(file, 'r+');
    return false;
  } catch (error) {
    return error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the probe only cares that the file is busy */ }
    }
  }
};
