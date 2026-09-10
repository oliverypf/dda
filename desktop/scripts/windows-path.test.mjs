import assert from 'node:assert/strict';
import { basename, normalize } from 'node:path';
import test from 'node:test';

import { projectPaths } from './windows-path.mjs';

test('derives one coherent desktop, workspace, and runtime root', () => {
  const paths = projectPaths(import.meta.url);

  assert.equal(basename(normalize(paths.desktopRoot)), 'desktop');
  assert.equal(normalize(paths.workspaceRoot), normalize(`${paths.desktopRoot}/..`));
  assert.equal(normalize(paths.runtimeRoot), normalize(`${paths.workspaceRoot}/runtime`));
});

test('honors an explicit desktop root before the caller directory', () => {
  const paths = projectPaths(import.meta.url, {
    cwd: pathsForTestRoot(),
    env: { HMCODEX_DESKTOP_ROOT: projectPaths(import.meta.url).desktopRoot }
  });

  assert.equal(basename(normalize(paths.desktopRoot)), 'desktop');
});

function pathsForTestRoot() {
  return projectPaths(import.meta.url).workspaceRoot;
}
