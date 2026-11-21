from pathlib import Path
from collections import Counter
import hashlib,subprocess,json,sys,re,shutil
root=Path(__file__).resolve().parent
repo=root.parent.parent
old=repo/'docs/artifacts/git-fingerprint-2026-11-21'
dest=repo/'docs/artifacts/git-fingerprint-retest-2026-11-21'
dest.mkdir(exist_ok=True)
def read(f):
 return json.loads(f.read_bytes())
def read_lines(f):
 out=[]
 for line in f.read_bytes().splitlines():
  for enc in ('utf-8','gb18030'):
   try: out.append(json.loads(line.decode(enc))); break
   except (ValueError,UnicodeError):pass
 return out
def tree(p):
 h=hashlib.sha256()
 for f in sorted(p.rglob('*')):
  if f.is_file():
   h.update(f.relative_to(p).as_posix().encode()+b'\0'+hashlib.sha256(f.read_bytes()).digest())
 return h.hexdigest()
def save(p,x):p.write_text(json.dumps(x,indent=2,ensure_ascii=False)+'\n',encoding='utf8')
def short_args(pl):
 args=pl.get('args')
 if not isinstance(args,list):return None
 return [str(a)[:300] if (i==0 or str(args[i-1]).lower() not in ['-e','-c','-command','--eval']) else '<inline-code>' for i,a in enumerate(args[:12])]
def native(v):
 out=[]
 for x in v:
  k=x.get('kind','');p=x.get('payload',{})
  if not isinstance(p,dict):continue
  if k not in ['task.classified','run.failed','run.completed','verification.completed','approval.resolved','tool.result','plan.step_changed','step.execution_profile'] and not any(t in k.lower() for t in ['repair','recovery','retry','retest','continuation']): continue
  fields={f:p[f] for f in ['taskClass','round','attempt','name','ok','path','errorCode','exitCode','command','state','invocationKey','code','status','failureCodes','nextAction','reason','executionProfileId','file','count','recoveryVersion','retestCommand','changedPaths','failedAssertions','reasonCodes','retryCount','repairAttempt'] if f in p and not isinstance(p[f],dict)}
  a=short_args(p)
  if a is not None:fields['args']=a
  if k=='harness.repair_continued':
   fields.update({f:p[f] for f in ('discardedTextChars','discardedReasoningChars') if f in p})
  out.append(dict(kind=k,seq=x.get('sequence'),ms=x.get('emittedAtMs'),**fields))
 return out
def command_is_test(e):
 if e.get('name') not in ('test.execute','shell.execute'):return False
 cmd=str(e.get('command','')).replace('\\','/').split('/')[-1].lower()
 args=e.get('args',[])
 return ('--test' in args or (cmd in ['npm','npm.cmd','pnpm','pnpm.cmd','yarn'] and ('test' in args or 'run' in args and any('test' in str(a) for a in args))) or any('git-audit.test.mjs' in str(a) for a in args))
def analyze(v):
 last_impl=None; red=[]; tests=[]; fixes=[]; before_red=False
 for e in v:
  if e.get('kind')!='tool.result':continue
  if e.get('name') in ('file.write','file.patch') and e.get('ok') and str(e.get('path','')).replace('\\','/').startswith('runtime/src/'):
   last_impl=e['seq'];fixes.append({'seq':last_impl,'path':e.get('path')})
  if command_is_test(e):
   tests.append({'seq':e['seq'],'exitCode':e.get('exitCode'),'ok':e.get('ok'),'command':e.get('command'),'args':e.get('args'),'preceding_impl_seq':last_impl})
   if e.get('ok') is False and last_impl is not None:red.append(e['seq'])
 return dict(implementation_writes=fixes,test_attempts=tests,failed_test_after_impl_seqs=red,
             continued_after_failed_retest=[{'retest_seq':n,'next_tool':next((dict(seq=e.get('seq'),name=e.get('name')) for e in v if (e.get('seq') or 0)>n and e.get('kind')=='tool.result'),None),'next_impl_seq':next((y['seq'] for y in fixes if y['seq']>n),None),'next_test_seq':next((t['seq'] for t in tests if t['seq']>n),None)} for n in red])
