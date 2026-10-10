import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = 'C:/Users/User/hmCodex-local/docs/artifacts';
const archivedPath = `${root}/agent-goal-runs/20261007T151628814Z-d02bc679/2-code-syntax-001-hmcodex-runtime/jev-requests.json`;
const archive = JSON.parse(await readFile(archivedPath, 'utf8'));
const original = archive[4].body;
if (original.state.tool !== 'test.execute' || !original.questions.actionGate) throw Error('UNEXPECTED_ARCHIVED_REQUEST');
const files = original.state.evidence.filter(item => item.id.startsWith('host-workspace-context-')).map(item => JSON.parse(item.claim));
const scope = { hostRequestedProcess: { command: 'node', operation: 'NODE_TEST_AUTODISCOVERY',
  cwd: '.', cwdSource: 'DEFAULT_AUTHORIZED_WORKSPACE', testIsolation: 'none',
  knownTestContext: files.filter(item => /\.test\.[cm]?js$/u.test(item.path ?? '')).map(item => item.path),
  discovery: 'Node recursively discovers matching test files under this working directory; the known context is a bounded sample, not the complete discovered set.',
  actualExecution: 'NOT_YET_EXECUTED', executionPolicy: 'HOST_ONE_SHOT_LEASE_REQUIRED' } };
const claim = JSON.stringify(scope);
if (claim.length > 500) throw Error('PROBE_CLAIM_EXCEEDS_STATE_LIMIT');
const withScope = structuredClone(original);
withScope.state.evidence.push({ id: 'host-requested-process-scope', type: 'runtime_state', claim, source: 'host-tool-registry-workspace-default-and-current-file-context', confidence: 1 });
const withSummary = structuredClone(withScope);
withSummary.state.toolRequest.summary = 'Proposed node --test --test-isolation=none: default cwd is the authorized workspace root. Node automatically discovers matching tests recursively. This proposal has not executed and still requires a host-issued one-shot lease.';
withSummary.state.action.summary = withSummary.state.toolRequest.summary;
const outside = structuredClone(withScope);
outside.state.evidence = outside.state.evidence.filter(item => item.id !== 'host-requested-process-scope');
const input = outside.state.evidence.find(item => item.id === 'proposed-tool-input');
const value = JSON.parse(input.claim); value.untrustedProposedInput.cwdClass = 'OUTSIDE_OR_OPAQUE'; input.claim = JSON.stringify(value);
const rows = [];
for (const [name, body, evidenceClass] of [['ORIGINAL', original, 'ARCHIVED_REQUEST'], ['EXPLICIT_DEFAULT_TEST_SCOPE', withScope, 'ARCHIVED_HOST_FACTS_WITH_EXPLICIT_NODE_SEMANTICS'],
  ['SCOPE_AND_REQUEST_SUMMARY', withSummary, 'ARCHIVED_HOST_FACTS_WITH_EXPLICIT_NODE_SEMANTICS'], ['OUTSIDE_CWD', outside, 'SYNTHETIC_NEGATIVE_REQUEST']]) {
  const started = Date.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.JEV_API_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  rows.push({ name, evidenceClass, request: body, response: result, status: response.status, wallMs: Date.now() - started, actualCost: null });
  console.log(JSON.stringify({ name, status: response.status, answer: result.answers?.actionGate }));
}
await writeFile(`${root}/GOAL_NODE_TEST_SCOPE_PROBE_2026-10-07.json`, JSON.stringify({ generatedAt: new Date().toISOString(), archivedPath,
  archiveSha256: createHash('sha256').update(await readFile(archivedPath)).digest('hex'), recordIndex: 4,
  nodeDocumentation: 'https://nodejs.org/download/release/v24.19.0/docs/api/test.html#running-tests-from-the-command-line',
  caveat: 'Archived decision probe only: no tool is executed, no workflow success is inferred and no answer is overridden.', rows }, null, 2), { flag: 'wx' });
