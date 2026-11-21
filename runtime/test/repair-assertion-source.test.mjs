import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { registerReadonlyWorkspaceTools, ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import { RepairRetest } from '../src/repair-retest.mjs';

const file = 'test/unit count.mjs';
const assertion = '  assert.equal(before.count, after.count);';
const priorPatch = '--- a/view.mjs\n+++ b/view.mjs\n@@ -1 +1 @@\n-return current;\n+return cached;';
const sourceText = ['// before', 'check(before);', assertion, 'check(after);', '// after'].join('\r\n');

async function setup(t, content = sourceText) {
  const root = await mkdtemp(join(tmpdir(), 'dda-assertion-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, file), content);
  const workspace = new ReadonlyWorkspace(root);
  const frame = pathToFileURL(join(root, file)).href + ':3:8';
  return { root, workspace, frame, readLines: workspace.readObservedLines.bind(workspace) };
}

function failed(frame) {
  return { ok: false, exitCode: 1, stderr: '', stdout:
    `not ok 1 - count test\n  location: 'declared.mjs:1:1'\n  code: ERR_ASSERTION\n  expected: 3\n  actual: 2\n  stack: |-\n    TestContext.<anonymous> (${frame})` };
}

const receipt = { kind: 'TEST', invocationKey: 'same-target', command: 'node', args: ['--test'], cwd: '.', exitCode: 1 };

async function runFailedRetest(t, content) {
  const { root, workspace, frame, readLines } = await setup(t, content);
  const registry = new ToolRegistry({ allowSideEffects: true });
  registerReadonlyWorkspaceTools(registry, workspace);
  registry.register({ name: 'file.patch', readOnly: false, description: 'Patch the test fixture.',
    inputSchema: { type: 'object' }, handler: () => ({ ok: true, path: 'view.mjs', diff: priorPatch }) });
  registry.register({ name: 'test.execute', readOnly: false, description: 'Test the fixture.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array' } } },
    handler: () => failed(frame) });
  const context = new Context();
  t.after(() => context.fiber.dispose());
  await context.plugin(toolRegistryPlugin(registry));
  const calls = [['workspace.read', { path: file }], ['file.patch', {}],
    ['test.execute', { command: 'node', args: ['--test'] }]];
  let round = 0;
  let readResult;
  const retests = [];
  const results = [];
  await context.plugin(cordisPlugin(ctx => ctx.provide('modelProvider', {
    provider: 'fixture', model: 'fixture', async *stream({ messages }) {
      const call = calls[round++];
      if (round === 2) {
        const tool = messages.find(message => message.source?.kind === 'tool');
        readResult = tool.content[0].content[0].text;
      }
      if (call) {
        yield { type: 'tool-call', id: 'fixture-' + round, name: call[0], arguments: JSON.stringify(call[1]) };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else {
        const prompt = messages.at(-1).content[0].text;
        assert.ok(prompt.startsWith('HOST_REPAIR_RETEST:'), JSON.stringify(results));
        const evidence = JSON.parse(prompt.split('\n').at(-1));
        assert.equal(evidence.editAtTest.diff, priorPatch);
        retests.push({ prompt, evidence });
        yield { type: 'text-delta', text: 'Fixture blocker.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
  }), 'assertion-fixture'));
  await context.plugin(taskRunnerPlugin);
  await context.taskRunner.run({ prompt: 'Fix the count and run its test.', workspace: {
    root, rootLabel: 'fixture', granted: true, entries: [], sections: [], snapshotDigest: 'sha256:fixture'
  }, readObservedAssertion: readLines, taskClass: 'test', maxToolRounds: 5,
  onEvent: e => { if (e.kind === 'tool.result') results.push([e.name, e.ok, e.errorCode, e.message]); } });
  assert.equal(round, 5);
  return { readResult, retests };
}

test('the next model call receives the verified assertion with the preceding applied patch', async t => {
  const { retests } = await runFailedRetest(t, sourceText);
  for (const { prompt, evidence } of retests) {
    assert.equal(evidence.assertionSource.path, file);
    assert.equal(evidence.assertionSource.line, 3);
    assert.ok(evidence.assertionSource.excerpt.includes(assertion));
    assert.doesNotMatch(prompt, /Read the assertion at its reported location/u);
  }
});

test('a line clipped from the actual serialized tool message is never claimed as read', async t => {
  // The text fits one workspace.read, but escaping quotes makes its JSON
  // exceed the model-facing tool message limit before the assertion line.
  const { readResult, retests } = await runFailedRetest(t, '// ' + '"'.repeat(27000) + sourceText);
  assert.ok(readResult.endsWith('…'));
  assert.ok(!readResult.includes(assertion));
  for (const { prompt, evidence } of retests) {
    assert.equal(evidence.assertionSource, undefined);
    assert.ok(!prompt.includes(assertion));
  }
});

test('only complete observed lines of the failure-time version can accompany the failure', async t => {
  const { root, workspace, frame, readLines } = await setup(t);
  const state = new RepairRetest({ root });
  const offset = sourceText.indexOf(assertion);
  const read = await workspace.read(file, assertion.length, offset);
  state.observeRead(read, { offsetChars: offset });
  state.observeTest(receipt, failed(frame));
  assert.equal((await state.assertionSource(readLines)).excerpt, '3: ' + assertion);
  await writeFile(join(root, file), sourceText.replace('before.count', 'aDifferentValue'));
  state.observeRead(await workspace.read(file), {});
  assert.equal(await state.assertionSource(readLines), undefined);
  await writeFile(join(root, file), sourceText);
  const partial = new RepairRetest({ root });
  partial.observeRead(await workspace.read(file, assertion.length - 1, offset), { offsetChars: offset });
  partial.observeTest(receipt, failed(frame));
  assert.equal(await partial.assertionSource(readLines), undefined);
});

test('Windows file URLs match exact observed paths, including escaped spaces', async () => {
  const workspace = {};
  const state = new RepairRetest(workspace);
  workspace.root = 'C:/project'; // desktop tasks may bind their workspace at the first read.
  state.observeRead({ path: file, digest: 'digest', content: sourceText }, {});
  for (const [frame, found] of [
    ['file:///C:/project/test/unit%20count.mjs:3:1', true],
    ['C:\\project\\test\\unit count.mjs:3:1', true],
    ['file:///C:/outside/test/unit%20count.mjs:3:1', false],
    ['file:///C:/project/unread/unit%20count.mjs:3:1', false]
  ]) {
    state.observeTest(receipt, failed(frame));
    let probes = 0;
    const excerpt = await state.assertionSource(async observation => {
      probes++;
      assert.equal(observation.path, file);
      return assertion;
    });
    assert.equal(Boolean(excerpt), found);
    assert.equal(probes, Number(found));
  }
});

test('long edits have a marked bounded diff and retain the resulting file digest', () => {
  const state = new RepairRetest();
  const diff = 'start\n' + 'x'.repeat(12000) + '\nend';
  state.observeEdit('file.patch', { path: 'view.mjs', diff, contentDigest: 'result' });
  state.observeTest(receipt, failed('test.mjs:3:1'));
  const { editAtTest } = JSON.parse(state.instruction(false).split('\n').at(-1));
  assert.equal(editAtTest.digest, 'result');
  assert.equal(editAtTest.diffTruncated, true);
  assert.ok(editAtTest.diff.length < 8100 && editAtTest.diff.startsWith('start') && editAtTest.diff.endsWith('end'));
});

test('pytest and unittest resolve observed paths relative to the actual test cwd', async () => {
  const workspace = { root: '/project' };
  const state = new RepairRetest(workspace);
  state.observeRead({ path: 'pkg/test_count.py', digest: 'digest', content: 'assert count == 3' }, {});
  for (const stdout of [
    'E   AssertionError: count mismatch\ntest_count.py:1: AssertionError',
    'Traceback (most recent call last):\n  File "test_count.py", line 1, in test_count\n    self.assertEqual(count, 3)\nAssertionError: count mismatch'
  ]) {
    state.observeTest({ ...receipt, cwd: 'pkg' }, { ok: false, stdout });
    assert.equal((await state.assertionSource(async () => '1: assert count == 3')).line, 1);
  }
  workspace.root = '/different';
  assert.equal(await state.assertionSource(() => assert.fail('another workspace cannot reuse the old observation')), undefined);
});
