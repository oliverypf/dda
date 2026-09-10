import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const result = spawnSync(
  process.execPath,
  ['--test', join(desktopRoot, 'scripts/windows-path.test.mjs')],
  { cwd: desktopRoot, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
