from pathlib import Path
import subprocess,os,json,time,threading,concurrent.futures,sys
root=Path(__file__).resolve().parent
repo=root.parent.parent
def run(i):
    home=root/f'dda-{i}'; work=home/'work'; config=home/'config.json'
    config.write_text(json.dumps({'schemaVersion':'1.0','provider':'openai-chat','protocol':'chat-completions','endpoint':f'http://127.0.0.1:{23110+i}/v1/chat/completions','baseURL':f'http://127.0.0.1:{23110+i}/v1','model':'deepseek-v4-flash','apiKeyEnv':'DDA_BENCH_KEY','decision':{'enabled':False}}))
    env={k:v for k,v in os.environ.items() if k.upper() in ['SYSTEMROOT','WINDIR','PATH','PATHEXT','COMSPEC','SYSTEMDRIVE','PROGRAMFILES','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS']}
    for key,folder in [('TEMP','temp'),('TMP','temp'),('HOME','home'),('USERPROFILE','home'),('APPDATA','roam'),('LOCALAPPDATA','local')]:
        path=home/folder;path.mkdir(exist_ok=True);env[key]=str(path)
    env.update(DDA_MODEL_CONFIG=str(config),DDA_BENCH_KEY='local-only',DDA_MODEL_API_KEY_ENV='DDA_BENCH_KEY',DDA_JEV_ENABLED='0',DDA_LEASE_CAPABILITIES='file.write,file.patch,shell.execute,test.execute',DDA_LEASE_COMMANDS='node,npm,git,rg',NO_PROXY='127.0.0.1,localhost')
    prompt=(root/'prompt.txt').read_text(encoding='utf8')
    argv=['node',str(repo/'linux-cli/bin/dda.mjs'),'task','--workspace',str(work),'--prompt',prompt,'--format','jsonl','--execution-mode','CONTROLLED','--approval-mode','jsonl','--data-dir',str(home/'data'),'--timeout-ms','480000','--config',str(config)]
    start=time.time()
    with (home/'dda-stderr.log').open('wb') as err,(home/'dda-events.jsonl').open('wb') as events:
        proc=subprocess.Popen(argv,cwd=work,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err)
        def kill():
            if proc.poll() is None: subprocess.run(['taskkill','/PID',str(proc.pid),'/T','/F'],capture_output=True)
        guard=threading.Timer(480,kill);guard.daemon=True;guard.start()
        for raw in proc.stdout:
            events.write(raw);events.flush()
            try: a=json.loads(raw)
            except ValueError:continue
            if a.get('kind')=='approval.requested':
                t=a['payload']; answer={'type':'approval_response','requestId':t['requestId'],'approved':True,'displayedDigest':t['requestDigest']}
                proc.stdin.write((json.dumps(answer)+'\n').encode());proc.stdin.flush()
        rc=proc.wait();guard.cancel()
    (home/'dda-run.json').write_text(json.dumps(dict(rc=rc,wall=time.time()-start)))
    print(home.name,rc,flush=True)
with concurrent.futures.ThreadPoolExecutor(3) as ex:list(ex.map(run,range(1,4)))

