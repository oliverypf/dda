# hmCodex

Windows MVP 的只读任务会把脱敏 Trajectory 追加到 `%LOCALAPPDATA%\hmCodex\trajectory.jsonl`，下一次任务最多恢复最近三个 run 的结构化摘要作为有界 context；原始 prompt、模型全文、隐藏思维链和凭据不会写入或恢复。

面向 HarmonyOS、Windows 和 Linux 的多平台 Agent 工作台。

本项目的目标不是复刻 Codex CLI 的终端输出，而是把 Codex 官方 App Server 暴露的 agent harness 能力做成一个可独立安装、独立运行的多平台客户端。HarmonyOS 保留 ArkUI 原生客户端，Windows/Linux 通过 Tauri 桌面客户端运行；手机和平板可作为远程监控、审批和只读 companion，但这不是核心运行模式：

- Thread：会话与历史
- Turn：一次用户请求及其执行过程
- Item：消息、推理摘要、命令、文件变更和工具调用
- 双向 JSON-RPC：客户端请求、服务端通知和服务端审批请求
- 流式消息、命令输出、审批卡片和错误状态
- 项目/文件工作区上下文

当前版本默认使用内置演示传输层，方便先验证客户端交互；HarmonyOS 设置中可以切换到真实 App Server。目标实现是：Windows/Linux 客户端启动并管理本地运行时，由本地运行时负责 Codex/App Server、受控 Executor、工作区和 OpenViking；HarmonyOS 复用同一套领域契约和生命周期语义，按设备能力选择本地实现或明确标注的兼容连接模式。远程 App Server/Gateway 只是可选 Adapter，不是客户端的前置依赖。Windows MVP 的 Cordis runtime 默认走 OpenAI Responses，可显式切换 OpenAI Chat Completions、兼容网关或 DeepSeek Harness；模型路由配置位于 `%LOCALAPPDATA%\hmCodex\model-config.json`，也可通过 `--config` 或 `HMCODEX_MODEL_CONFIG` 指定，API key 只从配置中声明的环境变量读取；同时支持持久化演化提案和受控状态迁移，桌面端取消任务会终止对应的本地 runtime 进程树。在线任务会以脱敏 outcome 进入 evaluator；可通过 `evolution cohort` 按模型、协议和任务类别形成 baseline cohort，再用于离线 replay。Memory proposal 必须保留来源事件；无来源候选不会被 accepted 或激活为 active memory。

Agent Harness 总体设计见 [docs/AGENT_HARNESS_DESIGN.md](docs/AGENT_HARNESS_DESIGN.md)，实现级协议、状态机、数据、Agent Decision Trace、安全、插件、部署、HarmonyOS 平台、评价、运维隐私和 UI 规范从 [docs/LONG_TERM_DESIGN_INDEX.md](docs/LONG_TERM_DESIGN_INDEX.md) 进入。v0.6 采用渐进迁移，目标架构与各端当前实现需要区分：

- 目标架构（设计契约）：UI 经 `HarnessFacade` 提交命令并订阅聚合后的 `HarnessReadModel`，Core 只依赖模型调用、执行、工作区和审批四类领域端口，`RoleSessionManager` 管理通用角色上下文，Codex 协议与会话代码收敛到 Codex Adapter 内。
- Windows/Linux 桌面端当前实现：已使用 `HarnessReadModel` 作为 UI 消费的聚合读模型（契约见 `contracts/v1/harness-read-model.schema.json`）；`HarnessFacade` 这一命令入口尚未作为独立符号落地。
- HarmonyOS 当前实现（迁移期）：`entry/src/main/ets/pages/Index.ets` 直接持有 `services/CodexSession.ets`，并通过 WebSocket JSON-RPC 直连 App Server；该端尚不存在 `HarnessFacade` / `HarnessReadModel`，Facade 与 read model 分层仍待迁移。

