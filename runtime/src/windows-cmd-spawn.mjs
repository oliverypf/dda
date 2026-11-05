import { existsSync } from 'node:fs';
import path from 'node:path';
import { SAFETY_ERROR_CODES, SafetyError } from './runtime-safety-monitor.mjs';

// Node CVE-2024-27980: spawning a .cmd/.bat with shell:false fails (EINVAL).
// Bare npm/npx/yarn/pnpm are those shims on Windows. Resolve PATHEXT ourselves
// and hand cmd.exe one already-escaped argument. Never shell:true string concat.
const BATCH_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);
const BATCH_EXT = new Set(['.cmd', '.bat']);
const CMD_META = '%!~^&|<>()';
const MAX_CMD_LINE = 8000;

const fail = (message) => {
  throw new SafetyError(SAFETY_ERROR_CODES.COMMAND_INVALID, message);
};

const pathApi = (platform) => (platform === 'win32' ? path.win32 : path.posix);

const environmentValue = (env, name) => {
  if (!env || typeof env !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const lowerName = name.toLowerCase();
  let value;
  for (const [key, candidate] of Object.entries(env)) {
    if (key.toLowerCase() === lowerName) value = candidate;
  }
  return value;
};

/** Quote one argv element for cmd.exe /d /s /c. Control characters are rejected. */
export const escapeCmdArgument = (arg) => {
  if (typeof arg !== 'string') fail('arg');
  if (/[\u0000-\u001F\u007F]/u.test(arg)) fail('arg');
  let out = '"';
  for (const char of arg) {
    if (char === '"') {
      out += '""';
      continue;
    }
    if (CMD_META.includes(char)) {
      // Close the quoted span so the caret is seen by cmd, then reopen.
      out += `"^${char}"`;
      continue;
    }
    out += char;
  }
  out += '"';
  return out;
};

/** Extra quotes so `/s` strips one layer and leaves the argv quotes intact. */
export const buildCmdCommandLine = (executable, args) => {
  const parts = [escapeCmdArgument(executable), ...args.map((arg) => escapeCmdArgument(arg))];
  const inner = `"${parts.join(' ')}"`;
  if (inner.length > MAX_CMD_LINE) fail('command line');
  return inner;
};

const pathExtensions = (env) => {
  const raw = environmentValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
  return String(raw).split(';').map((item) => item.trim()).filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));
};

const pathDirs = (env) => String(environmentValue(env, 'PATH') ?? '').split(';').map((item) => item.trim()).filter(Boolean);

const commandStem = (command, platform) => pathApi(platform).basename(command)
  .replace(/\.(?:exe|cmd|bat|com)$/iu, '')
  .toLowerCase();

const findOnPath = ({ command, platform, env, fileExists }) => {
  const api = pathApi(platform);
  const base = api.basename(command);
  const hasExt = api.extname(base) !== '';
  const rooted = api.isAbsolute(command) || command.includes('/') || command.includes('\\');
  const candidates = rooted
    ? (hasExt ? [command] : pathExtensions(env).map((ext) => command + ext))
    : pathDirs(env).flatMap((dir) => (hasExt ? [base] : pathExtensions(env).map((ext) => base + ext)).map((name) => api.join(dir, name)));
  for (const candidate of candidates) {
    if (fileExists(candidate)) return candidate;
  }
  return null;
};

/**
 * Plan a shell:false spawn. On Windows, .cmd/.bat (including PATHEXT hits for
 * npm/npx/yarn/pnpm) run through cmd.exe /d /s /c with escaped argv.
 */
export const planChildSpawn = ({
  command,
  args = [],
  platform = 'win32',
  env = {},
  fileExists = existsSync,
  comSpec
} = {}) => {
  if (typeof command !== 'string' || !command) fail('command');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) fail('arg');
  if (platform !== 'win32') {
    return {
      file: command,
      args: [...args],
      shell: false,
      windowsVerbatimArguments: false,
      viaCmd: false,
      resolvedPath: null
    };
  }
  const spec = comSpec || env.ComSpec || env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
  const resolved = findOnPath({ command, platform, env, fileExists });
  const target = resolved ?? command;
  const ext = path.win32.extname(target).toLowerCase();
  const needsCmd = BATCH_EXT.has(ext) || (!resolved && BATCH_SHIMS.has(commandStem(command, platform)));
  if (!needsCmd) {
    return {
      file: resolved ?? command,
      args: [...args],
      shell: false,
      windowsVerbatimArguments: false,
      viaCmd: false,
      resolvedPath: resolved
    };
  }
  return {
    file: spec,
    args: ['/d', '/s', '/c', buildCmdCommandLine(resolved ?? command, args)],
    shell: false,
    windowsVerbatimArguments: true,
    viaCmd: true,
    resolvedPath: resolved
  };
};
