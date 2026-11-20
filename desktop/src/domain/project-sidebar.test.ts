import { describe, expect, it } from 'vitest';
import { PROJECTLESS_ID, sidebarProjectIdForCwd, sidebarProjectIdForThread } from './project-sidebar';

const projectIdForCwd = (cwd: string): string =>
  cwd.replaceAll('\\', '/').toLowerCase().includes('hmcodex-local') ? 'project:hmcodex-local' : `project:${cwd}`;

describe('sidebarProjectIdForThread', () => {
  const thread = { id: 'hy4', cwd: 'C:\\Users\\User\\hmCodex-local' };

  it('keeps a task started without a project out of the saved project that shares the default cwd', () => {
    expect(sidebarProjectIdForThread(thread, new Set(['hy4']), projectIdForCwd)).toBe(PROJECTLESS_ID);
  });

  it('files a project task by its workspace', () => {
    expect(sidebarProjectIdForThread(thread, new Set(), projectIdForCwd)).toBe('project:hmcodex-local');
  });

  it('leaves a thread with no cwd unbound', () => {
    expect(sidebarProjectIdForThread({ id: 'draft', cwd: '  ' }, new Set(), projectIdForCwd)).toBe(PROJECTLESS_ID);
  });
});

describe('sidebarProjectIdForCwd', () => {
  const resolve = {
    isEphemeral: (path: string) => /desktop-builds|\.worktrees|\\target\\/i.test(path),
    savedProjectId: (path: string) => path.replaceAll('/', '\\').toLowerCase().endsWith('\\hmcodex-local') ? 'project:hmcodex-local' : undefined,
    mainCheckout: (path: string) => {
      const normalized = path.replaceAll('/', '\\');
      const marker = '\\hmCodex-local.worktrees\\';
      const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
      return index >= 0 ? normalized.slice(0, index) + '\\hmCodex-local' : undefined;
    },
    projectIdForPath: (path: string) => `project:${path}`,
  };

  it('does not invent a project for a staged build directory', () => {
    expect(sidebarProjectIdForCwd('C:\\Users\\User\\AppData\\Local\\dda\\desktop-builds\\build-x86_64-pc-windows-msvc-xHVOii', resolve))
      .toBe(PROJECTLESS_ID);
  });

  it('keeps a task worktree on the saved checkout instead of a new folder', () => {
    expect(sidebarProjectIdForCwd('C:\\Users\\User\\hmCodex-local.worktrees\\ui-mwjb0mx8-2-lmvzzt', resolve))
      .toBe('project:hmcodex-local');
  });

  it('leaves a worktree unbound when its checkout was never saved', () => {
    expect(sidebarProjectIdForCwd('D:\\other.worktrees\\ui-session', {
      ...resolve,
      savedProjectId: () => undefined,
      mainCheckout: () => 'D:\\other',
    })).toBe(PROJECTLESS_ID);
  });
});
