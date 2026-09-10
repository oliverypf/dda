# hmCodex Desktop

Windows/Linux 桌面客户端预留目录，目标运行时为 Tauri 2 + TypeScript 前端 + 本地运行时。

桌面客户端是独立安装、独立启动的本地产品。首期范围是本地 Thread/Turn、流式输出、审批、只读 workspace、本地 Trajectory 和统一 `ContextSummary`；Codex/App Server 与 OpenViking 由客户端启动或管理的本地运行时承载。

本地 shell、任意路径访问和网络调用不会因为是桌面应用就默认开放，必须经过 Tauri capability、工作区 scope、PolicyLease、审批和审计。远程 App Server/Gateway 可以作为设置中的可选连接模式，但不应成为桌面端启动前提。

当前已落地：

- Windows 优先的 Tauri 2 桌面骨架与 TypeScript/Vite 工作台；
- 默认 `READ_ONLY`，支持用户授权目录、目录浏览、限量文本预览、二进制屏蔽和 SHA-256 摘要；
- Mock 任务、流式时间线、取消和响应式上下文面板；
- 独立 Node/Cordis runtime，模型 provider 可配置，默认使用 OpenAI Responses，DeepSeek Harness 作为显式选项；
- Native 任务取消会终止当前 Cordis Node 子进程及其子进程树；任务期间由 JSONL 心跳和 30 秒 watchdog 监督失联进程；
- 桌面启动时会执行一次只读 recovery，对账上次异常退出遗留的 Approval、Lease、Intent、角色上下文和 Dream run；关闭窗口也会清理当前 runtime 进程树，不会自动重放任务；
- 治理面板支持显式启动/停止 Dream 后台维护；Tauri 托管独立 daemon、转发脱敏 JSONL 状态，并按活动 runtime 任务数动态阻断高优先级运行期间的 Dream；
- Tauri capability 仅保留核心窗口权限，不开放 shell、写入或网络权限。
- Thread 重新打开时会按已保存 Turn 回放脱敏运行事件；受控审批会展示风险、快照 scope、策略版本和过期时间；子 Agent 面板消费 runtime 的真实角色和 checkpoint 事件。

## Cordis runtime

Windows 原生任务由 `runtime/` 中的独立 Cordis 进程执行。
桌面侧栏的“设置”可编辑默认模型的 Provider、协议、模型名称、Base URL、完整 Endpoint、API Key 环境变量名称与会话 Header。保存后下一次任务使用新配置；运行中的任务不变。已有的高级模型列表和角色绑定会保留，独立角色绑定仍优先于默认模型。Web 预览仅展示表单，不保存本地配置。

首次运行
`npm run dev` 或 Tauri 开发命令时会自动安装 runtime 依赖；也可以手动执行
`npm run runtime:install`。模型配置从 `%LOCALAPPDATA%\hmCodex\model-config.json` 读取。
复制 `runtime/model-config.example.json` 作为起点；配置文件只保存 provider、协议、模型和
endpoint 等非敏感字段，API key 仍只从启动 hmCodex 的环境变量读取：

Windows MVP 需要本机安装 Node.js 22+，因为 Cordis runtime 以 Node 子进程运行。
打包配置会把 runtime 源码和依赖放进安装包；后续迭代再替换为随应用发布的
Node sidecar，去掉这一项系统前置条件。

```powershell
$env:DENGJIUWANLE_API_KEY = '...'
# 可选：不使用默认路径时指定配置文件
$env:HMCODEX_MODEL_CONFIG = 'C:\path\model-config.json'
```

也可以在启动 runtime 时传入 `--config PATH`。命令行模型参数优先级最高，其次是
JSON 配置文件，再其次是兼容旧版本的 `HMCODEX_MODEL_*` 环境变量，最后使用内置默认值。
桌面端启动时会自动执行一次不联网的 runtime health 检查；它只验证 Node/runtime 入口和
配置格式，不会读取或上传 API key。

