import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Workspace path identity. Windows drive-letter mapping stays in
 * `windows-path.mjs` and is loaded only on a Windows host, so Linux and
 * HarmonyOS never import `net.exe` mapping.
 */
const windows = process.platform === 'win32' ? await import('../windows-path.mjs') : undefined;

export const preferMappedPath = (value, options) => (windows ? windows.preferMappedPath(value, options) : value);

export const canonicalMappedPath = (value, options) => {
  if (windows) return windows.canonicalMappedPath(value, options);
  if (typeof value !== 'string' || !value.trim()) return '';
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
};
