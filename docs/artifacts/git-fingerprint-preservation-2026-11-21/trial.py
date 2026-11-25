"""Repeat the feedback benchmark unchanged; record preservation receipts without changing requests."""
import argparse
import importlib.util
from pathlib import Path
import sys

archive=Path(__file__).resolve().parent
prior=archive.parent/'git-fingerprint-feedback-2026-11-21'
sys.path.insert(0,str(prior))
spec=importlib.util.spec_from_file_location('feedback',prior/'trial.py')
feedback=importlib.util.module_from_spec(spec)
spec.loader.exec_module(feedback)
prepatch,replay,remaining=feedback.prepatch,feedback.replay,feedback.remaining


def capture(raw,request):
    stats=feedback.capture(raw,request)
    stats['external_suite_markers']=[marker for marker in ('multi-link.test.mjs','grade-links.mjs','additional_link_with_existing_link','move_link_between_metadata_paths') if marker.encode() in raw]
    ids={call.get('id'):call.get('function',{}).get('name') for msg in request['messages'] for call in msg.get('tool_calls',[]) or []}
    selected=stats['feedback_messages']
    keys={(m['call_id'],m['sha256']) for m in selected}
    for m in request['messages']:
        role=m['role']
        content=replay.text_content(m)
        call=m.get('tool_call_id')
        if role=='tool':
            keep=ids.get(call) in ('hmc_file_x2e_patch','hmc_file_x2e_write') or any(s in str(call) for s in ('candidate-test','baseline-test','preserv'))
        else:
            keep=role=='user' and content.startswith('HOST_') and 'preserv' in content.lower()
        sha=replay.digest(content.encode()) if keep else None
        if keep and (call,sha) not in keys:
            selected.append({'role':role,'call_id':call,'sha256':sha,'content':content})
            keys.add((call,sha))
    return stats


def run(root,dry,live):
    prepatch.capture=capture
    prepatch.cutpoint=feedback.cutpoint
    deps=feedback.dependencies()
    if live:
        witness=feedback.cutpoint(dry/'dda-1')['baseline_feedback']['preservation']
        assert witness['status']=='observed' and witness['aggregateConstant']
        assert witness['checks']=={'additional':True,'relocated':True}
        assert deps==replay.load(dry/'dependencies-observed.json')
        replay.save(root/'dependencies-start.json',deps)
    prepatch.run(root,dry,live)
    assert deps==feedback.dependencies()
    replay.save(root/('dependencies-end.json' if live else 'dependencies-observed.json'),deps)


def collect(root,dry):
    feedback.evidence.archive=archive
    feedback.evidence.collect(root,dry)
    protocol=replay.load(archive/'protocol.json')
    prev=replay.load(prior/'protocol.json')
    for key in ('original_inputs','historical_budget_and_cutpoint','actual_launcher_proxy_and_inputs'):
        assert protocol[key]==prev[key]
    deps=replay.load(root/'dependencies-start.json')
    assert deps==feedback.dependencies()==replay.load(root/'dependencies-end.json')==replay.load(dry/'dependencies-observed.json')
    protocol.update(comparison='../git-fingerprint-feedback-2026-11-21/results.json',
                    comparison_original_six_passes=3,external_preservation_grader='grade-links.mjs',
                    host_package_fingerprints=deps,preflight_native_checkpoint=feedback.cutpoint(dry/'dda-1'),
                    model_delivery='Only a locally accepted request with a successful upstream model response proves delivery. A denied or locally inspected request is counted separately.',
                    grading='The original six checks use the unchanged grader. The separate additional checks run after native termination against the final product, outside all model workspaces.')
    replay.save(archive/'protocol.json',protocol)
    from preservation import annotate
    totals=replay.load(archive/'results.json')
    for row in totals:
        name=row['run']
        file=archive/(name+'.json')
        result=replay.load(file)
        annotate(row,result,root/name,feedback.cutpoint(root/name),replay)
        replay.save(file,result)
    replay.save(archive/'results.json',totals)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','check','live','collect','merge'])
    parser.add_argument('--dry',default='fp-preservation-check-20261121')
    args=parser.parse_args()
    assert Path(args.dry).name==args.dry and args.dry.startswith('fp-preservation-check-')
    dry=replay.scratch/args.dry
    live=replay.scratch/'fp-preservation-live-20261121'
    if args.action=='prepare':
        remaining.prepare(dry)
        if not live.exists(): remaining.prepare(live)
    elif args.action=='collect': collect(live,dry)
    elif args.action=='merge':
        from preservation import merge
        merge(archive,replay)
    else: run(live if args.action=='live' else dry,dry,args.action=='live')
