import { spawnSync } from 'node:child_process';
import { projectPaths } from './windows-path.mjs';

// node:test scripts under scripts/ are excluded from the Vitest run in
// scripts/test.mjs (Vitest compares realpath-resolved filters and would turn a
// mapped Z: root into UNC). They are executed here with Node's own runner so
// the W10 evidence gate and build-channel tests are part of the regression
// entry points instead of only being runnable by hand.
const { desktopRoot } = projectPaths(import.meta.url);
const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=4', 'scripts/*.test.mjs'],
  { cwd: desktopRoot, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
