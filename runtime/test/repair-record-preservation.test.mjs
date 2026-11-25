import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { withCandidateWorkspace } from '../src/repair-candidate-workspace.mjs';

const run = promisify(execFile);
const product = `import { createHash } from 'node:crypto';
const seal = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function summarize(stops) {
  const byRoute = new Map(stops.map(stop => [stop.route, stop]));
  const rows = [...byRoute.values()].map(stop => [stop.route, stop.meta]);
  return {
    updated: Math.max(...[...byRoute.values()].map(stop => stop.meta.seconds)),
    stamp: seal(rows),
    delayed: [...byRoute.values()].some(stop => stop.meta.reason !== null)
  };
}
export const publish = (last, now) => last.stamp !== now.stamp;
`;
const target = `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './routes.mjs';
test('a new received time leaves a route intact', () => {
  const sample = (seconds, reason) => ({ route: 'private-route', meta: {seconds, reason} });
  assert.equal(summarize([sample(0, 91)]).delayed, true);
  const a = summarize([sample(1, null)]);
  const b = summarize([sample(2, null)]);
  assert.equal(a.stamp, b.stamp);
});
`;

test('a keyed record predicate preserves membership, identity and alternate non-null values', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dda-record-check-'));
  t.after(() => rm(root, { recursive:true,force:true }));
  const path = 'routes.mjs', targetPath = 'route.test.mjs';
  await writeFile(join(root, path), product);
  await writeFile(join(root, targetPath), target);
  const workspace = new ReadonlyWorkspace(root);
  const fieldLine = product.split('\n').findIndex(x => x.includes('stamp: seal')) + 1;
  const site = { path, digest:(await workspace.read(path)).digest, field:'stamp', line:fieldLine, sourceLine:product.split('\n')[fieldLine-1] };
  const params = {workspace,targetPath,targetDigest:(await workspace.read(targetPath)).digest,
    assertionLine:target.split('\n').findIndex(x=>x.includes('assert.equal(a.stamp')) + 1, producerSites:[site]};
  async function submit(preservation, candidateContent, otherSites = []) {
    const proposal = candidateContent ? {candidatePath:path,candidateContent} : {};
    return withCandidateWorkspace({...params,...proposal,preservation,producerSites:[...params.producerSites,...otherSites]}, async ({cwd, preservationMarker}) => {
      const env = {...process.env};
      delete env.NODE_TEST_CONTEXT;
      const result = await run(process.execPath,['--test','--test-reporter=tap',targetPath],{cwd:join(root,cwd),env}).catch(e=>e);
      const messages = result.stdout.split(/\r?\n/u).filter(line=>line.includes(preservationMarker));
      const receipts = messages.map(line => JSON.parse(line.split(preservationMarker)[1]));
      if (!otherSites.length) assert.equal(receipts.length,1,result.stdout);
      return {exit:result.code ?? 0,receipt:receipts[0],receipts};
    });
  }
  const baseline = await submit(true);
  assert.equal(baseline.exit,1);
  assert.equal(baseline.receipt.status,'observed');
  assert.deepEqual(baseline.receipt.branch,{field:'meta.reason',literal:'non-null'});
  assert.equal(JSON.stringify(baseline.receipt).includes('private-route'),false);
  const tests = [
    ['per-route codes', '[stop.route, { reason:stop.meta.reason }]', 'preserved', [true,true,true,true]],
    ['retains membership with one flag per route', '[stop.route, stop.meta.reason !== null]', 'collapsed', [true,true,false,false]],
    ['drops exceptions from the stamp', '[stop.route]', 'collapsed', [false,false,false,false]]
  ];
  for (const [name, replacement, status, checks] of tests) {
    const candidate = product.replace('[stop.route, stop.meta]',replacement);
    const result = await submit(baseline.receipt,candidate);
    assert.equal(result.exit,0,name);
    assert.equal(result.receipt.status,status,name);
    assert.deepEqual(result.receipt.checks,{additional:checks[0],relocated:checks[1],changedValue:checks[2],swappedValues:checks[3]},name);
  }
  const bag = product.replace('[stop.route, stop.meta]', '[stop.route, stop.meta.reason !== null]')
    .replace('stamp: seal(rows)', 'stamp: seal([rows, [...byRoute.values()].map(stop => stop.meta.reason).sort()])');
  const unbound = await submit(baseline.receipt, bag);
  assert.equal(unbound.exit,0);
  assert.equal(unbound.receipt.status,'collapsed');
  assert.deepEqual(unbound.receipt.checks,{additional:true,relocated:true,changedValue:true,swappedValues:false});
  const unverified = await submit(baseline.receipt, product.replace('[stop.route, stop.meta]', '[stop.route, stop.meta.reason]')
    .replace('const rows =', 'const timestamp = Date.now();\n  const rows ='));
  assert.equal(unverified.exit,0);
  assert.deepEqual(unverified.receipt,{status:'unverified'});

  // A second source that also returns "stamp" must not select its filesystem
  // replay over the actual failed comparison of the in-memory route records.
  const fsSource = `import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
const names = ['one','two'];
const seal = x => JSON.stringify(x);
const inspect = async p => {
  const stat = await lstat(p);
  const kind = stat.isDirectory() ? 'folder' : 'ordinary';
  return {kind};
};
export async function describe(root) {
  const entries = {};
  let occupied = false;
  for (const key of names) {
    const entry = await inspect(join(root,key));
    entries[key] = entry;
    occupied ||= entry.kind === 'folder';
  }
  return {stamp: seal(entries),occupied};
}
export const changed = (x,y) => x.stamp !== y.stamp || x.occupied !== y.occupied;
`;
  const file = 'layout.mjs';
  await writeFile(join(root,file),fsSource);
  const lines = fsSource.split('\n'), line = lines.findIndex(x => x.includes('stamp: seal')) + 1;
  const extra = {path:file,digest:(await workspace.read(file)).digest,line,sourceLine:lines[line-1],field:'stamp'};
  const mixed = await submit(true, undefined, [extra]);
  assert.deepEqual(mixed.receipts.map(r=>r.status).sort(),['observed','unverified']);
  assert.equal(mixed.receipts.find(r=>r.status==='observed').kind,'records');
});
