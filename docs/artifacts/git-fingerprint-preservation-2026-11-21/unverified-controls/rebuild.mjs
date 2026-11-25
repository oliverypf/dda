import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyTextPatch, textDigest } from '../../../../runtime/src/text-patch.mjs';
import { instrumentPreservation, preservationPlan } from '../../../../runtime/src/repair-preservation.mjs';
import { gradeLinks } from '../grade-links.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const archive = resolve(here, '..');
const repo = resolve(archive, '../../..');
const checkpoint = join(repo,'.codex-tmp/fp-preservation-live-20261121/bad-checkpoint/work');
const product = 'runtime/src/git-observer.mjs';
const test = 'runtime/test/git-audit.test.mjs';
const original = await readFile(join(checkpoint,product),'utf8');
const cases = [[3,11],[2,12]];
for (const [trial, round] of cases) {
  const label = `dda-${trial}-r${round}`;
  const log = JSON.parse(await readFile(join(archive,`dda-${trial}.json`),'utf8'));
  const selected = log.continuation_events.filter(e=>e.payload?.round===round);
  const call = selected.find(e=>e.kind==='tool.call_requested' && e.payload.name==='file.patch');
  const verdict = selected.find(e=>e.kind==='harness.repair_candidate');
  const result = selected.find(e=>e.kind==='tool.result' && e.payload.id===call.payload.id);
  assert.equal(result.payload.ok,false);
  assert.equal(result.payload.errorCode,'CANDIDATE_CHECK_FAILED');
  assert.equal(verdict.payload.status,'unverified');
  const realCall=log.presented_tool_history.flatMap(h=>h.turn.flatMap(m=>m.calls??[])).find(c=>c.id===call.payload.id);
  assert.equal(realCall.function.name,'hmc_file_x2e_patch');
  const args=JSON.parse(realCall.function.arguments);
  assert.equal(args.path,product);
  const candidate=applyTextPatch(original,args.replacements,args.expectedDigest);
  assert.equal(textDigest(candidate),verdict.payload.candidateDigest);
  const temp=await mkdtemp(join(tmpdir(),'dda-refused-candidate-'));
  try {
    await cp(join(checkpoint,'runtime'),join(temp,'runtime'),{recursive:true});
    await writeFile(join(temp,product),candidate);
    assert.equal(textDigest(await readFile(join(temp,product),'utf8')),verdict.payload.candidateDigest);
    const outputDir=join(here,label);
    await gradeLinks(temp,outputDir);
    const grade=JSON.parse(await readFile(join(outputDir,'grade.json'),'utf8'));
    const evidence={trial,round,callId:call.payload.id,callSeq:call.sequence,verdictSeq:verdict.sequence,
      product,checkpointProducerDigest:textDigest(original),argumentsDigest:call.payload.argumentsDigest,
      candidateDigest:textDigest(candidate),liveCandidateExit:verdict.payload.exitCode,
      liveAssertionPassed:verdict.payload.assertionPassed,liveWriteOk:result.payload.ok,
      independentGrade:{passed:grade.passed,failed:grade.failed,errored:grade.errored,green:grade.green}};
    if (trial===3) {
      // This extra run only records the two baseline keys actually visited by
      // the real candidate reader. The held-out grade above uses pristine bytes.
      const site=log.presented_recovery_context.source.possibleProducers[0];
      const line=Number(site.excerpt.match(/^(\d+):/u)[1]);
      const anchor={path:product,digest:textDigest(original),field:site.field,line,sourceLine:original.split(/\r?\n/u)[line-1]};
      const plan=preservationPlan(product,original,textDigest(original),candidate,[anchor]);
      assert.ok(plan,'candidate source must support the observed original loop');
      const helper=join(temp,'record-keys.mjs');
      await writeFile(helper,`import {after} from 'node:test';const seen=new Set();export function recordItem(path,key,reader,...args){if(key==='index'||key==='FETCH_HEAD')seen.add(key);return Reflect.apply(reader,undefined,args)}after(()=>console.log('CHECKPOINT_CONTROL_KEYS='+JSON.stringify([...seen].sort())));`);
      await writeFile(join(temp,product),instrumentPreservation(candidate,plan,pathToFileURL(helper).href,'__controlRecord'));
      const proc=spawnSync(process.execPath,['--test','--test-reporter=tap',test],{cwd:temp,encoding:'utf8',windowsHide:true,timeout:120000});
      assert.equal(proc.status,0,proc.stderr||proc.stdout);
      const observed=proc.stdout.match(/CHECKPOINT_CONTROL_KEYS=(\[[^\]]*\])/u);
      assert.ok(observed,proc.stdout);
      evidence.control={compiled:true,actualCollection:plan.actual.collection,watchedKeys:['index','FETCH_HEAD'],
        visitedKeys:JSON.parse(observed[1]),originalTestsPassed:Number(proc.stdout.match(/^# pass (\d+)/mu)[1])};
      assert.deepEqual(evidence.control.visitedKeys,['index']);
      await writeFile(join(outputDir,'instrumented-original.tap'),proc.stdout+proc.stderr);
    }
    await writeFile(join(outputDir,'reconstruction.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(label,JSON.stringify(evidence.independentGrade),evidence.control?.visitedKeys);
  } finally {
    await rm(temp,{recursive:true,force:true,maxRetries:2});
  }
}
