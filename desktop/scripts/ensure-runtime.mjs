import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { runtimeRoot: runtimeDir } = projectPaths(import.meta.url);
if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('hmCodex requires Node.js 24 or newer with built-in SQLite support.');
}
const { DatabaseSync, backup } = await import('node:sqlite');
if (typeof DatabaseSync !== 'function' || typeof backup !== 'function') {
  throw new Error('hmCodex requires node:sqlite DatabaseSync and backup support.');
}
const sqliteProbe = new DatabaseSync(':memory:');
try { sqliteProbe.prepare('SELECT sqlite_version()').get(); } finally { sqliteProbe.close(); }
const cordisEntry = resolve(runtimeDir, 'node_modules/@deepseek-ai/cordis/package.json');

if (!existsSync(cordisEntry)) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--omit=dev'], {
    cwd: runtimeDir,
    stdio: 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
