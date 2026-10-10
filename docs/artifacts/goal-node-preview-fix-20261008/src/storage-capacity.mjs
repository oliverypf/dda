import { stat } from 'node:fs/promises';

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const LEVELS = Object.freeze(['OK', 'WARNING', 'CRITICAL', 'HARD_LIMIT']);
const finiteRatio = (value, fallback) => Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
const normalizeMaxBytes = (value) => {
  const maxBytes = Number(value ?? DEFAULT_MAX_BYTES);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('STORAGE_CAPACITY_LIMIT_INVALID');
  return maxBytes;
};

export const assessStorageCapacity = async ({ paths = [], maxBytes = DEFAULT_MAX_BYTES, warningRatio = 0.7, criticalRatio = 0.85, hardRatio = 0.95 } = {}) => {
  if (!Array.isArray(paths) || paths.length > 128) throw new Error('STORAGE_CAPACITY_PATHS_INVALID');
  const normalizedMaxBytes = normalizeMaxBytes(maxBytes);
  const warning = finiteRatio(Number(warningRatio), 0.7);
  const critical = finiteRatio(Number(criticalRatio), 0.85);
  const hard = finiteRatio(Number(hardRatio), 0.95);
  if (!(warning < critical && critical < hard)) throw new Error('STORAGE_CAPACITY_THRESHOLDS_INVALID');
  const normalizedPaths = paths.filter((path) => typeof path === 'string' && path.trim()).map((path) => path.trim());
  const uniquePaths = [...new Set(normalizedPaths.flatMap((path) => /\.db$/iu.test(path)
    ? [path, `${path}-wal`, `${path}-shm`, `${path}-journal`] : [path]))];
  const entries = [];
  let totalBytes = 0;
  for (const path of uniquePaths) {
    const metadata = await stat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error));
    if (!metadata) continue;
    const bytes = Number.isSafeInteger(metadata.size) && metadata.size >= 0 ? metadata.size : 0;
    entries.push({ bytes });
    totalBytes += bytes;
  }
  const ratio = totalBytes / normalizedMaxBytes;
  const level = ratio >= 1 || ratio >= hard ? 'HARD_LIMIT' : ratio >= critical ? 'CRITICAL' : ratio >= warning ? 'WARNING' : 'OK';
  return {
    schemaVersion: '1.0',
    level,
    levels: LEVELS,
    totalBytes,
    maxBytes: normalizedMaxBytes,
    ratio,
    thresholds: { warningRatio: warning, criticalRatio: critical, hardRatio: hard },
    fileCount: entries.length,
    entries
  };
};

export const assertStorageCapacityForRun = async (options = {}) => {
  const assessment = await assessStorageCapacity(options);
  if (assessment.level === 'HARD_LIMIT') {
    const error = new Error('STORAGE_CAPACITY_HARD_LIMIT');
    error.assessment = assessment;
    throw error;
  }
  return assessment;
};

export { DEFAULT_MAX_BYTES };
