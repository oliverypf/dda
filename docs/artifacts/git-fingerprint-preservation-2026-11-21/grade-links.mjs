import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const suite = join(dirname(fileURLToPath(import.meta.url)), 'multi-link.test.mjs');
const testNames = ['additional_link_with_existing_link', 'move_link_between_metadata_paths'];
const executionEnv = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES']);

async function sourceTree(root) {
  const hash = createHash('sha256');
  async function visit(path) {
    for (const name of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) =>
      Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      const relative = path ? path + '/' + name.name : name.name;
      if (name.isDirectory()) await visit(relative);
      else if (name.isFile()) {
        hash.update(relative + '\0');
        hash.update(createHash('sha256').update(await readFile(join(root, relative))).digest());
      } else throw new Error('Unsupported product source entry: ' + relative);
    }
  }
  await visit('');
  return 'sha256:' + hash.digest('hex');
}

export async function gradeLinks(workspace, outputDir) {
  const temp = await mkdtemp(join(tmpdir(), 'dda-link-grade-'));
  const evidence = join(temp, 'records');
  const source = join(workspace, 'runtime/src');
  const product = join(temp, 'release/runtime/src');
  await mkdir(outputDir, { recursive: true });
  try {
    const originalDigest = await sourceTree(source);
    await mkdir(evidence);
    await cp(source, product, { recursive: true });
    if (await sourceTree(product) !== originalDigest) throw new Error('Source copy differs from the version being graded');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => executionEnv.has(key.toUpperCase())));
    const proc = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suite], {
      cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env: { ...env, DDA_LINKS_RELEASE: join(temp, 'release'), DDA_LINKS_RECORDS: evidence }
    });
    await writeFile(join(outputDir, 'tests.tap'), (proc.stdout ?? '') + (proc.stderr ?? ''));
    const tests = [];
    for (const name of testNames) {
      try { tests.push(JSON.parse(await readFile(join(evidence, name + '.json'), 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        tests.push({ name, status: 'error', message: proc.error?.message ?? 'Missing test receipt' });
      }
    }
    const passed = tests.filter(test => test.status === 'passed').length;
    const failed = tests.filter(test => test.status === 'failed').length;
    const errored = tests.filter(test => test.status === 'error').length;
    const grade = { sourceTreeSha256: originalDigest, gradeSuiteSha256: 'sha256:' + createHash('sha256').update(await readFile(suite)).digest('hex'),
      platform: process.platform, node: process.version, exitCode: proc.status, passed, failed, errored,
      green: passed === 2 && proc.status === 0, tests };
    if (await sourceTree(source) !== originalDigest) throw new Error('The version being graded changed during scoring');
    await writeFile(join(outputDir, 'grade.json'), JSON.stringify(grade, null, 2) + '\n');
    return grade;
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node grade-links.mjs <workspace> <output-directory>');
  const grade = await gradeLinks(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log(JSON.stringify({ passed: grade.passed, failed: grade.failed, errored: grade.errored, mode: grade.tests[0]?.mode }));
  process.exitCode = grade.errored ? 2 : grade.green ? 0 : 1;
}
