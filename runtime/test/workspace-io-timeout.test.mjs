import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withWorkspaceIoTimeout } from '../src/workspace-io-timeout.mjs';
import { runEvidenceProcess } from '../../desktop/scripts/goal-evidence-process.mjs';

test('settled workspace I/O preserves its value or original error and releases the timer', async () => {
  const timerCount = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length;
  const before = timerCount();
  const value = { actual: true };
  assert.equal(await withWorkspaceIoTimeout(Promise.resolve(value), 'resolve'), value);
  const failure = Error('ACTUAL_FS_FAILURE');
  await assert.rejects(withWorkspaceIoTimeout(Promise.reject(failure), 'reject'), error => error === failure);
  assert.equal(timerCount(), before);
});

test('pending workspace I/O still reaches its unchanged deadline and classification', async () => {
  const start = performance.now();
  await assert.rejects(withWorkspaceIoTimeout(new Promise(() => {}), 'stat', 40), /WORKSPACE_IO_TIMEOUT:stat/u);
  const duration = performance.now() - start;
  assert.ok(duration >= 30 && duration < 2000);
});

test('native workspace I/O exits after completion without reducing the 60-second I/O deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hmcodex-workspace-io-exit-'));
  await writeFile(join(directory, 'README.md'), 'ACTUAL_FS_EXIT_EVIDENCE');
  // Reproduce the old timer lifecycle as a labeled fixture using real fs I/O.
  const legacy = `import {readFile,stat} from 'node:fs/promises';
    const legacyDeadline = (promise,label) => Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('WORKSPACE_IO_TIMEOUT:'+label)),60000))]);
    await legacyDeadline(stat(${JSON.stringify(join(directory, 'README.md'))}),'stat');
    console.log(await readFile(${JSON.stringify(join(directory, 'README.md'))},'utf8'));`;
  const corrected = `import {ReadonlyWorkspace} from ${JSON.stringify(new URL('../src/plugins/workspace-readonly.mjs', import.meta.url).href)};
    const workspace = new ReadonlyWorkspace(${JSON.stringify(directory)});
    await workspace.snapshot(); const result = await workspace.read('README.md');
    console.log(JSON.stringify({done:true,content:result.content}));`;
  const baselineFile = join(directory, 'legacy-child.mjs'), correctedFile = join(directory, 'corrected-child.mjs');
  await writeFile(baselineFile, legacy); await writeFile(correctedFile, corrected);
  const env = { HMCODEX_WORKSPACE_TIMEOUT_MS: '60000' };
  const baseline = await runEvidenceProcess(process.execPath, [baselineFile], { env, timeoutMs: 3000 });
  assert.match(baseline.stdout, /ACTUAL_FS_EXIT_EVIDENCE/u);
  assert.equal(baseline.timedOut, true);
  const current = await runEvidenceProcess(process.execPath, [correctedFile], { env, timeoutMs: 3000 });
  assert.match(current.stdout, /ACTUAL_FS_EXIT_EVIDENCE/u);
  assert.equal(current.timedOut, false);
  assert.equal(current.code, 0);
  assert.ok(current.wallMs < 3000);
});
