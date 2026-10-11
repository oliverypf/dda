import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function listFiles(root, prefix = '') {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(root, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * Copy a data root only when the target is empty. Existing target files stop
 * the migration; nothing is deleted.
 */
export async function migrateDataDirectory({ sourceRoot, targetRoot, apply = false }) {
  const report = {
    sourceRoot,
    targetRoot,
    filesConsidered: 0,
    filesCopied: 0,
    digestVerified: false,
    status: 'STOPPED'
  };
  let files;
  try {
    files = await listFiles(sourceRoot);
  } catch (error) {
    return { ...report, status: 'FAILED', reason: error?.code ?? 'SOURCE_UNAVAILABLE' };
  }
  if (files === undefined) return { ...report, status: 'NOT_NEEDED', digestVerified: true };
  report.filesConsidered = files.length;
  let targetOccupied = false;
  try {
    const existing = await readdir(targetRoot);
    targetOccupied = existing.length > 0;
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ...report, status: 'FAILED', reason: error?.code ?? 'TARGET_UNAVAILABLE' };
  }
  if (targetOccupied && files.length > 0) return { ...report, status: 'STOPPED', reason: 'TARGET_NONEMPTY' };
  if (!apply) return { ...report, status: 'PLANNED' };
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  for (const relative of files) {
    const from = join(sourceRoot, relative);
    const to = join(targetRoot, relative);
    const source = await readFile(from);
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    await cp(from, to);
    const info = await stat(to);
    if (!info.isFile()) return { ...report, status: 'FAILED', reason: 'TARGET_NOT_FILE' };
    const copied = await readFile(to);
    if (createHash('sha256').update(source).digest('hex') !== createHash('sha256').update(copied).digest('hex')) {
      return { ...report, status: 'FAILED', reason: 'DIGEST_MISMATCH' };
    }
    report.filesCopied += 1;
  }
  report.digestVerified = true;
  report.status = 'COMPLETED';
  return report;
}
