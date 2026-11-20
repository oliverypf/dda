import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { proposedToolDecisionClaim, toolResultDecisionClaim, verifiedToolDecisionEvidence } from '../src/decision/evidence-claim.mjs';
import { classifyReadOnlyGitCommand, readOnlyCommandDecisionEvidence, toolWorkspaceDecisionEvidence, verificationSourceEvidence, workspaceWriteDecisionEvidence } from '../src/decision/workspace-context.mjs';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { RuntimeSafetyMonitor } from '../src/runtime-safety-monitor.mjs';
import { createDecisionState } from '../src/decision/types.mjs';

test('a step citing observed sources gets bounded current excerpts and only its cited process receipts', async () => {
  const paths = [];
  const digest = 'sha256:' + '1'.repeat(64);
  const observed = { name: 'workspace.read', state: 'SUCCEEDED', outputDigest: digest, verifiedResult: {
    outputDigest: digest, workspaceRead: { scope: 'IN_WORKSPACE', readOnly: true, path: 'src/build.mjs' }
  } };
  const receipt = { id: 'build-test-process-1', kind: 'BUILD', command: 'node', args: ['src/build.mjs'],
    outputDigest: digest, exitCode: 0, artifacts: [{ path: 'out/deck.pptx', sizeBytes: 900, sha256: digest, pptx: { slideCount: 3, entryCount: 18 } }] };
  const result = await verificationSourceEvidence({
    snapshot: { granted: true, sections: ['README.md', 'desktop/README.md', 'notes.md', 'absent.md'].map(path => ({ path, content: 'stale' })) },
    workspace: { async read(path) {
      paths.push(path);
      return { path, digest, content: ['header', 'unrelated', 'import foo', 'Cordis Runtime uses PolicyLease'].join('\n') };
    } },
    actions: [observed, { ...observed, state: 'FAILED', verifiedResult: { ...observed.verifiedResult, workspaceRead: { path: 'draft.mjs' } } }],
    conclusion: 'Compared `src/build.mjs` and `desktop/README.md` for Cordis Runtime and PolicyLease. out/deck.pptx exists. notes.md.bak and draft.mjs were proposed.',
    receipts: [{ ...receipt, id: 'other', args: ['foo.js'], artifacts: [] }, receipt]
  });
  assert.deepEqual(paths, ['src/build.mjs', 'desktop/README.md']);
  assert.equal(result.length, 3);
  assert.ok(result.every(item => item.claim.length <= 500 && item.source === digest));
  assert.deepEqual(JSON.parse(result[0].claim).artifact.pptx, { slideCount: 3, entryCount: 18 });
  assert.ok(result.slice(1).every(item => item.claim.includes('PolicyLease') && !item.claim.includes('stale')));
});

test('verification supplements respect the decision state limit without evicting existing evidence', async () => {
  const item = { id: 'primary', type: 'tool_result', claim: 'Current command failed', source: 'tool', confidence: 1 };
  const supplementalEvidence = Array.from({ length: 8 }, (_, i) => ({ ...item, id: 'extra-' + i, claim: 'x'.repeat(350) }));
  const input = { evidence: [item], action: { kind: 'EXECUTE', summary: 'Check comparison' } };
  const original = createDecisionState(input, { maxStateChars: 2300 });
  const enriched = createDecisionState(input, { maxStateChars: 2300, supplementalEvidence });
  assert.deepEqual(enriched.evidence[0], original.evidence[0]);
  assert.ok(enriched.evidence.length > 1 && enriched.evidence.length < 9);
  assert.ok(JSON.stringify(enriched).length <= 2300);
  const engine = createDecisionEngine({ enabled: true, client: { async decide({ state, questions }) {
    assert.ok(state.evidence.some(entry => entry.id === 'extra-0'));
    assert.match(questions.verification.prompt, /skipping a change/u);
    return { answers: { verification: { choice: 'UNCERTAIN' } } };
  } } });
  const decision = await engine.judgeVerification({ state: input, evidence: [item], supplementalEvidence, ruleStatus: 'PASS' });
  assert.equal(decision.source, 'jev');
  assert.equal(decision.decision, 'UNCERTAIN');
});

