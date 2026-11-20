export const PROJECTLESS_ID = '__projectless__';

export interface SidebarThreadRef {
  id: string;
  cwd?: string | null;
}

/**
 * Sidebar group for a thread.
 * A task the user started without choosing a project stays unbound even when
 * the runtime records the default workspace as cwd and that path is a saved project.
 */
export const sidebarProjectIdForThread = (
  thread: SidebarThreadRef,
  unboundThreadIds: ReadonlySet<string>,
  projectIdForCwd: (cwd: string) => string,
): string => {
  if (unboundThreadIds.has(thread.id) || !thread.cwd?.trim()) return PROJECTLESS_ID;
  return projectIdForCwd(thread.cwd.trim());
};

export interface SidebarCwdResolution {
  isEphemeral: (path: string) => boolean;
  savedProjectId: (path: string) => string | undefined;
  mainCheckout: (path: string) => string | undefined;
  projectIdForPath: (path: string) => string;
}

/**
 * Sidebar project for a workspace path.
 * Build output, app data, and other ephemeral directories never become their
 * own project. A linked task worktree stays with its saved checkout. A path
 * that is not a saved project stays unbound instead of inventing a folder.
 */
export const sidebarProjectIdForCwd = (
  cwd: string,
  resolve: SidebarCwdResolution,
): string => {
  const path = cwd.trim();
  if (!path) return PROJECTLESS_ID;
  if (resolve.isEphemeral(path)) {
    const main = resolve.mainCheckout(path);
    if (main && !resolve.isEphemeral(main)) {
      const saved = resolve.savedProjectId(main);
      if (saved && saved !== PROJECTLESS_ID) return saved;
    }
    return PROJECTLESS_ID;
  }
  return resolve.savedProjectId(path) ?? resolve.projectIdForPath(path);
};
