"""Join local feedback to paid model requests, native writes, shadow tests and original-target tests."""
from json import JSONDecoder,loads
from pathlib import Path


def returned_verdict(text):
    try:
        error=loads(text)
    except ValueError:
        return None
    if error.get('errorCode')!='CANDIDATE_CHECK_FAILED':
        return None
    message=error.get('message','')
    for i,c in enumerate(message):
        if c=='{':
            try:
                obj,_=JSONDecoder().raw_decode(message[i:])
            except ValueError:
                continue
            if isinstance(obj,dict) and 'status' in obj:
                return obj
    return {'errorCode':error['errorCode'],'message':message}


def supplement(result,summary,home,cutpoint,replay):
    native=[e for e in replay.lines(home/'dda-events.jsonl') if e.get('sequence',0)>cutpoint['failed_retest_sequence']]
    relevant=[e for e in native if e.get('kind','').startswith(('harness.','tool.result','tool.call_requested','model.request_started','verification.'))]
    gates=[e for e in replay.lines(home/'entry.jsonl') if e['kind']=='live_proxy_input']
    proxy=replay.lines(home.parent/'upstream'/home.name/'proxy.jsonl')
    decisions=[e for e in proxy if e['kind'] in ('request','budget_stop')]
    assert len(gates)==len(decisions)
    docs={}; deliveries=[]
    for gate,admit in zip(gates,decisions,strict=True):
        stat=gate['request']
        accepted=admit['kind']=='request'
        assert stat['bytes']==(admit['input_bytes'] if accepted else admit['attempt_bytes'])
        response=next((x for x in proxy if x['kind']=='response' and x['n']==admit.get('n')),None)
        delivered=bool(accepted and response and response.get('returned_model') and not response.get('error'))
        shas=[]; baseline_refs=[]; rejection_refs=[]
        for message in stat['feedback_messages']:
            key=message['sha256']
            assert key==replay.digest(message['content'].encode())
            docs.setdefault(key,message)
            shas.append(key)
            if message['role']=='user' and message['content'].startswith('HOST_REPAIR_RETEST:'):
                fields=loads(message['content'].split('\n',1)[1])
                if fields.get('baseline',{}).get('producerInputs'):
                    baseline_refs.append(key)
                if fields.get('lastRejected'):
                    rejection_refs.append(key)
        deliveries.append({'attempt':gate['attempt'],'round':gate['round'],'recorded_t':gate['t'],
                           'raw_request_sha256':stat['raw_sha256'],'raw_bytes':stat['bytes'],'accepted':accepted,
                           'upstream_request':admit.get('n'),'upstream_response_model':(response or {}).get('returned_model'),
                           'delivered':delivered,'denial_reasons':admit.get('reasons',[]),'feedback_message_shas':shas,
                           'baseline_observation_refs':baseline_refs,'last_rejection_refs':rejection_refs})
    work=(home/'work').resolve()
    writes=[]; shadow=[]; proactive=[]; actual=[]; other=[]
    for e in relevant:
        if e['kind']!='tool.result': continue
        p=e['payload']
        row={'sequence':e['sequence'],'ms':e['emittedAtMs'],**p}
        if p.get('name') in ('file.write','file.patch'):
            writes.append(row)
        if p.get('command')!='node' or p.get('args')!=['--test',replay.target]:continue
        cwd=(work/p.get('cwd','.')).resolve()
        if cwd==work:
            assert '/candidate-test' not in p['id'] and not p.get('candidatePreview')
            row['host_scheduled']=p['id'].split('/')[-1]==f"repair-retest-{p['round']}"
            if row['host_scheduled']:
                assert not any(d['round']==p['round'] and d['accepted'] for d in deliveries)
            test_refs={key for key,msg in docs.items() if msg['role']=='tool' and msg['call_id']==p['id']}
            row['upstream_requests_with_test_receipt']=[d['upstream_request'] for d in deliveries if d['delivered']
                                                       and any(key in test_refs for key in d['feedback_message_shas'])]
            actual.append(row)
        elif p['id'].endswith('/candidate-test'):
            assert Path(p['cwd']).name.startswith('.dda-candidate-')
            shadow.append(row)
        elif Path(p['cwd']).name.startswith('.dda-candidate-'):
            row['paid_requests_before_completion']=sum(d['accepted'] and d['recorded_t']<=row['ms']/1000 for d in deliveries)
            proactive.append(row)
        else:
            other.append(row)
    candidates=[]
    for preview in shadow:
        parent_id=preview['id'].removesuffix('/candidate-test')
        parent=next(p for p in writes if p['id']==parent_id)
        associated={key: m for key,m in docs.items() if m['call_id']==parent_id and m['role']=='tool'}
        seen=[d for d in deliveries if set(d['feedback_message_shas']) & associated.keys()]
        delivered=[d['upstream_request'] for d in seen if d['delivered']]
        denied=[d['attempt'] for d in seen if not d['accepted']]
        row={'round':preview['round'],'preview_seq':preview['sequence'],'preview_cwd':preview['cwd'],
             'preview_exit_code':preview.get('exitCode'),'parent_id':parent_id,'write_seq':parent['sequence'],
             'write_ok':parent['ok'],'applied_after_preview':parent['ok'] and preview.get('exitCode')==0,
             'tracked_tool_feedback':'rejected-candidate message',
             'observed_receipt_hashes':list(associated),'upstream_requests_with_receipt':delivered,'denied_attempts_with_receipt':denied}
        for key,m in associated.items():
            verdict=returned_verdict(m['content'])
            if verdict:
                if 'exitCode' in verdict: assert verdict['exitCode']==preview.get('exitCode')
                row['captured_verdict']=verdict
                row['verdict_delivered']=any(d['delivered'] and key in d['feedback_message_shas'] for d in seen)
        candidates.append(row)
    extra={'native_checkpoint':cutpoint,'proactive_previews':proactive,'candidate_previews':shadow,'candidate_verdicts':candidates,
           'target_retests':actual,'other_workspace_tests':other,'continuation_write_results':writes,
           'first_paid_round':next(d['round'] for d in deliveries if d['accepted']),
           'baseline_evidence_delivered_in':[d['upstream_request'] for d in deliveries if d['delivered'] and d['baseline_observation_refs']],
           'last_rejection_note_delivered_in':[d['upstream_request'] for d in deliveries if d['delivered'] and d['last_rejection_refs']]}
    summary.update(extra)
    result.update(extra,feedback_documents=docs,model_feedback_delivery=deliveries,continuation_events=relevant)
