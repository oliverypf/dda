import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const BLOCKED = ['/proc', '/sys', '/dev'];

export function resolveWorkspace(input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { code: 'WORKSPACE_NOT_FOUND' });
  }
  const absolute = resolve(input);
  let canonical;
  try {
    canonical = realpathSync(absolute);
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_UNAVAILABLE';
    throw Object.assign(new Error(code), { code });
  }
  if (BLOCKED.some((prefix) => canonical === prefix || canonical.startsWith(`${prefix}/`))) {
    throw Object.assign(new Error('WORKSPACE_PATH_FORBIDDEN'), { code: 'WORKSPACE_PATH_FORBIDDEN' });
  }
  let info;
  try {
    info = statSync(canonical);
  } catch {
    throw Object.assign(new Error('WORKSPACE_UNAVAILABLE'), { code: 'WORKSPACE_UNAVAILABLE' });
  }
  if (!info.isDirectory()) throw Object.assign(new Error('WORKSPACE_NOT_DIRECTORY'), { code: 'WORKSPACE_NOT_DIRECTORY' });
  return canonical;
}
