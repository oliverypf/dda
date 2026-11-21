// Codex App Server v2 item/permissions/requestApproval. Grant only explicit
// paths the user can review under the configured remote workspace.
interface SandboxPath { type: string; path?: string; }
interface SandboxEntry { access: string; path: SandboxPath; }
interface FilePermissions {
  entries?: SandboxEntry[] | null;
  read?: string[] | null;
  write?: string[] | null;
  globScanMaxDepth?: number | null;
}
export interface PermissionProfile {
  fileSystem?: FilePermissions | null;
  network?: Object | null;
}
export interface PermissionReview { profile: PermissionProfile; display: string; }
interface PermissionResult { permissions: PermissionProfile; scope: string; }
interface PermissionResponse { jsonrpc: string; id: number | string; result: PermissionResult; }

function onlyKeys(value: Object, allowed: string[]): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).every((key: string) => allowed.includes(key));
}

function reviewablePath(value: string, workspace: string): boolean {
  if (typeof value !== 'string' || !value || value.length > 1024 ||
    /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069*?]/.test(value)) { return false; }
  const windows = /^[A-Za-z]:[\\/]/.test(workspace);
  const path = windows ? value.replace(/\\/g, '/') : value;
  const root = (windows ? workspace.replace(/\\/g, '/') : workspace).replace(/\/+$/, '');
  if (windows ? !/^[A-Za-z]:\//.test(path) : !path.startsWith('/')) { return false; }
  if (path.includes('//') || path.includes('\\') ||
    path.split('/').some((part: string) => part === '.' || part === '..')) { return false; }
  if (windows && path.slice(3).split('/').some((part: string) =>
    /[:<>|"\x00-\x1F]/.test(part) || /[. ]$/.test(part))) { return false; }
  return path === root || path.startsWith(root + '/');
}

export function reviewPermissions(profile: PermissionProfile | undefined, workspace: string): PermissionReview | null {
  if (!workspace || !profile || !onlyKeys(profile, ['fileSystem', 'network']) || profile.network != null) { return null; }
  const files = profile.fileSystem;
  if (!files || !onlyKeys(files, ['entries', 'read', 'write', 'globScanMaxDepth']) || files.globScanMaxDepth != null) {
    return null;
  }
  const lines: string[] = [];
  const entries = files.entries ?? [];
  const read = files.read ?? [];
  const write = files.write ?? [];
  if (!Array.isArray(entries) || !Array.isArray(read) || !Array.isArray(write) ||
    entries.length + read.length + write.length > 24) { return null; }
  for (const item of entries) {
    if (!item || !onlyKeys(item, ['access', 'path']) || !item.path || !onlyKeys(item.path, ['type', 'path']) ||
      item.path.type !== 'path' || !reviewablePath(item.path.path ?? '', workspace) ||
      (item.access !== 'read' && item.access !== 'write')) { return null; }
    lines.push((item.access === 'read' ? '读取 ' : '写入 ') + item.path.path);
  }
  for (const path of read) {
    if (!reviewablePath(path, workspace)) { return null; }
    lines.push('读取 ' + path);
  }
  for (const path of write) {
    if (!reviewablePath(path, workspace)) { return null; }
    lines.push('写入 ' + path);
  }
  if (!lines.length) { return null; }
  return { profile: { fileSystem: files }, display: '仅限当前轮次\n' + lines.join('\n') };
}

export function permissionResponse(id: string | number, approved?: PermissionReview): string {
  const result: PermissionResult = { permissions: approved ? approved.profile : {}, scope: 'turn' };
  const response: PermissionResponse = { jsonrpc: '2.0', id: id, result: result };
  return JSON.stringify(response);
}
