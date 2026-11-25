// Offline controls: feed the previous three actual products through the new write gate.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepairRetest } from '../../../runtime/src/repair-retest.mjs';
import { ReadonlyWorkspace } from '../../../runtime/src/plugins/workspace-readonly.mjs';
import { CAPABILITIES, EXECUTION_MODES, RestrictedWindowsExecutor, RuntimeSafetyMonitor } from '../../../runtime/src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../../../runtime/src/controlled-tools.mjs';
import { textDigest } from '../../../runtime/src/text-patch.mjs';
import { ToolRegistry } from '../../../runtime/src/tool-registry.mjs';

const archive = dirname(fileURLToPath(import.meta.url));
const scratch = resolve(archive, '../../../.codex-tmp');
const checkpoint = join(scratch, 'fp-retry-20261121/dda-2/work');
const prior = join(scratch, 'fp-feedback-live-20261121');
const pkg = 'runtime/src/git-observer.mjs';
const testPath = 'runtime/test/git-audit.test.mjs';
const read = (root, path) => readFile(join(root, path), 'utf8');
const root = await mkdtemp(join(tmpdir(), 'dda-preservation-controls-'));
try {
  await cp(join(checkpoint, 'runtime'), join(root, 'runtime'), { recursive: true });
  await cp(join(checkpoint, 'package.json'), join(root, 'package.json'));
  const workspace = new ReadonlyWorkspace(root);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), {
    workspace, leaseProvider: createExplicitLeaseProvider({ monitor, capabilities: [CAPABILITIES.TEST], commands: ['node'] })
  });
  const repair = new RepairRetest(workspace);
  const source = await read(root, pkg);
  const lines = source.split(/\r?\n/u);
  const line = lines.findIndex(s => s.includes('metadataDigest: digestText(stableStringify(entries))')) + 1;
  assert.ok(line > 0);
  const site = { path: pkg, digest: textDigest(source), field: 'metadataDigest', line, sourceLine: lines[line - 1] };
  const target = { targetPath: testPath, targetDigest: textDigest(await read(root, testPath)), assertionLine: 88,
    cwd: '.', request: { command: 'node', args: ['--test', testPath], cwd: '.', timeoutMs: 240000, maxOutputChars: 8000 },
    producerSites: [site] };
  const invoke = input => {
    assert.notEqual(input.cwd, '.');
    assert.deepEqual(input.args, target.request.args);
    return registry.invoke('test.execute', input);
  };
  target.baseline = await repair.checkCandidate(target, { workspace }, invoke);
  assert.equal(target.baseline.status, 'rejected');
  const results = [];
  for (const [trial, expected] of [['dda-1', 'rejected'], ['dda-2', 'passed'], ['dda-3', 'rejected']]) {
    const content = await read(join(prior, trial, 'work'), pkg);
    const verdict = await repair.checkCandidate(target, { workspace, path: pkg, content }, invoke);
    results.push({ trial, candidateDigest: textDigest(content), expected, verdict });
  }
  assert.equal(textDigest(await read(root, pkg)), site.digest);
  assert.equal(textDigest(await read(root, testPath)), target.targetDigest);
  await writeFile(join(archive, 'guard-controls.json'), JSON.stringify({
    modelRequests: 0, productWrites: 0, targetPath: testPath, targetDigest: target.targetDigest, originalDigest: site.digest,
    baseline: target.baseline, results
  }, null, 2) + '\n');
  assert.equal(target.baseline.preservation?.status, 'observed');
  assert.deepEqual(target.baseline.preservation.checks, { additional: true, relocated: true });
  for (const row of results) {
    assert.equal(row.verdict.assertionPassed, true, row.trial);
    assert.equal(row.verdict.status, row.expected, row.trial);
    const retained = row.expected === 'passed';
    assert.equal(row.verdict.preservation?.status, retained ? 'preserved' : 'collapsed', row.trial);
    assert.deepEqual(row.verdict.preservation.checks, { additional: retained, relocated: retained }, row.trial);
  }
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
