"""Grade completed checkpoint continuations, preserve public tool receipts and diffs against the exact failed state."""
import argparse
import difflib
import re
import subprocess
import sys
from pathlib import Path
import replay as common

def diff_wrong(work):
    previous = common.wrong
    old_files = {p.relative_to(previous).as_posix() for p in previous.rglob('*') if p.is_file() and '.git' not in p.relative_to(previous).parts}
    new_files = {p.relative_to(work).as_posix() for p in work.rglob('*') if p.is_file() and '.git' not in p.relative_to(work).parts}
    blocks = []
    changed=[]
    for name in sorted(old_files|new_files):
        a=(previous/name).read_bytes() if name in old_files else b''
        b=(work/name).read_bytes() if name in new_files else b''
        if a==b and ((name in old_files)==(name in new_files)):continue
        changed.append(name)
        old='a/'+name if name in old_files else '/dev/null'
        new='b/'+name if name in new_files else '/dev/null'
        blocks.append(f'diff --git a/{name} b/{name}\n'.encode())
        if name not in old_files: blocks.append(b'new file mode 100644\n')
        if name not in new_files: blocks.append(b'deleted file mode 100644\n')
        for line in difflib.diff_bytes(difflib.unified_diff,a.splitlines(True),b.splitlines(True),old.encode(),new.encode()):
            blocks.append(line)
            if not line.endswith(b'\n'):blocks.append(b'\n\\ No newline at end of file\n')
    return b''.join(blocks),changed


def native_events(events):
    out=[]
    kinds={'run.failed','run.completed','tool.result','harness.repair_retest','harness.repair_continued','verification.completed','harness.context_compacted'}
    for e in events:
        if e.get('kind') not in kinds: continue
        p=e['payload']
        row={'kind':e['kind'],'seq':e['sequence'],'ms':e['emittedAtMs']}
        for k in ['round','attempt','state','name','ok','path','exitCode','command','errorCode','invocationKey','status','code','failureCodes','nextAction','repairAttempt']:
            if k in p:row[k]=p[k]
        if 'args' in p:
            row['args']=[('<inline-code>' if i and p['args'][i-1] in ['-e','--eval','-c','-Command'] else str(a)[:250]) for i,a in enumerate(p['args'][:16])]
        out.append(row)
    return out


def round_costs(timeline):
    total=0
    def costs():
        nonlocal total
        for item in timeline:
            total+=item['request_bytes']
            yield item['round'],{'live_request':item['request'],'live_bytes':total,'wall_s_since_first_live':item['response_s']}
    return dict(costs())


