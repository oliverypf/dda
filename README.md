# dda

产品名称统一为 `dda`，桌面程序为 `dda-desktop.exe`。为沿用已有配置和历史记录，数据目录 `%LOCALAPPDATA%\hmCodex`、数据库 `hmcodex.db`、`HMCODEX_*` 环境变量、应用标识和浏览器存储键保留兼容名称。MSI 的升级 GUID 固定为原值，发布者显示为 `dda`。仓库实际目录与归档证据中的旧路径不变。

Windows MVP 的只读任务会把脱敏 Trajectory 追加到 `%LOCALAPPDATA%\hmCodex\trajectory.jsonl`，下一次任务最多恢复最近三个 run 的结构化摘要作为有界 context；原始 prompt、模型全文、隐藏思维链和凭据不会写入或恢复。

面向 HarmonyOS、Windows 和 Linux 的多平台 Agent 工作台。

当前 Windows 未完成工作集中到 [阶段四：功能补齐、运行时收敛与发布验收](docs/WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md)，逐项状态见 [阶段四验收矩阵](docs/WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)。阶段四仅推进 Windows 本地版本，使用自研 Node/Cordis runtime 直接调用模型 provider；按用户要求取消 App Server 接入，多平台产品实现暂不纳入。Linux 端已确定为无界面 CLI，详细实施入口见 [Linux CLI 实施计划](docs/LINUX_CLI_IMPLEMENTATION_PLAN.md)、[CLI 契约](docs/LINUX_CLI_CONTRACT.md) 和 [Linux 平台适配设计](docs/LINUX_PLATFORM_ADAPTER_DESIGN.md)。

本项目建设可独立安装、独立运行的 Agent 工作台。当前优先完善 Windows 的 Tauri 桌面客户端与自研 Node/Cordis runtime，由 runtime 管理模型调用、任务编排、受控工具、审批、验证和审计。其他平台保留既有代码与长期设计，暂不开展产品实现。Windows 的核心能力包括：

- Thread：会话与历史
- Turn：一次用户请求及其执行过程
- Item：消息、推理摘要、命令、文件变更和工具调用
- 版本化命令与事件：任务请求、流式状态和审批回执
- 流式消息、命令输出、审批卡片和错误状态
- 项目/文件工作区上下文

Windows 客户端启动并管理自研本地运行时，负责模型 provider、受控 Executor、工作区和本地 Memory Journal，不依赖 App Server。演示模式用于验证客户端交互。HarmonyOS 既有直连模式属于迁移期历史实现，不作为当前 Windows 开发路线。Windows MVP 的 Cordis runtime 默认走 OpenAI Responses，可显式切换 OpenAI Chat Completions、兼容网关或 DeepSeek Harness；模型路由配置位于 `%LOCALAPPDATA%\hmCodex\model-config.json`，也可通过 `--config` 或 `HMCODEX_MODEL_CONFIG` 指定，API key 只从配置中声明的环境变量读取；同时支持持久化演化提案和受控状态迁移，桌面端取消任务会终止对应的本地 runtime 进程树。在线任务会以脱敏 outcome 进入 evaluator；可通过 `evolution cohort` 按模型、协议和任务类别形成 baseline cohort，再用于离线 replay。Memory proposal 必须保留来源事件；无来源候选不会被 accepted 或激活为 active memory。

Agent Harness 总体设计见 [docs/AGENT_HARNESS_DESIGN.md](docs/AGENT_HARNESS_DESIGN.md)，当前 Jev Decision Plane 迁移方案见 [docs/JEV_DECISION_PLANE_DESIGN.md](docs/JEV_DECISION_PLANE_DESIGN.md)；实现级协议、状态机、数据、Agent Decision Trace、安全、插件、部署、HarmonyOS 平台、评价、运维隐私和 UI 规范从 [docs/LONG_TERM_DESIGN_INDEX.md](docs/LONG_TERM_DESIGN_INDEX.md) 进入。v0.6 采用渐进迁移，目标架构与各端当前实现需要区分：

- 目标架构（设计契约）：UI 经 `HarnessFacade` 提交命令并订阅聚合后的 `HarnessReadModel`，Core 只依赖模型调用、执行、工作区和审批四类领域端口，`RoleSessionManager` 管理通用角色上下文，Codex 协议与会话代码收敛到 Codex Adapter 内。
- Windows 桌面端当前实现：已使用 `HarnessReadModel` 作为 UI 消费的聚合读模型（契约见 `contracts/v1/harness-read-model.schema.json`）；`HarnessFacade` 这一命令入口尚未作为独立符号落地。Linux CLI 不依赖桌面 UI，直接消费 runtime command result 和 `runtime-event` JSONL，契约见 [Linux CLI 命令与输出契约](docs/LINUX_CLI_CONTRACT.md)。
- HarmonyOS 当前实现（迁移期）：`entry/src/main/ets/pages/Index.ets` 直接持有 `services/CodexSession.ets`，并通过 WebSocket JSON-RPC 直连 App Server；该端尚不存在 `HarnessFacade` / `HarnessReadModel`，Facade 与 read model 分层仍待迁移。

Phase 1 即记录每个关键 Agent 的结构化决策（候选、证据、选择、预期和结果），由 Jev Decision Plane 统一完成需要语义判断的选择，用于审计、归因与后续受约束学习，但不保存隐藏思维链。路线先完成 Phase 0.5 协议合规，再交付 Phase 1 只读闭环；只有 Phase 1.5 的运行时安全、审批、一次性 `PolicyLease`、Rule Verifier 和 Jev Action Gate 闭环通过后才开放写入、命令和网络能力。旧的 LLM-as-a-Verifier、独立 Candidate Judge 和 OpenViking 不属于当前实现。

Jev 只在有限候选和有界证据内辅助任务分类、执行拓扑、模型/角色候选、工具语义门禁、验证后的恢复方向以及 Stop/Continue 判断；它不能直接执行动作、授予权限、签发租约、绕过审批或覆盖安全硬规则。命令、文件写入、网络访问、路径范围、凭据和 Rule Verifier 事实由确定性安全组件、审批和 Executor 控制。

Windows 本地运行方式：安装或启动桌面客户端，授权工作区并配置模型 provider，由客户端启动自研 runtime 执行任务。开发、模型配置及构建步骤见 [desktop/README.md](desktop/README.md)。App Server 不属于 Windows 的启动依赖、阶段四工作包或发布验收条件。

Windows 本地开发路径：项目已复制到本机 NTFS 目录
`C:\Users\User\hmCodex-local`。后续构建、测试和运行都应直接在这个目录中进行，避免
网络盘和 UNC 路径映射导致的工作目录、原生链接器和文件监听问题。原始共享盘副本仍可作为
备份，但不作为本地开发入口。

```powershell
# 本地开发入口
Set-Location C:\Users\User\hmCodex-local
```

构建或测试时优先在 `C:\Users\User\hmCodex-local` 下运行。模型配置和 API key
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
