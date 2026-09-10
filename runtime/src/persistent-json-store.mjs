import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { copyFile } from 'node:fs/promises';

// All runtime stores use the same lock protocol.  A lock file is acquired with
// O_EXCL, so independent Node processes cannot enter the replacement section
// at the same time.  The token check in release() prevents an old process from
// removing a lock that was reclaimed after a crash.
const DEFAULTS = Object.freeze({
  lockTimeoutMs: 15_000,
  staleLockMs: 60_000,
  retryDelayMs: 8,
  maxRetryDelayMs: 250,
  renameRetries: 8
});

const LOCK_RETRYABLE = new Set(['EEXIST', 'EACCES', 'EPERM', 'EBUSY']);
const RENAME_RETRYABLE = new Set(['EACCES', 'EPERM', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const isStale = async (lockPath, staleLockMs) => {
  try {
    const details = await stat(lockPath);
    return Date.now() - details.mtimeMs >= staleLockMs;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
};

const acquire = async (filePath, options) => {
  const lockPath = `${filePath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  let delay = options.retryDelayMs;

  await mkdir(dirname(filePath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        try {
          await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, acquiredAtMs: Date.now() })}\n`, 'utf8');
        } finally {
          await handle.close();
        }
      } catch (error) {
        await unlink(lockPath).catch(() => {});
        throw error;
      }
      return async () => {
        try {
          const contents = await readFile(lockPath, 'utf8');
          if (contents.includes(`"token":"${token}"`)) await unlink(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST' && !LOCK_RETRYABLE.has(error?.code)) throw error;
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        const timeout = new Error('PERSISTENCE_LOCK_TIMEOUT');
        timeout.code = 'PERSISTENCE_LOCK_TIMEOUT';
        throw timeout;
      }
      if (await isStale(lockPath, options.staleLockMs)) {
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      await sleep(delay);
      delay = Math.min(options.maxRetryDelayMs, Math.max(options.retryDelayMs, delay * 2));
    }
  }
};

const replace = async (temporaryPath, filePath, options) => {
  let delay = options.retryDelayMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      if (!RENAME_RETRYABLE.has(error?.code) || attempt >= options.renameRetries) throw error;
      await sleep(delay);
      delay = Math.min(options.maxRetryDelayMs, Math.max(options.retryDelayMs, delay * 2));
    }
  }
};

/**
 * Persist a JSON value while coordinating independent runtime processes.
 * Writes are made to a unique temporary file and replaced under a lock.
 */
export const persistJsonFile = async (filePath, value, options = {}) => {
  if (!filePath) return;
  const settings = { ...DEFAULTS, ...options };
  const release = await acquire(filePath, settings);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Re-read while holding the lock.  This lets callers merge changes from
    // independent processes instead of silently replacing a newer snapshot.
    let valueToWrite = value;
    if (typeof settings.merge === 'function') {
      let existing;
      try {
        existing = JSON.parse(await readFile(filePath, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      valueToWrite = await settings.merge(existing, value);
    }
    if (settings.backupPath && filePath) {
      try {
        await mkdir(dirname(settings.backupPath), { recursive: true });
        await copyFile(filePath, settings.backupPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await writeFile(temporaryPath, `${JSON.stringify(valueToWrite, null, 2)}\n`, 'utf8');
    await replace(temporaryPath, filePath, settings);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await release();
  }
};

/**
 * Read a JSON snapshot while coordinating with persistJsonFile writers.
 *
 * ThreadStore and other readers must take the same lock as writers.  This is
 * especially important on Windows network/UNC paths, where a reader racing a
 * replacement can otherwise observe a transient or incomplete destination.
 */
export const readPersistentJsonFile = async (filePath, options = {}) => {
  if (!filePath) return undefined;
  const settings = { ...DEFAULTS, ...options };
  const release = await acquire(filePath, settings);
  try {
    try {
      return JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  } finally {
    await release();
  }
};

export const persistentJsonDefaults = DEFAULTS;

/** Merge records by id, preferring the snapshot with the newest version. */
export const mergeRecordsById = (existing, incoming, {
  collection,
  id = 'id',
  version = (record) => record?.updatedAtMs ?? record?.finishedAtMs ?? record?.createdAtMs ?? 0,
  merge
} = {}) => {
  const merged = new Map();
  for (const record of Array.isArray(existing?.[collection]) ? existing[collection] : []) {
    if (record && typeof record[id] === 'string') merged.set(record[id], record);
  }
  for (const record of Array.isArray(incoming?.[collection]) ? incoming[collection] : []) {
    if (!record || typeof record[id] !== 'string') continue;
    const previous = merged.get(record[id]);
    if (!previous) merged.set(record[id], record);
    else if (typeof merge === 'function') merged.set(record[id], merge(previous, record));
    else if (version(record) >= version(previous)) merged.set(record[id], record);
  }
  return { ...incoming, [collection]: [...merged.values()] };
};