test('only bounded read-only Git argv receives a command classification', () => {
  const grep = ['grep', '-in', '--heading', '-e', 'glm'];
  for (const [args, operation] of [
    [grep, 'git grep'],
    [['grep', '-F', 'some text', '--', 'src/main.mjs'], 'git grep'],
    [['grep', '-e', 'first', '-e', 'second'], 'git grep'],
    [['ls-files', '--stage', '--', 'src'], 'git ls-files'],
    [['rev-parse', '--show-toplevel'], 'git rev-parse']
  ]) assert.equal(classifyReadOnlyGitCommand({ command: 'git', args })?.operation, operation);

  for (const args of [
    ['grep', '-inO', 'glm'], ['grep', '--open-files-in-pager=less', 'glm'],
    ['grep', '--textconv', 'glm'], ['grep', '--no-index', 'glm'],
    ['grep', '--recurse-submodules', 'glm'], ['grep', '-f', 'patterns.txt'],
    ['grep', '-n', 'glm', 'HEAD'], ['grep', '-e'], [...grep, '--textconv'],
    [...grep, '--', '../outside'], [...grep, '--', ':(top)private'], [...grep, '--', '*.mjs'],
    ['ls-files', '--recurse-submodules'], ['rev-parse', '--parseopt'],
    ['-c', 'alias.search=!anything', 'grep', 'glm'], ['status'], ['add', 'file'],
    [...grep, ...Array(64).fill('-n')], ['grep', '-e', 123]
  ]) assert.equal(classifyReadOnlyGitCommand({ command: 'git', args }), undefined, JSON.stringify(args));

  for (const override of [{ command: './git.exe' }, { cwd: '..' }, { cwd: 'C:/other' }, { env: {} }]) {
    assert.equal(classifyReadOnlyGitCommand({ command: 'git', args: grep, ...override }), undefined);
  }
});

test('Git read-only evidence checks the cwd and explicit paths without disclosing search arguments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dda-git-command-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'visible.mjs'), '');
  await writeFile(join(root, 'src', 'private.mjs'), '');
  const workspace = new ReadonlyWorkspace(root, { excludedPaths: [join(root, 'src', 'private.mjs')] });
  const collect = (cwd, path) => readOnlyCommandDecisionEvidence({ workspace, inspection: classifyReadOnlyGitCommand({
    command: 'git', cwd, args: ['grep', '-e', 'private search expression', '--', path]
  }) });

  const evidence = await collect('src', 'visible.mjs');
  assert.deepEqual(JSON.parse(evidence.claim).hostCommandInspection, {
    operation: 'git grep', expectedEffect: 'READ_ONLY', cwdCheck: 'IN_WORKSPACE', explicitPathsChecked: 1
  });
  assert.doesNotMatch(evidence.claim, /private search expression|visible\.mjs/u);
  assert.equal(await collect('src', 'private.mjs'), undefined);
  assert.equal(await collect('missing', 'visible.mjs'), undefined);
});

test('Jev sees the checked write target, live access mode, proposed change and approval criteria', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-jev-write-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = 'build-record.md';
  await writeFile(join(root, path), 'build pending');
  let accessMode = 'FULL_ACCESS';
  const monitor = new RuntimeSafetyMonitor({ workspaceRoot: root, getAccessMode: () => accessMode });
  const history = ['FAILURE_OBSERVED', 'SAFETY_BELOW_THRESHOLD', 'UNRELATED_SIGNAL'];
  const collect = (name, path) => workspaceWriteDecisionEvidence({ name, path, accessMode, monitor, history });
  const readFacts = evidence => JSON.parse(evidence.claim).hostWorkspaceWriteCheck;
  const checked = await collect('file.patch', path);
  assert.deepEqual(readFacts(checked), { accessMode: 'FULL_ACCESS', targetCheck: 'IN_WORKSPACE', targetExists: true,
    historicalRiskSignals: ['FAILURE_OBSERVED', 'SAFETY_BELOW_THRESHOLD'] });
  assert.equal(readFacts(await collect('file.patch', 'missing.md')).targetCheck, 'MISSING_PATCH_TARGET');
  assert.equal(readFacts(await collect('file.write', '.env')).targetCheck, 'DENIED');
  assert.equal(readFacts(await collect('file.write', '../other.md')).targetCheck, 'OUTSIDE_WORKSPACE');
  accessMode = 'REQUIRE_APPROVAL';
  assert.equal(readFacts(await collect('file.write', path)).accessMode, 'REQUIRE_APPROVAL');
  assert.equal(readFacts(await collect('file.write', '../other.md')).targetCheck, 'DENIED');

  const proposal = proposedToolDecisionClaim('file.patch', { path, replacements: [{ oldText: 'pending', newText: 'passed' }] });
  const engine = createDecisionEngine({ enabled: true, enforce: true, client: { async decide({ state, questions }) {
    assert.deepEqual(readFacts(state.evidence.find(item => item.id === checked.id)), readFacts(checked));
    assert.match(state.evidence.find(item => item.id === 'proposed-tool-input').claim, /passed/);
    assert.match(questions.actionGate.prompt, /Historical risk signals alone do not justify human approval/);
    assert.match(questions.actionGate.criteria.REQUIRE_APPROVAL, /single-use lease is a separate executor check/);
    return { answers: { actionGate: { choice: 'ALLOW', confidence: 0.95 } } };
  } } });
  const result = await engine.decideActionGate({ state: { tool: 'file.patch', goal: 'update the build record', evidence: [
    { id: 'proposed-tool-input', type: 'model_output', claim: proposal }, checked
  ] } });
  assert.equal(result.source, 'jev');
  assert.equal(result.decision, 'ALLOW');
  assert.equal(await readFile(join(root, path), 'utf8'), 'build pending');
});

