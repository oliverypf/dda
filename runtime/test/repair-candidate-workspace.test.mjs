import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { withCandidateWorkspace } from '../src/repair-candidate-workspace.mjs';

const execute = promisify(execFile);
const source = `import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { value } from '../value.js';
test('both calls execute once per iteration', async () => {
  let count = 0;
  for (const expected of [7, Number(await readFile(new URL('./fixture', import.meta.url), 'utf8'))]) {
    assert.equal((count++, value), expected);
  }
  assert.equal(count, 2);
});
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dda-candidate-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'tests', 'suite.js'), source);
  await writeFile(join(root, 'tests', 'fixture'), '7');
  await writeFile(join(root, 'value.js'), 'export const value = 99;');
  const workspace = new ReadonlyWorkspace(root);
  return { workspace, targetPath: 'tests/suite.js', targetDigest: (await workspace.read('tests/suite.js')).digest,
    assertionLine: 8, candidatePath: 'value.js', candidateContent: 'export const value = 7;', cwd: 'tests' };
}

test('candidate runs the copied original assertion at its relative cwd and reports all calls', async t => {
  const input = await fixture(t);
  for (const candidate of [7, 9]) {
    const outcomes = await withCandidateWorkspace({ ...input, candidateContent: `export const value = ${candidate};` }, async ({ cwd, marker }) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = await execute(process.execPath, ['--test', '--test-reporter=tap', 'suite.js'], {
        cwd: join(input.workspace.root, cwd), env
      }).catch(error => error);
      assert.equal(result.code ?? 0, candidate === 7 ? 0 : 1);
      return result.stdout.split(/\r?\n/u).map(line => line.replace(/^# /u, ''))
        .filter(line => line.startsWith(marker)).map(line => JSON.parse(line.slice(marker.length)));
    });
    assert.deepEqual(outcomes, candidate === 7 ? [
      { passed: true, operands: [7, 7] }, { passed: true, operands: [7, 7] }
    ] : [{ passed: false, operands: [9, 7] }]);
  }
  assert.equal(await readFile(join(input.workspace.root, input.targetPath), 'utf8'), source);
  assert.equal(await readFile(join(input.workspace.root, input.candidatePath), 'utf8'), 'export const value = 99;');
  assert.equal((await readdir(input.workspace.root)).filter(path => path.startsWith('.dda-candidate-')).length, 0);
});

test('a changed target and unsupported assertion fail before execution and leave no candidate tree', async t => {
  const input = await fixture(t);
  const never = () => assert.fail('unexpected test execution');
  await assert.rejects(withCandidateWorkspace({ ...input, assertionLine: 7 }, never), /UNSUPPORTED_ASSERTION/);
  await assert.rejects(withCandidateWorkspace({ ...input, targetDigest: 'sha256:' + '0'.repeat(64) }, never), /TARGET_CHANGED/);
  assert.equal((await readdir(input.workspace.root)).some(path => path.startsWith('.dda-candidate-')), false);
});

test('cleanup after a failed run unlinks a test-created directory link without traversing it', async t => {
  const input = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'dda-candidate-external-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, 'sentinel'), 'preserve');
  await assert.rejects(withCandidateWorkspace(input, async ({ cwd }) => {
    await symlink(external, join(input.workspace.root, cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    throw new Error('cancelled');
  }), /cancelled/);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'preserve');
  assert.equal((await readdir(input.workspace.root)).some(path => path.startsWith('.dda-candidate-')), false);
});

test('verified producer inputs are matched to both failed operands on the baseline and the actual candidate', async t => {
  const input = await fixture(t);
  const root = input.workspace.root;
  const target = `import test from 'node:test';
import assert from 'node:assert/strict';
import { packet, calls } from '../value.js';
test('compare the outputs', () => {
  const a = packet(false);
  const b = packet(true);
  assert.equal(calls(), 4);
  assert.equal(a.measure, b.measure);
});
`;
  const producer = `import { createHash } from 'node:crypto';
let runs = 0;
export const calls = () => runs;
const encode = value => { ++runs; return JSON.stringify(value); };
const result = text => { ++runs; return createHash('sha256').update(text).digest('hex'); };
export function packet(flag) {
  const payload = { flag, state: flag ? 'warm' : 'cold', privateToken: flag ? 'hide-me-2' : 'hide-me-1', ignored: 'unrelated' };
  return { measure: result(encode(payload)) };
}
`;
  await writeFile(join(root,input.targetPath), target);
  await writeFile(join(root,input.candidatePath), producer);
  const site = { path: input.candidatePath, digest: (await input.workspace.read(input.candidatePath)).digest,
    field: 'measure', line: 8, sourceLine: producer.split('\n')[7] };
  const settings = { workspace: input.workspace, cwd: 'tests', targetPath: input.targetPath, assertionLine: 8,
    targetDigest: (await input.workspace.read(input.targetPath)).digest, producerSites: [site] };
  async function observed(options) {
    return withCandidateWorkspace({ ...settings, ...options }, async ({cwd,marker}) => {
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = await execute(process.execPath,['--test','--test-reporter=tap','suite.js'],{cwd:join(root,cwd),env}).catch(error => error);
      assert.equal(result.code,1);
      const record = result.stdout.split(/\r?\n/u).map(line => line.replace(/^# /u,'')).find(line => line.startsWith(marker));
      assert.ok(record, result.stdout);
      return JSON.parse(record.slice(marker.length));
    });
  }
  const verify = (observed,line) => {
    assert.equal(observed.passed,false);
    assert.equal(observed.producerInputs.line,line);
    assert.deepEqual(observed.producerInputs.differences,[
      { path:['flag'],before:false,after:true },
      { path:['state'],before:'cold',after:'warm' }
    ]);
    assert.equal(observed.producerInputs.truncated,true);
    assert.doesNotMatch(JSON.stringify(observed.producerInputs), /hide-me|privateToken|ignored|unrelated/u);
  };
  verify(await observed({}),8);
  const moved = producer.replace('  return { measure:', '  const shifted = encode;\n  return { measure:').replace('result(encode(payload))','result(shifted(payload))');
  verify(await observed({ candidatePath:site.path,candidateContent:moved }),9);
  assert.equal((await observed({producerSites:[{...site,digest:'sha256:'+'0'.repeat(64)}]})).producerInputs, undefined);
  assert.equal((await observed({producerSites:[{...site,sourceLine:site.sourceLine.trim()}]})).producerInputs, undefined);
  const collision = producer.replace('++runs; return JSON.stringify(value)', "++runs; return String(value.flag)")
    .replace('export function packet(flag)', 'export function packet(flag, extra = 0)').replace('const payload = { flag,','const payload = { extra, flag,')
    .replace('export const calls = () => runs;', 'export const calls = () => runs - 2;') + '\npacket(false, 1);\n';
  assert.equal((await observed({candidatePath:site.path,candidateContent:collision})).producerInputs, undefined);
});
