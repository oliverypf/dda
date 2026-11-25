"""Run this harness revision with the previous benchmark's unchanged residual-budget protocol."""
import argparse
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys

archive = Path(__file__).resolve().parent
previous = archive.parent / 'git-fingerprint-remaining-2026-11-21'
sys.path.insert(0,str(previous))
import remaining
import evidence
from remaining import replay


def cutpoint(home):
    entry=evidence.proof(home)
    note=next(m['content'] for m in entry['request']['public_turn'] if m.get('content','').startswith('HOST_REPAIR_RETEST:'))
    assert 'temporary copy before writing' in note and 'original target is rerun automatically' in note
    events=replay.lines(home/'dda-events.jsonl')
    warm=[r for r in replay.lines(home/'entry.jsonl') if r['kind']=='local_native_tool_replay']
    assert [r['historical_round'] for r in warm]==list(range(1,9))
    red=next(x for x in events if x.get('kind')=='tool.result' and x['payload'].get('round')==8
             and x['payload'].get('args')==['--test',replay.target] and x['payload'].get('exitCode')==1)
    wrong=next(x for x in events if x.get('kind')=='tool.result' and x['payload'].get('name')=='file.patch' and x['payload'].get('ok') and x['payload'].get('round')==5)
    return {'warm_rounds':len(warm),'wrong_edit_sequence':wrong['sequence'],'failed_retest_sequence':red['sequence'],
            'first_continuation_bytes':entry['request']['bytes'],'wrong_tree':entry['proof']['workspace_sha256'],
            'candidate_preflight_and_auto_retest_guidance':True}


def capture(raw,req):
    stats=remaining.capture(raw,req)
    stats['write_tool_schemas']=[tool['function'] for tool in req.get('tools',[])
        if tool.get('function',{}).get('name') in ('hmc_file_x2e_patch','hmc_file_x2e_write')]
    return stats


def run(root,dry,is_live):
    replay.request_stats=capture
    if is_live:
        assert cutpoint(dry/'dda-1')
        assert not (dry/'upstream/dda-1/proxy.jsonl').exists()
        assert replay.source_hash()==replay.load(dry/'host-end.json')['source_sha256']==replay.load(dry/'host-start.json')['source_sha256']
        assert replay.load(root/'preflight.json')==replay.load(dry/'preflight.json')
        assert (root/'upstream/proxy.py').read_bytes()==(dry/'upstream/proxy.py').read_bytes()
        assert replay.load(root/'remaining.json')==replay.load(dry/'remaining.json')
        print('matched preflight host',replay.source_hash(),flush=True)
    else:
        replay.sessions=['dda-1']
        p=root/'launch_dda.py'
        p.write_text(remaining.change(p.read_text(encoding='utf8'),'list(ex.map(run,range(1,4)))','list(ex.map(run,[1]))'),encoding='utf8')
    with (root/'replay.log').open('w',encoding='utf8') as output,redirect_stdout(output):
        replay.run(root,is_live)
    for name in replay.sessions:
        print(name,cutpoint(root/name),flush=True)


def collect(root,dry):
    evidence.archive=archive
    evidence.collect(root,dry)
    protocol=replay.load(archive/'protocol.json')
    old=replay.load(previous/'protocol.json')
    assert protocol['actual_launcher_proxy_and_inputs']==old['actual_launcher_proxy_and_inputs']
    assert protocol['historical_budget_and_cutpoint']==old['historical_budget_and_cutpoint']
    assert protocol['original_inputs']==old['original_inputs']
    protocol.update(comparison='../git-fingerprint-remaining-2026-11-21/results.json',
                    collection_wrapper='trial.py',preflight_native_checkpoint=cutpoint(dry/'dda-1'),
                    trace_limit='CLI projections omit candidatePreview, decision status, and operands. Preview receipts are linked by /candidate-test and private cwd, then cross-checked against the parent write. Only rejected tool messages expose their sampled assertion operands. An original-target retest requires the real workspace cwd; host-scheduled rounds consume no model requests.')
    replay.save(archive/'protocol.json',protocol)
    overall=replay.load(archive/'results.json')
    for name in replay.sessions:
        native=replay.lines(root/name/'dda-events.jsonl')
        report=replay.load(archive/(name+'.json'))
        report['native_checkpoint']=cutpoint(root/name)
        report['continuation_events']=[x for x in native if x.get('sequence',0)>report['native_checkpoint']['failed_retest_sequence']
                and x.get('kind','').startswith(('tool.call_requested','tool.result','harness.','verification.'))]
        trials=[]; actual=[]; candidates=[]
        work=(root/name/'work').resolve()
        accepted_rounds={r['round'] for r in report['timeline']}
        for event in report['continuation_events']:
            data=event['payload']
            if event['kind']=='harness.repair_candidate':
                candidates.append({'seq':event['sequence'],**data})
            if event['kind']!='tool.result' or data.get('command')!='node' or data.get('args')!=['--test',replay.target]:
                continue
            row={'seq':event['sequence'],'ms':event['emittedAtMs'],**data}
            cwd=(work/row.get('cwd','.')).resolve()
            if row.get('candidatePreview') or row['id'].endswith('/candidate-test') or cwd!=work:
                trials.append(row)
                continue
            row['host_scheduled']=row['id'].split('/')[-1]==f"repair-retest-{row['round']}"
            if row['host_scheduled']:
                assert row['round'] not in accepted_rounds
            actual.append(row)
        for candidate in candidates:
            preview=next((p for p in reversed(trials) if p['round']==candidate['round'] and p['seq']<candidate['seq']),None)
            if preview is None:
                continue
            assert preview['id'].endswith('/candidate-test') and Path(preview['cwd']).name.startswith('.dda-candidate-')
            parent_id=preview['id'].removesuffix('/candidate-test')
            parent=next(e for e in report['continuation_events'] if e['kind']=='tool.result' and e['payload'].get('id')==parent_id)
            candidate.update(preview_seq=preview['seq'],preview_cwd=preview['cwd'],parent_id=parent_id,
                             parent_write_seq=parent['sequence'],parent_write_ok=parent['payload']['ok'])
            messages=[m['content'] for row in report['presented_tool_history'] for m in row['turn']
                      if m['role']=='tool' and m.get('call_id')==parent_id]
            if messages:
                output=json.loads(messages[0])
                if output.get('errorCode')=='CANDIDATE_CHECK_FAILED':
                    decision=json.loads(output['message'].split('unchanged source. ',1)[1])
                    assert decision['exitCode']==preview['exitCode'] and not parent['payload']['ok']
                    candidate['returned_to_model']=decision
            candidate['applied_after_preview']=bool(preview.get('exitCode')==0 and parent['payload']['ok'])
        extra={'candidate_previews':trials,'candidate_verdicts':candidates,'target_retests':actual}
        report.update(extra)
        next(s for s in overall if s['run']==name).update(extra)
        replay.save(archive/(name+'.json'),report)
    replay.save(archive/'results.json',overall)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['prepare','check','live','collect'])
    parser.add_argument('--dry',default='fp-prepatch-check-20261121')
    args=parser.parse_args()
    assert Path(args.dry).name==args.dry and args.dry.startswith('fp-prepatch-check-')
    dry=replay.scratch/args.dry
    live=replay.scratch/'fp-prepatch-live-20261121'
    if args.action=='prepare':
        remaining.prepare(dry)
        if not live.exists():
            remaining.prepare(live)
    elif args.action=='collect': collect(live,dry)
    else: run(live if args.action=='live' else dry,dry,args.action=='live')