test('automatic test context reads current authorized files rather than stale snapshot contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-file-context-'));
  await writeFile(join(root, 'name.mjs'), 'export const value = ;\n');
  await writeFile(join(root, 'name.test.mjs'), "import {value} from './name.mjs';\n");
  await writeFile(join(root, '.env'), 'PRIVATE_CONTEXT_KEY_DO_NOT_SEND');
  for (const path of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']) await writeFile(join(root, path), '// unrelated source');
  const workspace = new ReadonlyWorkspace(root);
  const snapshot = await workspace.snapshot();
  const request = { command: 'node', args: ['--test', '--test-isolation=none'], cwd: '.' };
  const collect = () => toolWorkspaceDecisionEvidence({ workspace, snapshot, name: 'test.execute',
    proposedInputClaim: proposedToolDecisionClaim('test.execute', request) });
  const initial = await collect();
  assert.ok(initial.some(item => JSON.parse(item.claim).outputData.text?.includes('export const value = ;')));
  assert.ok(initial.some(item => JSON.parse(item.claim).path === 'name.test.mjs'));
  await writeFile(join(root, 'name.mjs'), 'export const value = 1;\n');
  const current = await collect();
  assert.ok(current.some(item => JSON.parse(item.claim).outputData.text?.includes('export const value = 1;')));
  assert.notEqual(current.find(item => JSON.parse(item.claim).path === 'name.mjs').source,
    initial.find(item => JSON.parse(item.claim).path === 'name.mjs').source);
  assert.equal(JSON.stringify(current).includes('PRIVATE_CONTEXT_KEY_DO_NOT_SEND'), false);
  assert.ok(current.length <= 4 && current.every(item => item.claim.length <= 500));
});

test('context collection preserves workspace exclusions and never follows opaque or escaped proposals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-decision-context-policy-'));
  await writeFile(join(root, 'private-store.mjs'), 'PRIVATE_STORE_DO_NOT_SEND');
  await writeFile(join(root, 'name.test.mjs'), 'TEST_CONTEXT');
  const workspace = new ReadonlyWorkspace(root, { excludedPaths: [join(root, 'private-store.mjs')] });
  const snapshot = await workspace.snapshot();
  const collect = (name, request) => toolWorkspaceDecisionEvidence({ workspace, snapshot, name,
    proposedInputClaim: proposedToolDecisionClaim(name, request) });
  for (const path of ['../outside.mjs', 'C:/private.mjs', '/private.mjs']) assert.deepEqual(await collect('file.write', { path, content: 'x' }), []);
  assert.deepEqual(await collect('test.execute', { command: 'node', args: ['--test'], cwd: '../outside' }), []);
  assert.deepEqual(await collect('test.execute', { command: 'node', args: ['-e', 'private inline code'] }), []);
  const context = await collect('file.write', { path: 'private-store.mjs', content: 'x' });
  assert.equal(JSON.stringify(context).includes('PRIVATE_STORE_DO_NOT_SEND'), false);
  assert.equal(context.some(item => JSON.parse(item.claim).path === 'private-store.mjs'), false);
  assert.equal(JSON.stringify(toolResultDecisionClaim('workspace.context.read', { content: 'partial', truncated: true })).includes('sourceTruncated'), true);
});

