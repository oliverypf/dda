"""Replay native DDA through the failed historical test. Enforce the residual ledger at cutover."""
import argparse
from contextlib import redirect_stdout
from decimal import Decimal
import json
from pathlib import Path
import sys

archive = Path(__file__).resolve().parent
sys.path.insert(0, str(archive.parent / 'git-fingerprint-resume-2026-11-21'))
import replay


base_request_stats = replay.request_stats


def capture(raw, req):
    """Record the previous native turn as actually presented, without changing bytes."""
    stats = base_request_stats(raw, req)
    messages = req['messages']
    assistants = [i for i,m in enumerate(messages) if m.get('role')=='assistant']
    if not assistants:
        return stats
    tail = messages[assistants[-1]:]
    public = []
    for m in tail:
        content = replay.text_content(m)
        role = m['role']
        if role == 'assistant':
            public.append({'role':role,'content':content,'calls':m.get('tool_calls',[])})
        elif role == 'tool':
            public.append({'role':role,'call_id':m.get('tool_call_id'), 'content_chars':len(content),
                           'content':content[:18000],'sha256':replay.digest(content.encode())})
        elif role == 'user' and (content.startswith('HOST_') or 'HOST_REPAIR_RETEST:' in content):
            public.append({'role':role,'content':content[:18000],'sha256':replay.digest(content.encode())})
    stats['public_turn']=public
    return stats


def receipt():
    old = replay.previous / 'dda-2'
    q = [json.loads(s, parse_float=Decimal) for s in (old/'proxy.jsonl').read_bytes().splitlines()]
    e = replay.lines(old/'dda-events.jsonl')
    red = next(x for x in e if x.get('sequence') == 305)
    assert red['kind'] == 'tool.result' and red['payload']['round'] == 8
    assert red['payload']['args'] == ['--test',replay.target] and red['payload']['exitCode'] == 1
    done = Decimal(red['emittedAtMs']) / 1000
    req = [x for x in q if x['kind'] == 'request' and x['t'] <= done]
    res = [x for x in q if x['kind'] == 'response' and x['t'] <= done]
    assert [x['n'] for x in req] == [x['n'] for x in res] == list(range(1,9))
    cli = next(x for x in e if x.get('kind') == 'model.request_started')
    limits = replay.load(replay.old_archive/'protocol.json')['limits']
    raw = sum(x['input_bytes'] for x in req)
    out = sum(x['usage']['completion_tokens'] for x in res)
    wall = Decimal(limits['wall_seconds'])
    proxy_remaining = wall - (done - req[0]['t'])
    cli_remaining = wall - (done - Decimal(cli['emittedAtMs']) / 1000)
    # config.json was closed before the previous launcher sampled start. Its historical
    # NTFS write time sets a lower bound on the remaining time. Round that bound down.
    config_timestamp = (old/'config.json').stat().st_mtime_ns
    cli_guard = int(wall - (done - Decimal(config_timestamp)/10**9))
    assert cli_guard == 408
    return {'source':'fp-retry-20261121/dda-2','historical_red_sequence':red['sequence'],
            'historical_red_ms':red['emittedAtMs'],'historical_proxy_first_s':str(req[0]['t']),
            'historical_cli_first_model_request_ms':cli['emittedAtMs'],
            'historical_run_started_ms':e[0]['emittedAtMs'],
            'proxy_wall_remaining_s':float(proxy_remaining),'cli_first_request_wall_remaining_s':float(cli_remaining),
            'historical_launcher_config_mtime_ns':config_timestamp,'cli_guard_seconds':cli_guard,
            'spent':{'requests':len(req),'raw_request_bytes':raw,'completion_tokens':out},
            'limits':{'requests':limits['requests']-len(req),'raw_request_bytes':limits['cumulative_raw_request_bytes']-raw,
                      'completion_tokens':limits['completion_tokens']-out,'per_request_output_tokens':limits['per_request_completion_tokens']},
            'old_rows':[{'n':a['n'],'raw_request_bytes':a['input_bytes'],'completion_tokens':b['usage']['completion_tokens']}
                        for a,b in zip(req,res,strict=True)]}


