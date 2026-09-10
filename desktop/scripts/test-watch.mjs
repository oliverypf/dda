import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const forwarded = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [join(desktopRoot, 'node_modules/vitest/vitest.mjs'), '--configLoader', 'native', '--root', desktopRoot, ...forwarded],
  { cwd: desktopRoot, stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
