import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ReadonlyWorkspace } from '../src/plugins/workspace-readonly.mjs';
import { withCandidateWorkspace } from '../src/repair-candidate-workspace.mjs';

const exec=promisify(execFile);
const producer=`import { lstat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const names=['primary','secondary'];
const seal = text => createHash('sha256').update(text).digest('hex');
const serialize = input => JSON.stringify(input);
const inspect = async (file,options) => {
  const status = await lstat(file).catch(() => null);
  if (!status) return { exists:false };
  const kind = status.isSymbolicLink() ? 'alias' : status.isFile() ? 'regular' : 'other';
  return {exists:true,kind};
};
export const build = async directory => {
  const indexed={};
  let warning=false;
  for (const label of names) {
    const item=await inspect(join(directory,label),{ flexible:true });
    indexed[label]=item;
    warning ||= item.kind === 'alias';
  }
  return { signature: seal(serialize(indexed)), warning };
};
`;
const original=`import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from './producer.mjs';
export const changed = (a,b) => a.signature !== b.signature || a.warning !== b.warning;
test('publishing an optional ordinary record preserves the signature', async () => {
  const dir=await mkdtemp(join(tmpdir(),'dda-ordinary-fixture-'));
  try {
    const before=await build(dir);
    await writeFile(join(dir,'primary'),'example');
    const after=await build(dir);
    assert.equal(before.signature, after.signature);
    assert.equal(changed(before,after),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
`;

async function fixture(t, source = producer) {
  const root=await mkdtemp(join(tmpdir(),'dda-preserve-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'lib'));
  const path='lib/producer.mjs',targetPath='lib/behavior.test.mjs';
  await writeFile(join(root,path),source);
  await writeFile(join(root,targetPath),original);
  const workspace=new ReadonlyWorkspace(root);
  const line=source.split('\n').findIndex(s=>s.includes('signature: seal'))+1;
  const producerSites=[{path,line,field:'signature',sourceLine:source.split('\n')[line-1],digest:(await workspace.read(path)).digest}];
  const args={workspace,targetPath,assertionLine:14,targetDigest:(await workspace.read(targetPath)).digest,producerSites};
  return async function replay(preservation,candidateContent) {
    return withCandidateWorkspace({...args,preservation,...(candidateContent ? {candidatePath:path,candidateContent} : {})}, async ({cwd,marker,preservationMarker})=>{
      const env={...process.env};
      delete env.NODE_TEST_CONTEXT;
      const result=await exec(process.execPath,['--test','--test-reporter=tap',targetPath],{cwd:join(root,cwd),env}).catch(error=>error);
      const lines=result.stdout.split(/\r?\n/u).map(s=>s.replace(/^# /u,''));
      const receipt=prefix=>{
        const matching=lines.filter(s=>s.startsWith(prefix));
        assert.equal(matching.length,1,result.stdout);
        return JSON.parse(matching[0].slice(prefix.length));
      };
      return {exit:result.code??0,assertion:receipt(marker),preservation:receipt(preservationMarker)};
    });
  };
}

test('measured keys and an observed producer drive two independent exception controls', async t => {
  const replay = await fixture(t);
  const baseline=await replay(true);
  assert.equal(baseline.exit,1);
  assert.equal(baseline.assertion.passed,false);
  assert.equal(baseline.preservation.status,'observed');
  assert.deepEqual(baseline.preservation.branch,{field:'kind',literal:'alias'});
  assert.deepEqual([baseline.preservation.key,baseline.preservation.otherKey],['primary','secondary']);
  assert.deepEqual(baseline.preservation.checks,{additional:true,relocated:true});
  const contrasts = baseline.preservation.fileTypes;
  assert.deepEqual(new Set(contrasts.map(pair => pair.key)), new Set(['primary','secondary']));
  assert.equal(contrasts.length, 10);
  assert.ok(contrasts.every(row => row.distinguished));
  // Directory and residual filesystem items were already grouped as 'other'.
  assert.ok(!contrasts.some(pair => pair.from==='directory' && pair.to==='other'));
  const normalized=producer.replace('indexed[label]=item;', "indexed[label]=item.exists ? item : {exists:true,kind:'regular'};");
  const good=await replay(baseline.preservation,normalized);
  assert.equal(good.exit,0);
  assert.equal(good.assertion.passed,true);
  assert.equal(good.preservation.status,'preserved');
  assert.deepEqual(good.preservation.fileTypes, contrasts);
  const partial=await replay(baseline.preservation,normalized.replace('indexed[label]=item.exists',
    "indexed[label]=label === 'secondary' && item.kind === 'other' ? {exists:true,kind:'regular'} : item.exists"));
  assert.equal(partial.exit,0);
  assert.equal(partial.assertion.passed,true);
  assert.equal(partial.preservation.status,'collapsed');
  assert.deepEqual(partial.preservation.checks,{additional:true,relocated:true});
  assert.deepEqual(partial.preservation.fileTypes.filter(row => !row.distinguished),[
    {key:'secondary',from:'file',to:'directory',distinguished:false},
    {key:'secondary',from:'file',to:'other',distinguished:false}
  ]);
  const collapsed=await replay(baseline.preservation,producer.replace('indexed[label]=item;','indexed[label]={};'));
  assert.equal(collapsed.exit,0);
  assert.equal(collapsed.assertion.passed,true);
  assert.equal(collapsed.preservation.status,'collapsed');
  assert.equal(collapsed.preservation.aggregateConstant,true);
  assert.deepEqual(collapsed.preservation.checks,{additional:false,relocated:false});
  // An opaque additional read must never be performed by a synthetic replay.
  const unsupported=await replay(baseline.preservation,normalized.replace('indexed[label]=', "if (item.kind==='alias') await access(join(directory,label));\n    indexed[label]="));
  assert.equal(unsupported.exit,0);
  assert.deepEqual(unsupported.preservation,{status:'unverified'});
});

test('an explicit socket or device classification contributes a measured type contrast', async t => {
  const classifier = "status.isFIFO() ? 'pipe' : status.isSocket() ? 'socket' : status.isBlockDevice() ? 'block' : status.isCharacterDevice() ? 'character' : 'other'";
  const source = producer.replace("status.isFile() ? 'regular' : 'other'", "status.isFile() ? 'regular' : " + classifier);
  const replay = await fixture(t,source);
  const baseline = await replay(true);
  assert.equal(baseline.preservation.status,'observed');
  const comparisons = baseline.preservation.fileTypes.filter(pair => pair.key==='primary' && pair.from==='file');
  assert.deepEqual(comparisons.map(pair => pair.to),['directory','symlink','other','fifo','socket','blockDevice','characterDevice']);
  const wrong = source.replace('indexed[label]=item;', "indexed[label]=!item.exists || item.kind==='socket' ? {exists:true,kind:'regular'} : item;");
  const candidate = await replay(baseline.preservation,wrong);
  assert.equal(candidate.assertion.passed,true);
  assert.equal(candidate.preservation.status,'collapsed');
  assert.deepEqual(candidate.preservation.fileTypes.filter(pair => !pair.distinguished),[
    {key:'primary',from:'file',to:'socket',distinguished:false},
    {key:'secondary',from:'file',to:'socket',distinguished:false}
  ]);
});
