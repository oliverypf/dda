import type { HarnessReadModel, RuntimeTaskOptions } from './models';
import { threadRecoveryBlock } from './thread-recovery';

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

/**
 * `C:\repo.worktrees\session` belongs to `C:\repo`. Other paths stay unchanged.
 * The directory is created beside the main checkout so a second task can run
 * without taking that checkout's workspace lease.
 */
export const mainCheckoutForTaskWorktree = (path: string | undefined | null): string | undefined => {
  if (typeof path !== 'string') return undefined;
  const match = /^(.*[\\/])([^\\/]+)\.worktrees[\\/]([^\\/]+)((?:[\\/].*)?)$/iu.exec(path.trim().replace(/[\\/]+$/u, ''));
  if (!match || /(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(path)) return undefined;
  const home = match[1] + match[2] + match[4];
  return /^(?:[a-z]:|\/\/)/iu.test(home) ? home.replaceAll('/', '\\') : home;
};

/**
 * A linked task worktree (`repo.worktrees/<session>`) belongs to `repo`.
 * Subdirectories and unrelated checkouts stay distinct.
 */
export const sameProjectWorkspace = (left: string, right: string): boolean => {
  if (sameWorkspaceRoot(left, right)) return true;
  const leftMain = mainCheckoutForTaskWorktree(left);
  const rightMain = mainCheckoutForTaskWorktree(right);
  if (leftMain && (sameWorkspaceRoot(leftMain, right) || Boolean(rightMain && sameWorkspaceRoot(leftMain, rightMain)))) return true;
  if (rightMain && sameWorkspaceRoot(rightMain, left)) return true;
  return false;
};

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

const EPHEMERAL_PROJECT_PATTERNS: readonly RegExp[] = [
  // Cargo / Tauri build output & sandbox target directories (`release`, `debug`, `deps`)
  /(?:^|\/)(?:target(?:-[a-z0-9_-]+)?|cargo-target)(?:\/|$)/i,
  // Staged desktop build & runtime data directories under AppData (`desktop-builds`, `hmCodex`, Temp)
  /\/appdata\/(?:local|roaming)\/(?:dda|hmcodex|temp|programs\/dda)(?:\/|$)/i,
  // Windows OS system directories (`C:\Windows`, `C:\Windows\System32`)
  /^[a-z]:\/windows(?:\/|$)/i,
  // Node / package dependency internals
  /(?:^|\/)node_modules(?:\/|$)/i,
  // Sub-module / Tauri crate subdirectories inside a checkout when mistakenly launched directly (`.../desktop`, `.../desktop/src-tauri`)
  /\/desktop\/src-tauri(?:\/|$)/i,
  // Linked task worktrees (`repo.worktrees/<session>`), not a separate project.
  /(?:^|\/)[^/]+\.worktrees(?:\/|$)/i,
  // Staged desktop build directories, including copies that left AppData.
  /(?:^|\/)desktop-builds(?:\/|$)/i
];

/**
 * True when a directory path is a build artifact dir, Cargo target dir, OS
 * system dir, or app-data staging dir that should never be auto-bookmarked as
 * a standalone user project.
 */
export const isEphemeralWorkspaceRoot = (path: string | undefined | null): boolean => {
  if (typeof path !== 'string') return false;
  const key = workspacePathKey(path.trim());
  if (!key) return false;
  return EPHEMERAL_PROJECT_PATTERNS.some((pattern) => pattern.test(key));
};

/**
 * A nested `.../desktop` child of an existing project is dropped only when it
 * owns no persisted threads. Ephemeral build and app-data bookmarks are always dropped.
 */
/** Remove bookmarks that only point at build, app-data, or other ephemeral directories. */
export const dropEphemeralProjectBookmarks = <T extends ProjectBookmarkLike>(
  bookmarks: readonly T[],
): { bookmarks: T[]; removedIds: string[] } => {
  const kept: T[] = [];
  const removedIds: string[] = [];
  for (const bookmark of bookmarks) {
    const paths = deduplicateWorkspaceRoots([bookmark.path, ...(Array.isArray(bookmark.paths) ? bookmark.paths : [])]);
    if (paths.length > 0 && paths.every((path) => isEphemeralWorkspaceRoot(path))) {
      removedIds.push(bookmark.id);
      continue;
    }
    kept.push(bookmark);
  }
  return { bookmarks: kept, removedIds };
};

export const pruneAutoPollutedBookmarks = <T extends ProjectBookmarkLike>(
  bookmarks: readonly T[],
  threadPaths: readonly string[],
): { bookmarks: T[]; removedIds: string[] } => {
  const activeThreadRoots = deduplicateWorkspaceRoots(threadPaths);
  const hasThreadsInRoot = (candidatePath: string): boolean =>
    activeThreadRoots.some((threadRoot) => sameWorkspaceRoot(threadRoot, candidatePath));

  const allBookmarkRoots = bookmarks.map((item) => workspacePathKey(item.path));

  const isNestedDesktopSubdirWithoutThreads = (candidatePath: string): boolean => {
    const key = workspacePathKey(candidatePath);
    if (!key.endsWith('/desktop')) return false;
    const parentKey = key.slice(0, -'/desktop'.length);
    return Boolean(parentKey) && allBookmarkRoots.includes(parentKey);
  };

  const kept: T[] = [];
  const removedIds: string[] = [];
  for (const bookmark of bookmarks) {
    const paths = deduplicateWorkspaceRoots([bookmark.path, ...(Array.isArray(bookmark.paths) ? bookmark.paths : [])]);
    const hasThreads = paths.some(hasThreadsInRoot);
    const onlyEphemeral = paths.length > 0 && paths.every((p) => isEphemeralWorkspaceRoot(p));
    const nestedWithoutThreads = !hasThreads && paths.length > 0
      && paths.every((p) => isEphemeralWorkspaceRoot(p) || isNestedDesktopSubdirWithoutThreads(p));
    // A build or app-data directory is not a project, even when a task cwd
    // still points at it. Those tasks stay unbound or follow the real checkout.
    if (onlyEphemeral || nestedWithoutThreads) {
      removedIds.push(bookmark.id);
      continue;
    }
    kept.push(bookmark);
  }
  return { bookmarks: kept, removedIds };
};

export const workspaceThreadOptions = (model: HarnessReadModel): Pick<RuntimeTaskOptions, 'threadId' | 'resume'> => {
  const thread = model.threads.find((candidate) => candidate.id === model.activeThreadId);
  if (!thread?.cwd || !model.workspace.rootPath || !sameProjectWorkspace(thread.cwd, model.workspace.rootPath)) return {};
  // An uncertain side effect is not replayed. Resume still continues the
  // original task; the runtime replaces that step and finishes from the
  // files as they are.
  if (threadRecoveryBlock(thread)) return { threadId: thread.id, resume: true };
  return {
    threadId: thread.id,
    ...(model.resumeThreadId === thread.id ? { resume: true } : {})
  };
};
