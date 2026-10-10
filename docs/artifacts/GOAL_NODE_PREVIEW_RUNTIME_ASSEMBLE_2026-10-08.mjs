import { mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'runtime'), target = join(root, 'docs/artifacts/goal-node-preview-fix-20261008');
const hash = value => createHash('sha256').update(value).digest('hex');
const audit = JSON.parse(await readFile(join(root, 'docs/artifacts/AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-08.json'), 'utf8'));
const staged = [
  ...JSON.parse(await readFile(join(root, 'docs/artifacts/GOAL_NODE_PREVIEW_STAGE_MANIFEST_2026-10-08.json'), 'utf8')).files,
  ...JSON.parse(await readFile(join(root, 'docs/artifacts/GOAL_WORKSPACE_TIMEOUT_STAGE_MANIFEST_2026-10-08.json'), 'utf8')).files
];
const known = new Map(staged.map(file => [file.path, file]));
const baseline = [];
for (const path of (await readdir(join(source, 'src'), { recursive: true })).filter(path => path.endsWith('.mjs')).sort()) {
  const normalized = path.replaceAll('\\', '/'), original = await readFile(join(source, 'src', path));
  baseline.push({ path: normalized, sha256: hash(original) });
  const file = known.get(normalized), output = join(target, 'src', path);
  if (file) {
    if (file.originalSha256 !== hash(original) || file.stagedSha256 !== hash(await readFile(output))) throw Error(`STAGED_SOURCE_CHANGED:${normalized}`);
  } else {
    await mkdir(dirname(output), { recursive: true });
    try { await access(output); throw Error(`UNEXPECTED_EXISTING_SOURCE:${normalized}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(output, original, { flag: 'wx' });
  }
}
for (const name of ['package.json', 'package-lock.json']) {
  const bytes = await readFile(join(source, name)); baseline.push({ path: `../${name}`, sha256: hash(bytes) });
  await writeFile(join(target, name), bytes, { flag: 'wx' });
}
if (hash(JSON.stringify(baseline)) !== audit.runtimeSourceSha256) throw Error('FROZEN_MAIN_SOURCE_CHANGED');
await writeFile(join(root, 'docs/artifacts/GOAL_NODE_PREVIEW_RUNTIME_ASSEMBLE_2026-10-08.json'), JSON.stringify({
  createdAt: new Date().toISOString(), source, target, originalSourceSha256: audit.runtimeSourceSha256,
  stagedChanges: staged.filter(file => file.changed), appliedToMain: false
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ target, originalSourceSha256: audit.runtimeSourceSha256, changedFiles: staged.filter(file => file.changed).map(file => file.path) }));
