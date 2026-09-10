# hmCodex Windows Cordis Runtime

This is the first local runtime for the Windows MVP. It is a Node process so
the Tauri core stays provider-neutral. Every contribution is a Cordis plugin:

- `workspace-readonly` creates a bounded, canonical workspace snapshot;
- `model-deepseek` registers the official DeepSeek Harness LLM adapter when
  explicitly selected;
- `model-openai-compatible` supports OpenAI Responses and Chat Completions
  streams, including compatible gateways;
- `task-runner` consumes the model and workspace ports;
- `evolution-registry` persists future plugin/profile proposals and enforces
  the `PROPOSED -> VALIDATING -> SHADOW -> CANARY -> ACTIVE` lifecycle without
  activating candidates by itself.

Install and run it from this directory. The default route is OpenAI Responses;
DeepSeek is opt-in. Copy `model-config.example.json` to
`%LOCALAPPDATA%\hmCodex\model-config.json` and edit the non-secret fields:

```powershell
npm install
$configDir = Join-Path $env:LOCALAPPDATA 'hmCodex'
New-Item -ItemType Directory -Force $configDir | Out-Null
Copy-Item .\model-config.example.json (Join-Path $configDir 'model-config.json')
$env:DENGJIUWANLE_API_KEY = '...'
npm run start -- task --prompt '检查项目结构' --workspace 'C:\project'
```

可以先运行不联网的健康检查，确认配置文件和模型路由能够解析：

```powershell
npm run start -- health
```

该命令不会读取 API key，也不会发起模型请求。

桌面端启动时还会调用一次只读恢复扫描；命令行可用同样的入口手动对账上次
runtime 进程异常退出留下的受控状态：

```powershell
npm run start -- recovery
```

该命令只会将孤立的 Approval、Lease、Intent、角色上下文和 Dream run 收敛到安全终态，
不会自动重放任务或副作用。

Dreaming 支持一次运行和受边界约束的长期维护循环：

```powershell
# 一次 Dream：只生成 PROPOSED memory，不会自动激活
npm run start -- dream --operation run --project-id 'my-project'

# 长期维护循环；默认 activeRuns=1，桌面端通过活动状态文件动态更新
npm run start -- dream --operation daemon --project-id 'my-project' --active-runs 0
```

维护循环默认每 15 分钟执行一次，可用 `--interval-ms` 或
`HMCODEX_DREAM_DAEMON_INTERVAL_MS` 调整（30 秒到 24 小时）；连续失败达到
`--failure-limit` 或 `HMCODEX_DREAM_DAEMON_FAILURE_LIMIT` 后会 fail-closed 退出。
若提供 `--active-runs-file` 或 `HMCODEX_DREAM_ACTIVE_RUNS_FILE`，每轮会读取一个
`0` 到 `1024` 的活动任务数；文件缺失、不可读或越界时按 `1` 处理并阻断本轮 Dream。
收到 Ctrl+C 或终止信号时会停止当前循环，不会激活记忆或自动晋级演化提案。

桌面端以 JSONL 接收任务事件。runtime 在任务存活期间定期发送
`runtime.heartbeat`；Windows 宿主若 30 秒没有收到心跳，会终止该进程树并把任务
报告为监督失败。心跳只用于进程健康判断，不进入用户时间线。

ContextPort 默认使用本地 Memory Journal。若本机已单独启动 OpenViking server，
可显式切换到仅允许 loopback 地址的 REST 适配器：

```powershell
$env:HMCODEX_CONTEXT_PROVIDER = 'openviking'
$env:HMCODEX_OPENVIKING_URL = 'http://127.0.0.1:1933'
$env:HMCODEX_OPENVIKING_API_KEY_ENV = 'OPENVIKING_API_KEY'
$env:OPENVIKING_API_KEY = '...'
npm run start -- task --prompt '检查项目结构' --workspace 'C:\project'
```

API key 可省略以连接未启用认证的本地 server。该适配器拒绝非 loopback URL，
限制响应体和请求时长，只重试召回/健康检查等只读操作；写入和 commit 不会自动
重试。OpenViking 不可用时，模型任务仍会继续，但结果中的 `context.status` 会是
`DEGRADED`。默认值仍是 `journal`，所以未安装 sidecar 不影响现有运行方式。

Windows Tauri 桌面端可以在明确提供本地 server executable 时托管 sidecar；它不会
自动安装 Python 或 OpenViking。若目标端口已有健康的 loopback server，桌面端会直接
复用它；否则才会启动并监督指定的 `.exe`，并在退出时只终止自己拥有的进程树：

```powershell
$env:HMCODEX_CONTEXT_PROVIDER = 'openviking'
$env:HMCODEX_OPENVIKING_URL = 'http://127.0.0.1:1933'
$env:HMCODEX_OPENVIKING_EXECUTABLE = 'C:\OpenViking\openviking-server.exe'
# 可选：
$env:HMCODEX_OPENVIKING_CONFIG = 'C:\OpenViking\config.yaml'
$env:HMCODEX_OPENVIKING_WORKING_DIR = 'C:\OpenViking'
```

启动超时、健康检查间隔、失败阈值和最大重启次数也可用
`HMCODEX_OPENVIKING_START_TIMEOUT_MS`、`HMCODEX_OPENVIKING_HEALTH_INTERVAL_MS`、
`HMCODEX_OPENVIKING_HEALTH_FAILURE_THRESHOLD` 和 `HMCODEX_OPENVIKING_MAX_RESTARTS`
设置；所有值都有边界。未设置 executable 时不会自动拉起服务，任务仍会安全降级。

