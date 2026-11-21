from pathlib import Path
import subprocess,sys,shutil,json,hashlib,os
out=Path(__file__).resolve().parent
repo=out.parent.parent
def git(*args,cwd=repo):
    return subprocess.check_output(['git',*args],cwd=cwd)
seed=out/'seed'
seed.mkdir()
for rel in git('ls-tree','-r','--name-only','8aa4acd','runtime/src').decode().splitlines():
    f=seed/rel
    f.parent.mkdir(parents=True,exist_ok=True)
    f.write_bytes(git('show','8aa4acd:'+rel))
t=git('show','8aa4acd:runtime/test/git-audit.test.mjs').decode()
fixture=t[:t.index("test('GitObserver bounds untracked")]
f=seed/'runtime/test/git-audit.test.mjs'
f.parent.mkdir(parents=True)
f.write_text(fixture,encoding='utf8')
(seed/'package.json').write_text(json.dumps({'name':'runtime-regression-workspace','private':True,'scripts':{'test':'node --test runtime/test/*.test.mjs'}}),encoding='utf8')
git('init','-q',cwd=seed)
git('-c','core.autocrlf=false','add','.',cwd=seed)
git('-c','user.name=Benchmark','-c','user.email=bench@example.invalid','commit','-qm','Initial runtime fixture',cwd=seed)
prompt='修复这个仓库中的 Git 指纹误报：后台刷新 Git 后，普通工作区文件修改偶尔被报告为越界。请定位原因、修改实现并实际运行相关测试。真正的暂存区改动和仓库配置改动仍应被检测。保持现有测试有效。'
(out/'prompt.txt').write_text(prompt,encoding='utf8')
runs={}
for c,base in [('dda',23110),('dsh',23120),('bitfun',23130),('pi',23140)]:
    for i in range(1,4):
        key=f'{c}-{i}'
        home=out/key
        home.mkdir()
        shutil.copytree(seed,home/'work')
        runs[key]=base+i
(out/'ports.json').write_text(json.dumps(runs),encoding='utf8')
print('WORKSPACES_READY',len(runs),'seed',git('rev-parse','HEAD',cwd=seed).decode().strip())

