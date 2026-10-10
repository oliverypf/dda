import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGoalLiveJev } from '../../desktop/scripts/goal-live-jev.mjs';
import { ReadonlyWorkspace } from './goal-node-preview-fix-20261008/src/plugins/workspace-readonly.mjs';
import { proposedToolDecisionClaim } from './goal-node-preview-fix-20261008/src/decision/evidence-claim.mjs';
import { toolWorkspaceDecisionEvidence } from './goal-node-preview-fix-20261008/src/decision/workspace-context.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'docs/artifacts');
const caseRoot = join(artifacts, 'agent-goal-runs/20261007T180217856Z-3be656c2/1-code-feature-001-hmcodex-runtime');
const recorded = JSON.parse(await readFile(join(caseRoot, 'jev-requests.json'), 'utf8'));
const original = recorded.find(request => request.response?.answers?.actionGate?.choice === 'REQUEST_EVIDENCE'
  && request.body.state?.evidence?.some(item => item.id === 'proposed-tool-input' && item.claim.includes('OPAQUE_EXECUTABLE'))
  && request.body.state?.evidence?.some(item => {
    try { const claim = JSON.parse(item.claim); return claim.name === 'file.patch' && claim.ok === true; } catch { return false; }
  }));
if (!original) throw Error('POST_PATCH_OPAQUE_PREVIEW_NOT_FOUND');
const request = { command: 'node --test --test-isolation=none' };
const proposedInputClaim = proposedToolDecisionClaim('test.execute', request);
const workspace = new ReadonlyWorkspace(join(caseRoot, 'workspace-final'));
const snapshot = await workspace.snapshot();
const context = await toolWorkspaceDecisionEvidence({ workspace, snapshot, name: 'test.execute', proposedInputClaim });
if (!context.some(item => JSON.parse(item.claim).path === 'name.test.mjs')) throw Error('CURRENT_ARCHIVED_TEST_CONTEXT_MISSING');
const changed = structuredClone(original.body);
changed.state.evidence = changed.state.evidence.filter(item => !item.id.startsWith('host-workspace-context-'))
  .map(item => item.id === 'proposed-tool-input' ? { ...item, claim: proposedInputClaim } : item);
const previewIndex = changed.state.evidence.findIndex(item => item.id === 'proposed-tool-input');
changed.state.evidence.splice(previewIndex, 0, ...context);
const provider = await startGoalLiveJev();
const observations = [];
try {
  for (const [variant, body] of [['original-archived-state', original.body], ['normalized-preview-current-archived-file-context', changed]]) {
    const recordedRequests = provider.begin();
    const response = await fetch(provider.endpoint, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer goal-jev-local-key'
    }, body: JSON.stringify(body), signal: AbortSignal.timeout(7000) });
    const raw = await response.text();
    let answer;
    try { answer = JSON.parse(raw); } catch { answer = null; }
    observations.push({ variant, status: response.status, answer, requests: recordedRequests.requests });
    console.log(JSON.stringify({ variant, status: response.status, choice: answer?.answers?.actionGate?.choice,
      confidence: answer?.answers?.actionGate?.confidence }));
  }
} finally { await provider.close(); }
await writeFile(join(artifacts, 'GOAL_NODE_PREVIEW_JEV_PROBE_2026-10-08.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), method: 'Actual untouched Jev replies to an archived preflight state and its normalized-preview variant with actual reads of the preserved final workspace. Diagnostic replay only; no tool is executed or lease issued.',
  sourceCase: caseRoot, sourceRequestSequence: original.sequence, proposedCommand: request.command,
  stagedCodeAppliedToMain: false, originalTaskOutcomeChanged: false, questionsChanged: false,
  contextPaths: context.map(item => JSON.parse(item.claim).path), observations,
  limitation: 'One preflight replay pair cannot prove full-task success, speed, price savings or causal effects. The original failed task remains failed.'
}, null, 2), { flag: 'wx' });
