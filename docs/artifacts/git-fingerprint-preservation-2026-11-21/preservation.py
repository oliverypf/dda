"""Correlate native gate evidence, paid model inputs, real writes/targets and offline grades."""
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from delivery import returned_verdict


def check_unobserved_candidate(report,row,replay):
    verdict=next((e for e in row['host_gate_events'] if e.get('kind')=='harness.repair_candidate'),{})
    if verdict.get('observations')!=0 or not row.get('path','').endswith('.mjs'):
        return
    digest=next((e['candidateDigest'] for e in row['host_gate_events'] if e.get('candidateDigest')),None)
    call=next((call for turn in report['presented_tool_history'] for m in turn['turn'] if m['role']=='assistant'
               for call in m['calls'] if call['id']==row['call_id'] and call['function']['name']=='hmc_file_x2e_patch'),None)
    if not call or not digest:return
    path=(replay.wrong/row['path']).resolve()
    if not path.is_relative_to(replay.wrong.resolve()) or not path.is_file():return
    content=path.read_bytes().decode('utf8')
    for edit in json.loads(call['function']['arguments']).get('replacements',[]):
        if content.count(edit['oldText'])!=1:return
        content=content.replace(edit['oldText'],edit['newText'])
    if digest!='sha256:'+replay.digest(content.encode()):return
    with TemporaryDirectory(prefix='fp-preservation-syntax-') as tmp:
        candidate=Path(tmp)/'candidate.mjs';candidate.write_bytes(content.encode())
        check=subprocess.run(['node','--check',str(candidate)],capture_output=True,timeout=30)
    diagnostic=next((s for s in check.stderr.decode(errors='replace').splitlines() if s.startswith('SyntaxError:')),None)
    row['offline_check_without_instrumentation']={'candidateDigest':digest,'command':'node --check candidate.mjs','exitCode':check.returncode,'diagnostic':diagnostic}


def annotate(summary,result,home,cutpoint,replay):
    gates=[e for e in replay.lines(home/'entry.jsonl') if e['kind']=='live_proxy_input']
    proxy=replay.lines(home.parent/'upstream'/home.name/'proxy.jsonl')
    decisions=[e for e in proxy if e['kind'] in ('request','budget_stop')]
    docs={}; deliveries=[]
    for gate,decision in zip(gates,decisions,strict=True):
        stat=gate['request']
        accepted=decision['kind']=='request'
        assert stat['bytes']==decision.get('input_bytes',decision.get('attempt_bytes'))
        response=next((r for r in proxy if r['kind']=='response' and r['n']==decision.get('n')),None)
        ids=[]; preserved=[]; last=[]
        for msg in stat['feedback_messages']:
            sha=msg['sha256']
            assert sha==replay.digest(msg['content'].encode())
            docs.setdefault(sha,msg);ids.append(sha)
            if msg['role']=='user' and msg['content'].startswith('HOST_REPAIR_RETEST:'):
                data=json.loads(msg['content'].split('\n',1)[1])
                if data.get('baseline',{}).get('preservation'):preserved.append(sha)
                if data.get('lastRejected',{}).get('preservation'):last.append(sha)
        deliveries.append({'attempt':gate['attempt'],'round':gate['round'],'t':gate['t'],
                           'bytes':stat['bytes'],'request_sha256':stat['raw_sha256'],'accepted':accepted,
                           'upstream_request':decision.get('n'),'denial_reasons':decision.get('reasons',[]),
                           'upstream_model':(response or {}).get('returned_model'),'feedback_message_shas':ids,
                           'baseline_preservation_refs':preserved,'last_rejected_preservation_refs':last,
                           'external_suite_markers':stat.get('external_suite_markers',[]),
                           'delivered':bool(accepted and response and response.get('returned_model') and not response.get('error'))})
    native=[e for e in replay.lines(home/'dda-events.jsonl') if e.get('sequence',0)>cutpoint['failed_retest_sequence']]
    relevant=[e for e in native if e.get('kind','').startswith(('harness.','tool.result','tool.call_requested','model.request_started','verification.'))]
    tool_results=[{'sequence':e['sequence'],'ms':e['emittedAtMs'],**e['payload']} for e in relevant if e['kind']=='tool.result']
    work=(home/'work').resolve()
    writes=[]; previews=[]; checkpoints=[]; actual=[]
    for row in tool_results:
        if row['name'] in ('file.write','file.patch'): writes.append(row)
        if row['name'] not in ('test.execute','shell.execute'): continue
        ident=row['id']
        private=(work/row.get('cwd','.')).resolve()!=work
        if private and ident.endswith('/baseline-test'):
            checkpoints.append(row)
        elif private:
            previews.append(row)
        elif row.get('command')=='node' and row.get('args')==['--test',replay.target]:
            assert not ident.endswith(('/candidate-test','/baseline-test'))
            row['host_scheduled']=ident.split('/')[-1]==f"repair-retest-{row['round']}"
            if row['host_scheduled']: assert not any(d['accepted'] and d['round']==row['round'] for d in deliveries)
            refs={sha for sha,m in docs.items() if m['call_id']==ident}
            row['upstream_requests_with_test_receipt']=[d['upstream_request'] for d in deliveries if d['delivered'] and refs.intersection(d['feedback_message_shas'])]
            actual.append(row)
    attempts=[]
    for write in writes:
        ident=write['id']
        matched=[p for p in previews if p['id'].startswith(ident+'/')]
        gate_seq=min((p['sequence'] for p in matched),default=write['sequence'])
        evidence=[{'kind':e['kind'],'sequence':e['sequence'],**e['payload']} for e in relevant if e['kind'].startswith('harness.repair_')
                  and e['payload'].get('round')==write['round'] and gate_seq<=e['sequence']<=write['sequence']]
        refs={sha:m for sha,m in docs.items() if m['role']=='tool' and m['call_id']==ident}
        seen=[d for d in deliveries if refs.keys() & set(d['feedback_message_shas'])]
        row={'round':write['round'],'call_id':ident,'write_seq':write['sequence'],'path':write.get('path'),
             'write_ok':write['ok'],'error_code':write.get('errorCode'),'shadow_tests':matched,
             'host_gate_events':evidence,'feedback_message_shas':list(refs),
             'upstream_requests_with_receipt':[d['upstream_request'] for d in seen if d['delivered']],
             'denied_attempts_with_receipt':[d['attempt'] for d in seen if not d['accepted']]}
        for sha,m in refs.items():
            verdict=returned_verdict(m['content'])
            if verdict:
                row['candidate_verdict']=verdict
                row['verdict_delivered']=any(d['delivered'] and sha in d['feedback_message_shas'] for d in seen)
        check_unobserved_candidate(result,row,replay)
        attempts.append(row)
    extra={'native_checkpoint':cutpoint,'proactive_previews':checkpoints,'shadow_processes':previews,
           'continuation_write_results':writes,'candidate_and_write_attempts':attempts,'target_retests':actual,
           'first_paid_round':next(d['round'] for d in deliveries if d['accepted']),
           'baseline_preservation_sent_in':[d['upstream_request'] for d in deliveries if d['delivered'] and d['baseline_preservation_refs']],
           'last_rejected_preservation_sent_in':[d['upstream_request'] for d in deliveries if d['delivered'] and d['last_rejected_preservation_refs']],
           'delivered_requests_mentioning_external_suite':[d['upstream_request'] for d in deliveries if d['delivered'] and d['external_suite_markers']]}
    summary.update(extra)
    result.update(extra,feedback_documents=docs,model_feedback_delivery=deliveries,continuation_events=relevant)


