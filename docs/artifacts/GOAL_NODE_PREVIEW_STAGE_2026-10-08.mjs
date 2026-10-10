import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const target = join(root, 'docs/artifacts/goal-node-preview-fix-20261008/src');
const files = ['decision/evidence-claim.mjs', 'decision/process-intent.mjs', 'decision/workspace-context.mjs',
  'runtime-safety-monitor.mjs', 'windows-path.mjs'];
const manifest = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const path of files) {
  const original = await readFile(join(root, 'runtime/src', path), 'utf8');
  let staged = original;
  if (path === 'decision/evidence-claim.mjs') {
    const anchor = 'export const proposedToolDecisionClaim = (name, request = {}) => {';
    if (original.split(anchor).length !== 2) throw Error('PREVIEW_SOURCE_ANCHOR_CHANGED');
    staged = "import { nodeProcessIntent, normalizedNodeProcessRequest } from './process-intent.mjs';\n\n" + original.replace(anchor,
      `${anchor}\n  // Use the executor parser for bounded Node forms. This describes only a\n  // proposal: private overrides, opaque forms and host authorization remain\n  // outside this claim; no lease or execution evidence is created.\n  if (['test.execute', 'shell.execute'].includes(name) && nodeProcessIntent(request)) {\n    request = normalizedNodeProcessRequest(request);\n  }`);
  }
  if (path === 'decision/workspace-context.mjs') staged = original.replace("preview.commandName !== 'node'", "!['node', 'node.exe'].includes(preview.commandName)");
  await mkdir(dirname(join(target, path)), { recursive: true });
  await writeFile(join(target, path), staged, { flag: 'wx' });
  manifest.push({ path, originalSha256: hash(original), stagedSha256: hash(staged), changed: original !== staged });
}
await writeFile(join(root, 'docs/artifacts/GOAL_NODE_PREVIEW_STAGE_MANIFEST_2026-10-08.json'), JSON.stringify({
  createdAt: new Date().toISOString(), target, appliedToMain: false, files: manifest
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ target, changedFiles: manifest.filter(file => file.changed).map(file => file.path) }));
