from pathlib import Path
import sys, os, json, subprocess, time
root=Path(__file__).resolve().parent
exe=Path(sys.argv[1]).resolve()
i=int(sys.argv[2])
mode=sys.argv[3] if len(sys.argv)>3 else "exec"
run=root/f"bitfun-{i}" if mode=="exec" else root/"bitfun-probe"
work=run/"work"
work.mkdir(parents=True,exist_ok=True)
home=run/"client-state"; cfg=home/"config"; cfg.mkdir(parents=True,exist_ok=True)
model="deepseek-v4-flash"
port=23130+i if mode=="exec" else 1
base=f"http://127.0.0.1:{port}/v1"
selector=model
model_cfg={"id":selector,"name":model,"provider":"openai","model_name":model,"base_url":base,"api_key":"bench","enabled":True}
ai={"models":[model_cfg],"default_models":{"primary":selector,"fast":selector},"agent_model_selections":{"mode":{"kind":"model","model_ref":selector},"subagents":{"default":{"kind":"model","model_ref":selector},"builtin":{},"fork":{"kind":"inherit"}}}}
(cfg/"app.json").write_text(json.dumps({"app":{"auto_update":False,"telemetry":False},"ai":ai,"schema_version":1,"version":"0.2.19","last_modified":0}),encoding="utf8")
allow={"PATH","PATHEXT","SYSTEMROOT","WINDIR","SYSTEMDRIVE","COMSPEC","TEMP","TMP","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMW6432","PROGRAMDATA","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","COMPUTERNAME","USERNAME","OS"}
env={k:v for k,v in os.environ.items() if k.upper() in allow}
for k,sub in {"HOME":"home","USERPROFILE":"home","APPDATA":"roaming","LOCALAPPDATA":"local","BITFUN_HOME":"bitfun-home","BITFUN_USER_ROOT":"client-state","BITFUN_E2E_USER_ROOT":"client-state","OPENBITFUN_USER_ROOT":"client-state"}.items():
 dest=run/sub;dest.mkdir(exist_ok=True);env[k]=str(dest)
env.update(OPENAI_API_KEY="bench",OPENAI_BASE_URL=base,NO_PROXY="localhost,127.0.0.1",GIT_TERMINAL_PROMPT="0",NO_COLOR="1")
if mode!="exec":
 p=subprocess.run([str(exe),*sys.argv[4:]],cwd=work,env=env,capture_output=True,timeout=75);print("EXIT",p.returncode);print((p.stdout+p.stderr).decode('utf-8','replace').encode('ascii','backslashreplace').decode()[:8000]);sys.exit(p.returncode)
args=json.loads(os.environ.get("BITFUN_BENCH_ARGS",'["exec","--agent","agentic","--output-format","stream-json","--auto"]'))
start=time.time()
with (run/"bitfun-events.jsonl").open("xb") as out,(run/"bitfun-stderr.log").open("xb") as err:
 p=subprocess.Popen([str(exe),*args],cwd=work,env=env,stdin=subprocess.PIPE,stdout=out,stderr=err)
 try:
  p.communicate(input=(root/"prompt.txt").read_text(encoding="utf-8-sig").strip().encode("utf-8"),timeout=480)
  state="exited"
 except subprocess.TimeoutExpired:
  subprocess.run(["taskkill","/T","/F","/PID",str(p.pid)],capture_output=True);p.wait(20);state="wall_timeout"
r=dict(client="BitFun CLI",exe=exe.name,status=state,exit=p.returncode,elapsed=round(time.time()-start,2),model=model)
(run/"bitfun.execution.json").write_text(json.dumps(r),encoding="utf8");print(json.dumps(r))