当前 Cordis 组合包含只读 workspace、可配置的 model-provider（OpenAI Responses、
Chat Completions、兼容网关或显式 DeepSeek Harness）、task runner 和 evolution
proposal registry。每次任务会把脱敏的 run 生命周期、模型路由、workspace snapshot
摘要和结果摘要追加到 `%LOCALAPPDATA%\hmCodex\trajectory.jsonl`，下一次任务最多恢复
最近三个 run 的结构化摘要作为有限 context；不会恢复原始 prompt、模型全文、隐藏思维链或
凭据。受控模式下模型工具调用仍需 workspace scope、一次性 Lease 和逐项审批；拒绝、
过期、崩溃恢复和未知副作用都会 fail closed。演化注册表会在 Windows 用户数据目录中
持久化候选，evaluator 提供 replay、shadow、canary、promotion 和 rollback 的显式治理
命令；在线任务结果只记录为脱敏 outcome，不会自动晋级插件或提案。可用
`evolution cohort` 按 task class、provider、protocol、model 和时间窗口生成稳定的
baseline cohort，再用 `fixturesFromOutcomes` 进入离线 replay；cohort 只包含 outcome
摘要和 digest，不包含 prompt、模型全文或 reasoning。Memory proposal 也必须保留来源
事件；没有 source event 的记录可以保持 `PROPOSED`，但不能被 accepted 或激活为 `ACTIVE`。

runtime 现在还提供 provider-neutral 的 Tool Registry，内置
`workspace.list`、`workspace.read` 以及受控 `shell.execute`、`file.write`、`test.execute`。
工具输入经过严格 JSON schema 校验，输出有大小上限，敏感文件、二进制文件、超出授权范围
的符号链接和未授权路径都会被拒绝。Responses 与 Chat Completions 的 function-call
解析器支持有界多轮调用；副作用工具始终经过 RuntimeSafetyMonitor、Lease、审批和审计。

Dream 后台维护默认关闭。在治理面板点击“启动后台”后，桌面端会托管
`dream --operation daemon` 子进程；每轮维护都会重新读取活动任务计数，状态文件缺失或
异常时按繁忙处理。它只生成 `PROPOSED` memory，不会自动激活记忆、修改安全策略或晋级
Evolution proposal。应用退出时会清理 daemon 进程树。

完整产品后续仍需：

1. 完成 `contracts/` 的跨平台协议抽取；
2. 完善本地运行时长期驻留机制（当前已具备启动 health 预检、JSONL 心跳 watchdog、启动 recovery 和退出清理，runtime 仍按任务短命启动）；
3. 为 Windows 和 Linux 分别定义 Tauri capability、路径和凭据适配器；
4. 实现 OpenViking 本地 sidecar 的打包/监督与 loopback 连接；
5. 在协议 fixture 稳定后接入完整本地运行时和真实 App Server adapter。

## Windows MVP 构建

如果项目位于 Windows 映射盘（例如 `Z:`），请从映射盘路径进入项目后执行命令，
不要在同一次操作中混用 `Z:\...` 和 `\\server\share\...` 两种拼写。桌面端的
Vite、Vitest、runtime 安装、静态预览和构建脚本都通过 `desktop/scripts/windows-path.mjs`
解析项目根，会优先使用 `HMCODEX_DESKTOP_ROOT`、npm 的 `INIT_CWD` 和当前映射盘目录，
因此不会再分别推导出不一致的 `desktop`、`runtime` 或 `dist` 路径。需要从 IDE 或快捷方式
启动时，可显式设置：

```powershell
$env:HMCODEX_DESKTOP_ROOT = 'Z:\DevEcoStudioProjects\hmCodex\desktop'
```

若只能通过 UNC 路径访问，仍然可以运行；只需保持该终端内所有命令都使用 UNC 路径。

当前 Windows 打包命令固定使用 `x86_64-pc-windows-msvc`，因为部分 Windows ARM64 主机只安装了 x64 MSVC 目标库；ARM64 Windows 可通过系统 x64 兼容层运行该安装包。执行：

请在 Visual Studio Developer PowerShell 中运行以下命令，以确保 `link.exe` 和 Windows SDK 环境变量已加载：

```powershell
npm install
npm run build:windows
```

如需生成 ARM64 原生包，先安装 Visual Studio 的 ARM64 C++ 目标组件，并将 Rust ARM64 工具链设为默认，然后把命令改为 `tauri build --target aarch64-pc-windows-msvc`。
