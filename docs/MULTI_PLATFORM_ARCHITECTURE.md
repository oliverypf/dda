# dda 多平台单客户端架构基线

版本：v0.3
状态：迁移基线；Linux CLI 形态已确定

## 1. 产品定位

dda 是一个本地运行的 Agent 客户端，目标体验类似 Codex：用户安装一个客户端，客户端自己负责会话、模型连接、工作区、工具调用、审批、轨迹和上下文记忆。

HarmonyOS、Windows 和 Linux 是同一个产品的不同平台构建，不是“端侧控制云侧”的必然拆分。远程 App Server、远程 Executor 或 Gateway 只能作为可选连接模式，不能成为客户端的前置依赖或主要产品形态。

平台相关代码只负责窗口/UI、文件选择、凭据、进程和系统集成；会话模型、Harness Protocol、本地 Memory Journal、Jev Decision Plane、审批语义和安全策略保持一致。

## 2. 目标平台

| 平台 | 客户端形态 | 本地职责 |
| --- | --- | --- |
| HarmonyOS | ArkUI 原生客户端 | UI、会话、本地数据；本地运行时能力按设备 API 验证后启用 |
| Windows | Tauri 2 桌面客户端 | 完整本地 Agent、工作区、受控进程、Memory Journal、Jev |
| Linux | 无界面 CLI 客户端 | 终端命令、JSONL、完整本地 Agent、工作区、受控进程、Memory Journal、Jev |
| macOS | 预留 | 沿用桌面运行时，暂不作为首期验收平台 |

Windows/Linux 不直接复用 ArkUI 页面。Windows 使用 Tauri，Linux 使用终端 CLI；两端复用同一套领域 DTO、事件 envelope、协议契约、read model 和行为 fixture。Linux 的终端渲染属于应用层，不能复制 Harness 核心。跨平台首先保证语义一致，不强求 UI 或二进制完全相同。

## 3. 推荐拓扑：一个客户端内的本地运行时

```text
┌─────────────────────────────────────────────────────────────┐
│ dda Client                                               │
│                                                             │
│  Platform App      Harness Core / Coordinator                │
│  ArkUI/Tauri/CLI ─▶ Session / Agent / Safety / ReadModel      │
│                         │                                   │
│                         ├── Local Model/Codex Adapter        │
│                         ├── Local Workspace + Executor       │
│                         ├── Local Memory Journal             │
│                         ├── Jev Decision Plane              │
│                         └── Local Store / Trajectory         │
│                                                             │
│  optional: external model provider / remote App Server      │
└─────────────────────────────────────────────────────────────┘
```

“本地”指客户端安装包启动并管理自己的运行时。运行时可以是同进程模块，也可以是客户端拉起的受监管子进程；Memory Journal 与 Jev 的调用都必须受当前客户端实例和运行时策略约束，不形成独立的 OpenViking sidecar 依赖。

这和 Codex App Server 的客户端集成方式一致：客户端可以启动本机 app-server，通过 stdio、Unix socket 或本机 WebSocket 连接；远程连接另行配置并不改变本地客户端的产品定位。

## 4. 仓库目标结构

```text
hmCodex/
├── contracts/                 # 版本化 JSON Schema / 协议 fixture
├── packages/
│   ├── harness-model/         # 平台无关 DTO、事件、read model
│   ├── harness-core/          # Coordinator、Safety、Agent、Rule Verifier、Jev 抽象
│   └── context-contract/      # Memory Journal / Evidence 映射
├── runtime/                   # 本地运行时与进程监督
│   ├── codex/                 # Codex/App Server 本地适配
│   ├── decision/               # Jev Decision Plane 适配
│   └── workspace/             # 工作区、进程、权限和审计
├── desktop/                   # Tauri 2 + TypeScript Windows 客户端
│   ├── src/                   # 桌面 UI
│   └── src-tauri/             # 系统集成与本地运行时启动
├── entry/                     # HarmonyOS ArkUI 客户端
├── linux-cli/                  # Linux 无界面 CLI 应用层
├── gateway/                   # 可选远程/企业适配器，不是本地客户端必需项
└── docs/
```