Phase 1 即记录每个关键 Agent 的结构化决策（候选、证据、选择、预期和结果），用于审计、归因与后续受约束学习，但不保存隐藏思维链。路线先完成 Phase 0.5 协议合规，再交付 Phase 1 只读闭环；只有 Phase 1.5 的运行时安全、审批、一次性 `PolicyLease` 和 Verifier 闭环通过后才开放写入、命令和网络能力。

当前真实模式使用方式（迁移期兼容路径）：

1. 在可访问的主机上运行 Codex App Server，并准备 `ws://` 或 `wss://` 地址。
2. 在应用“设置”中填写 App Server 地址和服务器上的项目目录，例如 `/workspace`。
3. 点击“连接 App Server”，然后在工作区面板浏览目录、打开文本文件，并在审批卡片中确认工具操作。

由于 App Server 的 WebSocket transport 仍属于实验性、非生产支持接口，当前直连模式用于开发和受控试点。正式本地客户端应优先由运行时使用 stdio、Unix socket 或 loopback 连接本机 App Server；只有需要跨设备接续、企业策略或远程工作区时，才启用 Gateway 远程模式。详见 [docs/DEPLOYMENT_TOPOLOGY.md](docs/DEPLOYMENT_TOPOLOGY.md)。

Windows 网络工作区路径说明：当前开发工作区使用 UNC 路径
`\\\\hwfs\\文档\\DevEcoStudioProjects\\hmCodex`，并已映射到 `Z:`，因此项目路径为
`Z:\\DevEcoStudioProjects\\hmCodex`。Windows 的 `cmd.exe`、npm
和 Cargo 在 UNC 当前目录下可能退回到 `C:\Windows`，因此执行命令前应先映射盘符，或
使用 `pushd` 建立临时盘符映射。推荐：

```powershell
# 当前 cmd 会话内临时映射（退出会话后自动解除）
pushd \\hwfs\文档
Set-Location Z:\DevEcoStudioProjects\hmCodex

# 如果 Z: 尚未映射，可建立持久映射
net use Z: \\hwfs\文档 /persistent:yes
Set-Location Z:\DevEcoStudioProjects\hmCodex
```

构建或测试时优先在 `Z:\DevEcoStudioProjects\hmCodex` 下运行；若 `Z:` 尚未映射，则使用上面的
`pushd`，不要直接把 UNC 路径作为 npm/Cargo 的当前目录。模型配置和 API key
不随盘符映射保存：配置仍位于 `%LOCALAPPDATA%\hmCodex\model-config.json`，密钥
仅从 `DENGJIUWANLE_API_KEY` 等配置声明的环境变量读取。

多平台架构与迁移路线见 [docs/MULTI_PLATFORM_ARCHITECTURE.md](docs/MULTI_PLATFORM_ARCHITECTURE.md)，对应架构决策见 [docs/adr/0006-multi-platform-clients.md](docs/adr/0006-multi-platform-clients.md)。

安全边界：

- HarmonyOS、Windows 和 Linux 客户端默认只负责展示、请求编排和用户确认；本地运行时可以在同一客户端内执行受控命令，但不根据模型消息直接执行。
- 命令执行与文件变更必须由本地或远程 Executor 按 sandbox/approval policy 执行；客户端保留拒绝权。
- 当前设置只保存连接地址和工作目录，不在项目代码中内置 API key。

验证：

- 构建 HAP：`hvigorw assembleHap --no-daemon --no-incremental`
- 编译并运行单元测试任务：`hvigorw test -p module=entry --no-daemon`
- 页面清单位于 `entry/src/main/resources/base/profile/main_pages.json`，测试桥接入口位于 `entry/src/test/List.test.ets`。
- Windows Phase 1 的 runtime、desktop、TypeScript 和 Tauri 独立套件默认并行运行：在 `desktop` 目录执行 `npm run test:all:parallel`；UI 套件因共享安装进程和本地 store 必须随后顺序执行。详见 [Windows 测试执行约定](docs/WINDOWS_TESTING_WORKFLOW.md)。

官方参考：

- https://github.com/openai/codex
- https://developers.openai.com/codex/app-server
