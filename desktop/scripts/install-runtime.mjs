import { spawnSync } from 'node:child_process';
import { projectPaths } from './windows-path.mjs';

const { runtimeRoot } = projectPaths(import.meta.url);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['install', '--omit=dev'], {
  cwd: runtimeRoot,
  stdio: 'inherit'
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
