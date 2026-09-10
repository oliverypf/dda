import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    join(desktopRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--configLoader',
    'native',
    '--dir',
    'src',
    // Path tests use Node's built-in node:test runner and are invoked by
    // `npm run path:test`; Vitest must not treat them as empty suites.
    '--exclude',
    'scripts/**/*.test.mjs',
    // Do not pass relative file filters here. Vitest 4 compares those
    // filters with realpath-resolved files, which turns a mapped Z: root into
    // UNC and reports existing tests as missing. Scanning the source subtree
    // keeps discovery deterministic while allowing new frontend tests.
    ...process.argv.slice(2)
  ],
  // Keep the child process in the same mapped-drive root. Starting Vitest from
  // the parent workspace lets Vite canonicalise that parent to UNC.
  { cwd: desktopRoot, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
