from pathlib import Path
import hashlib,json,shutil,subprocess,sys
root=Path(__file__).resolve().parent
repo=root.parent.parent
old=repo/'.codex-tmp/fp-bench-20261121'
art=repo/'docs/artifacts/git-fingerprint-2026-11-21'
protocol=json.loads((art/'protocol.json').read_bytes())
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def tree(p):
 h=hashlib.sha256()
 for f in sorted(p.rglob('*')):
  if f.is_file():
   h.update(f.relative_to(p).as_posix().encode()+b'\0'+hashlib.sha256(f.read_bytes()).digest())
 return h.hexdigest()
def git(*args,cwd):
 return subprocess.check_output(['git',*args],cwd=cwd).decode().strip()
files={}
for n in ('prompt.txt','grade.py','proxy.py','launch_dda.py'):
 a=old/n
 v=digest(a)
 assert v==digest(art/n), (n,'old script changed')
 if n in protocol['checksums']:assert v==protocol['checksums'][n], n
 shutil.copy2(a,root/n); files[n]=v
se=old/'seed'
assert git('rev-parse','HEAD',cwd=se)==protocol['seed']
assert not git('status','--porcelain','--untracked-files=all',cwd=se)
assert all((root/x).exists()==False for x in ['seed','dda-1','dda-2','dda-3'])
seeds={}
for n in ['seed','dda-1','dda-2','dda-3']:
 d=root/'seed' if n=='seed' else root/n/'work'
 shutil.copytree(se,d)
 seeds[n]=dict(head=git('rev-parse','HEAD',cwd=d),src_hash=tree(d/'runtime/src'),test_hash=digest(d/'runtime/test/git-audit.test.mjs'),package_hash=digest(d/'package.json'),dirty=git('status','--porcelain','--untracked-files=all',cwd=d))
 assert seeds[n]==seeds['seed'] and not seeds[n]['dirty']
(root/'ports.json').write_text(json.dumps({f'dda-{i}':23110+i for i in range(1,4)}),encoding='utf8')
(root/'preflight.json').write_text(json.dumps(dict(method=files,seeds=seeds,model=protocol['model'],limits=protocol['limits'],baseline_host='8aa4acd'),indent=2),encoding='utf8')
print('prepared',protocol['seed'],seeds['seed']['src_hash'],files['prompt.txt'],flush=True)

