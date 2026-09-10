import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, [join(desktopRoot, 'node_modules/typescript/bin/tsc'), '-p', join(desktopRoot, 'tsconfig.json'), '--noEmit']);
run(process.execPath, [join(desktopRoot, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(desktopRoot, 'vite.config.ts'), '--configLoader', 'native']);
