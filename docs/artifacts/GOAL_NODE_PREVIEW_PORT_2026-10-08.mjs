import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)), artifacts = join(root, 'docs/artifacts');
const assembly = JSON.parse(await readFile(join(artifacts, 'GOAL_NODE_PREVIEW_RUNTIME_ASSEMBLE_2026-10-08.json'), 'utf8'));
const series = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_CURRENT_COMPARE_SERIES_2026-10-08.json'), 'utf8'));
if (series.status !== 'COMPLETE' || series.steps.some(step => step.status !== 'COMPLETE' || !step.matchesVerifiedRuntime)) throw Error('FROZEN_SERIES_NOT_COMPLETE');
const hash = value => createHash('sha256').update(value).digest('hex');
const files = [];
for (const path of (await readdir(join(root, 'runtime/src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort())
  files.push({ path: path.replaceAll('\\', '/'), sha256: hash(await readFile(join(root, 'runtime/src', path))) });
for (const name of ['package.json', 'package-lock.json']) files.push({ path: `../${name}`, sha256: hash(await readFile(join(root, 'runtime', name))) });
if (hash(JSON.stringify(files)) !== assembly.originalSourceSha256) throw Error('MAIN_SOURCE_CHANGED_SINCE_ISOLATION');
// Validate every target before writing any file, so intervening user edits are preserved.
for (const file of assembly.stagedChanges) {
  const target = join(root, 'runtime/src', file.path), staged = join(assembly.target, 'src', file.path);
  if (hash(await readFile(staged)) !== file.stagedSha256) throw Error(`STAGED_CHANGE_DRIFT:${file.path}`);
  if (file.originalSha256 === null) {
    try { await access(target); throw Error(`NEW_TARGET_EXISTS:${file.path}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else if (hash(await readFile(target)) !== file.originalSha256) throw Error(`MAIN_TARGET_DRIFT:${file.path}`);
}
let previewTests = (await readFile(join(artifacts, 'GOAL_NODE_PREVIEW_STAGE_2026-10-08.test.mjs'), 'utf8')).replaceAll('\r\n', '\n');
previewTests = previewTests.replace("import { proposedToolDecisionClaim as baseline } from '../../runtime/src/decision/evidence-claim.mjs';\n", '')
  .replace("import { toolWorkspaceDecisionEvidence as baselineContext } from '../../runtime/src/decision/workspace-context.mjs';\n", '')
  .replaceAll("'./goal-node-preview-fix-20261008/src/", "'../src/")
  .replaceAll("'../../runtime/src/", "'../src/");
previewTests = previewTests.replace(/test\('the frozen source has a contradictory opaque preview[\s\S]*?\n\}\);\n\n/u, '');
previewTests = previewTests.replace("  assert.deepEqual(await baselineContext({ ...input, proposedInputClaim: baseline('test.execute', requests[1]) }), []);\n", '');
previewTests = previewTests.replaceAll('staged ', '').replaceAll('Staged ', '').replaceAll(' now ', ' ');
if (previewTests.includes('baselineContext') || previewTests.includes('baseline(') || previewTests.includes('the frozen source has')) throw Error('REPRODUCTION_ASSERTION_NOT_REMOVED');
const timeoutTests = await readFile(join(artifacts, 'GOAL_WORKSPACE_TIMEOUT_PORT_TEST_2026-10-08.mjs'), 'utf8');
for (const name of ['node-preview-runtime.test.mjs', 'workspace-io-timeout.test.mjs']) {
  try { await access(join(root, 'runtime/test', name)); throw Error(`TEST_TARGET_EXISTS:${name}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
for (const file of assembly.stagedChanges) await writeFile(join(root, 'runtime/src', file.path), await readFile(join(assembly.target, 'src', file.path)));
await writeFile(join(root, 'runtime/test/node-preview-runtime.test.mjs'), previewTests, { flag: 'wx' });
await writeFile(join(root, 'runtime/test/workspace-io-timeout.test.mjs'), timeoutTests, { flag: 'wx' });
await writeFile(join(artifacts, 'GOAL_NODE_PREVIEW_PORT_2026-10-08.json'), JSON.stringify({
  mergedAt: new Date().toISOString(), priorSourceSha256: assembly.originalSourceSha256,
  changes: assembly.stagedChanges, tests: ['node-preview-runtime.test.mjs', 'workspace-io-timeout.test.mjs'], frozenSeriesCompleted: true
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ merged: true, sourceFiles: assembly.stagedChanges.map(file => file.path) }));