def source_digest(root):
    value=sha256()
    def visit(directory):
        for item in sorted(directory.iterdir(),key=lambda f:f.name.encode()):
            if item.is_dir():
                visit(item)
            else:
                value.update(item.relative_to(root).as_posix().encode()+b'\0')
                value.update(sha256(item.read_bytes()).digest())
    visit(root)
    return 'sha256:'+value.hexdigest()


def merge(archive,replay):
    totals=replay.load(archive/'results.json')
    protocol=replay.load(archive/'protocol.json')
    root=Path(protocol['trial_workspaces'])
    previous=archive.parent/'git-fingerprint-feedback-2026-11-21'
    old=replay.load(previous/'results.json')
    old_root=Path(replay.load(previous/'protocol.json')['trial_workspaces'])
    suite='sha256:'+replay.digest((archive/'multi-link.test.mjs').read_bytes())
    comparison=[]
    for summary in [*totals,*old]:
        current=any(summary is item for item in totals)
        name=summary['run']
        variant=name if current else name.replace('dda-','feedback-')
        folder=archive/'multi-link'/variant
        home=(root if current else old_root)/name
        assert (home/'dda-run.json').is_file(),'grade only terminated workspaces'
        if not (folder/'grade.json').is_file() or not (folder/'tests.tap').is_file():
            folder.parent.mkdir(parents=True,exist_ok=True)
            with TemporaryDirectory(prefix=variant+'-',dir=folder.parent) as stage:
                temp=Path(stage)
                graded=subprocess.run(['node',str(archive/'grade-links.mjs'),str(home/'work'),str(temp)])
                if graded.returncode not in (0,1,2) or not all((temp/f).is_file() for f in ('tests.tap','grade.json')):
                    raise RuntimeError('No complete independent grade for '+variant)
                folder.mkdir(exist_ok=True)
                (temp/'tests.tap').replace(folder/'tests.tap')
                (temp/'grade.json').replace(folder/'grade.json')
        grade=replay.load(folder/'grade.json')
        assert (folder/'tests.tap').stat().st_size>0
        assert grade['sourceTreeSha256']==source_digest(home/'work/runtime/src')
        assert grade['gradeSuiteSha256']==suite
        assert len(grade['tests'])==2 and grade['passed']+grade['failed']+grade['errored']==2
        basic=summary['grade']
        passed=sum(test['passed'] for key in ('original','external') for test in basic[key])
        extra={'expanded_grade_file':f'multi-link/{variant}/grade.json','source_tree_sha256':grade['sourceTreeSha256'],
               'initial_six_passed':passed,'additional_two_passed':grade['passed'],'additional_two_errors':grade['errored'],
               'passed_out_of_eight':passed+grade['passed'],'all_eight_and_immutable':basic['green'] and grade['green'] and basic['immutable_test']}
        if current:
            summary['extended_acceptance']=extra
            report=replay.load(archive/(name+'.json'))
            report['extended_acceptance']=extra
            replay.save(archive/(name+'.json'),report)
        comparison.append({'variant':variant,**extra})
    replay.save(archive/'results.json',totals)
    protocol.update(expanded_suite_sha256=suite,expanded_comparison=comparison)
    replay.save(archive/'protocol.json',protocol)
