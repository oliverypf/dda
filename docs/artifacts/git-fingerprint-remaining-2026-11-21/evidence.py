"""Independently grade the copied product and retain the live public decision/tool evidence."""
import json
import shutil
import subprocess
import sys
from pathlib import Path
from remaining import archive, receipt, replay
import collect as previous


def proof(home):
    e=[r for r in replay.lines(home/'entry.jsonl') if r['kind']=='entry_to_live']
    assert len(e)==1
    p=e[0]['proof']
    assert all(p[k] for k in ['workspace_matches_wrong','previous_diff_in_repair_message',
                              'failed_after_edit_event','red_target_ran','assertion_line_in_repair_message','stack_line_88'])
    return e[0]


def recovery_context(entry,native):
    notes=[m['content'] for m in entry['request']['public_turn'] if m.get('role')=='user' and m['content'].startswith('HOST_REPAIR_RETEST:')]
    assert len(notes)==1
    data=json.loads(notes[0].split('\n',1)[1])
    trimmed=[e for e in native if e.get('kind')=='harness.context_compacted' and e['payload'].get('reason')=='FAILED_RETEST_HISTORY']
    return {'first_live_request_bytes':entry['request']['bytes'],'source':data['assertionSource'],
            'history_compaction':[{'sequence':x['sequence'],'payload':x['payload']} for x in trimmed]}