首阶段不强行把 ArkTS、TypeScript 和 Rust 编译成同一个运行时。`contracts/` 是事实源，各端通过生成或手写的薄 DTO 适配；可复用的核心行为先以契约测试和回放 fixture 固化，再逐步抽取共享实现。

## 5. 本地 Memory Journal 与 Jev 决策方式

上下文使用本地 `MemoryJournal` 与当前 run 的证据轨迹，不再依赖 OpenViking sidecar、`viking://` 命名空间或独立 context 服务。记忆内容必须带来源、范围、版本和有效期，并按不可信外部资料处理。

所有需要运行时判断的地方先形成有界证据包，再调用 Jev Decision Plane。Jev 只能从宿主提供的有限候选中选择，不能生成工具、命令、权限、路径或新的候选。Jev 的候选选择、Action Gate、行为/结果判断、停滞恢复和停止/升级方向都写入 Decision Trace。

Jev 不可用时采用保守降级：只读能力可继续，副作用能力需要 Approval 或暂停；行为判断为 `UNCERTAIN`，候选按确定性规则选择。Runtime Safety、workspace scope、Approval、PolicyLease 和 Rule Verifier 始终优先于 Jev。

## 6. 平台边界与安全

- UI 不执行模型返回的命令；命令由同一客户端内受控的 `ExecutorPort` 执行。
- Windows 的本地文件和终端能力必须经过 Tauri capability、路径 scope、PolicyLease 和审计。
- Linux CLI 的本地文件和终端能力必须经过 Linux platform adapter、路径 scope、PolicyLease 和审计；CLI 终端不等于自动放权。
- HarmonyOS 只有在目标设备 API 具备可靠进程、文件、沙箱和后台能力后，才启用完整本地 Executor；未验证设备先降级为 UI、只读工作区或可配置的 App Server 连接。
- Memory Journal 的存储细节只存在于本地 Adapter；Core 只依赖 `ContextPort`，Jev 只依赖 `DecisionEngine`。
- 远程模型、App Server 或 Gateway 是可选 Adapter，不能改变本地状态机、审批和安全语义。

## 7. 迁移阶段

### Phase A：协议与核心抽取

从 `CodexTypes.ets` 和 `CodexProtocol.ets` 抽取平台无关契约，保留现有 ArkTS 兼容层，并补齐版本号、错误和未知事件处理。

### Phase B：Windows 本地客户端与 Linux CLI

Windows 建立 Tauri 2 桌面壳和本地运行时监督器；Linux 建立无界面 CLI bridge 和本地运行时监督器。两端先实现本地 Thread/Turn、流式输出、只读 workspace、审批展示/终端审批和本地 Trajectory。Linux 首期使用 XDG 路径、JSONL 事件和 POSIX process group，不引入桌面窗口。

### Phase C：本地证据与 Jev Decision Plane

实现 Memory Journal、证据标准化、Jev Decision Engine、候选选择、Action Gate、行为判断、保守 fallback 和 Decision Trace 绑定；加入超时、不可用、证据不足、重启和重复执行测试。

### Phase D：HarmonyOS 本地能力验证

验证进程、文件、后台和存储能力。能满足条件时复用同一运行时语义；不能满足时保留只读/本地会话，并将远程连接作为明确标注的兼容模式，而非默认架构。

### Phase E：可选远程模式

只有在本地客户端闭环稳定后，再增加远程 App Server/Gateway/Executor 适配器，用于跨设备接续、企业策略或高算力场景。它属于扩展模式，不反向侵入本地核心。

## 8. 验收标准

- Windows 安装后、Linux CLI 安装后，无需先部署 Gateway 即可创建会话、读取工作区并运行已批准的本地能力；
- 同一协议 fixture 在 HarmonyOS、Windows、Linux 三端得到一致的事件和状态结果；
- Memory Journal 与 Decision Trace 默认留在本机应用数据目录；Jev 请求只发送必要的脱敏证据；
- Jev 不可用时任务明确降级，不影响审批和安全策略；
- 任一平台的本地副作用都能追溯到 ActionIntent、PolicyLease、审批和 Outcome；
- 远程模式关闭时，本地客户端仍能独立运行；远程模式开启时，不改变本地协议和状态机。
