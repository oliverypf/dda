import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { RepairRetest } from '../src/repair-retest.mjs';
import { asyncQueueSchedule } from '../src/repair-async-queue.mjs';
import { CAPABILITIES, EXECUTION_MODES, RestrictedWindowsExecutor, RuntimeSafetyMonitor } from '../src/safety-executor.mjs';
import { createExplicitLeaseProvider, registerExecutorTools } from '../src/controlled-tools.mjs';
import { registerReadonlyWorkspaceTools, ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { textDigest } from '../src/text-patch.mjs';

const implementation = 'src/classify.mjs';
const originalTest = 'test/classify.test.mjs';
const fixtureTest = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { classify } from '../src/classify.mjs';",
  "test('both ordinary states share a label', () => {",
  '  const before = classify(false);',
  '  const after = classify(true);',
  '  assert.equal(before.label, after.label);',
  '});',
  ''
].join('\n');
const oldLabel = "present ? 'present' : 'missing'";
const wrongLabel = "present ? 'stored-value' : 'no-value'";
const correctLabel = "'ordinary'";
const initialSource = `// Original display label.\nexport const classify = present => ({ label: ${oldLabel} });\n`;
const checkpoint = initialSource.replace('Original display label', 'Display label');

async function fixture(t, source = initialSource, target = fixtureTest) {
  const root = await mkdtemp(join(tmpdir(), 'dda-candidate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, implementation), source);
  await writeFile(join(root, originalTest), target);
  const workspace = new ReadonlyWorkspace(root);
  const monitor = new RuntimeSafetyMonitor({ mode: EXECUTION_MODES.CONTROLLED, workspaceRoot: root });
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, workspace);
  registerExecutorTools(registry, new RestrictedWindowsExecutor({ monitor }), {
    workspace, leaseProvider: createExplicitLeaseProvider({
      monitor, capabilities: [CAPABILITIES.TEST, CAPABILITIES.WRITE_FILE], commands: ['node']
    })
  });
  const context = new Context();
  t.after(() => context.fiber.dispose());
  await context.plugin(toolRegistryPlugin(registry));
  return { root, context, workspace };
}

function patch(oldText, newText, expectedDigest) {
  return ['file.patch', { path: implementation, replacements: [{ oldText, newText }], expectedDigest }];
}

const runOriginal = ['test.execute', { command: 'node', args: ['--test', originalTest], cwd: '.' }];

test('passing the original assertion cannot authorize a write with a missing preservation receipt', async t => {
  const { root, context, workspace } = await fixture(t);
  const source = await readFile(join(root, implementation), 'utf8');
  const target = {
    cwd: '.', request: runOriginal[1], targetPath: originalTest, targetDigest: textDigest(fixtureTest), assertionLine: 7,
    producerSites: [], baseline: { preservation: {
      status: 'observed', site: { path: implementation, line: 2, field: 'label' },
      key: 'first', otherKey: 'second', branch: { field: 'state', literal: 'special' },
      aggregateConstant: true, checks: { additional: true, relocated: true }
    } }
  };
  // The candidate can pass the target, but the former producer is no longer
  // identifiable. An absent contrast must not silently approve the edit.
  const gate = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: implementation, content: source.replace(oldLabel, correctLabel)
  }, input => context.toolRegistry.invoke('test.execute', input));
  assert.equal(gate.assertionPassed, true);
  assert.equal(gate.status, 'unverified');
  assert.match(gate.detail, /per-key distinction/u);
  assert.equal(await readFile(join(root, implementation), 'utf8'), source);
});

