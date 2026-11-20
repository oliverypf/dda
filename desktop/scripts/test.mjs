import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const args = process.argv.slice(2);
const customReporter = args.some(arg => /^(?:--(?:reporters?|outputFile|config)|-c)(?:[=.\s]|$)/u.test(arg));
const reportDir = customReporter ? undefined : await mkdtemp(join(tmpdir(), 'dda-vitest-')).catch(() => undefined);
const reportPath = reportDir ? join(reportDir, 'results.json') : undefined;

try {
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
      // Relative file filters can disagree with realpath-resolved files on
      // mapped Windows drives. Discover tests under the desktop source root.
      ...args,
      ...(reportPath ? ['--reporter=default', '--reporter=json', `--outputFile.json=${reportPath}`] : [])
    ],
    // Keep the child process in the same mapped-drive root.
    { cwd: desktopRoot, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (reportPath) {
    try {
      if ((await stat(reportPath)).size <= 16 * 1024 * 1024) {
        const { numTotalTests: tests, numPassedTests: pass, numFailedTests: fail,
          numPendingTests: skipped, numTodoTests: todo, testResults } = JSON.parse(await readFile(reportPath, 'utf8'));
        if ([tests, pass, fail, skipped, todo].every(number => Number.isSafeInteger(number) && number >= 0) && tests === pass + fail + skipped + todo) {
          const root = await realpath(desktopRoot);
          const suites = (Array.isArray(testResults) ? testResults : []).flatMap(file => {
            if (typeof file?.name !== 'string') return [];
            const path = relative(root, file.name).replaceAll('\\', '/');
            return path && path !== '..' && !path.startsWith('../') && !isAbsolute(path) ? [path.slice(0, 160)] : [];
          });
          console.log(`DDA_TEST_RESULT ${JSON.stringify({ version: 1, tests, pass, fail, skipped, todo, suites: [...new Set(suites)].slice(0, 32) })}`);
        }
      }
    } catch { /* The regular reporter still supplies the original output. */ }
  }
} finally {
  if (reportPath) await unlink(reportPath).catch(() => {});
  if (reportDir) await rmdir(reportDir).catch(() => {});
}
