# hmCodex 多平台单客户端架构基线

版本：v0.2  
状态：迁移基线

## 1. 产品定位

hmCodex 是一个本地运行的 Agent 客户端，目标体验类似 Codex：用户安装一个客户端，客户端自己负责会话、模型连接、工作区、工具调用、审批、轨迹和上下文记忆。

HarmonyOS、Windows 和 Linux 是同一个产品的不同平台构建，不是“端侧控制云侧”的必然拆分。远程 App Server、远程 Executor 或 Gateway 只能作为可选连接模式，不能成为客户端的前置依赖或主要产品形态。

平台相关代码只负责窗口/UI、文件选择、凭据、进程和系统集成；会话模型、Harness Protocol、ContextPort、审批语义、安全策略和 OpenViking 生命周期保持一致。

## 2. 目标平台

| 平台 | 客户端形态 | 本地职责 |
| --- | --- | --- |
| HarmonyOS | ArkUI 原生客户端 | UI、会话、本地数据；本地运行时能力按设备 API 验证后启用 |
| Windows | Tauri 2 桌面客户端 | 完整本地 Agent、工作区、受控进程、OpenViking |
| Linux | Tauri 2 桌面客户端 | 完整本地 Agent、工作区、受控进程、OpenViking |
| macOS | 预留 | 沿用桌面运行时，暂不作为首期验收平台 |

Windows/Linux 不直接复用 ArkUI 页面。它们复用同一套领域 DTO、事件 envelope、协议契约、read model 和行为 fixture；视觉组件按平台前端实现。跨平台首先保证语义一致，不强求 UI 或二进制完全相同。

## 3. 推荐拓扑：一个客户端内的本地运行时

```text
┌─────────────────────────────────────────────────────────────┐
│ hmCodex Client                                               │
│                                                             │
│  Platform UI       Harness Core / Coordinator                │
│  ArkUI/Tauri  ───▶ Session / Agent / Safety / ReadModel      │
│                         │                                   │
│                         ├── Local Model/Codex Adapter        │
│                         ├── Local Workspace + Executor       │
│                         ├── Local OpenViking Adapter         │
│                         └── Local Store / Trajectory         │
│                                                             │
│  optional: external model provider / remote App Server      │
└─────────────────────────────────────────────────────────────┘
```

“本地”指客户端安装包启动并管理自己的运行时。运行时可以是同进程模块，也可以是客户端拉起的受监管子进程；即使 OpenViking 通过 `127.0.0.1` HTTP 访问，也仍属于同一客户端实例，不是云端架构。

这和 Codex App Server 的客户端集成方式一致：客户端可以启动本机 app-server，通过 stdio、Unix socket 或本机 WebSocket 连接；远程连接另行配置并不改变本地客户端的产品定位。

## 4. 仓库目标结构

```text
hmCodex/
├── contracts/                 # 版本化 JSON Schema / 协议 fixture
├── packages/
│   ├── harness-model/         # 平台无关 DTO、事件、read model
│   ├── harness-core/          # Coordinator、Safety、Agent、Verifier 抽象
│   └── context-contract/      # ContextPort / OpenViking 映射
├── runtime/                   # 本地运行时与进程监督
│   ├── codex/                 # Codex/App Server 本地适配
│   ├── openviking/            # OpenViking sidecar/embedded 生命周期
│   └── workspace/             # 工作区、进程、权限和审计
├── desktop/                   # Tauri 2 + TypeScript Windows/Linux 客户端
│   ├── src/                   # 桌面 UI
│   └── src-tauri/             # 系统集成与本地运行时启动
├── entry/                     # HarmonyOS ArkUI 客户端
├── gateway/                   # 可选远程/企业适配器，不是本地客户端必需项
└── docs/
```

首阶段不强行把 ArkTS、TypeScript 和 Rust 编译成同一个运行时。`contracts/` 是事实源，各端通过生成或手写的薄 DTO 适配；可复用的核心行为先以契约测试和回放 fixture 固化，再逐步抽取共享实现。

