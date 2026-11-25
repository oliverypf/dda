"""Compare a frozen feedback harness with the three prepatch runs at the identical red checkpoint."""
import argparse
import json
from pathlib import Path
import sys

archive = Path(__file__).resolve().parent
prior = archive.parent/'git-fingerprint-prepatch-2026-11-21'
sys.path.insert(0,str(prior))
import importlib.util

spec=importlib.util.spec_from_file_location('prepatch',prior/'trial.py')
prepatch=importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepatch)
replay,remaining,evidence=prepatch.replay,prepatch.remaining,prepatch.evidence
old_capture=prepatch.capture


def dependencies():
    files=['runtime/package.json','runtime/package-lock.json','runtime/node_modules/acorn/package.json']
    pkg,lock,installed=[replay.load(replay.repo/f) for f in files]
    acorn=lock['packages']['node_modules/acorn']
    assert acorn['version']==pkg['dependencies']['acorn']==installed['version']=='8.18.0'
    return {'sha256':{f:replay.digest((replay.repo/f).read_bytes()) for f in files},
            'acorn_version':acorn['version'],'lock_integrity':acorn['integrity']}


def capture(raw,request):
    stats=old_capture(raw,request)
    selected=[]
    for m in request['messages']:
        content=replay.text_content(m)
        role=m['role']
        is_note=role=='user' and content.startswith('HOST_REPAIR')
        is_tool=role=='tool' and ('CANDIDATE_CHECK_FAILED' in content or 'candidate-test' in m.get('tool_call_id','') or 'repair-' in m.get('tool_call_id',''))
        if is_note or is_tool:
            selected.append({'role':role,'call_id':m.get('tool_call_id'),'sha256':replay.digest(content.encode()),'content':content})
    stats.update(raw_sha256=replay.digest(raw),feedback_messages=selected)
    return stats


def cutpoint(home):
    entry=evidence.proof(home)
    events=replay.lines(home/'dda-events.jsonl')
    local=[e for e in replay.lines(home/'entry.jsonl') if e['kind']=='local_native_tool_replay']
    assert [e['historical_round'] for e in local]==list(range(1,9))
    wrong=next(e for e in events if e.get('kind')=='tool.result' and e['payload'].get('name')=='file.patch'
               and e['payload'].get('round')==5 and e['payload'].get('ok'))
    red=next(e for e in events if e.get('kind')=='tool.result' and e['payload'].get('round')==8
             and e['payload'].get('args')==['--test',replay.target] and e['payload'].get('exitCode')==1)
    note=next(m['content'] for m in entry['request']['feedback_messages'] if m['content'].startswith('HOST_REPAIR_RETEST:'))
    baseline=json.loads(note.split('\n',1)[1])['baseline']
    diffs=baseline['producerInputs']['differences']
    assert {'path':['FETCH_HEAD','exists'],'before':False,'after':True} in diffs
    assert {'path':['FETCH_HEAD','type'],'before':{'missing':True},'after':'file'} in diffs
    preview=next(e for e in events if e.get('kind')=='tool.result' and e['payload'].get('id','').endswith('/baseline-test'))
    deadline=replay.load(home/'deadline.json')
    assert deadline['start_ms']==red['emittedAtMs']<preview['emittedAtMs']<entry['t']*1000
    return {'wrong_tree':entry['proof']['workspace_sha256'],'warm_rounds':len(local),'wrong_edit_sequence':wrong['sequence'],
            'failed_retest_sequence':red['sequence'],'first_request_bytes':entry['request']['bytes'],
            'first_request_sha256':entry['request']['raw_sha256'],'baseline_feedback':baseline,
            'proactive_preview_seq':preview['sequence'],'red_to_preview_exit_s':(preview['emittedAtMs']-red['emittedAtMs'])/1000}


def collect(root,dry):
    from delivery import supplement
    evidence.archive=archive
    evidence.collect(root,dry)
    protocol=replay.load(archive/'protocol.json')
    previous=replay.load(prior/'protocol.json')
    for k in ('original_inputs','historical_budget_and_cutpoint','actual_launcher_proxy_and_inputs'):
        assert protocol[k]==previous[k]
    old_deliveries=[]
    for n in replay.sessions:
        report=replay.load(prior/(n+'.json'))
        for c in report['candidate_verdicts']:
            if 'returned_to_model' not in c: continue
            seen=[g['attempt'] for g in report['presented_tool_history'] if any(
                m.get('role')=='tool' and m.get('call_id')==c['parent_id'] for m in g['turn'])]
            live=[t['request'] for t in report['timeline'] if t['request'] in seen and t['returned_model'] and not t['error']]
            old_deliveries.append({'run':n,'candidate_round':c['round'],'local_attempts_with_receipt':seen,'upstream_requests_with_receipt':live})
    deps=replay.load(root/'dependencies-start.json')
    assert deps==dependencies()==replay.load(root/'dependencies-end.json')==replay.load(dry/'dependencies-observed.json')
    protocol.update(comparison='../git-fingerprint-prepatch-2026-11-21/results.json',collection_wrapper='trial.py',previous_rejection_deliveries=old_deliveries,
                    host_package_fingerprints=deps,
                    preflight_native_checkpoint=cutpoint(dry/'dda-1'),
                    model_delivery='Only a paid upstream request with a successful, model-identified response is counted as delivered. Bytes sent to the local gateway and rejected by its budget guard are recorded separately.')
    replay.save(archive/'protocol.json',protocol)
    totals=replay.load(archive/'results.json')
    for summary in totals:
        n=summary['run']
        result=replay.load(archive/(n+'.json'))
        supplement(result,summary,root/n,cutpoint(root/n),replay)
        replay.save(archive/(n+'.json'),result)
    replay.save(archive/'results.json',totals)
    first_rounds=sorted({s['first_paid_round'] for s in totals})
    protocol.update(first_live_round=first_rounds[0] if len(first_rounds)==1 else first_rounds)
    replay.save(archive/'protocol.json',protocol)


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['prepare','check','live','collect'])
    p.add_argument('--dry',default='fp-feedback-check-20261121')
    args=p.parse_args()
    assert Path(args.dry).name==args.dry and args.dry.startswith('fp-feedback-check-')
    dry=replay.scratch/args.dry
    live=replay.scratch/'fp-feedback-live-20261121'
    if args.action=='prepare':
        remaining.prepare(dry)
        if not live.exists(): remaining.prepare(live)
    elif args.action=='collect':
        collect(live,dry)
    else:
        prepatch.capture=capture
        prepatch.cutpoint=cutpoint
        if args.action=='live':
            deps=dependencies()
            assert deps==replay.load(dry/'dependencies-observed.json')
            replay.save(live/'dependencies-start.json',deps)
        prepatch.run(live if args.action=='live' else dry,dry,args.action=='live')
        if args.action=='live':
            assert deps==dependencies()
            replay.save(live/'dependencies-end.json',deps)
        else:
            replay.save(dry/'dependencies-observed.json',dependencies())