test('a bound queue check needs one consistent, complete receipt in addition to a passing assertion', async t => {
  const { root, workspace } = await fixture(t);
  const target = {
    cwd: '.', request: runOriginal[1], targetPath: originalTest, targetDigest: textDigest(fixtureTest), assertionLine: 7,
    asyncQueuePlan: { path: implementation, specifier: '../src/classify.mjs', exportName: 'classify',
      keyType: 'string', revisionType: 'number', productDigest: textDigest(initialSource) }
  };
  const schedule = asyncQueueSchedule('number');
  const callers = Object.fromEntries(Object.entries(schedule).map(([name, slots]) =>
    [name, slots.map(slot => ({ ...slot, actual: slot.expected }))]));
  const complete = { kind: 'asyncQueue', status: 'observed', checks: { serial: true, latest: true, reuseAfterFailure: true }, callers };
  const changedFirst = fields => ({ ...callers, success: [{ ...callers.success[0], ...fields }, ...callers.success.slice(1)] });
  const repair = new RepairRetest(workspace);
  for (const [rows, truncated, expected] of [
    [[], false, 'unverified'], [[complete, complete], false, 'unverified'],
    [[{ ...complete, checks: { ...complete.checks, serial: false } }], false, 'unverified'],
    [[{ ...complete, callers: undefined }], false, 'unverified'],
    [[{ ...complete, callers: { ...callers, failure: callers.failure.slice(0,-1) } }], false, 'unverified'],
    [[{ ...complete, callers: changedFirst({ batch: 2 }) }], false, 'unverified'],
    [[{ ...complete, callers: changedFirst({ actual: 'value:17' }) }], false, 'unverified'],
    [[{ ...complete, status: 'violated', checks: { ...complete.checks, latest: false },
      callers: changedFirst({ actual: { raw: 'unbounded' } }) }], false, 'unverified'],
    [[complete], true, 'unverified'], [[complete], false, 'passed']
  ]) {
    const result = await repair.checkCandidate(target, {
      workspace, path: implementation, content: initialSource.replace(oldLabel, correctLabel)
    }, async ({ cwd }) => {
      const source = await readFile(join(root, cwd, originalTest), 'utf8');
      const assertMarker = source.match(/DDA_ASSERT_[a-f0-9]{32}=/u)[0];
      const queueMarker = source.match(/DDA_QUEUE_[a-f0-9]{32}=/u)[0];
      return { ok: true, exitCode: 0, truncated, stdout: [
        assertMarker + JSON.stringify({ passed: true, operands: ['ordinary', 'ordinary'] }),
        ...rows.map(row => queueMarker + JSON.stringify(row))
      ].join('\n') };
    });
    assert.equal(result.assertionPassed, true);
    assert.equal(result.status, expected);
    if (expected === 'passed') assert.deepEqual(result.asyncQueue.callers, callers);
  }
});

test('an unverified candidate gets one bounded preview retry while a rejected candidate gets none', async t => {
  const { root, workspace } = await fixture(t);
  const target = {
    cwd: '.', request: runOriginal[1], targetPath: originalTest, targetDigest: textDigest(fixtureTest), assertionLine: 7,
    asyncQueuePlan: { path: implementation, specifier: '../src/classify.mjs', exportName: 'classify',
      keyType: 'string', revisionType: 'number', productDigest: textDigest(initialSource) }
  };
  const schedule = asyncQueueSchedule('number');
  const callers = Object.fromEntries(Object.entries(schedule).map(([name, rows]) =>
    [name, rows.map(row => ({ ...row, actual: row.expected }))]));
  const complete = JSON.stringify({ kind: 'asyncQueue', status: 'observed',
    checks: { serial: true, latest: true, reuseAfterFailure: true }, callers });
  let attempts = 0;
  const good = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: implementation, content: initialSource.replace(oldLabel, correctLabel)
  }, async ({ cwd }) => {
    attempts++;
    const source = await readFile(join(root, cwd, originalTest), 'utf8');
    const assertMarker = source.match(/DDA_ASSERT_[a-f0-9]{32}=/u)[0];
    const queueMarker = source.match(/DDA_QUEUE_[a-f0-9]{32}=/u)[0];
    return { ok: true, exitCode: 0, truncated: false, stdout: [
      assertMarker + JSON.stringify({ passed: true, operands: ['ordinary', 'ordinary'] }),
      ...(attempts === 1 ? [] : [queueMarker + complete])
    ].join('\n') };
  }, undefined, { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts, 2);
  assert.equal(good.status, 'passed');
  assert.deepEqual(good.retest, { attempts: 2, initialStatus: 'unverified', finalStatus: 'passed', resolved: true });

  attempts = 0;
  const bad = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: implementation, content: initialSource.replace(oldLabel, wrongLabel)
  }, async ({ cwd }) => {
    attempts++;
    const source = await readFile(join(root, cwd, originalTest), 'utf8');
    const assertMarker = source.match(/DDA_ASSERT_[a-f0-9]{32}=/u)[0];
    return { ok: false, exitCode: 1, truncated: false, stdout: assertMarker + JSON.stringify({
      passed: false, operands: ['no-value', 'stored-value']
    }) };
  }, undefined, { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts, 1);
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.retest, undefined);
});

