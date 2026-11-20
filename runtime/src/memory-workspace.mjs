import { posix, win32 } from 'node:path';
import { canonicalMappedPath } from './platform/workspace-path.mjs';

// Stored history can come from another platform. Resolve local aliases when
// possible, while preserving the case semantics of the original filesystem.
export function memoryWorkspaceKey(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const path = value.trim();
  if (/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/])/iu.test(path)) {
    const normalized = win32.normalize(process.platform === 'win32' ? canonicalMappedPath(path) : path)
      .replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '');
    return 'win:' + normalized.replace(/[\\]+$/u, '').toLowerCase();
  }
  if (!posix.isAbsolute(path)) return '';
  const native = process.platform === 'win32' ? path : canonicalMappedPath(path);
  return 'posix:' + (posix.normalize(native).replace(/\/+$/u, '') || '/');
}

export const memoryScopeKey = (item) => JSON.stringify([
  String(item.scope ?? 'workspace').trim().toLowerCase(), memoryWorkspaceKey(item.workspacePath)
]);
export const memoryLessonKey = (item) => JSON.stringify([memoryScopeKey(item), item.key?.trim() ?? '']);
