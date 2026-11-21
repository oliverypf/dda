"""Launch one isolated run of the installed first-party DeepSeek Harness."""
import argparse
import json
import os
import pathlib
import subprocess
import time
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("--workspace", type=pathlib.Path, required=True)
parser.add_argument("--base-url", required=True)
parser.add_argument("--model", required=True)
parser.add_argument("--prompt-file", type=pathlib.Path, required=True)
parser.add_argument("--timeout", type=int, required=True)
parser.add_argument("--key", default="bench")
parser.add_argument("--prepare", action="store_true")
args = parser.parse_args()
url = urlsplit(args.base_url)
if url.scheme != "http" or url.hostname not in {"127.0.0.1", "localhost"}:
    raise ValueError("Expected per-run loopback benchmark proxy")
workspace = args.workspace.resolve()
out = workspace.parent
state = out / "dsh-state"
state.mkdir(exist_ok=True)
quote = json.dumps
patch = out / "dsh.patch.yml"
patch.write_text(
    "- id: session-persistence-jsonl\n  config:\n    root: " + quote(str(state/"sessions")) + "\n    compression: none\n    packChunks: false\n"
    "- id: agent-default-model\n  config:\n    provider: benchmark\n    model: " + quote(args.model) +
    "\n- id: llm-pi-ai\n  config:\n    providers:\n      benchmark:\n"
    "        displayName: Benchmark\n        apiKeyEnv: DSH_BENCH_LOCAL_KEY\n"
    "        api: openai-completions\n        baseURL: " + quote(args.base_url) +
    "\n        compat:\n          supportsDeveloperRole: false\n          maxTokensField: max_tokens\n"
    "        models:\n          - id: " + quote(args.model) + "\n            name: " + quote(args.model) +
    "\n            contextWindow: 131072\n            maxTokens: 8192\n",
    encoding="utf-8")
# No upstream provider credentials in the model-controlled child environment.
allow = {"PATH","PATHEXT","TEMP","TMP","SYSTEMROOT","WINDIR","COMSPEC","APPDATA","LOCALAPPDATA","USERPROFILE","HOMEDRIVE","HOMEPATH","SYSTEMDRIVE","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMW6432","NUMBER_OF_PROCESSORS","PROCESSOR_ARCHITECTURE","PSMODULEPATH","OS","ALLUSERSPROFILE","PROGRAMDATA"}
env = {k:v for k,v in os.environ.items() if k.upper() in allow}
env.update(DSH_HOME=str(state), DSH_BENCH_LOCAL_KEY=args.key, DSH_PERMISSION_MODE="workspace-write")
entry = pathlib.Path(env["APPDATA"]) / "npm/node_modules/@deepseek-ai/dsh/lib/bin.js"
command = ["node", str(entry),"--profile","headless","--patch",str(patch)]
if args.prepare:
    joined = subprocess.run(command+["--dump-config"],cwd=workspace,env=env,capture_output=True,timeout=90)
    text = joined.stdout.decode(errors="replace")
    if joined.returncode or args.model not in text or args.base_url not in text:
        raise SystemExit("dsh patch did not compose: " + joined.stderr.decode(errors="replace")[:400])
    print("Isolated headless profile and benchmark route ready")
    raise SystemExit(0)
prompt = args.prompt_file.read_text(encoding="utf-8-sig").strip()
started = time.time()
with (out / "dsh.answer.txt").open("wb") as stdout, (out / "dsh.stderr.log").open("wb") as stderr:
    process = subprocess.Popen(command+[prompt], cwd=workspace, env=env, stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr)
    try:
        code = process.wait(timeout=args.timeout)
        state_name = "exited"
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill","/T","/F","/PID",str(process.pid)],capture_output=True)
        code = process.wait(timeout=15)
        state_name = "wall_timeout"
result = {"client":"@deepseek-ai/dsh","version":"0.1.1-rc.2","model":args.model,"exit":code,"status":state_name,"elapsed":round(time.time()-started,2)}
(out / "dsh.execution.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
print(json.dumps(result))

