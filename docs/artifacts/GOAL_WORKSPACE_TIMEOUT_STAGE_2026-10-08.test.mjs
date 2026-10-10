import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withWorkspaceIoTimeout } from './goal-node-preview-fix-20261008/src/workspace-io-timeout.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';

test('settled I/O preserves its value or original error and releases the long timer', async () => {
  const timerCount = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
  const before = timerCount();
  const value = { actual: true };
  assert.equal(await withWorkspaceIoTimeout(Promise.resolve(value), 'resolve'), value);
  const failure = Error('ACTUAL_FS_FAILURE');
  await assert.rejects(withWorkspaceIoTimeout(Promise.reject(failure), 'reject'), error => error === failure);
  assert.equal(timerCount(), before);
});

test('pending I/O still reaches its original deadline and error classification', async () => {
  const start = performance.now();
  await assert.rejects(withWorkspaceIoTimeout(new Promise(() => {}), 'stat', 40), /WORKSPACE_IO_TIMEOUT:stat/u);
  const duration = performance.now() - start;
  assert.ok(duration >= 30 && duration < 2000);
});

test('actual workspace I/O finishes yet the frozen process stays alive; staged process exits promptly without shortening the I/O deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-io-exit-'));
  await writeFile(join(directory, 'README.md'), 'ACTUAL_FS_EXIT_EVIDENCE');
  const code = module => `import { ReadonlyWorkspace } from ${JSON.stringify(module)};
    const workspace = new ReadonlyWorkspace(${JSON.stringify(directory)});
    await workspace.snapshot(); const result = await workspace.read('README.md');
    console.log(JSON.stringify({ done: true, content: result.content }));`;
  const baselineFile = join(directory, 'baseline-child.mjs'), stagedFile = join(directory, 'staged-child.mjs');
  await writeFile(baselineFile, code(new URL('../../runtime/src/plugins/workspace-readonly.mjs', import.meta.url).href));
  await writeFile(stagedFile, code(new URL('./goal-node-preview-fix-20261008/src/plugins/workspace-readonly.mjs', import.meta.url).href));
  const env = { HMCODEX_WORKSPACE_TIMEOUT_MS: '60000' };
  const baseline = await runEvidenceProcess(process.execPath, [baselineFile], { env, timeoutMs: 3000 });
  assert.match(baseline.stdout, /ACTUAL_FS_EXIT_EVIDENCE/u);
  assert.equal(baseline.timedOut, true, 'only the owned baseline child is terminated after I/O already completed');
  const staged = await runEvidenceProcess(process.execPath, [stagedFile], { env, timeoutMs: 3000 });
  assert.match(staged.stdout, /ACTUAL_FS_EXIT_EVIDENCE/u);
  assert.equal(staged.timedOut, false);
  assert.equal(staged.code, 0);
  assert.ok(staged.wallMs < 3000);
});
