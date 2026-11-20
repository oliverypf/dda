// Global machine-user access mode authority. One persisted file — the desktop
// host is the only writer; the runtime re-reads on every request so revoking
// FULL_ACCESS stops new auto-approvals and outside-path authorization at once.
// Fail-closed on every malformed input.

import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatformPaths } from './platform/paths.mjs';

const FILE_NAME = 'computer-access.json';
const MAX_BYTES = 64 * 1024;
const ALLOWED_KEYS = new Set(['version', 'scope', 'mode', 'updatedAtMs']);

const configDir = (env = process.env) => createPlatformPaths(env).configDir();

const parseMode = (raw) => {
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
  if (Object.keys(doc).some((key) => !ALLOWED_KEYS.has(key))) return undefined;
  if (doc.version !== 1 || doc.scope !== 'USER_FILESYSTEM') return undefined;
  if (!Number.isInteger(doc.updatedAtMs) || doc.updatedAtMs < 0) return undefined;
  return doc.mode === 'FULL_ACCESS' || doc.mode === 'REQUIRE_APPROVAL' ? doc.mode : undefined;
};

/**
 * Read the persisted machine-user access mode. Returns 'FULL_ACCESS' only for
 * an exact valid grant; anything else (missing, unreadable, oversized,
 * symlink, bad schema) is REQUIRE_APPROVAL. Deps injectable for tests only.
 */
export const readAccessMode = async ({
  env = process.env,
  policyPath,
  readFileImpl = readFile,
  lstatImpl = lstat
} = {}) => {
  try {
    const filePath = policyPath ?? join(configDir(env), FILE_NAME);
    const meta = await lstatImpl(filePath);
    if (meta.isSymbolicLink() || !meta.isFile() || meta.size > MAX_BYTES) return 'REQUIRE_APPROVAL';
    const mode = parseMode(await readFileImpl(filePath, 'utf8'));
    return mode === 'FULL_ACCESS' ? 'FULL_ACCESS' : 'REQUIRE_APPROVAL';
  } catch {
    return 'REQUIRE_APPROVAL';
  }
};

export const computerAccessInternals = { configDir, parseMode, FILE_NAME, MAX_BYTES };
