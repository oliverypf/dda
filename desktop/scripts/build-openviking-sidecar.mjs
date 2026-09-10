import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const srcTauriRoot = join(desktopRoot, 'src-tauri');
const target = process.argv.includes('--debug') ? 'debug' : 'release';
const targetTriple = process.argv.includes('--target')
  ? process.argv[process.argv.indexOf('--target') + 1]
  : 'x86_64-pc-windows-msvc';
const args = ['build', '--features', 'sidecar', '--bin', 'openviking-server', '--target', targetTriple];
if (target === 'release') args.push('--release');
const bundleDirectory = join(srcTauriRoot, 'binaries');
mkdirSync(bundleDirectory, { recursive: true });
const tripleBinary = join(bundleDirectory, `openviking-server-${targetTriple}.exe`);
const canonicalBinary = join(bundleDirectory, 'openviking-server.exe');
if (canonicalBinary !== tripleBinary && !existsSync(canonicalBinary) && existsSync(tripleBinary)) {
  copyFileSync(tripleBinary, canonicalBinary);
}
const build = spawnSync('cargo', args, {
  cwd: srcTauriRoot,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [] } })
  }
});
if (build.error) throw build.error;
if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
} else {
  const output = join(srcTauriRoot, 'target', targetTriple, target, 'openviking-server.exe');
  copyFileSync(output, join(bundleDirectory, `openviking-server-${targetTriple}.exe`));
  if (canonicalBinary !== output) copyFileSync(output, canonicalBinary);
}
if (process.argv.includes('--test')) {
  const test = spawnSync('cargo', ['test', '--lib'], { cwd: srcTauriRoot, stdio: 'inherit', windowsHide: true });
  if (test.error) throw test.error;
  if (test.status !== 0) process.exitCode = test.status ?? 1;
}
