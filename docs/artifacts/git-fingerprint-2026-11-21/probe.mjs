import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {createGitObserver} from './seed/runtime/src/git-observer.mjs';
const root=await mkdtemp(join(tmpdir(),'dda-fp-witness-'));
const git=(...a)=>execFileSync('git',a,{cwd:root,windowsHide:true});
git('init','-q');git('config','user.name','Fixture');git('config','user.email','f@example.invalid');
await writeFile(join(root,'a'),'a\n');git('add','a');git('commit','-qm','base');
const observer=createGitObserver({workspaceRoot:root});
let prev=await observer.snapshot();let rows=[];
async function check(step,action){await action();const x=await observer.snapshot();rows.push({step,metadataChanged:x.metadataDigest!==prev.metadataDigest,indexChanged:x.indexDigest!==prev.indexDigest,unstaged:x.status.unstagedCount,staged:x.status.stagedCount});prev=x;}
await check('edit worktree',()=>writeFile(join(root,'a'),'b\n'));
await check('git status',()=>git('status'));
await check('create FETCH_HEAD',()=>writeFile(join(root,'.git','FETCH_HEAD'),'a'.repeat(40)+'\tnot-for-merge\tbranch main\n'));
await check('update existing FETCH_HEAD',()=>writeFile(join(root,'.git','FETCH_HEAD'),'b'.repeat(40)+'\tnot-for-merge\tbranch other\n'));
await check('stage real change',()=>git('add','a'));
await check('change repo config',()=>git('config','audit.fixture','yes'));
await writeFile(new URL('root-cause-probe.json',import.meta.url),JSON.stringify(rows,null,2));console.log(JSON.stringify(rows));

