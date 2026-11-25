import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RepairRetest } from '../../../runtime/src/repair-retest.mjs';
import { ReadonlyWorkspace } from '../../../runtime/src/plugins/workspace-readonly.mjs';
import { CAPABILITIES, EXECUTION_MODES, RestrictedWindowsExecutor, RuntimeSafetyMonitor } from '../../../runtime/src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../../../runtime/src/controlled-tools.mjs';
import { applyTextPatch, textDigest } from '../../../runtime/src/text-patch.mjs';
import { ToolRegistry } from '../../../runtime/src/tool-registry.mjs';

const archive = dirname(fileURLToPath(import.meta.url));
const repo = resolve(archive, '../../..');
const scratch = join(repo, '.codex-tmp');
const checkpoint = join(scratch, 'fp-retry-20261121/dda-2/work');
const good = join(scratch, 'fp-resume-20261121/dda-3/work');
const priorArchive = join(archive, '../git-fingerprint-prepatch-2026-11-21');
const producer = 'runtime/src/git-observer.mjs';
const consumer = 'runtime/src/execution-scope-snapshot.mjs';
const targetPath = 'runtime/test/git-audit.test.mjs';
const request = { command: 'node', args: ['--test', targetPath], cwd: '.', timeoutMs: 240000, maxOutputChars: 8000 };

const fileDigest = async path => 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
const originals = async root => Object.fromEntries(await Promise.all([producer, consumer, targetPath].map(
  async path => [path, await fileDigest(join(root, path))]
)));
const historical = JSON.parse(await readFile(join(priorArchive, 'dda-3.json'), 'utf8'));
const known = JSON.parse(await readFile(join(priorArchive, 'known-candidates.json'), 'utf8'));
const before = await originals(checkpoint);
const current = await readFile(join(checkpoint, producer), 'utf8');
const green = await readFile(join(good, producer), 'utf8');
assert.equal(textDigest(green), known.cases.find(row => row.name === 'resume-dda-3').candidate_content_sha256);
const cases = [{ name: 'checkpoint', source: 'unchanged checkpoint producer', content: current }];
for (const round of [14, 15]) {
  const history = historical.presented_tool_history.find(row => row.round === round + 1);
  const assistant = history.turn.find(message => message.role === 'assistant');
  const args = JSON.parse(assistant.calls.find(call => call.function.name === 'hmc_file_x2e_patch').function.arguments);
  assert.equal(args.path, producer);
  cases.push({ name: 'historical-red-round-' + round, source: '../git-fingerprint-prepatch-2026-11-21/dda-3.json', round,
    content: applyTextPatch(current, args.replacements, args.expectedDigest) });
}
cases.push({ name: 'historical-green', source: '../git-fingerprint-resume-2026-11-21/dda-3.patch', content: green });

const sourceLines = current.split('\n');
const line = sourceLines.findIndex(text => text.includes('metadataDigest: digestText(stableStringify(entries))')) + 1;
assert.ok(line);
const site = { path: producer, digest: before[producer], line, field: 'metadataDigest', sourceLine: sourceLines[line - 1] };
const target = { request, cwd: '.', targetPath, assertionLine: 88, targetDigest: before[targetPath], producerSites: [site] };
const root = await mkdtemp(join(tmpdir(), 'dda-producer-controls-'));
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
  const evidence = [];
  for (const { name, source, round, content } of cases) {
    let receipt;
    const baseline = name === 'checkpoint';
    const candidate = baseline ? { workspace } : { workspace, path: producer, content };
    const verdict = await repair.checkCandidate(target, candidate, async input => {
      assert.notEqual(input.cwd, '.');
      assert.deepEqual({ ...input, cwd: '.' }, request);
      const result = await registry.invoke('test.execute', input);
      receipt = { tool: 'test.execute', privateCopy: true, exitCode: result.exitCode, ok: result.ok,
        aborted: result.aborted, timedOut: result.timedOut, truncated: result.truncated };
      return result;
    });
    if (!baseline) repair.rememberRejection(target, verdict, producer);
    const after = await originals(root);
    assert.deepEqual(after, before);
    assert.equal(verdict.status, name === 'historical-green' ? 'passed' : 'rejected');
    if (verdict.status === 'rejected') {
      assert.ok(verdict.producerInputs?.differences.some(item => item.path[0] === 'FETCH_HEAD'), JSON.stringify(verdict));
    }
    evidence.push({ name, source, round, candidateContentDigest: textDigest(content), verdict, receipt, originalAfter: after });
  }
  assert.notEqual(evidence[1].candidateContentDigest, evidence[2].candidateContentDigest);
  assert.deepEqual(evidence[1].verdict.producerInputs.differences, evidence[2].verdict.producerInputs.differences);
  assert.equal(evidence[1].verdict.repeatCount, 1);
  assert.equal(evidence[2].verdict.repeatCount, 2);
  await writeFile(join(archive, 'controls.json'), JSON.stringify({
    kind: 'offline-historical-producer-controls', modelRequests: 0, productWrites: 0, assertionLine: 88, request,
    method: 'Actual RepairRetest.checkCandidate and controlled test.execute for the unchanged baseline and three historical candidate contents. Two rejected candidates go through rememberRejection. All four executions run in private copies. No candidate is applied to the checkpoint.',
    originalBefore: before, producerSite: site, observations: evidence
  }, null, 2) + '\n');
  for (const row of evidence) console.log(row.name, row.verdict.status, row.verdict.producerInputs?.differences);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
