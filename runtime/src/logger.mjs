// File logger for the Cordis runtime.
//
// Hard rules enforced here:
//   * stdout is the JSONL protocol channel — this module never writes to it;
//   * logging failures are swallowed (a broken log file must never crash a run);
//   * install() keeps every original console/stderr behaviour intact and only
//     adds a file copy, so existing protocol output is byte-for-byte unchanged.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { format } from 'node:util';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LEVELS = Object.freeze(['INFO', 'WARN', 'ERROR', 'FATAL']);

export const logsDir = (env = process.env) => {
  const dataRoot = env.LOCALAPPDATA ?? env.APPDATA ?? env.XDG_CONFIG_HOME;
  return dataRoot ? join(dataRoot, 'hmCodex', 'logs') : undefined;
};

const dayStamp = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

// One entry per line keeps the file grep-friendly; multi-line payloads such as
// stack traces are collapsed so every line still carries its prefix.
const sanitizeMessage = (message) => String(message)
  .replace(/[\r\n\t\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
  .trim();

let currentFilePath;
let currentDayKey;
let writeQueue = Promise.resolve();
let installed = false;

/**
 * Append one entry to `%LOCALAPPDATA%\hmCodex\logs\runtime-YYYYMMDD.log`.
 * Rotate to `.1` (single previous generation) once the active file exceeds 5MB.
 * Returns the write promise purely for internal sequencing; callers must not
 * surface failures from it.
 */
export const appendLog = (level, message) => {
  const entryLevel = LEVELS.includes(level) ? level : 'INFO';
  const entry = `[${new Date().toISOString()}] [${entryLevel}] ${sanitizeMessage(message)}\n`;
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const dir = logsDir();
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const key = dayStamp();
    if (currentFilePath === undefined || key !== currentDayKey) {
      currentDayKey = key;
      currentFilePath = join(dir, `runtime-${key}.log`);
    }
    try {
      const metadata = await stat(currentFilePath);
      if (metadata.size > MAX_LOG_BYTES) {
        await rename(currentFilePath, `${currentFilePath}.1`).catch(() => undefined);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await appendFile(currentFilePath, entry, 'utf8');
  });
  // A failed append must never propagate into runtime control flow.
  writeQueue.catch(() => undefined);
  return writeQueue;
};

const formatValue = (value) => {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  return typeof value === 'string' ? value : format(value);
};

/**
 * Tee console.log/warn/error into the log file while keeping their original
 * output targets untouched (stderr stays a pure passthrough). Registers
 * uncaughtException/unhandledRejection handlers that record the full stack,
 * then replicate Node's default behaviour (stderr dump + exit code 1).
 */
export const install = () => {
  if (installed) return;
  installed = true;
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args) => {
    try {
      appendLog('INFO', args.map(formatValue).join(' '));
    } catch { /* ignore */ }
    originalLog(...args);
  };
  console.warn = (...args) => {
    try {
      appendLog('WARN', args.map(formatValue).join(' '));
    } catch { /* ignore */ }
    originalWarn(...args);
  };
  console.error = (...args) => {
    try {
      appendLog('ERROR', args.map(formatValue).join(' '));
    } catch { /* ignore */ }
    originalError(...args);
  };

  process.on('uncaughtException', (error) => {
    const detail = error?.stack ?? String(error);
    appendLog('FATAL', `uncaughtException: ${detail}`).finally(() => {
      process.stderr.write(`${detail}\n`);
      process.exit(1);
    });
  });
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? `${reason.name}: ${reason.message}`) : String(reason);
    appendLog('FATAL', `unhandledRejection: ${detail}`).finally(() => {
      process.stderr.write(`${detail}\n`);
      process.exit(1);
    });
  });
};

export const logger = {
  install,
  info: (message) => appendLog('INFO', message),
  warn: (message) => appendLog('WARN', message),
  error: (message) => appendLog('ERROR', message),
  fatal: (message) => appendLog('FATAL', message)
};
