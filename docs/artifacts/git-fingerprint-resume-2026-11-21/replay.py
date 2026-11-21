"""Replay the archived failed retest through native DDA tools, then cut over to the unchanged live budget proxy."""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

repo = Path(__file__).resolve().parents[3]
scratch = repo / '.codex-tmp'
original = scratch / 'fp-bench-20261121'
previous = scratch / 'fp-retry-20261121'
archive = repo / 'docs/artifacts/git-fingerprint-resume-2026-11-21'
old_archive = archive.parent / 'git-fingerprint-2026-11-21'
wrong = previous / 'dda-2/work'
product = 'runtime/src/execution-scope-snapshot.mjs'
target = 'runtime/test/git-audit.test.mjs'
sessions = ['dda-1', 'dda-2', 'dda-3']


def load(path):
    return json.loads(path.read_bytes())


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf8')


def lines(path):
    data=path.read_bytes()
    # The CLI can be flushing the next event while the gateway inspects earlier receipts.
    if data and not data.endswith(b'\n'):
        data=data.rpartition(b'\n')[0]
    return [json.loads(line) for line in data.splitlines() if line.strip()]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def tree(path):
    value = hashlib.sha256()
    for f in sorted(path.rglob('*')):
        name = f.relative_to(path)
        if '.git' not in name.parts and f.is_file():
            value.update(name.as_posix().encode() + b'\0' + hashlib.sha256(f.read_bytes()).digest())
    return value.hexdigest()


def git(work, *args):
    return subprocess.check_output(['git', *args], cwd=work, stderr=subprocess.DEVNULL)


def read_exact(path):
    return path.read_bytes().decode('utf8')


def replacement():
    a = read_exact(original / 'seed' / product).splitlines(keepends=True)
    b = read_exact(wrong / product).splitlines(keepends=True)
    left = 0
    while a[left] == b[left]:
        left += 1
    right = 0
    while a[-right - 1] == b[-right - 1]:
        right += 1
    old = ''.join(a[left:len(a)-right])
    new = ''.join(b[left:len(b)-right])
    assert ''.join(a).count(old) == 1 and ''.join(a).replace(old, new) == ''.join(b)
    return {'path': product, 'replacements': [{'oldText': old, 'newText': new}]}


def historical_turns():
    events = lines(previous / 'dda-2/dda-events.jsonl')
    records = lines(previous / 'dda-2/proxy.jsonl')
    turns = []
    for r in range(1, 9):
        ran = [e['payload'] for e in events if e.get('kind') == 'tool.call_requested' and e['payload'].get('round') == r]
        public = ''.join(e['payload']['text'] for e in events if e.get('kind') == 'model.text_delta' and e['payload'].get('round') == r)
        saved = next(e['tools'] for e in records if e.get('kind') == 'response' and e.get('n') == r)
        calls = []
        for call, event in zip(saved, ran, strict=True):
            args = replacement() if event['name'] == 'file.patch' else json.loads(call['args'])
            assert call['name'] == 'hmc_' + event['name'].replace('.', '_x2e_')
            calls.append({'id': event['id'], 'type': 'function', 'function': {'name': call['name'], 'arguments': json.dumps(args, ensure_ascii=False)}})
        turns.append({'role': 'assistant', 'content': public or None, 'tool_calls': calls})
    return turns


