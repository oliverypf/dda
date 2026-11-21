"""Start the native Pi CLI in one prepared benchmark checkout. No upstream keys."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from urllib.parse import urlparse

parser = argparse.ArgumentParser()
parser.add_argument("run", choices=["pi-1", "pi-2", "pi-3"])
parser.add_argument("base_url")
parser.add_argument("model")
parser.add_argument("--wall-seconds", type=int, default=600)
args = parser.parse_args()
if urlparse(args.base_url).hostname not in ("127.0.0.1", "localhost", "::1"):
    parser.error("expected a loopback budget proxy")
root = Path(__file__).resolve().parent
run = root / args.run
work = run / "work"
if not work.is_dir():
    parser.error(f"prepared checkout missing: {work}")
agent = run / "pi-state"
agent.mkdir(exist_ok=True)
events_path = run / "pi-events.jsonl"
if events_path.exists():
    parser.error("refusing to overwrite an existing run")
cli = Path(os.environ["APPDATA"]) / "npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
model_cfg = {"providers": {"bench": {"baseUrl": args.base_url, "api": "openai-completions", "apiKey": "bench", "models": [{"id": args.model}]}}}
(agent / "models.json").write_text(json.dumps(model_cfg), encoding="utf-8")
git_bash = Path(os.environ["ProgramFiles"]) / "Git/bin/bash.exe"
if git_bash.is_file():
    (agent / "settings.json").write_text(json.dumps({"shellPath": str(git_bash)}), encoding="utf-8")
allowed_env = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "COMPUTERNAME", "USERNAME", "OS"}
env = {key: value for key, value in os.environ.items() if key.upper() in allowed_env}
env.update({"PI_CODING_AGENT_DIR": str(agent), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "NO_COLOR": "1", "GIT_TERMINAL_PROMPT": "0"})
cmd = [shutil.which("node"), str(cli), "--mode", "json", "--no-session", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--provider", "bench", "--model", args.model, (root / "prompt.txt").read_text(encoding="utf-8-sig").strip()]
start = time.time()
with events_path.open("xb") as stdout, (run / "pi-stderr.log").open("xb") as stderr:
    proc = subprocess.Popen(cmd, cwd=work, env=env, stdout=stdout, stderr=stderr, stdin=subprocess.DEVNULL)
    try:
        code = proc.wait(args.wall_seconds)
        timed_out = False
    except subprocess.TimeoutExpired:
        subprocess.run(["taskkill","/PID",str(proc.pid),"/T","/F"], capture_output=True)
        code = proc.wait()
        timed_out = True
meta = {"client": "pi", "version": "1.1.0", "model": args.model, "proxy": args.base_url, "run": args.run, "startUnix":start, "wallSeconds": round(time.time()-start, 2), "exitCode": code, "timedOut": timed_out}
(run / "pi-run.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
print(json.dumps(meta))
sys.exit(124 if timed_out else code)