before=read(root/'host-start.json');end=read(root/'host-end.json');assert before['source_sha256']==end['source_sha256'] and end['all_clients_terminal']
base_protocol=read(old/'protocol.json');pf=read(root/'preflight.json')
assert read(root/'grading/seed/grade.json')==read(old/'seed-grade.json')
protocol={'baseline_protocol':'../git-fingerprint-2026-11-21/protocol.json','preflight':pf,'host_at_launch':before,'host_at_finish':end,'model':base_protocol['model'],'thinking':base_protocol['thinking'],'limits':base_protocol['limits'],'raw_run_parent':str(root),'three_parallel_fresh_sessions':True}
save(dest/'protocol.json',protocol)
for n in ['prepare.py','start.py','collect.py']:shutil.copy2(root/n,dest/n)
result=[]
for i in range(1,4):
 n=f'dda-{i}';d=root/n
 q=read_lines(d/'proxy.jsonl');responses=[e for e in q if e.get('kind')=='response']; requests=[e for e in q if e.get('kind')=='request']
 model_ids=sorted({e['returned_model'] for e in responses if e.get('returned_model')});assert model_ids==['deepseek-flash']
 events=native(read_lines(d/'dda-events.jsonl')); old_row=read(old/(n+'.json'))
 grade=read(root/'grading'/n/'grade.json'); sh=tree(d/'work/runtime/src');assert sh==tree(root/'grading'/n/'runtime/src')
 stats=dict(calls=len(requests),request_bytes=sum(x['input_bytes'] for x in requests),first_input_bytes=requests[0]['input_bytes'],reported_prompt_tokens=sum((e.get('usage') or {}).get('prompt_tokens',0) for e in responses),completion_tokens=sum((e.get('usage') or {}).get('completion_tokens',0) for e in responses),budget_rejections=sum(e.get('kind')=='budget_stop' for e in q))
 stats.update(upstream_responses=len(responses),upstream_model_responses=sum(bool(e.get('returned_model')) for e in responses),proxy_response_errors=sum(bool(e.get('error')) for e in responses))
 assert stats['calls']<=24 and stats['request_bytes']<=2500000 and stats['completion_tokens']<=24576
 diff=subprocess.check_output(['git','diff','--no-ext-diff','HEAD','--','runtime/src','runtime/test'],cwd=d/'work',stderr=subprocess.DEVNULL)
 if diff:(dest/(n+'.patch')).write_bytes(diff)
 changed=subprocess.check_output(['git','status','--short'],cwd=d/'work').decode(errors='replace').splitlines()
 rec={'run':n,'upstream_model_ids':model_ids,'grade':grade,'native':read(d/'dda-run.json'),'final_source_sha256':sh,'diff_sha256':hashlib.sha256(diff).hexdigest(),'worktree_changes':changed,**stats,'changes_and_retests':analyze(events),'baseline':{'grade':old_row['grade'],'calls':old_row['calls'],'request_bytes':old_row['request_bytes'],'changes_and_retests':analyze(old_row['dda_events'])}}
 timeline=[]
 for e in q:
  line={k:e[k] for k in ('kind','n','t','msgs','input_bytes','model','returned_model','usage') if k in e}
  if e.get('kind')=='response':
   line['calls']=[t.get('name','') for t in (e.get('tools') or [])]
   line['proxy_response_error']=bool(e.get('error'))
  timeline.append(line)
 save(dest/(n+'.json'),{**rec,'runtime_events':events,'proxy_timeline':timeline})
 result.append(rec)
save(dest/'results.json',result)
print('INPUT_AND_GRADER_VERIFIED; reports at',dest)
for row in result:print(row['run'],row['grade']['green'],row['calls'],row['native'],row['changes_and_retests'])