For DeepSeek Harness, set `provider` to `deepseek` and `apiKeyEnv` to
`DEEPSEEK_API_KEY` in the file, then set that environment variable. For an
OpenAI-compatible Chat Completions gateway, set `provider` to `openai-chat`,
`protocol` to `chat-completions`, and the gateway `baseURL` or `endpoint`.
`apiKeyEnv` selects the environment variable containing the key; the key is
never written to the configuration file or task payload.

Configuration precedence is command-line option (`--provider`, `--protocol`,
`--model`, `--base-url`, `--endpoint`, `--api-key-env`) over the JSON file,
then legacy environment variables (`HMCODEX_MODEL_*` and provider-specific
model/base URL variables), then built-in defaults. Use `--config PATH` or
`HMCODEX_MODEL_CONFIG` to select another file. An explicitly selected file must
exist; the default file is optional.

The registry is stored under `%LOCALAPPDATA%\hmCodex\evolution-proposals.json`
on Windows (or `%APPDATA%` when `%LOCALAPPDATA%` is unavailable). Set
`HMCODEX_EVOLUTION_STORE` or pass `--evolution-store` to use another location.
The file is written through a temporary file and contains only immutable
proposal records and their lifecycle metadata.

The default runtime mode is `READ_ONLY`. In that mode shell, file-write and
test tools are registered behind the safety boundary but every invocation is
rejected before a process is spawned or a file is changed. Each task also appends redacted lifecycle events to
`%LOCALAPPDATA%\hmCodex\trajectory.jsonl` (override with
`HMCODEX_TRAJECTORY_STORE` or `--trajectory-store`). The next task reads at
most the three newest run summaries and injects a 6,000-character bounded
context. It contains digests, route metadata, workspace snapshot metadata and
terminal status, never the original prompt, model output, reasoning tokens or
credentials. Promotion of a proposed plugin remains a separate evaluator/canary
step by design; the registry only records an explicitly requested transition.

Verified task outcomes can seed a bounded evolution candidate without copying
the prompt, model output, reasoning, or credentials. Enable this explicitly on
a task (the default is off):

```powershell
npm run start -- task --auto-evolution-proposal --prompt '检查项目结构' --workspace 'C:\project'
```

For a supervised local runner, the same switch can be set with
`HMCODEX_AUTO_EVOLUTION_PROPOSAL=true`.

The same operation is available after a persisted run through the evaluator
CLI. It creates only a `PROPOSED` record; use `shadow`, `canary`, and `promote`
for the remaining gates:

```powershell
npm run start -- evolution propose-from-outcome --outcome-id OUTCOME_ID
```

The store exposes `toHarnessEvent(record)` through
`runtime/src/harness-event-adapter.mjs` for adapters that need the complete
cross-platform event envelope; local JSONL remains in the smaller trajectory
record shape.

The Harness Event Store retention query is read-only by default. To process expired
runs, opt in explicitly and bound the batch size; each purge leaves a minimal
tombstone and the command reports any remaining expired runs:

```powershell
npm run start -- harness-events retention --retention-ms 2592000000 --purge-expired --purge-limit 10 --harness-event-store 'C:\data\harness-events.db'
```

Use `--now-ms` in deterministic maintenance jobs. Pass `--read-model PATH`
to rebuild the redacted projection after a successful batch. A failed purge
never reports the batch as successful; rerun the command to process remaining
runs.

For unattended maintenance, use the explicit retention worker. It persists operational progress beside the Harness database, retries failed runs on later cycles, and stops after the current expired set is drained. The progress file is not an authority and may be removed and rebuilt from Harness:

```powershell
npm run start -- harness-events retention-worker --retention-ms 2592000000 --batch-size 10 --interval-ms 900000 --harness-event-store 'C:\data\harness-events.db' --progress-store 'C:\data\retention-progress.json'
```

The worker is opt-in, and Ctrl+C or a termination signal stops between purge operations. A failed purge remains retryable and is never marked completed. Use `--failure-limit` or `HMCODEX_RETENTION_WORKER_FAILURE_LIMIT` to stop after repeated failed cycles (default: 3; maximum: 20) so a persistent storage fault fails closed instead of causing an unbounded loop.

动态 Cordis contribution 只能读取 manifest 权限映射出来的服务，并且只能发布
自己的 contribution ID 或插件命名空间。访问 root registry、事件总线、fiber、未授权
model/executor service 等逃逸入口会失败并触发 quarantine。

The read-only Tool Registry is available without a model request. List tools or
invoke one directly from PowerShell:

```powershell
npm run start -- tools --workspace 'C:\project'
npm run start -- tools --workspace 'C:\project' --tool workspace.read `
  --input '{"path":"README.md","maxChars":4000}'
```

In `READ_ONLY`, the public tool list contains only `workspace.list` and
`workspace.read`. Inputs are validated against strict JSON schemas, and
outputs are bounded. Sensitive,
binary, oversized, symlinked-outside, and unauthorized paths are rejected.
Tool handlers are provider-neutral and receive no model-specific objects, so
the same registry is used by the Responses and Chat Completions tool-call loop.

Controlled execution is opt-in and still requires an explicit host approval
scope. For example, this permits one-shot leases for Node commands and file
writes while keeping all other capabilities denied:

```powershell
npm run start -- task --execution-mode CONTROLLED `
  --lease-capabilities shell.execute,file.write `
  --lease-commands node `
  --prompt '运行检查并把结果写入 result.txt' --workspace 'C:\project'
```

The model cannot create or reuse leases. `shell.execute`, `test.execute` and
`file.write` always pass through `RuntimeSafetyMonitor`, `PolicyLease` and
`RestrictedWindowsExecutor`; command/cwd/path scope, timeout, output limits and
secret redaction are enforced before results return to the model or trajectory.