def collect(root,preflight):
    start=replay.load(root/'host-start.json')
    end=replay.load(root/'host-end.json')
    assert end['all_clients_terminal'] and start['source_sha256']==end['source_sha256']
    dry=proof(preflight/'dda-1')
    assert not (preflight/'upstream/dda-1/proxy.jsonl').exists()
    assert replay.load(preflight/'host-end.json')['source_sha256']==start['source_sha256']
    ledger=receipt()
    assert ledger == replay.load(root/'remaining.json')
    assert (root/'grade.py').read_bytes() == (replay.old_archive/'grade.py').read_bytes()
    if not (root/'bad-checkpoint').exists():
        shutil.copytree(replay.wrong/'runtime',root/'bad-checkpoint/work/runtime')
    subprocess.run([sys.executable,str(root/'grade.py'),'bad-checkpoint',*replay.sessions],check=True,stdout=subprocess.DEVNULL)
    info=replay.load(root/'preflight.json')
    files=['launch_dda.py','upstream/proxy.py','grade.py','prompt.txt']
    current={n:replay.digest((root/n).read_bytes()) for n in files}
    proto={'model':'deepseek-v4-flash','thinking':'disabled','baseline':'../git-fingerprint-2026-11-21/protocol.json',
           'wrong_patch':'../git-fingerprint-retest-2026-11-21/dda-2.patch','previous_replay':'../git-fingerprint-resume-2026-11-21/replay.py',
           'native_replay_rounds':8,'first_live_round':9,'local_preflight_trials':1,'live_trials':3,
           'historical_budget_and_cutpoint':ledger,'host':start,'host_end':end,'original_inputs':info,
           'actual_launcher_proxy_and_inputs':current,'preflight_proof':dry['proof'],
           'preflight_presented_context':recovery_context(dry,replay.lines(preflight/'dda-1/dda-events.jsonl')),
           'initial_grade':replay.load(root/'grading/bad-checkpoint/grade.json'),
           'wall_policy':'Both live clocks begin at the native replayed round-8 red tool.result timestamp. Proxy enforces 413.746758 s from historical first proxy request to red. CLI enforces 408 s across model calls and local tools, conservatively rounding down the remaining launcher time using the config file closed before its unlogged start. CLI first model.request_started instead gives 413.632 s.',
           'trial_workspaces':str(root),'local_preflight_workspace':str(preflight)}
    replay.save(archive/'protocol.json',proto)
    results=[]
    for name in replay.sessions:
        home=root/name
        entry=proof(home)
        native=replay.lines(home/'dda-events.jsonl')
        events=previous.native_events(native)
        gates=[x for x in replay.lines(home/'entry.jsonl') if x['kind']=='live_proxy_input']
        proxy=replay.lines(root/'upstream'/name/'proxy.jsonl')
        requests=[x for x in proxy if x['kind']=='request']
        responses=[x for x in proxy if x['kind']=='response']
        denials=[x for x in proxy if x['kind']=='budget_stop']
        clock=replay.load(home/'deadline.json')
        start_s=clock['start_ms']/1000
        assert clock['duration_s']==ledger['cli_guard_seconds']
        assert requests and len(gates)==len(requests)+len(denials)
        rows=[]; total=0; output=0
        for i,req in enumerate(requests):
            g=gates[i]
            assert req['n']==i+1 and g['request']['bytes']==req['input_bytes']
            assert req['t'] < start_s+ledger['proxy_wall_remaining_s'] and req['t'] < clock['deadline_s']
            assert req['completion_limit']==min(ledger['limits']['completion_tokens']-output,ledger['limits']['per_request_output_tokens'])
            total+=req['input_bytes']
            res=next(x for x in responses if x['n']==req['n'])
            usage=res.get('usage') or {}
            completion=usage.get('completion_tokens')
            assert completion is None or completion<=req['completion_limit']
            output+=completion if completion is not None else req['completion_limit']
            rows.append({'request':req['n'],'round':g['round'],'raw_bytes':req['input_bytes'],'cumulative_bytes':total,
                         'sent_s_after_red':round(req['t']-start_s,4),'response_s_after_red':round(res['t']-start_s,4),
                         'completion_limit':req['completion_limit'],'completion_tokens':completion,'prompt_tokens':usage.get('prompt_tokens'),
                         'returned_model':res.get('returned_model'),'error':res.get('error'),'calls':res['tools']})
        caps=ledger['limits']
        assert len(rows)<=caps['requests'] and total<=caps['raw_request_bytes'] and output<=caps['completion_tokens']
        writes=[e for e in events if e.get('round',0)>8 and e['kind']=='tool.result' and e.get('name') in ('file.write','file.patch') and e.get('ok') and e.get('path','').startswith('runtime/src/')]
        targets=[e for e in events if e.get('round',0)>8 and e['kind']=='tool.result' and e.get('args')==['--test',replay.target] and e.get('command')=='node']
        grades=replay.load(root/'grading'/name/'grade.json')
        assert replay.tree(home/'work/runtime/src')==replay.tree(root/'grading'/name/'runtime/src')
        diff,changed=previous.diff_wrong(home/'work')
        (archive/(name+'.patch')).write_bytes(diff)
        tap=archive/'grading'/name
        tap.mkdir(parents=True,exist_ok=True)
        for fname in ('external.tap','original.tap'):
            shutil.copyfile(root/'grading'/name/fname,tap/fname)
        public_by_round={}
        for e in native:
            p=e.get('payload',{})
            if e.get('kind')=='model.text_delta' and p.get('round',0)>8:
                r=p['round']
                public_by_round[r]=public_by_round.get(r,'')+p['text']
        summary={'run':name,'live_requests':len(requests),'live_bytes':total,'completion_charged':output,
                 'upstream_models':sorted({x['returned_model'] for x in rows if x['returned_model']}),'budget_denials':denials,
                 'first_second_patch':writes[0] if writes else None,'target_retests':targets,'grade':grades,
                 'files_changed_from_checkpoint':changed,'patch_sha256':replay.digest(diff),'patch_bytes':len(diff),
                 'native_terminal':[e for e in events if e['kind'] in ('verification.completed','run.failed','run.completed')],
                 'cli':replay.load(home/'dda-run.json'),'cli_deadline':clock,
                 'last_native_event_s_after_red':round(max(e['emittedAtMs'] for e in native if 'emittedAtMs' in e)/1000-start_s,3)}
        results.append(summary)
        replay.save(archive/(name+'.json'),{**summary,'entry':entry['proof'],'first_live_request':entry['request'],
                    'presented_recovery_context':recovery_context(entry,native),
                    'timeline':rows,'native_events':events,'public_output_by_round':public_by_round,
                    'presented_tool_history':[{'attempt':g['attempt'],'round':g['round'],'request_bytes':g['request']['bytes'],
                                                'turn':g['request'].get('public_turn',[])} for g in gates]})
    replay.save(archive/'results.json',results)
    for row in results:
        print(row['run'],row['grade']['green'],row['live_requests'],row['live_bytes'],row['completion_charged'])