def change(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


def prepare(root):
    r = receipt()
    assert list(r['limits'].values()) == [16,711126,22098,4096]
    replay.prepare(root)
    replay.save(root/'remaining.json', r)
    p = root/'upstream/proxy.py'
    src = p.read_text(encoding='utf8')
    src = change(src,"model='deepseek-v4-flash'", """ledger=json.loads((root.parent/'remaining.json').read_bytes())
caps=ledger['limits']
budget_wall=ledger['proxy_wall_remaining_s']

def cutpoint_time(name):
    entries=(root.parent/name/'dda-events.jsonl').read_bytes().split(b'\\n')[:-1]
    for line in entries:
        if b'"tool.result"' in line:
            row=json.loads(line)
            payload=row.get('payload',{})
            if row.get('kind')=='tool.result' and payload.get('round')==8 and payload.get('name')=='test.execute' and payload.get('exitCode')==1:
                return row['emittedAtMs']/1000
    raise RuntimeError('missing native red-test receipt')

model='deepseek-v4-flash'""")
    src = change(src, "state['first']=time.time()", "state['first']=cutpoint_time(name)")
    src = change(src, "24576-state['charged']", "caps['completion_tokens']-state['charged']")
    src = change(src, "denied=limit<1 or state['count']>=24 or state['body']+len(b)>2500000 or time.time()-state['first']>=480",
        """reasons=[reason for reason,hit in [('output_tokens',limit<1),('requests',state['count']>=caps['requests']),('raw_request_bytes',state['body']+len(b)>caps['raw_request_bytes']),('wall',time.time()-state['first']>=budget_wall)] if hit]
                denied=bool(reasons)""")
    src = change(src,"emit(kind='budget_stop')","emit(kind='budget_stop',reasons=reasons,attempt_bytes=len(b),accepted_bytes=state['body'],accepted_requests=state['count'],reserved_or_spent_tokens=state['charged'])")
    src = change(src, "emit(kind='request',n=n,", "emit(kind='request',n=n,completion_limit=limit,deadline_s=state['first']+budget_wall,")
    src = change(src, "timeout=90", "timeout=max(0.001,min(90,state['first']+budget_wall-time.time()))")
    src = change(src, "if time.time()-state['first']>=480: break", "if time.time()-state['first']>=budget_wall: break")
    p.write_text(src,encoding='utf8')
    # The launcher must also stop local tool execution when the continuation wall allowance expires.
    p = root/'launch_dda.py'
    src = p.read_text(encoding='utf8')
    src = change(src, "if a.get('kind')=='approval.requested':", """payload=a.get('payload',{})
            if a.get('kind')=='tool.result' and payload.get('round')==8 and payload.get('name')=='test.execute' and payload.get('exitCode')==1:
                duration=json.loads((root/'remaining.json').read_bytes())['cli_guard_seconds']
                deadline=a['emittedAtMs']/1000+duration
                (home/'deadline.json').write_text(json.dumps(dict(start_ms=a['emittedAtMs'],duration_s=duration,deadline_s=deadline)))
                guard.cancel()
                guard=threading.Timer(max(0,deadline-time.time()),kill);guard.daemon=True;guard.start()
            if a.get('kind')=='approval.requested':""")
    p.write_text(src,encoding='utf8')


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('mode',choices=['prepare','check','live','collect','clock'])
    parser.add_argument('directory',nargs='?')
    parser.add_argument('preflight',nargs='?')
    opt=parser.parse_args()
    if opt.mode=='clock':
        print(json.dumps(receipt(),indent=2))
    else:
        assert opt.directory.startswith('fp-remaining-') and Path(opt.directory).name==opt.directory
        root=replay.scratch/opt.directory
        if opt.mode=='prepare': prepare(root)
        elif opt.mode in ('check','live'):
            replay.request_stats=capture
            if opt.mode=='check':
                replay.sessions=['dda-1']
                p=root/'launch_dda.py'
                s=p.read_text(encoding='utf8')
                p.write_text(change(s,'list(ex.map(run,range(1,4)))','list(ex.map(run,[1]))'),encoding='utf8')
            with (root/'replay.log').open('w',encoding='utf8') as output, redirect_stdout(output):
                replay.run(root,opt.mode=='live')
            for name in replay.sessions:
                entries=replay.lines(root/name/'entry.jsonl')
                matched=[e for e in entries if e['kind']=='entry_to_live']
                print(name,'cutpoint_verified',bool(matched and matched[-1]['proof']['red_target_ran']))
        else:
            from evidence import collect
            collect(root,replay.scratch/opt.preflight)