test('a timed-out queue preview returns caller obligations without repeating the same candidate', async t => {
  const { workspace } = await fixture(t);
  const target = {
    cwd: '.', request: runOriginal[1], targetPath: originalTest, targetDigest: textDigest(fixtureTest), assertionLine: 7,
    asyncQueuePlan: { path: implementation, specifier: '../src/classify.mjs', exportName: 'classify',
      keyType: 'string', revisionType: 'number', productDigest: textDigest(initialSource) }
  };
  const schedule = asyncQueueSchedule('number');
  const callers = Object.fromEntries(Object.entries(schedule).map(([name, rows]) =>
    [name, rows.map(row => ({ ...row, actual: row.expected }))]));
  target.baseline = { asyncQueue: {
    kind: 'asyncQueue', status: 'observed', checks: { serial: true, latest: true, reuseAfterFailure: true },
    callers, obligations: { batches: { success: [], failure: [] } }
  } };
  let attempts = 0;
  const result = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: implementation, content: initialSource.replace(oldLabel, correctLabel)
  }, async () => {
    attempts += 1;
    throw Object.assign(new Error('CANDIDATE_PREVIEW_TIMEOUT'), { code: 'CANDIDATE_PREVIEW_TIMEOUT' });
  }, undefined, { retryUnverified: true, retryLimit: 1 });
  assert.equal(attempts, 1);
  assert.equal(result.status, 'unverified');
  assert.equal(result.observations, 0);
  assert.equal(result.previewTimedOut, true);
  assert.equal(result.asyncQueue.status, 'unverified');
  assert.deepEqual(result.asyncQueue.callers, callers);
  assert.deepEqual(result.asyncQueue.checks, { serial: null, latest: null, reuseAfterFailure: null });
  assert.equal(result.retest, undefined);
});

test('an aborted candidate preview keeps the executor receipt for the next repair decision', async t => {
  const { workspace } = await fixture(t);
  const target = {
    cwd: '.', request: runOriginal[1], targetPath: originalTest, targetDigest: textDigest(fixtureTest), assertionLine: 7
  };
  const result = await new RepairRetest(workspace).checkCandidate(target, {
    workspace, path: implementation, content: initialSource.replace(oldLabel, correctLabel)
  }, async () => ({
    ok: false, exitCode: null, aborted: true, timedOut: false, truncated: true,
    stdout: 'candidate partial output\n', stderr: 'candidate cleanup complete\n'
  }));
  assert.equal(result.status, 'unverified');
  assert.equal(result.observations, 0);
  assert.match(result.detail, /候选预览被中止/u);
  assert.match(result.detail, /candidate partial output/u);
});

async function runTask({ root, context, workspace }, turns, events, prompt) {
  let turnsTaken = 0;
  await context.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture', async *stream({ messages }) {
      const next = turns[turnsTaken++];
      assert.ok(next, 'unexpected extra model turn');
      const response = typeof next === 'function' ? await next(messages) : next;
      if (typeof response === 'string') {
        yield { type: 'text-delta', text: response };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else {
        const [name, args] = response;
        yield { type: 'tool-call', id: 'candidate-' + turnsTaken, name, arguments: JSON.stringify(args) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
  }), 'candidate-fixture'));
  await context.plugin(taskRunnerPlugin);
  await context.taskRunner.run({
    prompt, workspace: { root, rootLabel: 'fixture', granted: true, entries: [], sections: [], snapshotDigest: 'sha256:fixture' },
    taskClass: 'test', maxToolRounds: 15, repairWorkspace: workspace,
    readObservedAssertion: workspace.readObservedLines.bind(workspace),
    onEvent: event => { events.push(event); }
  });
  assert.equal(turnsTaken, turns.length);
}