def source_hash():
    h = hashlib.sha256()
    for pattern in ('runtime/src/**/*.mjs', 'linux-cli/src/**/*.mjs', 'linux-cli/bin/**/*.mjs'):
        for f in sorted(repo.glob(pattern)):
            h.update(f.relative_to(repo).as_posix().encode() + b'\0' + hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()


def prepare(root):
    root.mkdir(parents=True, exist_ok=False)
    assert git(original/'seed', 'rev-parse', 'HEAD').decode().strip() == load(old_archive/'protocol.json')['seed']
    assert git(wrong, 'status', '--short').decode().strip() == 'M ' + product
    assert git(wrong, 'diff', '--no-ext-diff', 'HEAD', '--', 'runtime/src', 'runtime/test') == (archive.parent/'git-fingerprint-retest-2026-11-21/dda-2.patch').read_bytes()
    (root/'upstream').mkdir()
    for name in ('grade.py', 'launch_dda.py', 'prompt.txt', 'proxy.py'):
        src = original/name
        assert src.read_bytes() == (old_archive/name).read_bytes()
        shutil.copyfile(src, (root/'upstream' if name=='proxy.py' else root)/name)
    save(root/'upstream/ports.json', {n: 23211+i for i,n in enumerate(sessions)})
    shutil.copytree(original/'seed', root/'seed')
    for n in sessions:
        shutil.copytree(original/'seed', root/n/'work')
        (root/'upstream'/n).mkdir()
    save(root/'preflight.json', {'seed':git(original/'seed','rev-parse','HEAD').decode().strip(), 'wrong_workspace_sha256':tree(wrong),
        'wrong_file_sha256':digest((wrong/product).read_bytes()), 'wrong_patch_sha256':digest((archive.parent/'git-fingerprint-retest-2026-11-21/dda-2.patch').read_bytes()),
        'prompt_sha256':digest((root/'prompt.txt').read_bytes()), 'grade_sha256':digest((root/'grade.py').read_bytes()),
        'budget_proxy_sha256':digest((root/'upstream/proxy.py').read_bytes()), 'launcher_sha256':digest((root/'launch_dda.py').read_bytes())})


def compact_bytes(v):
    return len(json.dumps(v, ensure_ascii=False, separators=(',', ':')).encode('utf8'))


def text_content(m):
    c=m.get('content')
    if isinstance(c,str):return c
    return '\n'.join(v.get('text','') for v in c or [] if isinstance(v,dict))


def request_stats(raw, req):
    ms=req['messages']
    return {'bytes':len(raw), 'messages_bytes':compact_bytes(ms),'tools_bytes':compact_bytes(req.get('tools',[])),
        'messages':len(ms),'tools':len(req.get('tools',[])), 'system_bytes':sum(compact_bytes(m) for m in ms if m['role']=='system'),
        'workspace_text_bytes':sum(compact_bytes(text_content(m))-2 for m in ms if text_content(m).startswith('Read-only workspace context'))}


def entry_proof(work, req):
    repairs = [text_content(m) for m in req['messages'] if m.get('role')=='user' and 'HOST_REPAIR_RETEST:' in text_content(m)]
    note=repairs[-1] if repairs else ''
    assertion = 'assert.equal(before.metadataDigest, afterRefresh.metadataDigest)'
    evidence=json.loads(note.split('\n',1)[1]) if '\n' in note else {}
    source=evidence.get('assertionSource') or {}
    edit=evidence.get('editAtTest') or {}
    diff=edit.get('diff','')
    source_matches=(source.get('path')==target and source.get('line')==88 and assertion in source.get('excerpt','')
                    and source.get('digest')=='sha256:'+digest((work/target).read_bytes()))
    return {'workspace_sha256':tree(work),'workspace_matches_wrong':tree(work)==tree(wrong),
        'tracked_change':git(work,'status','--short').decode().strip(), 'repair_message_count':len(repairs),
        'assertion_line_in_repair_message':source_matches,'assertion_line':assertion + ';' if source_matches else None,
        'assertion_source_digest':source.get('digest'),'assertion_source_path':source.get('path'),'assertion_source_line':source.get('line'),
        'previous_edit_path_in_repair_message':product if edit.get('path')==product else None,
        'previous_diff_in_repair_message':('@@ ' in diff and '-export function compareGitObservations' in diff and '+const pathCodesByDigest' in diff),
        'previous_diff_chars':len(diff),'previous_diff_sha256':digest(diff.encode()),
        'stack_line_88':':88:' in note, 'repair_message_sha256':digest(note.encode())}


def make_front(root,name,port,backend,live,turns):
    observed=0
    prepared=False
    live_attempts=0
    home=root/name
    def record(row):
        with (home/'entry.jsonl').open('a',encoding='utf8') as f:
            print(json.dumps(dict(t=time.time(),**row),ensure_ascii=False),file=f)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def send_body(self,status,data,typ='application/json'):
            self.send_response(status);self.send_header('Content-Type',typ);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_GET(self):
            self.send_body(200,b'{"object":"list","data":[{"id":"deepseek-v4-flash","object":"model"}]}')
        def do_POST(self):
            nonlocal observed,prepared,live_attempts
            raw=self.rfile.read(int(self.headers['Content-Length']));req=json.loads(raw)
            assert req['model']=='deepseek-v4-flash'
            if observed<len(turns):
                turn=turns[observed]; observed+=1
                model='deepseek-v4-flash'
                def frame(delta,reason=None):
                    return {'id':f'local-warmup-{observed}','object':'chat.completion.chunk','model':model,'created':int(time.time()),
                        'choices':[{'index':0,'delta':delta,'finish_reason':reason}]}
                if req.get('stream'):
                    calls=[dict(index=i,**c) for i,c in enumerate(turn['tool_calls'])]
                    frames=[frame({'role':'assistant','content':turn['content'] or ''}),frame({'tool_calls':calls}),frame({},'tool_calls')]
                    body=''.join('data: '+json.dumps(c,ensure_ascii=False)+'\n\n' for c in frames)+'data: [DONE]\n\n'
                    self.send_body(200,body.encode(),'text/event-stream')
                else:
                    self.send_body(200,json.dumps({'id':'warm','object':'chat.completion','model':model,'choices':[{'index':0,'message':turn,'finish_reason':'tool_calls'}]}).encode())
                record({'kind':'local_native_tool_replay','historical_round':observed,'request':request_stats(raw,req)})
                return
            if not prepared:
                proof=entry_proof(home/'work',req)
                events=lines(home/'dda-events.jsonl')
                proof['failed_after_edit_event']=any(e.get('kind')=='harness.repair_retest' and e['payload'].get('state')=='failed_after_edit' for e in events)
                proof['red_target_ran']=any(e.get('kind')=='tool.result' and e['payload'].get('round')==8 and e['payload'].get('exitCode')==1 and target in e['payload'].get('args',[]) for e in events)
                record({'kind':'entry_to_live','request':request_stats(raw,req),'proof':proof})
                ready=all(proof[k] for k in ['workspace_matches_wrong','failed_after_edit_event','red_target_ran','assertion_line_in_repair_message','previous_edit_path_in_repair_message','previous_diff_in_repair_message','stack_line_88'])
                prepared=ready
                if not ready:
                    self.send_body(400,b'{"error":{"message":"local checkpoint captured; no upstream request"}}')
                    return
            if not live:
                self.send_body(400,b'{"error":{"message":"local preflight complete; no upstream request"}}')
                return
            live_attempts+=1
            events=lines(home/'dda-events.jsonl')
            started=next(e for e in reversed(events) if e.get('kind')=='model.request_started')
            record({'kind':'live_proxy_input','attempt':live_attempts,'round':started['payload']['round'],'request':request_stats(raw,req)})
            # Forward wire bytes unchanged. The unmodified budget proxy handles caps, thinking and API authentication.
            conn=http.client.HTTPConnection('127.0.0.1',backend,timeout=100)
            try:
                conn.request('POST',self.path,body=raw,headers={'Content-Type':'application/json'})
                response=conn.getresponse()
                self.send_response(response.status);self.send_header('Content-Type',response.getheader('Content-Type','application/json'))
                self.end_headers()
                for chunk in response:
                    self.wfile.write(chunk);self.wfile.flush()
            except (BrokenPipeError,ConnectionResetError):
                pass
            finally: conn.close()
    return ThreadingHTTPServer(('127.0.0.1',port),Handler)


def run(root, live):
    if live: assert os.environ.get('DEEPSEEK_API_KEY'),'model credential unavailable'
    assert all(not (root/n/'entry.jsonl').exists() for n in sessions),'fresh trial required'
    start=source_hash()
    save(root/'host-start.json',{'source_sha256':start,'host_head':git(repo,'rev-parse','HEAD').decode().strip()})
    turns=historical_turns();servers=[];proc=None
    try:
        for i,n in enumerate(sessions):
            s=make_front(root,n,23111+i,23211+i,live,turns)
            servers.append(s);threading.Thread(target=s.serve_forever,daemon=True).start()
        if live:
            for p in range(23211,23214):
                with socket.socket() as sock:
                    sock.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1);sock.bind(('127.0.0.1',p))
            with (root/'backend.log').open('wb') as log:
                proc=subprocess.Popen([sys.executable,'-u',str(root/'upstream/proxy.py')],stdout=log,stderr=log)
            for _ in range(60):
                try:
                    for p in range(23211,23214):
                        with socket.create_connection(('127.0.0.1',p),timeout=.4):pass
                    break
                except OSError:time.sleep(.1)
            else: raise RuntimeError('budget proxies did not start')
        with (root/'launcher.log').open('wb') as f:
            subprocess.run([sys.executable,'-u',str(root/'launch_dda.py')],cwd=root,stdout=f,stderr=f,timeout=530,check=True)
    finally:
        if proc:proc.terminate();proc.wait(timeout=10)
        for s in servers:s.shutdown();s.server_close()
    save(root/'host-end.json',{'source_sha256':source_hash(),'all_clients_terminal':all((root/n/'dda-run.json').exists() for n in sessions)})
    assert source_hash()==start,'host code changed'
    for n in sessions:
        en=[e for e in lines(root/n/'entry.jsonl') if e['kind']=='entry_to_live']
        print(n, en[-1] if en else 'NO CHECKPOINT',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('phase',choices=['prepare','check','live'])
    parser.add_argument('directory')
    opt=parser.parse_args()
    assert opt.directory.startswith('fp-resume-') and Path(opt.directory).name==opt.directory
    root=scratch/opt.directory
    if opt.phase=='prepare': prepare(root)
    else: run(root,opt.phase=='live')

