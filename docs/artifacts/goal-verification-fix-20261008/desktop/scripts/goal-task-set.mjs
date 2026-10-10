import { readdir, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEvidenceProcess } from './goal-evidence-process.mjs';

export const TASK_SET_VERSION = '3.1';
const inspect = [
  { taskId: 'inspect-readme-001', prompt: 'Read README.md using a tool and report its evidence marker.', acceptance: 'marker', recoverable: false },
  { taskId: 'inspect-layout-001', prompt: 'List the project directory using a tool. Report the README.md, package.json, name.mjs and name.test.mjs entries you find.', acceptance: 'layout', recoverable: false },
  { taskId: 'recoverable-read-001', prompt: 'The recovery test requires an observable failed tool call. First invoke a tool that ONLY reads missing-evidence.txt and lets its missing-file error occur. Do not check existence, catch the error, or combine a fallback command in this first call. Only AFTER receiving that tool error, invoke a separate tool to read README.md and report its evidence marker.', acceptance: 'marker', recoverable: true }
];
export const GOAL_TASKS = Object.freeze([...inspect,
  { taskId: 'code-normalize-001', suite: 'engineering', mode: 'CONTROLLED', acceptance: 'code', recoverable: true, target: 'name.mjs', initialCommand: ['--test', '--test-isolation=none'],
    prompt: 'First run node --test --test-isolation=none as a separate tool call to observe the existing test failure. Then fix only name.mjs. normalizeName must return an empty string for null/undefined, convert other values to strings, apply Unicode NFKC, trim, collapse internal whitespace to a single space, and lowercase. Preserve the export and all other files, including tests. Use declared tools to edit and rerun node --test --test-isolation=none until it passes. Report the actual result.',
    initial: 'export const normalizeName = value => value.trim().toLowerCase();\n',
    tests: "import test from 'node:test'; import assert from 'node:assert/strict'; import {normalizeName} from './name.mjs'; test('normalizes names', () => { assert.equal(normalizeName(' Alice '), 'alice'); assert.equal(normalizeName(null), ''); assert.equal(normalizeName('A  B'), 'a b'); });\n",
    solution: "export const normalizeName = value => value == null ? '' : String(value).normalize('NFKC').trim().replace(/\\s+/g, ' ').toLowerCase();\n",
    assertions: "assert.equal(m.normalizeName(null), ''); assert.equal(m.normalizeName(undefined), ''); assert.equal(m.normalizeName(42), '42'); assert.equal(m.normalizeName('  ＡＬＩＣＥ\\t Smith  '), 'alice smith'); assert.equal(m.normalizeName('\\n A   B \\n'), 'a b'); assert.equal(m.normalizeName(''), '');", checks: 6 },
  { taskId: 'code-syntax-001', suite: 'engineering', mode: 'CONTROLLED', acceptance: 'code', recoverable: true, target: 'tags.mjs', initialCommand: ['--check', 'tags.mjs'],
    prompt: 'First run node --check tags.mjs in a separate tool call to observe the syntax failure. Then repair only tags.mjs. parseTags must accept a comma-separated string, trim/lowercase each tag, drop empty tags, remove duplicates while keeping their first occurrence order, and return [] for null/undefined. Preserve the export and all other files, including tests. Run node --check tags.mjs and node --test --test-isolation=none and report their real results.',
    initial: "export const parseTags = value => { return String(value).split(',').map(item => item.trim(); };\n",
    tests: "import test from 'node:test'; import assert from 'node:assert/strict'; import {parseTags} from './tags.mjs'; test('parses tags', () => { assert.deepEqual(parseTags('a, b, a'), ['a','b']); assert.deepEqual(parseTags(null), []); });\n",
    solution: "export const parseTags = value => value == null ? [] : [...new Set(String(value).split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];\n",
    assertions: "assert.deepEqual(m.parseTags(null), []); assert.deepEqual(m.parseTags(undefined), []); assert.deepEqual(m.parseTags('  A, b, a,, B, c '), ['a','b','c']); assert.deepEqual(m.parseTags(' , , '), []); assert.deepEqual(m.parseTags('z,a,z,b'), ['z','a','b']);", checks: 5 },
  { taskId: 'code-feature-001', suite: 'engineering', mode: 'CONTROLLED', acceptance: 'code', recoverable: true, target: 'name.mjs', initialCommand: ['--test', '--test-isolation=none'],
    prompt: 'First run node --test --test-isolation=none in a separate tool call to observe the missing feature failure. Then add only to name.mjs an exported uniqueNames(values). It must return [] for non-array input; normalize each item with the existing normalizeName, discard empty names, and return unique normalized names in first occurrence order. Preserve normalizeName and all other files, including tests. Edit using declared tools, rerun node --test --test-isolation=none, and report the actual result.',
    initial: "export const normalizeName = value => value == null ? '' : String(value).trim().toLowerCase();\n",
    tests: "import test from 'node:test'; import assert from 'node:assert/strict'; import {uniqueNames} from './name.mjs'; test('deduplicates names', () => assert.deepEqual(uniqueNames(['Alice',' alice ','Bob']), ['alice','bob']));\n",
    solution: "export const normalizeName = value => value == null ? '' : String(value).trim().toLowerCase();\nexport const uniqueNames = values => Array.isArray(values) ? [...new Set(values.map(normalizeName).filter(Boolean))] : [];\n",
    assertions: "assert.deepEqual(m.uniqueNames(null), []); assert.deepEqual(m.uniqueNames('Alice'), []); assert.deepEqual(m.uniqueNames([' BOB ',null,'Alice','bob',undefined,'',' ALICE ',42]), ['bob','alice','42']); assert.equal(m.normalizeName(null), ''); assert.equal(m.normalizeName(' X '), 'x');", checks: 5 }
]);

