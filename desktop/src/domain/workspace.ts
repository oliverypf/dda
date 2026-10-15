import type { HarnessReadModel, RuntimeTaskOptions } from './models';

const workspacePathKey = (path: string): string => {
  const normalized = path.replaceAll('\\', '/')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\/\/\?\//, '')
    .replace(/\/+$/, '');
  return /^[a-z]:(?:\/|$)/i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
};

export const sameWorkspaceRoot = (left: string, right: string): boolean =>
  workspacePathKey(left) === workspacePathKey(right);

export const deduplicateWorkspaceRoots = (paths: readonly string[]): string[] => {
  const roots = new Map<string, string>();
  for (const path of paths) {
    if (typeof path !== 'string') continue;
    const trimmed = path.trim();
    if (!trimmed) continue;
    const key = workspacePathKey(trimmed);
    if (!roots.has(key)) roots.set(key, trimmed);
  }
  return [...roots.values()];
};


export type ProjectBookmarkLike = {
  id: string;
  name: string;
  path: string;
  paths?: readonly string[];
  lastUsedAtMs?: number;
};

/** Merge catalog entries that share a workspace root (sameWorkspaceRoot). Keeps the first id. */
export const mergeProjectBookmarksByWorkspaceRoot = <T extends ProjectBookmarkLike>(
  bookmarks: readonly T[],
): { bookmarks: T[]; idRemap: Record<string, string> } => {
  const merged: T[] = [];
  const idRemap: Record<string, string> = {};
  for (const item of bookmarks) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.path !== 'string') continue;
    const paths = deduplicateWorkspaceRoots([item.path, ...(Array.isArray(item.paths) ? item.paths : [])]);
    if (!paths.length) continue;
    const existing = merged.find((candidate) =>
      deduplicateWorkspaceRoots([candidate.path, ...(Array.isArray(candidate.paths) ? candidate.paths : [])])
        .some((left) => paths.some((right) => sameWorkspaceRoot(left, right))));
    if (!existing) {
      merged.push({
        ...item,
        path: paths[0]!,
        paths,
        lastUsedAtMs: Number(item.lastUsedAtMs) || 0,
      } as T);
      continue;
    }
    if (item.id !== existing.id) idRemap[item.id] = existing.id;
    const nextPaths = deduplicateWorkspaceRoots([
      existing.path,
      ...(Array.isArray(existing.paths) ? existing.paths : []),
      ...paths,
    ]);
    Object.assign(existing, {
      name: existing.name.trim() || item.name.trim() || existing.name,
      path: nextPaths[0] ?? existing.path,
      paths: nextPaths,
      lastUsedAtMs: Math.max(Number(existing.lastUsedAtMs) || 0, Number(item.lastUsedAtMs) || 0),
    });
  }
  return { bookmarks: merged, idRemap };
};


export type ProjectArchiveRecordLike = {
  name: string;
  path: string;
  archivedAtMs: number;
};

/** Move archive rows from dropped bookmark ids onto the surviving id after catalog merge. */
export const remapProjectArchiveIds = <T extends ProjectArchiveRecordLike>(
  archives: Record<string, T>,
  idRemap: Record<string, string>,
): { archives: Record<string, T>; changed: boolean } => {
  if (!idRemap || !Object.keys(idRemap).length) return { archives, changed: false };
  const next: Record<string, T> = { ...archives };
  let changed = false;
  for (const [fromId, toId] of Object.entries(idRemap)) {
    if (!fromId || !toId || fromId === toId) continue;
    const from = next[fromId];
    if (!from) continue;
    const existing = next[toId];
    if (!existing) next[toId] = from;
    else if (from.archivedAtMs < existing.archivedAtMs) {
      // Keep the earlier archive stamp; name/path prefer the survivor row.
      next[toId] = { ...existing, archivedAtMs: from.archivedAtMs };
    }
    delete next[fromId];
    changed = true;
  }
  return { archives: next, changed };
};

export const workspaceRootForDisplay = (path: string): string => path
  .replace(/^\\\\\?\\UNC\\/iu, '\\\\')
  .replace(/^\\\\\?\\/u, '');

export const workspaceThreadOptions = (model: HarnessReadModel): Pick<RuntimeTaskOptions, 'threadId' | 'resume'> => {
  const thread = model.threads.find((candidate) => candidate.id === model.activeThreadId);
  if (!thread?.cwd || !model.workspace.rootPath || !sameWorkspaceRoot(thread.cwd, model.workspace.rootPath)) return {};
  return {
    threadId: thread.id,
    ...(model.resumeThreadId === thread.id ? { resume: true } : {})
  };
};
