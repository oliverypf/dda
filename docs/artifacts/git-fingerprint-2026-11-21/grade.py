from pathlib import Path
import json,sys,shutil,re,subprocess,os,time
root=Path(__file__).resolve().parent
seed=root/'seed'
original=(seed/'runtime/test/git-audit.test.mjs').read_text(encoding='utf8')
prefix=original.split("test('GitObserver returns")[0]
def test(name,body):return "test('"+name+"', async () => {\n"+body+"\n});\n"
setup="""const root = await initRepository();
const observer = createGitObserver({workspaceRoot:root});
const before = await observer.snapshot({reason:'ACTION_STARTED'});
const scope = createExecutionScopeSnapshot({allowedPathScope:'WORKSPACE'});
"""
suite=prefix
suite+=test('worktree_refresh',setup+"""await writeFile(join(root,'README.md'),'new working content\\n'); await runGit(root,['status']); await writeFile(join(root,'.git','FETCH_HEAD'),'b'.repeat(40)+'\\tnot-for-merge\\trefs/heads/topic\\n');
const after=await observer.snapshot({reason:'ACTION_COMPLETED'});
assert.equal(after.available,true); assert.ok(after.status.unstagedCount>=1); assert.notEqual(before.observationDigest,after.observationDigest);
assert.equal(before.metadataDigest,after.metadataDigest); assert.equal(before.indexDigest,after.indexDigest); assert.equal(compareGitObservations(before,after,scope).ok,true);""")
suite+=test('staged_change',setup+"""await writeFile(join(root,'additional.txt'),'extra\\n'); await runGit(root,['add','additional.txt']); const after=await observer.snapshot({reason:'ACTION_COMPLETED'});
assert.ok(after.status.stagedCount>=1); const compared=compareGitObservations(before,after,scope); assert.equal(compared.ok,false); assert.equal(compared.metadataChanged,true);""")
suite+=test('config_change',setup+"""await runGit(root,['config','audit.extra','independent']); const after=await observer.snapshot({reason:'ACTION_COMPLETED'});
assert.notEqual(before.metadataDigest,after.metadataDigest);assert.equal(compareGitObservations(before,after,scope).ok,false);""")
for name in sys.argv[1:]:
    source=(root/name/'work') if name!='seed' else seed
    grade=root/'grading'/name
    grade.mkdir(parents=True,exist_ok=True)
    shutil.copytree(source/'runtime/src',grade/'runtime/src',dirs_exist_ok=True)
    testdir=grade/'runtime/test';testdir.mkdir(exist_ok=True)
    (testdir/'external.mjs').write_text(suite,encoding='utf8')
    (testdir/'original.mjs').write_text(original,encoding='utf8')
    env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','PATHEXT','WINDIR','SYSTEMROOT','PROGRAMFILES','SYSTEMDRIVE','COMSPEC','TEMP','TMP','USERPROFILE','HOME','APPDATA','LOCALAPPDATA']}
    result={}
    for key in ('external','original'):
        cp=subprocess.run(['node','--test','--test-reporter=tap',str(testdir/(key+'.mjs'))],cwd=grade,env=env,capture_output=True,timeout=100)
        (grade/(key+'.tap')).write_bytes(cp.stdout+cp.stderr)
        result[key]=[{'passed':m[1]=='ok','name':m[2]} for m in re.finditer(r'^(ok|not ok) \d+ - (.*)$',cp.stdout.decode(errors='replace'),re.M)]
    result['immutable_test']=original==(source/'runtime/test/git-audit.test.mjs').read_text(encoding='utf8')
    result['green']=all(len(result[k])==3 and all(c['passed'] for c in result[k]) for k in ('external','original')) and result['immutable_test']
    (grade/'grade.json').write_text(json.dumps(result),encoding='utf8');print(name,json.dumps(result),flush=True)