test('a failing candidate leaves the checkpoint intact, then a passing candidate lands and the host reruns the original test', async t => {
  const state = await fixture(t);
  const events = [];
  const digest = textDigest(checkpoint);
  const candidateEvents = () => events.filter(event => event.kind === 'harness.repair_candidate');
  const retests = () => events.filter(event => event.kind === 'harness.repair_retest');
  const turns = [
    ['workspace.read', { path: originalTest }],
    patch('Original display label', 'Display label'),
    runOriginal,
    ['file.write', { path: 'diagnostic.mjs', content: 'export const observation = true;\n' }],
    async () => {
      assert.equal(await readFile(join(state.root, 'diagnostic.mjs'), 'utf8'), 'export const observation = true;\n');
      assert.ok(retests().some(event => event.state === 'failed_after_edit'));
      return patch(oldLabel, wrongLabel, digest);
    },
    async messages => {
      assert.equal(await readFile(join(state.root, implementation), 'utf8'), checkpoint);
      assert.equal(await readFile(join(state.root, originalTest), 'utf8'), fixtureTest);
      const rejected = candidateEvents().find(event => event.status === 'rejected');
      assert.equal(rejected?.path, implementation);
      assert.deepEqual(rejected.operands, ['no-value', 'stored-value']);
      const tool = messages.findLast(message => message.source?.kind === 'tool');
      const receipt = tool.content[0].content[0].text;
      assert.match(receipt, /no-value/u);
      assert.match(receipt, /stored-value/u);
      return patch(oldLabel, 'missingFunction()', digest);
    },
    async () => {
      const unverified = candidateEvents().find(event => event.status === 'unverified');
      assert.equal(unverified?.path, implementation);
      assert.equal(unverified.observations, 0);
      assert.equal(await readFile(join(state.root, implementation), 'utf8'), checkpoint);
      return patch(oldLabel, correctLabel, digest);
    },
    'The original check now passes.'
  ];
  await runTask(state, turns, events, 'Fix the classifier labels, then rerun the original test.');
  assert.equal(await readFile(join(state.root, implementation), 'utf8'), checkpoint.replace(oldLabel, correctLabel));
  assert.equal(await readFile(join(state.root, originalTest), 'utf8'), fixtureTest);
  const passed = candidateEvents().find(event => event.status === 'passed');
  assert.equal(passed?.path, implementation);
  assert.deepEqual(passed.operands, ['ordinary', 'ordinary']);
  assert.ok(events.indexOf(passed) < events.findIndex(event => event.kind === 'harness.repair_retest' && event.state === 'target_passed'));
  const tests = events.filter(event => event.kind === 'tool.result' && event.name === 'test.execute');
  assert.deepEqual(tests.filter(event => event.candidatePreview).map(event => event.ok), [false, false, false, true]);
  assert.deepEqual(tests.filter(event => event.cwd === '.').map(event => event.ok), [false, true]);
});

test('a product edit without a failed target uses the ordinary write path', async t => {
  const state = await fixture(t);
  const events = [];
  await runTask(state, [
    patch('Original display label', 'New display label', textDigest(initialSource)),
    'Updated the comment.'
  ], events, 'Update the comment in the classifier source.');
  assert.equal(await readFile(join(state.root, implementation), 'utf8'), initialSource.replace('Original', 'New'));
  assert.ok(!events.some(event => event.kind === 'harness.repair_candidate' || event.name === 'test.execute'));
});

const computedSource = [
  "import { createHash } from 'node:crypto';",
  '// Original display label.',
  'const encode = value => JSON.stringify(value);',
  "const seal = input => createHash('sha256').update(input).digest('hex');",
  'export function classify(present, tenant) {',
  `  const record = { tenant, entry: { state: ${oldLabel} } };`,
  '  return { label: seal(encode(record)) };',
  '}',
  ''
].join('\n');

const interleavedTest = fixtureTest.replace(
  '  const before = classify(false);\n  const after = classify(true);',
  [
    "  const before = classify(false, 'main');",
    "  classify(false, 'unused-left');",
    "  const after = classify(true, 'main');",
    "  classify(true, 'unused-right');"
  ].join('\n')
);