## 5. OpenViking 的本地集成方式

OpenViking 放在本地运行时的 `ContextPort` 后面，而不是放在云侧 Gateway 后面：

1. 客户端按用户/项目初始化本地 OpenViking 数据目录；
2. Windows/Linux 首期由运行时启动并监督本地 OpenViking sidecar，优先使用 loopback HTTP；后续再评估嵌入式调用；
3. Turn 开始前按预算执行 context search，返回 L0/L1/L2 上下文；
4. 将召回内容作为不可信外部资料交给 Agent；
5. Turn 完成后记录 user、assistant、tool 消息和实际使用 URI；
6. 在压缩、会话结束或阈值触发时异步 commit；
7. 项目文档、技能和用户记忆使用不同的 `viking://` 命名空间。

推荐数据位置：Windows 使用 `%LOCALAPPDATA%/hmCodex/openviking`，Linux 使用 `$XDG_DATA_HOME/hmcodex/openviking`，HarmonyOS 使用应用沙箱目录。模型 provider 密钥进入各平台安全存储，不写入项目配置、协议 fixture 或 Trajectory。

如果本地 OpenViking 未安装、启动失败或索引损坏，客户端应明确显示“记忆不可用”，继续提供无记忆会话；不能伪造召回成功，也不应因此把会话转移到云端。

## 6. 平台边界与安全

- UI 不执行模型返回的命令；命令由同一客户端内受控的 `ExecutorPort` 执行。
- Windows/Linux 的本地文件和终端能力必须经过 Tauri capability、路径 scope、PolicyLease 和审计；桌面平台不等于自动放权。
- HarmonyOS 只有在目标设备 API 具备可靠进程、文件、沙箱和后台能力后，才启用完整本地 Executor；未验证设备先降级为 UI、只读工作区或可配置的 App Server 连接。
- OpenViking 的 REST/MCP/SDK 细节只存在于 Adapter；Core 只依赖 `ContextPort`。
- 远程模型、App Server 或 Gateway 是可选 Adapter，不能改变本地状态机、审批和安全语义。

## 7. 迁移阶段

### Phase A：协议与核心抽取

从 `CodexTypes.ets` 和 `CodexProtocol.ets` 抽取平台无关契约，保留现有 ArkTS 兼容层，并补齐版本号、错误和未知事件处理。

### Phase B：Windows/Linux 本地客户端

建立 Tauri 2 桌面壳和本地运行时监督器，先实现本地 Thread/Turn、流式输出、只读 workspace、审批展示和本地 Trajectory。Codex/App Server 优先由客户端本机启动并通过 stdio 或 loopback 连接。

### Phase C：本地 OpenViking

实现 OpenViking sidecar 生命周期、项目数据目录、`ContextPort`、recall/record/used/commit 绑定和不可用降级；加入迁移、重启、锁和索引损坏测试。

### Phase D：HarmonyOS 本地能力验证

验证进程、文件、后台和存储能力。能满足条件时复用同一运行时语义；不能满足时保留只读/本地会话，并将远程连接作为明确标注的兼容模式，而非默认架构。

### Phase E：可选远程模式

只有在本地客户端闭环稳定后，再增加远程 App Server/Gateway/Executor 适配器，用于跨设备接续、企业策略或高算力场景。它属于扩展模式，不反向侵入本地核心。

## 8. 验收标准

- Windows/Linux 安装后无需先部署 Gateway 即可创建会话、读取工作区并运行已批准的本地能力；
- 同一协议 fixture 在 HarmonyOS、Windows、Linux 三端得到一致的事件和状态结果；
- OpenViking 数据默认留在本机应用数据目录，服务通过 loopback 或同进程访问；
- OpenViking 不可用时任务明确降级，不影响审批和安全策略；
- 任一平台的本地副作用都能追溯到 ActionIntent、PolicyLease、审批和 Outcome；
- 远程模式关闭时，本地客户端仍能独立运行；远程模式开启时，不改变本地协议和状态机。