test('npm evidence resolves the current package from the command cwd and includes its lifecycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-npm-context-'));
  await mkdir(join(root, 'desktop', 'scripts'), { recursive: true });
  const packagePath = join(root, 'desktop', 'package.json');
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'ROOT_WRONG_PACKAGE' } }));
  await writeFile(packagePath, JSON.stringify({ scripts: { build: 'STALE_PACKAGE' } }));
  const workspace = new ReadonlyWorkspace(root);
  const snapshot = await workspace.snapshot();
  await writeFile(packagePath, JSON.stringify({
    secret: 'UNRELATED_PROPERTY', scripts: {
      prebuild: 'node ./scripts/pre.mjs',
      build: 'node scripts/build.mjs',
      postbuild: 'node ../escaped.mjs',
      windows: 'node "%npm_config_local_prefix%/scripts/build.mjs"',
      unrelated: 'UNRELATED_SCRIPT'
    }
  }));
  await writeFile(join(root, 'desktop', 'scripts', 'pre.mjs'), '// local preparation');
  await writeFile(join(root, 'desktop', 'scripts', 'build.mjs'), '// local build entry');
  await writeFile(join(root, 'escaped.mjs'), '// ESCAPED_ENTRY_CONTENT');
  const request = { command: 'npm.cmd', args: ['run', 'build'], cwd: 'desktop' };
  const collect = (request) => toolWorkspaceDecisionEvidence({ workspace, snapshot, name: 'shell.execute', request });
  const evidence = await collect(request);
  const claims = evidence.map(item => JSON.parse(item.claim));
  assert.deepEqual(claims.filter(item => item.name === 'workspace.context.npm-script').map(item => item.outputData.text), [
    'prebuild: node ./scripts/pre.mjs', 'build: node scripts/build.mjs', 'postbuild: node ../escaped.mjs'
  ]);
  assert.deepEqual(claims.filter(item => item.name === 'workspace.context.npm-entry').map(item => item.path), [
    'desktop/scripts/pre.mjs', 'desktop/scripts/build.mjs'
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /ROOT_WRONG_PACKAGE|STALE_PACKAGE|UNRELATED_|ESCAPED_ENTRY_CONTENT/u);
  assert.ok(evidence.every(item => item.claim.length <= 500));
  assert.deepEqual(await collect({ ...request, cwd: '../outside' }), []);
  assert.deepEqual(await collect({ ...request, args: ['run', 'build', '--', 'opaque'] }), []);
  const prefix = (await collect({ ...request, args: ['run', 'windows'] })).map(item => JSON.parse(item.claim));
  assert.equal(prefix.find(item => item.name === 'workspace.context.npm-local-prefix-candidate')?.path,
    'desktop/scripts/build.mjs');
});

test('actual failed and successful tests remain visible after a long chain and state compaction', () => {
  const actual = (name, state, index, value) => ({ name, state,
    verifiedResult: { decisionClaim: toolResultDecisionClaim(name, value), outputDigest: `sha256:${String(index).padStart(64, '0')}` } });
  const first = actual('test.execute', 'FAILED', 1, { ok: false, exitCode: 1, stderr: 'REAL_INITIAL_TEST_FAILURE' });
  const writes = actual('file.write', 'SUCCEEDED', 2, { ok: true, path: 'name.mjs' });
  const passed = actual('test.execute', 'SUCCEEDED', 3, { ok: true, exitCode: 0, stdout: 'REAL_PASSED_TEST' });
  const reads = Array.from({ length: 40 }, (_, i) => actual('workspace.read', 'SUCCEEDED', i + 4, { path: `source-${i}.mjs`, content: 'read' }));
  const actions = [first, writes, passed, ...reads, { name: 'test.execute', state: 'FAILED', errorCode: 'TOOL_ACTION_REQUIRES_EVIDENCE', invocationAttempted: false }];
  const evidence = verifiedToolDecisionEvidence(actions);
  assert.equal(evidence.length, 8);
  assert.ok(evidence.some(item => item.claim.includes('REAL_INITIAL_TEST_FAILURE')));
  assert.ok(evidence.some(item => item.claim.includes('REAL_PASSED_TEST')));
  assert.ok(evidence.some(item => JSON.parse(item.claim).name === 'file.write'));
  const state = createDecisionState({ taskId: 'test', evidence: [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `old-${i}`, type: 'tool_result', claim: 'x'.repeat(500) })), ...evidence
  ] });
  assert.ok(state.evidence.some(item => item.claim.includes('REAL_INITIAL_TEST_FAILURE')));
  assert.ok(state.evidence.some(item => item.claim.includes('REAL_PASSED_TEST')));
  assert.equal(JSON.stringify(state).includes('TOOL_ACTION_REQUIRES_EVIDENCE'), false, 'a deferred proposal is not actual execution evidence');
});