function recoveryNote(messages) {
  const note = messages.flatMap(message => message.content)
    .findLast(part => part.type === 'text' && part.text.startsWith('HOST_REPAIR_RETEST:'));
  assert.ok(note, 'expected a model-visible repair continuation');
  return JSON.parse(note.text.split('\n').at(-1));
}

function verifyDifference(observation, left, right) {
  assert.equal(observation.path, implementation);
  assert.equal(observation.field, 'label');
  assert.deepEqual(observation.differences, [{ path: ['entry', 'state'], before: left, after: right }]);
  assert.equal(observation.truncated, false);
}

test('verified producer inputs exclude interleaved snapshots and expose repeated candidate semantics before the next edit', async t => {
  const state = await fixture(t, computedSource, interleavedTest);
  const events = [];
  const unchanged = computedSource.replace('Original display label', 'Display label');
  const digest = textDigest(unchanged);
  await runTask(state, [
    ['workspace.read', { path: originalTest }],
    patch('Original display label', 'Display label'),
    ['workspace.read', { path: implementation }],
    runOriginal,
    messages => {
      verifyDifference(recoveryNote(messages).baseline.producerInputs, 'missing', 'present');
      return patch(oldLabel, wrongLabel, digest);
    },
    async messages => {
      const rejection = recoveryNote(messages).lastRejected;
      verifyDifference(rejection.producerInputs, 'no-value', 'stored-value');
      assert.equal(rejection.repeatCount, 1);
      assert.equal(await readFile(join(state.root, implementation), 'utf8'), unchanged);
      return patch(oldLabel, "present === true ? 'stored-value' : 'no-value'", digest);
    },
    async messages => {
      const rejection = recoveryNote(messages).lastRejected;
      verifyDifference(rejection.producerInputs, 'no-value', 'stored-value');
      assert.equal(rejection.repeatCount, 2);
      assert.equal(await readFile(join(state.root, implementation), 'utf8'), unchanged);
      return patch(oldLabel, correctLabel, digest);
    },
    'Both states now share a stable label.'
  ], events, 'Fix the classifier labels, then run the original test.');
  assert.equal(await readFile(join(state.root, implementation), 'utf8'), unchanged.replace(oldLabel, correctLabel));
  assert.equal(await readFile(join(state.root, originalTest), 'utf8'), interleavedTest);
  const baselines = events.filter(event => event.kind === 'harness.repair_baseline');
  assert.equal(baselines.length, 1);
  verifyDifference(baselines[0].producerInputs, 'missing', 'present');
  const candidates = events.filter(event => event.kind === 'harness.repair_candidate');
  assert.deepEqual(candidates.map(event => event.status), ['rejected', 'rejected', 'passed']);
  assert.deepEqual(candidates.slice(0, 2).map(event => event.repeatCount), [1, 2]);
  const originals = events.filter(event => event.kind === 'tool.result' && event.name === 'test.execute' && event.cwd === '.');
  assert.deepEqual(originals.map(event => event.ok), [false, true]);
});

test('multiple different producer inputs yielding the same operand do not identify a snapshot pair', async t => {
  // Dropping tenant makes each real observation collide with its decoy.
  const collision = computedSource.replace(".update(input)", ".update(JSON.stringify(JSON.parse(input).entry))");
  const state = await fixture(t, collision, interleavedTest);
  const events = [];
  await runTask(state, [
    ['workspace.read', { path: originalTest }],
    patch('Original display label', 'Display label'),
    ['workspace.read', { path: implementation }],
    runOriginal,
    messages => {
      const note = recoveryNote(messages);
      assert.equal(note.baseline?.producerInputs, undefined);
      assert.ok(note.assertionSource.possibleProducers.some(site => site.path === implementation && site.field === 'label'));
      return patch(oldLabel, correctLabel);
    },
    'Verified the classifier.'
  ], events, 'Fix the classifier labels, then run the original test.');
  const baselines = events.filter(event => event.kind === 'harness.repair_baseline');
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0].producerInputs, undefined);
  assert.ok(events.some(event => event.kind === 'harness.repair_retest' && event.state === 'target_passed'));
});