def collect(root, preflight):
    start=common.load(root/'host-start.json')
    end=common.load(root/'host-end.json')
    assert start['source_sha256']==end['source_sha256'] and end['all_clients_terminal']
    if not (root/'grading/bad-checkpoint/grade.json').exists():
        import shutil
        shutil.copytree(common.wrong/'runtime',root/'bad-checkpoint/work/runtime')
        subprocess.run([sys.executable,str(root/'grade.py'),'bad-checkpoint'],check=True,stdout=subprocess.DEVNULL)
    subprocess.run([sys.executable,str(root/'grade.py'),*common.sessions],check=True,stdout=subprocess.DEVNULL)
    original=common.load(common.old_archive/'protocol.json')
    historical=common.load(common.archive.parent/'git-fingerprint-retest-2026-11-21/dda-2.json')
    old_requests=[q['input_bytes'] for q in historical['proxy_timeline'] if q['kind']=='request']
    prior_remaining=original['limits']['cumulative_raw_request_bytes']-sum(old_requests[:8])
    assert prior_remaining==711126
    historical_setup={'historical_commit':original['seed'],'historical_failed_run':'../git-fingerprint-retest-2026-11-21/dda-2.json',
        'wrong_patch':'../git-fingerprint-retest-2026-11-21/dda-2.patch','prior_remaining_bytes_at_red':prior_remaining,
        'remaining_request_count_at_red':24-8,'old_post_red_model_request_bytes':old_requests[8:],
        'original_bytes_through_first_eight_requests':sum(old_requests[:8])}
    protocol={'baseline_conditions':'../git-fingerprint-2026-11-21/protocol.json','model':original['model'],'thinking':original['thinking'],'live_limits':original['limits'],
        'host':start,'ending_host':end,'input_sha256':common.load(root/'preflight.json'),'baseline':historical_setup,'starting_grade':common.load(root/'grading/bad-checkpoint/grade.json'),
        'replay':{'local_rounds':8,'first_model_round':9,'cutpoint':'after historical test.execute exited 1 on original target',
        'historical_calls':'Replay all prior native tool calls with historical public assistant text. Only the truncated fifth-round patch arguments were reconstructed from the unique differing contiguous line interval of the two real file versions. The receipt, resulting bytes, and test exit were generated again.',
        'traffic':'No upstream for replay. The same budget proxy and prompt as baseline are used after the cutpoint. Per-client 480s timeout includes the local replay; the budget proxy starts its 480s clock on the first live request.',
        'meaning_of_bytes':'Original request body bytes before proxy normalization, including tool schemas and tool history. Replayed calls do not count towards live byte/request/token allowances.',
        'external_ledger':str(root),'live_count':len(common.sessions),'preflight_only':str(preflight)}}
    common.save(common.archive/'protocol.json',protocol)
    summary=[]
    for name in common.sessions:
        home=root/name
        q=common.lines(root/'upstream'/name/'proxy.jsonl');ev=common.lines(home/'dda-events.jsonl')
        em=common.lines(home/'entry.jsonl')
        requests=[x for x in q if x['kind']=='request'];responses=[x for x in q if x['kind']=='response']; gateways=[x for x in em if x['kind']=='live_proxy_input']
        logged=[x for x in em if x['kind']=='entry_to_live']; assert len(logged)==1
        ck=logged[0]; proof=ck['proof']
        assert all(proof[k] for k in ('workspace_matches_wrong','assertion_line_in_repair_message','previous_diff_in_repair_message','stack_line_88','failed_after_edit_event','red_target_ran'))
        assert len(gateways)>=len(requests)
        timeline=[];t0=requests[0]['t']
        for x in requests:
            n=x['n']; rr=next((y for y in responses if y['n']==n),{})
            at=gateways[n-1];assert at['request']['bytes']==x['input_bytes']
            timeline.append({'request':n,'round':at['round'],'request_bytes':x['input_bytes'],'request_s':round(x['t']-t0,3),
                'response_s':round(rr['t']-t0,3) if 't' in rr else None,'returned_model':rr.get('returned_model'),'error':bool(rr.get('error')),
                'prompt_tokens':(rr.get('usage') or {}).get('prompt_tokens'),'completion_tokens':(rr.get('usage') or {}).get('completion_tokens'),'tool_calls':[t.get('name') for t in rr.get('tools',[])]})
        costs=round_costs(timeline)
        native=native_events(ev)
        for row in native:
            if row.get('round') in costs:
                row['live_request']=costs[row['round']]['live_request'];row['live_bytes_through_request']=costs[row['round']]['live_bytes']
                row['live_wall_s']=round(row['ms']/1000-t0,3)
        grade=common.load(root/'grading'/name/'grade.json')
        assert common.tree(home/'work/runtime/src')==common.tree(root/'grading'/name/'runtime/src')
        changes,files=diff_wrong(home/'work')
        if changes:(common.archive/(name+'.patch')).write_bytes(changes)
        writes=[e for e in native if e['kind']=='tool.result' and e.get('round',0)>8 and e.get('name') in ('file.patch','file.write') and e.get('ok') and e.get('path','').startswith('runtime/src/')]
        tests=[e for e in native if e['kind']=='tool.result' and e.get('round',0)>8 and e.get('name') in ('shell.execute','test.execute')
               and e.get('command')=='node' and e.get('args')==['--test',common.target]]
        greens=[e for e in tests if e.get('exitCode')==0]
        def stamp(xs):
            if not xs:return None
            e=xs[0]
            return {k:e[k] for k in ('seq','round','path','live_request','live_bytes_through_request','live_wall_s') if k in e}
        first_write=stamp(writes);green=stamp(greens)
        first_native=next(x for x in ev if x.get('emittedAtMs'));warm=[x for x in em if x['kind']=='local_native_tool_replay']
        res={'run':name,'native':common.load(home/'dda-run.json'),'live_calls':len(requests),'live_responses':len(responses),'upstream_errors':sum(bool(x.get('error')) for x in responses),
            'returned_models':sorted({x['returned_model'] for x in responses if x.get('returned_model')}),'live_request_bytes':sum(x['input_bytes'] for x in requests),
            'completion_tokens':sum(x.get('completion_tokens') or 0 for x in timeline),'budget_denials':sum(x['kind']=='budget_stop' for x in q),
            'initial_local_request_bytes':warm[0]['request']['bytes'],'first_live_request_bytes':requests[0]['input_bytes'],
            'preparation_wall_s':round(t0-first_native['emittedAtMs']/1000,3),'first_product_write':first_write,'first_exact_target_green':green,'grade':grade,
            'changed_files_from_checkpoint':files,'checkpoint_relative_diff_sha256':common.digest(changes),'native_terminal':[e for e in native if e['kind'] in ('verification.completed','run.failed','run.completed')]}
        assert res['live_calls']<=24 and res['live_request_bytes']<=2500000 and res['completion_tokens']<=24576
        common.save(common.archive/(name+'.json'),{**res,'entry_proof':proof,'warm_local_requests':warm,'live_entry_stats':ck['request'],
            'timeline':timeline,'native_events':native,'local_preflight':next(e for e in common.lines(preflight/name/'entry.jsonl') if e['kind']=='entry_to_live')['proof']})
        summary.append(res)
    common.save(common.archive/'results.json',summary)
    for row in summary:print(row['run'],row['grade']['green'],row['live_calls'],row['first_product_write'],row['first_exact_target_green'])


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('directory');parser.add_argument('preflight_dir')
    args=parser.parse_args()
    collect(common.scratch/args.directory,common.scratch/args.preflight_dir)

