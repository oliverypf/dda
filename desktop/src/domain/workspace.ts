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
