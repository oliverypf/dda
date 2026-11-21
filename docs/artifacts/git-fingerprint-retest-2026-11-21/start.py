"""Run the patched host against three untouched task checkouts, once."""
from pathlib import Path
import hashlib,json,os,socket,subprocess,sys,time
root=Path(__file__).resolve().parent
repo=root.parent.parent
def hash_files():
    h=hashlib.sha256()
    for pattern in ('runtime/src/**/*.mjs','linux-cli/src/**/*.mjs','linux-cli/bin/**/*.mjs'):
        for f in sorted(repo.glob(pattern)):
            h.update(f.relative_to(repo).as_posix().encode()+b'\0'+hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()
def write(n,x):
    (root/n).write_text(json.dumps(x,indent=2),encoding='utf8')
def spawn(cmd,**kwargs):
    return subprocess.Popen([sys.executable,'-u',str(root/cmd)],cwd=root,**kwargs)
ports=json.loads((root/'ports.json').read_bytes())
for n,p in ports.items():
    assert not (root/n/'proxy.jsonl').exists() and not (root/n/'dda-events.jsonl').exists(), 'fresh attempt required'
    with socket.socket() as s:
        s.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1);s.bind(('127.0.0.1',p))
assert os.environ.get('DEEPSEEK_API_KEY'), 'provider credential unavailable'
sha=hash_files()
dirty=subprocess.check_output(['git','diff','--name-only','8aa4acd','--','runtime/src','linux-cli/src','linux-cli/bin'],cwd=repo).decode().splitlines()
new=subprocess.check_output(['git','ls-files','--others','--exclude-standard','--','runtime/src','linux-cli/src','linux-cli/bin'],cwd=repo).decode().splitlines()
write('host-start.json',dict(host_head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo).decode().strip(),source_sha256=sha,modified_vs_baseline=dirty+new,changed_sha256={n:hashlib.sha256((repo/n).read_bytes()).hexdigest() for n in dirty+new if (repo/n).is_file()}))
with (root/'proxy.stderr.log').open('wb') as logfile:
    proxy=spawn('proxy.py',stdout=logfile,stderr=subprocess.STDOUT)
    try:
        for attempt in range(60):
            ok=True
            for p in ports.values():
                try:
                    with socket.create_connection(('127.0.0.1',p),timeout=.3): pass
                except OSError:ok=False
            if ok: break
            if proxy.poll() is not None: raise RuntimeError('proxy terminated')
            time.sleep(.2)
        else: raise RuntimeError('three proxy listeners not ready')
        with (root/'launcher.stdout.log').open('wb') as output:
            proc=spawn('launch_dda.py',stdout=output,stderr=subprocess.STDOUT)
            try:rc=proc.wait(timeout=530)
            except subprocess.TimeoutExpired:
                subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True)
                raise
        assert rc==0,'one or more launcher workers failed: '+str(rc)
    finally:
        proxy.terminate();proxy.wait(timeout=10)
write('host-end.json',dict(source_sha256=hash_files(),all_clients_terminal=all((root/n/'dda-run.json').exists() for n in ports)))
assert hash_files()==sha,'host changed during run'
print('Three clients reached terminal state; proxy stopped.')