export const goalTaskFiles = (task, marker) => ({
  'README.md': `# Goal evidence\n${marker}\n`,
  'package.json': '{"name":"goal-evidence-task","type":"module","scripts":{"test":"node --test --test-isolation=none"}}\n',
  [task.target ?? 'name.mjs']: task.initial ?? 'export const normalizeName = value => String(value).trim().toLowerCase();\n',
  [task.target === 'tags.mjs' ? 'tags.test.mjs' : 'name.test.mjs']: task.tests ?? "import test from 'node:test'; import assert from 'node:assert/strict'; import {normalizeName} from './name.mjs'; test('normalizes', () => assert.equal(normalizeName(' Alice '), 'alice'));\n"
});

export const verifyCodeTask = async ({ task, workspace, initialFiles }) => {
  if (task.acceptance !== 'code') return null;
  const paths = (await readdir(workspace, { recursive: true })).sort();
  const expected = Object.keys(initialFiles).sort();
  const scopeChecks = {
    onlyExpectedFiles: JSON.stringify(paths) === JSON.stringify(expected),
    onlyTargetChanged: true, targetChanged: false, ordinaryFiles: true
  };
  for (const path of expected) {
    let info;
    try { info = await lstat(join(workspace, path)); } catch { return { passed: false, scopeChecks, error: 'EXPECTED_FILE_MISSING', path }; }
    scopeChecks.ordinaryFiles &&= info.isFile() && !info.isSymbolicLink();
    if (!info.isFile() || info.isSymbolicLink()) return { passed: false, scopeChecks, error: 'EXPECTED_ORDINARY_FILE', path };
    const content = await readFile(join(workspace, path), 'utf8');
    if (path === task.target) scopeChecks.targetChanged = content !== initialFiles[path];
    else scopeChecks.onlyTargetChanged &&= content === initialFiles[path];
  }
  if (!Object.values(scopeChecks).every(Boolean)) return { passed: false, scopeChecks };
  const source = `import assert from 'node:assert/strict'; const m = await import(${JSON.stringify(pathToFileURL(join(workspace, task.target)).href)}); ${task.assertions} console.log('GOAL_INDEPENDENT_ASSERTIONS_PASSED:${task.checks}');`;
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter(name => process.env[name]).map(name => [name, process.env[name]]));
  const syntax = await runEvidenceProcess(process.execPath, ['--check', task.target], { cwd: workspace, env, inheritEnv: false, timeoutMs: 10000 });
  const assertions = await runEvidenceProcess(process.execPath, ['--input-type=module', '-e', source], { cwd: workspace, env, inheritEnv: false, timeoutMs: 10000 });
  const visibleTests = await runEvidenceProcess(process.execPath, ['--test', '--test-isolation=none'], { cwd: workspace, env, inheritEnv: false, timeoutMs: 10000 });
  const passed = [syntax, assertions, visibleTests].every(result => result.code === 0 && !result.timedOut)
    && assertions.stdout.trim() === `GOAL_INDEPENDENT_ASSERTIONS_PASSED:${task.checks}`;
  return { passed, scopeChecks, syntax, assertions, visibleTests, independentAssertions: task.checks };
};
