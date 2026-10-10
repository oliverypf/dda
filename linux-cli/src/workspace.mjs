import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const POSIX_BLOCKED = ['/proc', '/sys', '/dev'];
const HARMONY_BLOCKED = ['/system', '/sys_prod', '/chip_prod', '/data/service'];
const WINDOWS_BLOCKED = ['/windows', '/program files', '/program files (x86)', '/programdata'];

const normalize = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/u, '');

export function isBlockedWorkspacePath(input, platform = 'linux-cli') {
  const normalized = normalize(input);
  const lower = normalized.toLowerCase();
  const drive = lower.match(/^([a-z]:)(\/.*)?$/u);
  if (platform === 'windows-cli' || platform === 'windows-desktop' || drive) {
    const rest = drive?.[2] || (platform.startsWith('windows') ? lower : '');
    if (rest && WINDOWS_BLOCKED.some((prefix) => rest === prefix || rest.startsWith(`${prefix}/`))) return true;
  }
  if (platform === 'windows-cli' || platform === 'windows-desktop') return false;
  const blocked = platform === 'harmonyos-cli' || platform === 'harmonyos'
    ? [...POSIX_BLOCKED, ...HARMONY_BLOCKED]
    : POSIX_BLOCKED;
  return blocked.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export function resolveWorkspace(input, platform = 'linux-cli') {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) {
    throw Object.assign(new Error('WORKSPACE_NOT_FOUND'), { code: 'WORKSPACE_NOT_FOUND' });
  }
  if (isBlockedWorkspacePath(input, platform)) {
    throw Object.assign(new Error('WORKSPACE_PATH_FORBIDDEN'), { code: 'WORKSPACE_PATH_FORBIDDEN' });
  }
  const absolute = resolve(input);
  let canonical;
  try {
    canonical = realpathSync(absolute);
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'WORKSPACE_NOT_FOUND' : 'WORKSPACE_UNAVAILABLE';
    throw Object.assign(new Error(code), { code });
  }
  if (isBlockedWorkspacePath(canonical, platform)) {
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
