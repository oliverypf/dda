import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { projectPaths } from './windows-path.mjs';
import { resolveWindowsProcessCommand } from '../../runtime/src/platform/windows-command.mjs';

const { runtimeRoot: runtimeDir } = projectPaths(import.meta.url);
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('dda requires Node.js 24 or newer with built-in SQLite support.');
}
const { DatabaseSync, backup } = await import('node:sqlite');
if (typeof DatabaseSync !== 'function' || typeof backup !== 'function') {
  throw new Error('dda requires node:sqlite DatabaseSync and backup support.');
}
const sqliteProbe = new DatabaseSync(':memory:');
try { sqliteProbe.prepare('SELECT sqlite_version()').get(); } finally { sqliteProbe.close(); }
const manifest = JSON.parse(readFileSync(resolve(runtimeDir, 'package.json'), 'utf8'));
const missing = Object.keys(manifest.dependencies).some(name =>
  !existsSync(resolve(runtimeDir, 'node_modules', name, 'package.json')));

if (missing) {
  const npm = await resolveWindowsProcessCommand({ command: 'npm', args: ['install', '--omit=dev'] });
  const result = spawnSync(npm.command, npm.args, {
    cwd: runtimeDir,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
