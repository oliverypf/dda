import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const target = join(root, 'docs/artifacts/goal-node-preview-fix-20261008/src');
const hash = value => createHash('sha256').update(value).digest('hex');
const files = [];
const helper = `// Keep a pending I/O deadline alive, but release its timer as soon as either\n// branch settles. This changes no filesystem policy or timeout duration.\nexport const withWorkspaceIoTimeout = async (promise, label, timeoutMs = 60000) => {\n  let timer;\n  try {\n    return await Promise.race([promise, new Promise((_, reject) => {\n      timer = setTimeout(() => reject(new Error(\`WORKSPACE_IO_TIMEOUT:\${label}\`)), timeoutMs);\n    })]);\n  } finally { clearTimeout(timer); }\n};\n`;
await writeFile(join(target, 'workspace-io-timeout.mjs'), helper, { flag: 'wx' });
files.push({ path: 'workspace-io-timeout.mjs', originalSha256: null, stagedSha256: hash(helper), changed: true });
for (const path of ['plugins/workspace-readonly.mjs', 'plugins/cordis-plugin.mjs']) {
  const original = await readFile(join(root, 'runtime/src', path), 'utf8');
  let staged = original;
  if (path.endsWith('workspace-readonly.mjs')) {
    const anchor = "const withTimeout = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`WORKSPACE_IO_TIMEOUT:${label}`)), LIST_TIMEOUT_MS))]);";
    if (original.split(anchor).length !== 2) throw Error('WORKSPACE_TIMEOUT_SOURCE_CHANGED');
    staged = "import { withWorkspaceIoTimeout } from '../workspace-io-timeout.mjs';\n" + original.replace(anchor,
      'const withTimeout = (promise, label) => withWorkspaceIoTimeout(promise, label, LIST_TIMEOUT_MS);');
  }
  await mkdir(dirname(join(target, path)), { recursive: true });
  await writeFile(join(target, path), staged, { flag: 'wx' });
  files.push({ path, originalSha256: hash(original), stagedSha256: hash(staged), changed: original !== staged });
}
await writeFile(join(root, 'docs/artifacts/GOAL_WORKSPACE_TIMEOUT_STAGE_MANIFEST_2026-10-08.json'), JSON.stringify({
  createdAt: new Date().toISOString(), target, appliedToMain: false, files
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ target, changedFiles: files.filter(file => file.changed).map(file => file.path) }));
