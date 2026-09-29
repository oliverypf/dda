# hmCodex 多平台 Agent Harness 设计

版本：v0.7（Jev Decision Plane 基线）
状态：本文件与 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md) 是当前权威设计契约；各平台落地进度不同，规范先行于实现。

> **当前架构基线（必须遵守）**：所有需要在运行时作出的语义决策，都先收集有界证据，再交给 Jev Decision Plane 输出有限结果，最后经过不可覆盖的安全硬边界才允许执行。旧的 `LLM as a Verifier`、独立 `Candidate Judge`、独立语义 Verifier 角色和 OpenViking 不再是当前架构；相关历史文档仅保留为迁移/验收记录。

- Windows 桌面线已按阶段落地：Phase 1 只读闭环（channel `WINDOWS_PHASE1_READ_ONLY`）已发布，Phase 1.5 受控链路（`WINDOWS_PHASE1_5_CONTROLLED`）已过 G2 发布门，当前处于阶段二 W9 进行中。进度证据见 [Windows 阶段二进度记录](WINDOWS_PHASE2_PROGRESS.md)。
- HarmonyOS 线仍是早期原型：`entry/src/main/ets` 下只有 `pages/Index.ets` 直接持有 `services/CodexSession.ets`，经 WebSocket JSON-RPC 直连 App Server，尚未落地本文描述的 Facade / read model 分层。
- Gateway 尚未实现：`gateway/` 目前只有说明文档，远程模式仍是可选 Adapter 的设计目标，不是可用能力。

本文件是架构总览。实现级权威契约从 [长期设计规范索引](LONG_TERM_DESIGN_INDEX.md) 进入；协议、状态、安全或数据细节发生冲突时，以专项规范为准。

## 1. 目标与边界

hmCodex 的下一阶段目标，是建设一套面向 HarmonyOS、Windows 和 Linux 的多平台 Agent Harness。客户端可以使用 ArkUI 或桌面 Web/Rust 技术，但核心契约、会话、上下文、安全和执行边界保持一致。它借鉴三类思路：

- Pi Agent 的轻量 Agent Core：用少量稳定的核心抽象组织任务、上下文、工具调用和循环，而不是把所有能力写死在 UI 中。
- DSH 的插件化机制：Agent、Skill、Executor 和确定性 Verifier 都可以按 manifest 注册、启停、升级和隔离；语义决策统一由 Jev Decision Plane 承担。
- Codex 的 Coding Agent：围绕代码工作区执行多步任务，持续展示流式进展、命令、文件变更、审批和验证结果。

本项目的首版定位是“多平台独立客户端 + 可解释的 Agent Harness”。客户端内的本地运行时负责模型连接、命令、沙箱、工作区、本地 Memory Journal 和轨迹；Codex App Server 与 Executor 通过本地 Adapter 接入，Jev Decision Plane 负责基于证据作出候选、工具和行为判断。远程执行主机或 Gateway 只是可选连接模式，用于跨设备接续、企业策略或高算力，不是客户端的前置依赖。这样既能复用当前的 App Server 连接，也不会把客户端变成无约束的命令执行器。

首版不追求直接在鸿蒙设备内移植完整 Codex Rust runtime，也不在没有真实轨迹数据时引入在线策略学习。所有自动化决策必须经过安全硬约束，并能在界面上解释“为什么选中、为什么拒绝、验证了什么”。

模型调用按“服务”而不是“路由”定位。事前路由只决定执行拓扑和角色绑定；同一个角色面对同一个问题时，模型调用服务层可以并行扇出多个模型候选，独立评分后选择其中一个提交。调用方只声明要解决的问题，不感知候选数量和具体模型身份。事前路由与事后候选选择是两层独立机制，不能用“提前挑一个模型”代替“跑多个再挑”。

### 1.1 架构审阅结论

总体方案合理：ArkUI/Tauri 负责客户端交互，本地运行时负责真实 I/O，配合 Runtime Safety、Jev Decision Plane、Trajectory 和画像闭环，能够渐进落地，也能复用现有 Codex App Server 客户端。本轮复核在前次结构性修正的基础上，又补齐了模型调用边界、权限表达、治理阶段与实时控制的区分、结构化 Agent 决策轨迹，以及同角色多候选选择：

1. **角色与模型解耦。** 不再把 Luna、Sol 当作核心协议角色；统一使用可配置的 `PlanningRole`、`ExecutionRole` 和确定性 `RuleVerifier`，Luna/Sol 仅保留为可选预设名称。语义判断不再绑定一个独立 Verifier 模型，而由 Jev Decision Plane 统一完成。
2. **安全检查分三段。** 任务预检负责提前拒绝明显越界任务，候选过滤负责检查具体角色/模型/Skill/Executor 组合，Runtime Safety Monitor 负责逐动作重检。
3. **路由单位升级。** Router 不再选择单个 `Model × Agent × Skill`，而是选择“执行拓扑 + 一组角色绑定 + 验证策略”，从而支持规划模型和执行模型分别配置、分别回退和分别归因。
4. **首版收敛范围。** v1 只实现静态角色配置、规则路由、单规划者、单执行者、Jev 有界决策和确定性验证；Council、Dreaming 与策略学习继续作为有指标门槛的后续能力。
5. **迁移采用兼容分层。** 现有 UI、Mock、WebSocket 和审批交互继续保留；Codex 协议与会话代码收敛到 Adapter 层，UI 经 Facade/read model 接入，通用角色上下文由独立 `RoleSessionManager` 管理。
6. **安全随可写能力同时落地。** 只读垂直切片可以使用最小规则策略；一旦开放文件写入、命令或网络，Runtime Safety Monitor、PolicyLease、审批、Rule Verifier 和 Jev Action Gate 必须同批启用，禁止先上线可写 Executor 再补安全层。
7. **Agent 决策成为一等轨迹。** 所有关键 Agent 选择先保存结构化候选、证据、约束与预期，执行或验证后再挂接独立结果，为回放、归因和后续学习提供可靠样本；不保存隐藏思维链。
8. **候选选择统一进入 Jev。** 同角色多候选不通过独立 judge 或角色分工实现；由 `ModelInvocationGateway` 扇出、证据标准化后交给 Jev 选择。扇出规模、淘汰、选择和降级都必须可解释、可回放，且不改变安全语义。

## 2. 设计原则

1. **Safety 是硬约束，不是评分项。** 先过滤不安全候选，再在安全集合内优化质量、成本和延迟。
2. **运行时持续治理。** 任务开始时的 Safety Gate 不是一次性检查；每次工具调用、路径访问、网络访问、文件变更和策略升级前都要重新检查。
3. **小核心、可插拔。** 核心只负责状态机、策略、事件和契约；具体 Agent、Skill、Executor、Verifier 通过插件或适配器接入。
4. **先规则和证据，后学习。** v1 使用规则、数据库画像和确定性 Verifier；Bandit 只能在安全集合内做选择，并先以 shadow mode 运行。
5. **失败默认收敛。** 超时、协议不兼容、验证失败、策略不确定或画像缺失时，采取更严格的权限和更小的动作范围。
6. **轨迹优先。** 每个分类、路由、动作、验证、审批、升级和策略变更都进入可审计 Trajectory，不能只留下最终文本。
7. **角色与模型解耦。** 角色定义职责、上下文和权限上限，模型只是该角色的一次可替换绑定；数据库、协议和 UI 不依赖 Luna/Sol 等模型名称。
8. **验证保持独立。** 确定性证据优先；高风险任务中，执行角色不能自行决定验证通过，语义 Verifier 应优先使用独立上下文或不同模型绑定。
9. **依赖指向领域端口。** Harness Core 只依赖 `ModelInvocationPort`、`ExecutorPort`、`WorkspacePort` 和 `ApprovalPort`，不直接依赖 Codex JSON-RPC、WebSocket 或具体 provider。
10. **UI 只消费 read model。** UI 通过 `HarnessFacade` 提交命令并订阅聚合后的 `HarnessReadModel`；流式协议事件先进入 Coordinator/Trajectory 聚合，避免 UI 复制编排状态机。
11. **记录可观察决策，不记录隐藏思维。** 每个关键 Agent 决策保存当时目标、约束、候选、证据、选择、预期和后续结果；不要求、不推断模型的逐 token 隐藏思维链。
12. **同角色可有多候选。** 一个角色可以针对同一个问题并行调用多个模型候选，评分后选择其一提交；候选之间是同一职责的并列实现，不是角色分工。扇出不产生额外权限，未被选中的候选没有任何执行权。

## 3. 与官方 Codex App Server 的兼容定位

官方 App Server 提供的是面向丰富客户端的双向 JSON-RPC 控制面：客户端初始化并创建或恢复 Thread，提交 Turn，服务端通过 Item 和增量通知报告消息、命令、文件变更和工具执行，必要时反向请求客户端审批。官方文档还支持 Thread 的 list、resume、fork 等历史操作。

因此本项目将 App Server 放在 Adapter 层，而不是把它当成整个 Harness。一个 `CodexAppServerAdapter` 可以同时实现模型调用、执行、工作区和审批端口，但这些能力在 Core 中保持独立契约：

```text
HarmonyOS UI
    │ command / HarnessReadModel
    ▼
HarnessFacade / HarnessReadModel
    │
    ▼
HarnessCoordinator（只管理 TaskRun 状态机）
    ├── Classifier / Safety Precheck / Candidate Filter / Jev Decision Plane
    ├── Deliberation Gate（按需）
    └── AgentCore（角色循环）
            │
            ├── PlanningRole / RuleVerifier
            │       └── ModelInvocationPort
            └── ActionIntent
                    ▼
              RuntimeSafetyMonitor
                    ▼ PolicyLease
              ExecutionRole
                    ▼
               ExecutorPort

横切能力：TrajectoryStore / ProfileStore / PluginRegistry / BudgetManager
角色上下文：RoleSessionManager → Planner / Executor / Council Context

Adapters
    ├── CodexAppServerAdapter
    │     ├── ModelInvocationPort
    │     ├── ExecutorPort
    │     ├── WorkspacePort
    │     └── ApprovalPort
    ├── Local / enterprise adapters（future）
    └── Mock adapters（development）
```

兼容层必须隔离协议版本差异：

- 用 `ThreadContext`、`TaskRun`、`ExecutionItem` 和 `HarnessEvent` 表达内部语义，不让 UI 直接依赖 JSON-RPC 字段。
- App Server 的 handshake、Thread、Turn、Item、审批请求和通知由独立 adapter 转换。
- 每个 Codex 版本优先使用该版本生成的 schema；当前官方 wire 省略 `jsonrpc` 头，历史兼容形态只能由独立 legacy profile 处理，不能泄漏到 Core。
- WebSocket 每帧、JSONL 每行和未来其他 transport 都归一化为同一个事件流。
- 未知通知必须保留为 `UnknownProtocolEvent` 或安全忽略，不能因为新增通知让整个会话崩溃。

当前仓库的 `CodexProtocol`、`CodexSession`、`AppServerWebSocketTransport` 和 `MockCodexTransport` 可以作为 Codex Adapter 层的基础；`CodexSession` 保持供应商专用，不演化为通用 Harness Session。迁移时先用兼容 Facade 保留现有 UI 行为，再把 UI 的直接 Session 调用切换为 `HarnessFacade`，不直接推翻聊天界面。

当前兼容性差距已经明确：

| 项目 | 当前状态 | 设计要求 |
| --- | --- | --- |
| WebSocket framing | 当前传输层按字符串并可按换行拆分消息 | WebSocket 固定一帧一消息，stdio 固定 JSONL；transport profile 负责归一化，Core 不处理 framing |
| `jsonrpc` 头 | 当前序列化器会生成标准头 | 当前官方 App Server wire 必须省略；如确需兼容旧私有端点，使用显式 legacy profile 和独立 fixture |
| Thread 历史 | 当前主要支持 `thread/start` | 增加 `thread/list`、`thread/resume`、`thread/fork`，并把历史映射为本地 Thread read model |
| 服务端反向请求 | 当前已有命令/文件/权限审批 | 继续扩展用户输入、认证刷新、工具调用等请求；未支持的高风险请求必须明确拒绝并记轨迹 |
| schema 演进 | 当前使用手写最小接口 | 后续按实际 Codex 版本生成 schema，再映射到稳定的内部 `HarnessEvent` |

这意味着当前代码是可复用的 UI/Transport 基础，但在接入不同版本或远程生产 App Server 前，必须先完成上述 Adapter 兼容层和协议回放测试。

## 4. 总体运行流程

```text
用户任务
  │
  ▼
HarnessFacade ─────── 生成 TaskEnvelope，UI 只订阅 HarnessReadModel
  │
  ▼
Task Classifier
  │  taskClass / intent / riskFlags / contextRequirements
  ▼
Task Safety Precheck ────── hard deny / quarantine
  │
  ▼
Candidate Enumerator
  │  ExecutionTopology + RoleBindingSet + VerificationPolicy
  ▼
Candidate Safety Filter ─── unsafe candidate removed
  │  安全候选集合
  ▼
  Jev Decision Plane
  │  基于候选、证据和约束选择拓扑/绑定
  ▼
Deliberation Gate
  │  DIRECT or selective Agent Council
  ▼
PlanningRole（按需规划、分解或诊断）
  │
  ▼
AgentCore 生成 ActionIntent
  │
  ▼
Runtime Safety Monitor ───── 每次工具调用前重检
  ├── DENY / QUARANTINE ───── 停止并记录
  ├── CONFIRM_REQUIRED ─────── 等待用户
  └── PolicyLease
          │
          ▼
ExecutionRole → ExecutorPort → ExecutionEvent
          │
          ├── Trajectory Append ── 记录输入、动作、证据和决策
          └── Rule Verifier + Jev ─ 检查事实并判断进展、质量和不确定性
          │
          ├── PASS ─────── 继续下一步或完成
          ├── CONTINUE ─── ExecutionRole 执行下一步
          ├── STALLED ──── PlanningRole 以诊断模式生成多个假设
          ├── UNCERTAIN ── 提高验证强度或请求用户确认
          └── FAIL ─────── 停止、回滚或收紧权限
                              │
                              ▼
                 Credit / Blame / Router Evaluation
                              │
                              ▼
Capability Profile / Safety Profile
```

上述顺序是强制依赖，不是绘图上的建议：任何 `ExecutionRole`、Executor Adapter 或插件都不能绕过 `ActionIntent → RuntimeSafetyMonitor → PolicyLease` 直接产生真实 I/O。Jev 的输出只能在有限候选和证据范围内作出选择，不能覆盖硬规则。Rule Verifier 事实与 Jev 判断共同作为 AgentCore/Coordinator 状态迁移的输入，不是任务结束后的旁路日志。

一次运行的内部状态为：

```text
RECEIVED
  → CLASSIFIED
  → TASK_PRECHECKED
  → CANDIDATES_FILTERED
  → ROUTED
  → PLANNING（可选）
  → EXECUTING
  → VERIFYING
      ├→ COMPLETED
      ├→ CONTINUE → EXECUTING
      ├→ DIAGNOSING → PROBING → VERIFYING
      ├→ CONFIRM_REQUIRED → WAITING_USER
      ├→ DENIED
      ├→ QUARANTINED
      └→ ABORTED / FAILED
```

任何状态都可以被 `Safety Monitor` 转为 `CONFIRM_REQUIRED`、`DENIED` 或 `QUARANTINED`。运行中安全事件优先级高于 Agent 的继续执行意愿。

## 5. 核心模块职责

### 5.1 Task Classifier

Classifier 把自然语言任务、当前 Thread、工作区上下文和用户设置转换成稳定的任务描述。v1 采用可解释规则，后续允许插件化分类器，但分类结果必须带证据和置信度。

建议的 `taskClass`：

| 类别 | 典型动作 | 默认风险 |
| --- | --- | --- |
| `EXPLAIN` | 解释代码、总结文件 | 低 |
| `INSPECT` | 读取目录、搜索、静态分析 | 低至中 |
| `CODE_CHANGE` | 编辑代码、生成补丁 | 中 |
| `TEST_BUILD` | 编译、测试、格式化 | 中 |
| `COMMAND` | 执行 shell 或脚本 | 中至高 |
| `EXTERNAL_SIDE_EFFECT` | 网络请求、提交、发布、发送消息 | 高 |
| `SECRET_AUTH` | 访问凭据、密钥或登录态 | 高 |
| `DESTRUCTIVE` | 删除、覆盖、迁移、破坏性变更 | 很高 |
| `UNKNOWN_HIGH_RISK` | 无法确定意图或边界 | 很高 |

输出至少包含：`taskId`、`taskClass`、`intent`、`riskFlags`、`workspaceScope`、`requiresTools`、`confidence`、`classifierVersion`。低置信度不能自动降低安全级别。

### 5.2 Safety Gate

Safety Gate 是同一策略引擎的两次前置判定，而不是一个顺序含糊的单点：

- `TaskSafetyPrecheck` 在候选枚举前输入任务描述、当前 `SafetyProfile`、用户策略、工作区范围和环境状态，提前拒绝明显越界、非法或必须隔离的任务。
- `CandidateSafetyFilter` 在候选枚举后逐项检查角色绑定、模型来源、Agent、Skill、Executor、Verifier 和执行拓扑，只把安全候选交给 Router 排序。

二者使用相同的策略级别并输出；需要语义判断时，把任务、候选、动作、工具和上下文证据交给 Jev，但 Jev 不能放宽硬规则。这里的级别既包含最终决策，也包含必须叠加的控制措施；`MONITOR`、`CONFIRM` 和 `SANDBOX` 不应被实现为互斥的单一整数：

- `ALLOW`：可在当前限制内自动执行；
- `MONITOR`：允许执行，但所有动作必须实时记录和监控；
- `CONFIRM`：动作前必须得到用户确认；
- `SANDBOX`：只能在受限路径、网络和资源预算内执行；
- `DENY`：本次候选不允许执行；
- `QUARANTINE`：候选、插件或 Executor 被隔离，等待审查。

Gate 的第一层是不可被模型覆盖的硬规则，例如越权路径、凭据外泄、未授权外部副作用、明显破坏性动作和已隔离插件。第二层是画像驱动规则，例如某插件近期出现异常、某类任务连续验证失败或某 Executor 的安全置信度不足。第三层才是用户可配置的偏好。最终结果应表示为 `decision`（`ALLOW`/`DENY`/`QUARANTINE`）加 `requiredControls`（`MONITOR`/`CONFIRM`/`SANDBOX`/路径、网络和资源限制）的组合。

Gate 对任务或每个候选输出 `reasonCodes` 和 `requiredControls`，例如：`PATH_OUT_OF_SCOPE`、`NETWORK_REQUIRED`、`COMMAND_NEEDS_CONFIRM`、`PLUGIN_QUARANTINED`。这些字段直接展示在 UI 的路由和审批详情中。即使任务预检通过，具体候选和运行时动作仍可被拒绝。

### 5.3 Adaptive Router

Router 只接收 Candidate Safety Filter 保留下来的安全候选。候选的最小单位改为：

```text
RouteCandidate = ExecutionTopology + RoleBindingSet + VerificationPolicy

RoleBinding = Role × ModelSelector × AgentProfile × Skill[] × ExecutorBinding
```

`ExecutionTopology` 描述角色之间如何协作，例如 `DIRECT_EXECUTE`、`PLAN_THEN_EXECUTE`、`DELIBERATE_THEN_EXECUTE`、`DIAGNOSE_PROBE_RECOVER`。`RoleBindingSet` 必须包含 `executor`，可以按拓扑加入 `planner`、`critic` 和 `coordinator`。确定性 Rule Verifier 单独属于 `VerificationPolicy`；语义选择、工具门禁和行为判断不再配置为角色，而统一调用 Jev Decision Plane。

例如：

- `DIRECT_EXECUTE + executor=(fast-coder, coding-agent, repo-inspect, CodexAppServer) + verification=(rules=[RuleVerifier], decisionPlane=Jev)`
- `PLAN_THEN_EXECUTE + planner=(strong-reasoner, planning-agent, architecture) + executor=(fast-coder, coding-agent, arkts-edit, CodexAppServer) + verification=(rules=[BuildVerifier], decisionPlane=Jev)`
- `DIAGNOSE_PROBE_RECOVER + planner=(diagnostic-model, planning-agent:diagnose, failure-analysis) + executor=(low-cost-coder, probe-agent, LocalSandboxExecutor) + verification=(rules=[EvidenceVerifier], decisionPlane=Jev)`

每个 `ModelSelector` 支持三种配置模式：

- `PINNED`：固定 provider/model，适合可复现、离线或合规环境；
- `ALLOW_LIST`：Router 只能从项目批准的模型集合中选择；
- `CAPABILITY_QUERY`：按能力、上下文长度、延迟、成本和部署位置筛选，仍受批准列表和安全策略约束。

配置优先级为“本次任务显式覆盖 → 项目配置 → 用户全局配置 → 内置保守默认值”。任务覆盖只能缩小候选或提高验证强度，不能突破组织策略、Safety Profile 或模型批准列表。角色解析失败时按该角色的 `fallbackBindings` 有界回退；不得静默把规划模型替换为拥有更高执行权限的模型。

v1 的选择规则：

```text
safeCandidates = CandidateSafetyFilter.filter(allCandidates)
score(routeCandidate) =
    wQuality × expectedQuality
  + wCapability × capabilityConfidence
  + wProgress × expectedProgress
  - wCost × estimatedCost
  - wLatency × estimatedLatency
  - wUncertainty × uncertainty
```

这是排序，不是安全许可；任何分数都不能让被 Gate 拒绝的候选重新进入集合。Router 要分别记录拓扑选择和每个角色绑定的理由，不能用整体成功掩盖某个角色的持续失败。分数相同采用确定性 tie-break，确保能够复现路由。未来引入情境 Bandit 时，Bandit 只能在同一个 `safeCandidates` 集合内探索，先 shadow 评估，再小流量启用，并支持立即回滚。

### 5.3.1 Model Registry 与 Invocation Gateway

模型配置不能只保存 `modelId`，还需要有实际的解析和调用边界：

- `ModelRegistry` 保存已批准的 provider/model、能力声明、上下文上限、成本/延迟估计、部署位置、版本和健康状态；
- `RoleBindingResolver` 根据注册表解析角色绑定，生成不可变的 `ResolvedRoleBinding` 快照；
- `ModelInvocationGateway` 负责 Planner、Critic、Coordinator 和 MemoryConsolidator 的模型调用，并把 provider 错误、超时和限流转为统一事件；Jev Decision Engine 是独立的决策端口，不作为角色注册；
- `RoleSessionManager` 为每个解析后的角色分配 `RoleContextHandle`，管理独立 Thread、ephemeral fork、上下文生命周期、取消和资源回收；
- `CodexAppServerAdapter` 只有在目标 App Server 明确支持按 Thread/Turn 选择模型时，才能承载对应的模型绑定；不支持时该候选必须标记为不可用，不能静默使用服务端默认模型；
- provider 凭据、API key 和 bearer token 不进入任一客户端普通配置文件或 Trajectory，只由受控的远端网关/Executor Adapter 使用。

模型注册表的健康状态只能影响候选可用性和成本排序，不能直接改变角色权限。模型回退必须重新解析、重新经过 CandidateSafetyFilter，并生成新的绑定快照。

Planner 和 Executor 默认使用独立 `RoleContextHandle`。Jev 只接收经裁剪的状态、候选和证据，不共享可写执行上下文，也不拥有工具权限。如果低风险配置显式允许共享 Thread，每次 Turn 仍必须传入解析后的模型和角色参数，不能依赖上一个 Turn 留下的默认值；高风险决策、Council 和故障诊断不得共享可写执行上下文。`RoleSessionManager` 是通用领域服务，不能由 `CodexSession` 直接替代；后者只管理某一个 Codex App Server 会话。

### 5.3.2 多候选扇出与选择（LLM as a Service）

`PINNED`、`ALLOW_LIST` 和 `CAPABILITY_QUERY` 都只解析出**一个**模型，属于事前路由。多候选扇出是独立的第二层机制：同一个角色、同一个问题，同时调用多个模型候选生成结果，评分后再选择其中一个提交。调用方（角色）只表达“解决这个问题”，扇出、收集、评分和选择由模型调用服务层完成，调用方不感知候选数量与具体模型。

`ModelSelector` 增加第四种模式 `CANDIDATE_SET`：

```text
ModelSelector = { mode: CANDIDATE_SET, candidateBindings[], fanout, selectionPolicyRef, fanoutBudget }
```

`ModelInvocationGateway` 的语义从单次调用升级为扇出调用：一次逻辑调用对应 N 次物理调用，gateway 负责并发上限、超时、部分失败、限流、去重和统一错误映射。只要至少一个候选成功返回，该次逻辑调用即视为成功；全部失败才按调用失败上报。

扇出规模 `N` 由策略决定，默认保守：

- 低风险、已有稳定 Profile 的任务：`N = 1`，退化为单候选，不增加成本；
- 高风险、任务类别无历史、Gate 判定 `UNCERTAIN`，或同类任务近期失败率上升：扇出到 `N > 1`；
- `fanoutBudget` 限制单次扇出的并发、token 和成本上限；超限时按确定性顺序截断候选集并记录截断原因。

`CandidateSelectionPolicy` 分两级执行，最终选择由 Jev Decision Plane 完成：

1. **硬淘汰**：确定性检查失败的候选直接出局，例如编译失败、测试失败、越界路径、超出预算、超时或违反 diff 约束；
2. **Jev 选择**：把幸存候选、证据、约束、成本和延迟交给 Jev，在有限选项中选择、拒绝或请求补充证据。

Jev 判断必须使用独立的决策输入快照，候选生成模型的自报置信度只能作为不可信证据，不能作为唯一依据。Jev 不可用时，选择退化为确定性检查加成本/延迟排序，并记录降级原因；不得重新启用旧的独立 judge 或 LLM Verifier。

选择结果进入 Decision Trace：每次扇出产生一个 `SELECT_CANDIDATE` 决策，每个候选是一个 `DecisionOption`（候选草稿摘要放入 `outputDraftDigest`），选中项随后关联 `DecisionOutcome`，未选中项标记为 `NOT_EXECUTED` 并只用于反事实分析。

多候选不改变安全语义：

- 所有候选共享同一个 `TaskSafetyPrecheck`，且必须逐个通过 `CandidateSafetyFilter` 才能进入评分集合；
- 被 Gate 拒绝的候选不进入集合，评分不能把已拒绝的候选重新放回；
- 选中候选的副作用仍走 `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort`，扇出不产生额外权限、不合并 lease；
- N 个候选意味着 N 份 prompt 可能发往不同 provider，出域记录、脱敏、成本记账和 Support Bundle 边界必须按候选粒度展开。

同一问题的多个候选及其排序是天然的偏好数据，可用于 Profile 校准和评估 cohort；但必须按候选真实来源归因，不能把选中项的分数复制给所有参与模型。

### 5.4 HarnessFacade、Coordinator 与 Agent Core

三者职责必须分离：

- `HarnessFacade` 是 UI 的唯一应用层入口，接收发送任务、取消、审批、切换配置、读取工作区等命令，并发布稳定的 `HarnessReadModel`；
- `HarnessCoordinator` 只维护 `TaskRun` 状态机、模块调用顺序、取消/恢复和超时，不直接生成模型内容、不解析 JSON-RPC、不执行工具；
- `AgentCore` 负责选定执行拓扑中的轻量角色循环，把计划转换成下一步 `ActionIntent`，等待 Safety、Executor 和 Verifier 的结果。

Agent Core 保持轻量，只管理：

- 当前 `TaskRun` 和 Thread/Turn 上下文；
- 下一步动作的生成与预算；
- Skill 提示、工具契约和 Executor 调用；
- 对每个动作等待 Verifier；
- 发生停滞或高不确定性时，把 PlanningRole 切换到 `DIAGNOSE` 能力模式；
- 统一产生 `HarnessEvent` 和 Trajectory。

Agent Core 不直接访问数据库、不绕过 Safety Gate、不直接执行系统命令。它只能申请 `ActionIntent`，由 Safety Monitor 决定是否获得一次性 `PolicyLease`。Coordinator 与 AgentCore 都只依赖领域端口；UI 不能绕过 Facade 直接调用 Executor Adapter。

### 5.5 领域端口与 Executor Adapter

Harness Core 通过四类端口访问外部能力：

- `ModelInvocationPort`：执行 Planner、语义 Verifier、Critic、Coordinator 等模型调用；
- `ExecutorPort`：执行已经获得 `PolicyLease` 的命令、补丁、测试和其他副作用动作；
- `WorkspacePort`：在明确 scope 内读取目录、文件、diff 和元数据；写入仍必须转换为 ActionIntent 并走 ExecutorPort；
- `ApprovalPort`：发起和恢复用户确认、服务端反向审批及权限请求。

`ExecutorPort` 是真实副作用 I/O 的唯一入口。首个生产 Adapter 是 `CodexAppServerAdapter`，它负责把下列 App Server 能力映射到领域端口：

- `thread/start`、`thread/resume`、`thread/fork`；
- `turn/start` 与流式 Item；
- 命令执行、文件变更、权限审批和用户输入请求；
- 工作区目录/文件读取；
- 连接、超时、重试、协议版本和服务端错误。

一个 `CodexAppServerAdapter` 可以同时实现上述多个端口，但 Core 仍把它们视为不同能力边界。未来可以有 `LocalSandboxExecutor`、`BuildExecutor`、`TestExecutor` 和企业内部 Executor。它们必须实现相同的 `ExecutorPort` 契约，并由 Safety Gate 为不同 Executor 授予不同权限。

Executor 的服务端审批请求转换为 `SafetyRequest`，在用户响应前暂停对应 Turn。用户拒绝、连接断开、策略租约过期或响应超时，都以 fail-closed 方式结束动作。

现有 `CodexTransport` 暂时作为兼容接口保留，由 `CodexAppServerAdapter` 包装；不要直接把它扩张为通用 Harness 端口，因为它当前同时混合 Thread、Turn、文件读取和审批职责。待 Facade 接管 UI 后，再逐步把调用迁移到四个领域端口。

### 5.6 Rule Verifier 与 Jev 行为判断

验证链由确定性事实检查和 Jev 语义判断组成，不再存在独立的模型 Verifier 或 Candidate Judge 角色：

1. 确定性检查：编译、单元测试、静态检查、格式检查、文件存在性和 diff 约束，由 Rule Verifier 产生不可覆盖的事实。
2. 过程证据：是否产生了预期 Item、是否有进展、是否重复同一动作、是否接近预算上限。
3. 质量与目标证据：任务目标覆盖、修改范围、回归风险和证据完整性。
4. 安全证据：路径、网络、权限、敏感数据、策略租约和输出泄露。
5. 语义判断：将以上有界证据交给 Jev，输出继续、停滞、不确定、失败或完成方向。

Jev 的输出必须是有限枚举：

```text
VerifierReport {
  status: PASS | CONTINUE | STALLED | UNCERTAIN | FAIL
  progress: 0..1
  quality: 0..1
  safety: 0..1
  uncertainty: 0..1
  evidence[]
  failureCodes[]
  nextAction
  decisionSource: JEV | RULE | FALLBACK
  reasonCodes[]
}
```

触发升级的条件包括：连续若干步没有新证据、动作指纹重复、测试在相同位置振荡、结果与目标冲突、质量/安全证据不足、外部副作用前缺少证据，或达到预算阈值。阈值必须可配置并记录在 Trajectory。Jev 可以判断证据不足或方向不对，但不能把 Rule Verifier 的硬失败改成成功。

### 5.7 可配置的 Planning / Execution / Verification 角色

核心只认识职责稳定的角色，不认识具体模型名称：

- **PlanningRole**：负责理解目标、任务分解、计划、架构推理，以及在停滞时以 `DIAGNOSE` 模式生成互斥或互补假设；默认只读，不能直接修改工作区。
- **ExecutionRole**：负责读取、修改、测试和最小 Probe；只有该角色可以为实际 I/O 申请 `PolicyLease`，但权限仍由 Executor 与 Safety Monitor 共同限制。
- **RuleVerifier**：执行确定性检查并输出事实；不能自行授予执行权限。
- **CriticRole / CoordinatorRole**：仅在 Deliberation 拓扑中启用，分别负责反例审查和短生命周期协调，均默认只读。

每个角色都由 `RoleBinding` 绑定到可配置的模型选择器、Agent Profile、Skill、Executor、预算、上下文策略和回退链。规划模型与执行模型可以相同，也可以不同；Jev 的模型、超时、证据预算和 fallback 属于 `DecisionEngine` 配置，不是一个可执行角色，也不拥有独立工具权限。

为兼容早期设计，可提供两个**可选预设**：`luna-default` 映射到低成本 ExecutionRole，`sol-diagnostic` 映射到 PlanningRole 的 `DIAGNOSE` 模式。它们不得出现在核心状态机、数据库主键或协议必填字段中，用户可以删除、替换或重命名。

概念配置示例：

```json5
{
  "profile": "balanced",
  "roles": {
    "planner": {
      "model": { "mode": "PINNED", "providerIds": ["provider-a"], "modelIds": ["planning-model"] },
      "agentProfile": "general-planner",
      "skills": ["repo-analysis", "failure-analysis"],
      "permissionCeiling": { "capabilityIds": ["workspace.read"], "maxRiskClass": "INSPECT" }
    },
    "executor": {
      "model": { "mode": "ALLOW_LIST", "providerIds": ["provider-a"], "modelIds": ["coding-model-fast", "coding-model-balanced"] },
      "agentProfile": "coding-executor",
      "skills": ["arkts-edit", "build-test"],
      "executor": "codex-app-server",
      "permissionCeiling": { "capabilityIds": ["policy.lease"], "maxRiskClass": "CODE_CHANGE" }
    },
  },
  "verification": {
    "deterministic": ["scope-verifier", "build-verifier", "test-verifier"],
    "decisionPlane": "jev",
    "jev": {
      "model": "jev-latest",
      "evidenceBudget": 32,
      "fallback": "CONSERVATIVE"
    }
  }
}
```

`permissionCeiling` 只能收紧角色权限，不能覆盖插件 manifest、组织策略或 Runtime Safety Monitor；它应当按规范化 capability ID 与风险类别解析，不能作为自由文本权限表达。配置中出现未知模型、失效 provider、循环回退或权限扩张时，解析失败并回到保守默认值，而不是带病执行。

诊断流程：

1. Rule Verifier 或 Jev 检测 `STALLED` 或 `UNCERTAIN`，冻结当前高风险动作。
2. 配置的 PlanningRole 读取精简的失败上下文和轨迹，以 `DIAGNOSE` 模式生成带证据需求的多个 `Hypothesis`。
3. Jev 根据解释力、风险、预期信息增益和验证成本，从有限 Probe 候选中选择下一步。
4. ExecutionRole 按排序执行最小成本 `Probe`，每个 Probe 仍经过 Safety Monitor。
5. 新证据支持某一假设后，再由 Jev 判断是否恢复主任务；没有支持时停止、请求用户或收紧策略。

禁止 PlanningRole 直接执行大范围修复；它只生成计划、诊断和 Probe 建议。禁止 ExecutionRole 在没有 Verifier 新证据的情况下无限重试。角色绑定发生回退、模型切换或预算升级时必须生成 Trajectory 事件并重新经过候选安全检查。

## 6. Trajectory 与评估闭环

Trajectory 是每次运行的追加式事件序列，最小事件类型包括：

```text
TaskReceived
TaskClassified
TaskSafetyPrechecked
CandidateSafetyEvaluated
RouteSelected
RoleBindingsResolved / RoleBindingFallback
CandidateBatchInvoked
CandidateScored
CandidateSelected
AgentDecisionProposed / AgentDecisionCommitted / AgentDecisionRevised / AgentDecisionAbstained
PluginLoaded
ActionProposed
ActionAllowed / ActionDenied
ApprovalRequested / ApprovalResolved
ExecutorStarted / ExecutorDelta / ExecutorCompleted
VerifierReport
DiagnosisGenerated
ProbeStarted / ProbeCompleted
PolicyTransition
CreditAssigned / BlameAssigned
DecisionOutcomeLinked
RunCompleted / RunFailed
```

每个事件包含 `runId`、`threadId`、`turnId`、`stepId`、时间、组件版本、输入摘要、输出摘要、证据引用、策略版本和关联事件。原始命令、路径、token、密钥和个人数据必须在落库前按规则脱敏；需要审计的原文放在受控的加密存储中，不直接放入 UI 日志。

### 6.1 Credit / Blame Assignment

v1 使用可解释的启发式归因：

- Credit 按“动作产生的有效证据”“对最终目标的进展”“Verifier 通过情况”和下游成功程度分配。
- Blame 根据失败码、最后一个导致失败的动作、越界/不安全信号、重复行为和不必要成本分配。
- 将 `Role`、`Model`、`Agent`、`Skill`、`Executor`、`Verifier` 和 `Router` 分开归因，避免把所有失败都归给模型，也避免把规划错误算到执行模型头上。
- Router 评价保存“本次选择的预期”和“安全候选中的事后结果”，不在单次失败后直接修改路由规则。

Profile 更新在 Turn 完成或明确失败后进行；安全事件、越界尝试和疑似泄露可以立即提高 Safety Profile 的限制级别。

Capability Profile 的正向 Credit 不能由单次成功直接触发权限放开，必须经过最小样本数、时间窗口、去重、置信区间和回归检查；任务内容、工具输出或 Agent 消息中的自我评价不能作为独立证据。Safety Profile 的放开仍只能按治理阶段迁移和人工/受控审查执行。

### 6.2 Profile 维度

`CapabilityProfile` 的 key 至少包含 `role`、`modelProvider`、`modelId`、`agentId`、`skillVersion`、`executorId`、`taskClass` 和环境类型。规划、执行、验证角色分别统计；拓扑层另有组合效果指标。建议字段：

- 样本数、成功数、失败数；
- Verifier 的 progress/quality 均值和置信度；
- P50/P95 延迟、成本、平均步数；
- 停滞率、升级率、恢复率；
- 最近成功/失败时间、版本和数据窗口。

`SafetyProfile` 的 key 至少包含主体（模型/provider、角色绑定、插件、Agent、Executor 或能力）、任务类别、工作区/环境范围和版本。建议字段：

- 当前治理级别、风险类别和策略版本；
- 事件数、近失误数、越界数、拒绝数、隔离原因；
- 安全运行 streak、最近安全时间、最近事件时间；
- 允许路径/网络/资源范围；
- 当前限制、人工审查状态、quarantine 截止时间。

样本不足时使用保守先验，不能把“没有数据”当成“安全”。

### 6.3 Agent Decision Trace

Trajectory 不仅记录“发生了什么”，还要记录每个 Agent 在语义分支点“基于哪些当时可见事实，在什么约束下比较了哪些候选，选择了什么，以及预期什么结果”。Classifier、Router、PlanningRole、ExecutionRole、Diagnostician、Critic/Council 和 MemoryConsolidator 的关键决策都先形成结构化 `AgentDecisionRecord`，并由 Jev Decision Plane 作出有限选择；Coordinator 提交后才能产生 route、ActionIntent、行为判断、Probe 或 Memory Proposal。

执行、Rule Verifier、Jev 判断和用户反馈随后通过 `DecisionOutcomeLinked` 追加，Credit/Blame 只使用独立结果，不反向修改决策时特征。Decision DAG 支持 `DEPENDS_ON`、`SUPERSEDES`、`CRITIQUES`、`SELECTS` 和 `OUTCOME_OF` 等关系，使后续离线回放、错误模式分析、Profile 更新和受约束策略学习都可以从真实过程而非最终文本取样。

同角色多候选扇出产生 `SELECT_CANDIDATE` 决策：逐候选记录来源绑定、评分分量和淘汰原因，选中项写出选择理由，未选中候选随决策一起保留但只用于反事实分析。

该记录是 provider-neutral 的结构化决策摘要，不是 chain-of-thought。模型自报置信度或 provider reasoning summary 均不是事实、权限或学习真值；系统提示、reasoning token、凭据和隐藏思维不进入普通记录。完整契约见 [Agent Decision Trace 规范](DECISION_TRACE_SPEC.md)。

## 7. 安全反向治理

治理收紧历史按主体和作用域维护，而不是只维护一个全局开关：

```text
ALLOW → MONITOR → CONFIRM → SANDBOX → DENY → QUARANTINE
```

上面的路径是安全历史驱动的**治理阶段迁移**，不是可以直接比较大小的运行时权限数值。实现上至少拆成两个维度：

- `governanceStage`：主体当前处于允许观察、需复核、受限隔离、拒绝或检疫等阶段，用于反向治理和逐级放开；
- `requiredControls`：本次动作必须叠加的实时控制，例如监控、用户确认、沙箱、路径白名单、网络白名单、速率限制和资源预算。

因此一次动作可以是“治理阶段 `MONITOR` + `CONFIRM` + `SANDBOX`”，也可以是“治理阶段 `ALLOW` + `MONITOR`”。`CONFIRM` 与 `SANDBOX` 的先后不能通过普通数值比较推导，必须由策略表针对 taskClass、资源和风险组合决定。

### 7.1 收紧条件

- `ALLOW → MONITOR`：出现异常但尚未构成安全事件，或画像置信度下降。
- `MONITOR → CONFIRM`：重复近失误、用户频繁拒绝、验证证据不足或需要外部副作用。
- `CONFIRM → SANDBOX`：确认后仍发生越界、资源超限或环境不可信。
- `SANDBOX → DENY`：沙箱内仍失败、越权或产生高风险信号。
- `DENY → QUARANTINE`：能力/插件有明确安全事件、协议欺骗、数据泄露疑点或完整性校验失败。

收紧必须带 `reasonCodes`、证据引用和生效范围。不能因为某个插件失败，就无依据地封禁所有 Agent；也不能只降低 UI 提示而继续保留执行权限。

### 7.2 逐步放开条件

治理阶段的放开只能按相邻阶段逐级进行，禁止从 `QUARANTINE` 直接跳到 `ALLOW`；本次动作的 `requiredControls` 是否减少，则按独立的策略表重新计算：

1. 通过完整性、依赖和版本审查；
2. 在隔离环境中完成足够数量的安全轨迹；
3. Verifier 通过率、越界率、异常率达到门槛；
4. 在更严格级别运行一个观察窗口；
5. 获得人工审查或受控审批；
6. 只放开指定 taskClass、workspace scope 和资源范围。

安全历史足够时的典型路径为：

```text
QUARANTINE → DENY → SANDBOX → CONFIRM → MONITOR → ALLOW
```

每次放开都生成 `PolicyTransition`。高风险任务类别拥有不可突破的安全底线，即使画像良好也至少需要 `CONFIRM` 或 `SANDBOX`。人工可以随时收紧权限，但不能通过普通 UI 操作绕过系统硬规则放开权限。

### 7.3 Runtime Safety Monitor

Monitor 在以下时点运行：

- 产生 ActionIntent 后、调用 Executor 前；
- Executor 请求访问新路径、新网络目标、新工具或新凭据时；
- 命令参数、补丁范围或文件目标发生变化时；
- Verifier 发现停滞、异常输出或高不确定性时；
- Router/Plugin/Profile 发生版本或策略变化时。

Monitor 检查路径边界、命令分类、网络白名单、秘密扫描、资源预算、调用深度、重复动作、输出泄露和 PolicyLease。每个 lease 只对应一组明确的动作、作用域和有效期，不能被 Agent 自行扩展。

## 8. 插件化机制

首版采用“manifest + 编译期注册 + 数据库状态”的保守方案，后续再根据 HarmonyOS PC 的 HSP/动态模块能力选择真正的动态加载方式。禁止把任意字符串当作 ArkTS 代码执行。

概念 manifest：

```json5
{
  "id": "arkts-test-skill",
  "version": "1.0.0",
  "kind": "skill",
  "entry": "skills/ArkTsTestSkill",
  "capabilities": ["run_tests", "read_build_output"],
  "requiredPermissions": ["workspace.read", "process.test"],
  "riskClass": "TEST_BUILD",
  "verifier": "arkts-build-verifier",
  "dependencies": [],
  "contentHash": "...",
  "trusted": false
}
```

插件生命周期：`DISCOVERED → VALIDATING → ENABLED → MONITORING → DISABLED / QUARANTINED`。验证包括 manifest schema、签名或 hash、依赖、权限、能力声明与实际调用的匹配。插件版本必须进入 Capability/Safety Profile key，升级后默认重新观察，不能继承旧版本的全部信任。

插件类型建议分为：

- `skill`：任务方法、提示和工具声明；不拥有直接系统权限。
- `agent`：轻量循环和决策策略；不能越过 Core 调用 Executor。
- `executor`：受控外部 I/O；每次动作需要 PolicyLease。
- `verifier`：检查证据和结果；不能因为自评通过就修改安全级别。
- `role-preset`：声明 Planner/Executor/Verifier/Critic/Coordinator 的默认绑定与回退链；本身不授予权限。

“诊断”是 PlanningRole 的一种能力模式，不再作为必须绑定某个模型或独立插件类型的核心概念。

## 9. ArkTS 模块与数据设计

建议在现有 `entry/src/main/ets` 下增加如下目录；这是下一阶段实现目标，不要求本次设计提交全部代码：

```text
entry/src/main/ets/
├── facade/
│   ├── HarnessFacade.ets
│   ├── HarnessCommands.ets
│   └── HarnessReadModel.ets
├── core/
│   ├── HarnessCoordinator.ets
│   ├── AgentCore.ets
│   ├── HarnessState.ets
│   └── HarnessEvents.ets
├── ports/
│   ├── ModelInvocationPort.ets
│   ├── ExecutorPort.ets
│   ├── WorkspacePort.ets
│   └── ApprovalPort.ets
├── sessions/
│   ├── RoleSessionManager.ets
│   └── RoleContextHandle.ets
├── classifier/
│   ├── TaskClassifier.ets
│   └── RuleTaskClassifier.ets
├── safety/
│   ├── SafetyGate.ets
│   ├── RuntimeSafetyMonitor.ets
│   ├── SafetyProfileStore.ets
│   └── PolicyLease.ets
├── routing/
│   ├── AdaptiveRouter.ets
│   ├── RuleRouter.ets
│   ├── ExecutionTopology.ets
│   ├── ModelRegistry.ets
│   ├── RoleBindingResolver.ets
│   └── CapabilityProfileStore.ets
├── models/
│   ├── ModelProviderAdapter.ets
│   └── ModelInvocationGateway.ets
├── deliberation/
│   ├── DeliberationOrchestrator.ets
│   ├── AgentCouncil.ets
│   ├── DebateProtocol.ets
│   ├── ConsensusJudge.ets
│   └── DiversityPolicy.ets
├── agents/
│   ├── PlanningAgent.ets
│   ├── ExecutionAgent.ets
│   ├── VerificationAgent.ets
│   └── RolePresetRegistry.ets
├── plugins/
│   ├── PluginManifest.ets
│   ├── PluginRegistry.ets
│   └── PluginLifecycle.ets
├── verifiers/
│   ├── Verifier.ets
│   ├── RuleVerifier.ets
│   └── DiagnosisVerifier.ets
├── trajectory/
│   ├── TrajectoryStore.ets
│   ├── DecisionTraceRecorder.ets
│   ├── DecisionTraceProjector.ets
│   ├── CreditBlameAssigner.ets
│   └── RouterEvaluator.ets
├── memory/
│   ├── DreamScheduler.ets
│   ├── MemoryConsolidator.ets
│   ├── MemoryVerifier.ets
│   └── MemoryStore.ets
├── adapters/
│   ├── codex/
│   │   ├── CodexAppServerAdapter.ets
│   │   ├── CodexProtocol.ets
│   │   ├── CodexWireProfile.ets
│   │   ├── CodexSession.ets
│   │   └── AppServerWebSocketTransport.ets
│   └── mock/
│       ├── MockModelAdapter.ets
│       └── MockExecutorAdapter.ets
├── services/                         # 迁移期兼容目录
│   ├── CodexSession.ets              # 先保留旧 API，后委托给 codex adapter
│   └── MockCodexTransport.ets        # 先保留旧 UI/测试入口
└── pages/
    └── Index.ets
```

以上是目标逻辑分层，不要求第一步就移动现有文件。迁移期允许 `services/` 中的旧类通过委托包装新 Adapter，以减少 UI 和测试一次性改动；完成 Facade 切换后，Core、Facade 和页面不得再 import `adapters/codex` 的协议类型。

实现级契约已经从本总览移出，避免概念代码与长期协议发生漂移：

- `HarnessCommandEnvelope`、`HarnessEventEnvelope`、结构化 `PortResult`、流式 Operation 和四类 Port 以 [PROTOCOL_SPEC.md](PROTOCOL_SPEC.md) 为准；
- `TaskRun`、Approval、PolicyLease、RoleContext 的状态与恢复以 [STATE_MACHINE.md](STATE_MACHINE.md) 为准；
- `ActionIntent`、`PolicyLease`、SafetyDecision 和权限求交以 [SECURITY_MODEL.md](SECURITY_MODEL.md) 为准；
- relationalStore schema、事务、回放和迁移以 [DATA_MODEL.md](DATA_MODEL.md) 为准。
- Agent 决策点、候选/证据、Decision DAG、结果关联和学习样本以 [DECISION_TRACE_SPEC.md](DECISION_TRACE_SPEC.md) 为准。

长期协议不再使用 `Promise<string>` 表示模型或执行操作；统一采用 operation handle、持久化事件流、结构化最终结果、deadline 和 cancellation。`SafetyDecision.allowed` 不单独落库或传输，是否允许由 `decision` 推导，避免布尔值与枚举产生矛盾。

结构化事件和画像使用 HarmonyOS 的 relationalStore；设置和少量本地偏好可以使用 preferences。数据库表建议包括：`tasks`、`runs`、`trajectory_events`、`verifier_reports`、`route_decisions`、`role_bindings`、`role_binding_resolutions`、`model_registry`、`deliberations`、`deliberation_rounds`、`agent_proposals`、`critique_edges`、`capability_profiles`、`safety_profiles`、`policy_transitions`、`plugin_registry` 和 `approval_requests`。

角色配置按“系统策略 → 用户全局 → 项目 → 当前任务”分层合并，并保存解析后的不可变快照。Trajectory 只引用该快照 ID，确保模型注册表或项目配置变化后仍能准确回放历史选择。

所有写入需要 `runId + eventId` 幂等键。UI 不直接查询原始事件表，而是读取按 Thread/Turn 聚合的 read model，避免大量流式事件导致界面状态难以维护。

## 10. Dreaming：跨会话记忆整理

### 10.1 调研结论

Claude Code 的官方文档把跨会话能力称为 **Auto Memory**：每个会话从新的 context window 开始，由项目指令文件和自动积累的 memory 提供连续性。Auto Memory 会记录构建命令、调试规律、项目约定和用户偏好，按项目隔离，使用一个简洁的索引和按主题拆分的文件，并允许用户查看、编辑、删除或关闭。

Anthropic 公开的 **Dreaming** 则是 Claude Managed Agents 的研究预览能力：它作为定时过程回看历史 Agent session 和 memory store，抽取跨会话模式、整理记忆，并允许自动更新或先经人工审核后落地。它不应被理解为“模型在后台无限自主执行”，而是一个有触发条件、输入范围、锁、预算和发布门槛的记忆维护任务。

因此 hmCodex 可以加入同类能力，但产品命名和工程边界应是 `DreamScheduler + MemoryConsolidator`。不把社区对隐藏功能或逆向实现的描述当成 Claude Code 的规范，也不宣称 hmCodex 复刻了 Claude Code 的内部实现。

### 10.2 在 hmCodex 中的定位

Dreaming 是一种 `MEMORY_MAINTENANCE` 任务，属于 Harness 的后台维护流，不是普通 Coding Turn，也不拥有额外的执行权限：

```text
Trajectory / VerifierReport / UserFeedback
          │
          ▼
    DreamScheduler
          │  时间、会话数、空闲、锁、隐私和预算门控
          ▼
    MemoryConsolidator
      Orient → Gather → Consolidate → Verify → Review/Publish → Prune
          │
          ├── Project Memory
          ├── User Preference Memory
          ├── Failure Pattern Memory
          └── Profile Update Proposal
```

MemoryConsolidator 使用独立的只读 `MAINTENANCE` 角色绑定。它可以复用项目配置中的规划模型，也可以绑定专用模型，但必须拥有独立预算、上下文和 Capability/Safety Profile，不能继承 ExecutionRole 的工具权限。

Dream 的输出是带来源、置信度、有效期和变更摘要的 `MemoryProposal`。它可以帮助下一轮 Classifier、Router、Agent 和 Verifier 减少重复探索，但不能直接：

- 修改项目源码或执行命令；
- 把推测写成安全事实；
- 提升 Candidate、Plugin 或 Executor 的权限；
- 直接改写 Capability/Safety Profile；
- 把一次偶然的模型输出当成永久用户偏好。

### 10.3 记忆分层

| 层级 | 内容 | 生命周期 | 访问方式 |
| --- | --- | --- | --- |
| `HOT` | 当前 Task/Turn 上下文、未验证假设、临时计划 | 当前运行 | Agent Core |
| `WARM` | 项目约定、稳定构建命令、已验证调试模式、用户明确偏好 | 跨会话 | Classifier/Router/Agent 按需检索 |
| `COLD` | 原始 Trajectory、完整 Verifier 报告、历史版本和审计记录 | 按保留期归档 | 审计、Dream、离线评估 |

`WARM` 记忆采用“索引 + 主题记录”模式，索引必须短小、可审计；详细内容按需加载，避免每个会话把所有历史塞入 context。`COLD` Trajectory 是证据源，不能被整理过程覆盖。安全事件、越权尝试和人工策略决定采用追加式安全日志，不能因为“过时”而被普通 Prune 删除。

### 10.4 Dream 生命周期

```text
SCHEDULED
  → ELIGIBILITY_CHECK
  → LOCK_ACQUIRED
  → ORIENT
  → GATHER
  → CONSOLIDATE
  → VERIFY
      ├→ REVIEW_REQUIRED → PUBLISHED / REJECTED
      ├→ LOW_RISK_AUTO_PUBLISH → PUBLISHED
      └→ FAILED / QUARANTINED
  → PRUNE
  → COMPLETE
```

触发门控建议为：距上次整理达到时间阈值、出现足够多的新完成会话、设备处于用户设定的空闲窗口、没有正在进行的高优先级运行、没有同一项目的整理锁，并且当前 Safety Profile 允许只读维护。任何一个门控失败都不启动 Dream。

整理阶段：

1. **Orient**：读取项目 memory 索引、策略版本和上次整理水位。
2. **Gather**：只读取已完成或明确失败的 Trajectory、VerifierReport 和用户反馈；先做秘密、个人数据和超范围路径脱敏。
3. **Consolidate**：去重、合并、标记冲突，提炼稳定模式，并为每条记忆保留来源事件。
4. **Verify**：检查来源存在性、时间新鲜度、互相矛盾、敏感内容、过度泛化和对权限的隐含影响。
5. **Review/Publish**：低风险项目事实可以按设置自动发布；偏好、跨项目记忆、能力评价和所有安全相关记忆默认进入审核队列。
6. **Prune**：只删除已确认重复、已失效且没有审计价值的普通记忆；更新索引，保留版本和删除原因。

### 10.5 与 Verifier、Profile 和 Router 的关系

Dream 使用独立的 `MemoryVerifier`，不复用“任务完成”结论。`MemoryVerifier` 至少检查：

- 每条结论是否有可回放的 Trajectory source；
- 结论是否被多个独立运行支持；
- 事实是否过期、被后续运行推翻或仅来自模型猜测；
- 是否包含秘密、个人数据、越权路径或可执行指令；
- 是否可能诱导 Router 选择更高权限候选。

Dream 可以生成 `CapabilityUpdateProposal` 和 `SafetyUpdateProposal`，但实际更新必须走既有的 ProfileUpdater：

```text
Dream Proposal
    → Evidence Check
    → ProfileUpdater
    → Safety Gate / Policy Review
    → Profile Versioned Commit
```

Capability Profile 可以吸收“某类任务的稳定成功模式”。Safety Profile 对事件采取更保守的处理：安全事件和近失误立即生效，普通安全历史只能作为逐级放开的证据，不能被 Dream 一次性改成 `ALLOW`。

Router 把已验证的 WARM memory 当作 context feature 或候选能力证据，同时记录 memory version。memory 被撤回或降级时，相关路由结果可以按版本回放，避免产生不可解释的历史差异。

### 10.6 安全与权限

Dream 默认运行在只读 `SANDBOX`：只能读取指定项目的脱敏 Trajectory/Memory 数据库，不能调用 shell、写工作区、访问网络、读取凭据或加载未信任插件。跨项目聚合、团队共享、外部知识库同步和修改用户偏好，需要 `CONFIRM` 或显式设置。

Dream 的锁、预算、取消和失败都进入 Trajectory。应用退出、数据库锁冲突、网络异常、Verifier 不确定和资源超限时，保留候选草稿并停止，不重复自动提交。记忆文件与项目源码目录分离，用户可以查看、编辑、撤回和清空；清除 memory 不得删除原始安全审计记录。

### 10.7 UI 设计

在当前工作台增加“记忆 / Dreaming”面板：

- 显示 `DREAMING`、等待门控、完成、审核和失败状态；
- 展示本次整理读取了哪些 session、产生了哪些候选记忆；
- 对每条候选显示来源、置信度、有效期、冲突和影响范围；
- 提供接受、编辑、拒绝、删除和“以后不要记录此类信息”；
- 把 Profile Update Proposal 与真正的 Profile 版本变更分开显示；
- 支持手动开始、取消、暂停自动 Dream 和导出审计摘要。

UI 中禁止使用“模型自己学会了”这类不可验证表述，应显示为“从 N 个已完成运行中提炼，经过 MemoryVerifier，待审核/已发布”。

### 10.8 数据与指标

增加表：`memory_runs`、`memory_records`、`memory_sources`、`memory_proposals`、`memory_feedback`、`dream_locks`。每条 `memory_record` 包含 `memoryId`、`scope`、`kind`、`contentDigest`、`sourceEventIds`、`confidence`、`validFrom`、`expiresAt`、`status`、`version` 和 `redactionPolicy`。

观测指标：记忆命中率、用户接受/修改/拒绝率、重复率、过期率、被用户纠正率、来源覆盖率、对任务步数和成本的影响、错误记忆导致的回归率，以及安全相关记忆的误放行率。没有来源或无法解释的记忆不计入“有效学习”。

## 11. Deliberation：多 Agent 审议与相互质疑

### 11.1 调研结论

多 Agent 的价值不在于“让几个模型闲聊”，而在于让多个相对独立的解决路径暴露假设，再用证据和 Verifier 筛掉错误路径。现有资料给出的结论是有条件的：

| 证据 | 观察 | 对 hmCodex 的启示 |
| --- | --- | --- |
| Multiagent Debate 研究 | 多实例先独立回答，再互相批评和修订；在多个推理/事实任务上优于单实例，但成本更高，且可能收敛到错误共识 | 默认先独立、后讨论；必须保留 `ABSTAIN`，不能把共识当正确性证明 |
| SWE-Debate | 面向软件问题先生成多个故障传播路径，再由专业角色进行多轮竞争式讨论，最后交给代码修改/搜索过程 | 代码任务应围绕依赖图、失败日志、测试和 diff 进行讨论，而不是只比较自然语言答案 |
| Claude Managed Agents | 一个 coordinator 可以把复杂任务拆给隔离上下文中的专业 Agent，并行化、专业化或升级；线程持久且每个 Agent 有独立模型、工具和 Skill | 采用 Coordinator + 专业 Agent roster；每个子 Agent 的工具和权限独立配置 |
| Debate strategy 研究 | Agent 数量、轮数、同意倾向和通信方式会影响结果；额外轮数并不无限带来收益 | 用 `DeliberationPolicy` 动态控制人数、轮数和通信拓扑，用 A/B 数据验证收益 |

因此结论是：**可以加入，而且对复杂代码定位、架构决策、测试失败诊断和高不确定性任务有潜在性能收益；但不应全局开启。** 性能目标应同时看成功率、验证通过率、成本、延迟、工具调用数和错误共识率。

### 11.2 触发策略

Adaptive Router 提议审议拓扑，随后由位于 Router 与 Agent Core 之间的 `DeliberationGate` 做策略与预算强制检查。Gate 可以接受或降级提议，不能把不安全候选升级为 Council。它根据 taskClass、Capability/Safety Profile、Verifier 状态和预算处理以下模式：

- `DIRECT`：简单解释、单文件只读、低风险查询，直接由一个 Agent 处理。
- `PLAN_REVIEW`：跨文件变更、架构设计、复杂重构，先并行提出计划，再质疑和排序。
- `FAULT_DEBATE`：测试失败、构建失败、问题定位不确定，围绕故障传播链进行竞争式诊断。
- `PATCH_REVIEW`：ExecutionRole 生成补丁后，由独立 Reviewer 和 Security Critic 审核，再交给 Verifier。
- `HIGH_RISK_REVIEW`：外部副作用、敏感数据、权限变化和破坏性操作，只允许在明确的安全范围内审议；审议不能替代用户确认。
- `RECOVERY_DEBATE`：Verifier 判断停滞或高不确定性时，调用配置的 PlanningRole 组织少量候选假设和最小 Probe。

推荐默认规则：低风险任务 `DIRECT`；中等复杂度任务按成本预算选择 `PLAN_REVIEW` 或 `PATCH_REVIEW`；出现停滞或高不确定性才升级 `FAULT_DEBATE/RECOVERY_DEBATE`。没有足够预算或候选独立性不足时，宁可单 Agent + 强 Verifier，也不强行组 Council。

### 11.3 Council 角色

Council 不是平等无限群聊，而是有明确输入输出的短生命周期协作组：

```text
Coordinator / Lead
   ├── Explorer A：独立分析代码、需求或故障路径
   ├── Explorer B：从另一种假设、模型或 Skill 出发分析
   ├── Reviewer：针对方案寻找反例、遗漏和回归风险
   ├── Security Critic：检查权限、注入、数据流和副作用
   └── Judge / Verifier：按证据、质量、风险和成本排序
                         │
                         ▼
             ExecutionRole 最小执行 / Probe
```

角色映射：

- Coordinator 负责分解、收集和控制轮数，不直接替代 Safety Gate。
- Explorer 默认只读，输出 `Proposal`、证据引用和待验证假设。
- Reviewer 不能只说“不同意”，必须指出具体 claim、反例、证据缺口或最小验证方式。
- Security Critic 的否决权只作用于安全风险，不参与普通质量的多数投票。
- Judge 负责裁决“采用、继续收集证据、升级或弃权”，不能凭投票直接授予权限。
- ExecutionRole 负责按批准计划执行最小动作；任何工具调用仍经过 Runtime Safety Monitor。
- PlanningRole 的 `DIAGNOSE` 模式主要承担高不确定性诊断和争议归因，不在 Council 中拥有绕过规则的特殊权限。

Council roster 中每个角色都使用独立 `RoleBinding`，可分别配置模型、Agent Profile、Skill、上下文切片和预算。项目可以让多个角色共享模型以降低成本，但高风险审议默认要求 Executor、Security Critic 与语义 Verifier 至少在上下文或模型上保持独立。

相同模型的多个副本可以增加采样覆盖，但不应被误认为真正独立。Router 的 `DiversityPolicy` 要尽量混合模型、系统提示、Skill、上下文切片或分析视角，并在 Trajectory 中记录实际差异。

### 11.4 结构化审议协议

采用最多三阶段、默认两轮的短协议：

**Round 0：独立提案。** 各 Explorer 从同一个任务快照出发，不先读取其他 Agent 的结论。每个提案必须包含目标解释、关键假设、影响文件/符号、证据引用、风险和最小验证。

**Round 1：定向质疑。** 每个 Reviewer 选择最重要的 1～3 个 claim，输出 `question`、`counterEvidence`、`severity`、`requiredProbe`。只允许针对可验证内容质疑，不鼓励长篇角色扮演。

**Round 2：有限修订与裁决。** 原提案者回应质疑并更新方案；Judge 结合 Verifier 的确定性证据排序，生成 `ACCEPT_PLAN`、`REQUEST_PROBE`、`ESCALATE` 或 `ABSTAIN`。高争议时优先执行最小 Probe，而不是继续增加辩论轮数。

审议完成后只向 ExecutionRole 传递压缩后的 `DecisionPacket`：选中方案、保留的不确定性、证据引用、需要执行的最小动作、不可触碰范围和验证标准。不要把全部讨论 transcript 无限制塞回执行 Agent 的上下文。

### 11.5 ArkTS 契约

```ts
interface DeliberationRequest {
  deliberationId: string;
  runId: string;
  mode: string;
  taskSnapshotId: string;
  roleRoster: Array<RoleBinding>;
  maxAgents: number;
  maxRounds: number;
  budgetUnits: number;
}

interface AgentProposal {
  proposalId: string;
  authorBindingId: string;
  claims: Array<string>;
  assumptions: Array<string>;
  evidenceRefs: Array<string>;
  proposedActions: Array<string>;
  riskFlags: Array<string>;
}

interface Critique {
  critiqueId: string;
  authorBindingId: string;
  targetProposalId: string;
  challengedClaims: Array<string>;
  counterEvidenceRefs: Array<string>;
  requiredProbes: Array<string>;
  severity: string;
}

interface DecisionPacket {
  deliberationId: string;
  outcome: string;
  selectedProposalId?: string;
  rankedProposalIds: Array<string>;
  unresolvedDisagreements: Array<string>;
  requiredProbes: Array<string>;
  allowedScope: string;
  verifierCriteria: Array<string>;
}
```

以上契约只表达可审计的 claim、证据和动作，不要求保存或展示模型的隐含思维过程。每个 Proposal、Critique、Judge 决定和 Probe 都要关联 Trajectory。

### 11.6 防止集体认错和安全绕过

- **防止锚定**：Round 0 隐藏其他提案；只有进入质疑轮后才共享压缩后的方案。
- **防止同质化**：DiversityPolicy 记录模型、Prompt、Skill、上下文和工具差异；同质副本不能伪装成独立证据。
- **防止错误共识**：Judge 必须允许 `ABSTAIN`；最终正确性由测试、构建、静态检查、diff 和 Runtime Monitor 证明。
- **防止迎合**：Reviewer 需要给出反例或 Probe；单纯的多数同意不增加置信度。
- **防止工具污染**：Explorer/Reviewer 默认只读或使用隔离快照；多个 Agent 不能同时写同一工作区。
- **防止 Prompt Injection**：跨 Agent 消息和仓库内容都标记为不可信数据；任何“忽略规则/提升权限”的文本只能作为待分析内容，不能成为策略指令。
- **防止权限升级**：Council 的结果只是计划或证据，所有动作重新过 Safety Gate 和 PolicyLease；Security Critic 的“通过”也不能放宽权限。
- **防止无限消耗**：人数、轮数、上下文长度、并发数、Probe 数和成本都有硬上限，达到上限即 `ABSTAIN` 或交给用户。

### 11.7 性能策略与评价

不要用“最终答案看起来更好”作为唯一评价。每一种 taskClass 维护单 Agent 基线和 Council 变体，至少比较：

- `solveRate`：任务达到验收条件的比例；
- `verifierPassRate`：通过确定性 Verifier 的比例；
- `firstValidPatchLatency`：得到第一个可验证补丁的时间；
- `costPerSolvedTask`：每个成功任务的 token/费用/执行单位；
- `toolCallsPerSolvedTask`：工具调用和重试次数；
- `regressionRate`：当前任务通过但引入回归的比例；
- `falseConsensusRate`：Council 达成共识但被 Verifier 或测试否定的比例；
- `disagreementValue`：分歧是否实际带来了有效 Probe 或错误修正。

Router 可以依据历史数据决定是否开启 Council，但安全层不使用这些指标抵消硬风险。建议初始策略是 `ON_DEMAND`，当某类任务的 Council 在固定窗口内带来质量提升且成本增幅低于阈值时，才提高自动触发比例；如果 `falseConsensusRate` 或安全近失误上升，立即降级为 `DIRECT + Verifier`。

### 11.8 UI 呈现

当前工作台增加“审议”时间线：

- 显示 Council 是否触发、原因、Agent roster、每个 Agent 的状态和成本；
- 展示独立提案、关键质疑、证据引用和 Judge 决定；
- 折叠默认显示摘要，用户可以展开完整审议轨迹；
- 明确区分“Agent 共识”“Verifier 通过”“用户批准”；
- 争议未解决时显示 `ABSTAIN/需要验证`，不显示虚假的确定结论；
- 支持用户指定“直接执行、先审议、只给计划”三种模式，但用户模式仍受 Safety Gate 约束。

## 12. 与当前仓库的兼容改造路径

当前代码已有 UI、会话抽象、Mock Transport、App Server WebSocket Transport、工作区读取和审批卡片，适合采用“Facade 上接 UI、端口隔离 Core、Adapter 下接 App Server”的渐进迁移。现有文件不整体删除，但职责必须重新收敛：

| 当前能力 | 设计中的归属 | 改造方式 |
| --- | --- | --- |
| `Index.ets` | Harness UI | 从直接调用 `CodexSession` 改为调用 `HarnessFacade` 并订阅 `HarnessReadModel`；不在页面中复制状态机 |
| `SessionEvent` / UI switch | 兼容 read-model adapter | 迁移期映射为 `HarnessEvent`，由 Facade 聚合；稳定后 UI 不直接理解 Codex Item/Turn 字段 |
| `CodexSession` | Codex 专用 Session Adapter | 保留单服务连接和 Thread 生命周期；增加 resume/list/fork，但不升级为通用 RoleSessionManager |
| `CodexTransport` | 迁移期兼容接口 | 由 `CodexAppServerAdapter` 包装，并逐步拆为 ModelInvocation/Executor/Workspace/Approval 四个 Port |
| `CodexProtocol` | Codex Wire Adapter | 按 App Server 版本生成或校验 schema，增加 `CodexWireProfile`，内部转为稳定领域事件 |
| `AppServerWebSocketTransport` | Codex Transport | 只负责连接、framing、请求关联和重连；不承担 Router、Safety 或角色逻辑 |
| `MockCodexTransport` | 兼容 Mock | 保留现有 UI/测试入口，同时新增 Mock Port Adapter，覆盖分类、Verifier、停滞、诊断和治理场景 |
| 新 `RoleSessionManager` | 通用角色上下文 | 管理 Planner/Executor/Verifier/Council 的独立 context/thread/fork；只依赖端口，不依赖 Codex 类型 |
| 审批卡片 | Safety UI | 同时显示风险等级、理由、作用域、一次性 lease 和历史依据 |
| 工作区面板 | Workspace Context UI | 显示当前 scope、沙箱状态、候选路由和验证证据 |

迁移期遵守三条不变量：

1. `Index.ets` 可以短期继续通过旧 `CodexSession` 工作，但新 Harness 功能只从 `HarnessFacade` 暴露；完成 Facade 垂直切片后再删除页面直连。
2. `core/`、`routing/`、`safety/`、`agents/` 和 `verifiers/` 禁止 import JSON-RPC、WebSocket 或 `adapters/codex` 类型，只依赖领域事件和 Port。
3. 只读路径可以先迁移；文件写入、命令、网络和外部副作用只有在 Runtime Safety Monitor、PolicyLease、ApprovalPort 和 Verifier 同时接通后才能开放。

首版 UI 增加五个可折叠面板：

1. **任务分析**：任务类别、风险标签、分类置信度。
2. **模型与角色**：分别配置 Planner、Executor、Verifier 的固定模型或批准集合、Agent Profile、预算和回退链；显示本次解析结果。
3. **路由解释**：候选拓扑、安全候选、各角色绑定、成本/质量/延迟估计和被过滤候选的原因。
4. **执行与验证**：Item 时间线、工具调用、Verifier 证据、停滞/诊断过程。
5. **安全历史**：当前 Safety Profile、治理等级、策略变更和收紧/放开原因。

当前 UI 中的“允许执行”只能解析服务端审批请求；未来还要显示 `Safety Gate` 的结果。两者不是同一个动作：Gate 决定候选能否进入执行，Runtime Safety Monitor 决定是否签发一次性 PolicyLease，服务端审批决定某一次具体动作是否继续。

## 13. 分阶段实现计划

### Phase 0：设计与契约（长期基线已完成）

- 固化总体设计、长期规范索引和 ArkTS 接口契约；
- 固化 Planning/Execution/Verification 角色配置、模型注册表、执行拓扑和回退语义；
- 固化 HarnessFacade、Coordinator、AgentCore、RoleSessionManager 与四类领域端口的依赖方向；
- 确定事件、画像、策略级别和数据脱敏规则；
- 给 App Server adapter 加版本兼容策略；
- 明确测试场景和验收指标；
- 使用 ADR 固化端口分层、事件状态、PolicyLease、本地运行时优先和结构化 Agent Decision Trace 等长期决策。

### Phase 0.5：App Server Adapter 合规基线

- 按目标 App Server 版本生成/校验 schema，并实现 `CodexWireProfile`；
- 修正 `jsonrpc` framing、审批/沙箱枚举和 server request decision；
- 增加 `model/list`、Thread/Turn 的 model/effort 参数和 capability discovery；
- 定义 `ModelInvocationPort`、`ExecutorPort`、`WorkspacePort`、`ApprovalPort`，由 `CodexAppServerAdapter` 包装现有 Session/Transport；
- 增加握手、单帧 JSON、JSONL、Thread/Turn、模型切换、文件 API、审批、未知事件和断线场景的协议回放测试；
- 保持旧 `CodexSession`/`CodexTransport` API 可用，确保当前 UI 和 Mock 回归不破坏。

### Phase 1：只读、可解释 MVP

- 实现 `HarnessFacade`、`HarnessReadModel` 和只管理状态迁移的 `HarnessCoordinator`；
- 实现 `RuleTaskClassifier`、TaskSafetyPrecheck、CandidateSafetyFilter 和确定性 `RuleRouter`；
- 实现静态 `ModelRegistry`、`RoleBindingResolver` 和最小 `RoleSessionManager`，支持 Planner/Executor/语义 Verifier 分别使用 `PINNED` 或 `ALLOW_LIST` 配置；
- 预留 `ModelSelector` 的 `CANDIDATE_SET` 扇出模式与 `SELECT_CANDIDATE` 决策类型契约，默认 `fanout = 1` 以保持单候选行为；
- 只开放工作区范围内的读取、搜索、解释和静态分析，不开放文件写入、shell、网络或外部副作用；
- 实现 relationalStore 的 Trajectory 和最小 Capability/Safety Profile；
- 实现 `DecisionTraceRecorder`/projection：所有关键 Agent 决策保存候选、证据、选择、预期和不可变 decision-time feature snapshot，并在验证后关联 Outcome；
- 实现 RuleVerifier：目标覆盖、动作进展、重复检测、路径范围和基本证据检查；
- 实现最小的只读 Memory Journal：按完成运行生成脱敏候选，不自动修改 Profile；
- 固化 Deliberation 契约和 Mock Council，不在首版默认开启多 Agent 执行；
- 将当前聊天 UI 从直连 Session 迁移到 HarnessFacade，并展示分类、路由、验证和安全状态；
- Mock Executor 覆盖允许、确认、拒绝、失败和停滞场景。

这一阶段不需要学习策略，目标是在没有可写副作用的条件下获得真实可审计轨迹，并验证 Facade、Coordinator、RoleSessionManager、Router 和 Verifier 的依赖方向。

### Phase 1.5：受控写入闭环

- 实现 ActionIntent、Runtime Safety Monitor、一次性 PolicyLease、ApprovalPort 和 lease 过期/撤销；
- 只有完成上述闭环后，才开放文件写入、补丁、构建、测试、命令和受限网络；
- Planner、Executor 和语义 Verifier 默认使用独立 RoleContextHandle；共享 Thread 必须显式配置且每次 Turn 明确模型；
- ExecutorPort 校验 lease 与动作指纹、scope、有效期一致，Adapter 不接受无 lease 的副作用请求；
- Verifier 对每个写入/命令步骤输出证据，失败、断线、超时、用户拒绝和未知协议均 fail-closed；
- 增加审批前无副作用、拒绝后不继续、越界路径阻断、重复命令停滞和回滚/停止场景测试。

### Phase 2：插件化与 Executor 扩展

- manifest、registry、版本/hash 校验和 quarantine；
- Skill/Agent/Verifier 插件接口；
- Agent roster、独立上下文、只读快照和 Council 成员权限配置；
- 完善 Codex App Server 的 Thread resume/list/fork、ephemeral fork 和用户输入请求；
- WebSocket 认证、TLS、超时、指数退避和服务端过载处理；
- 增加 HAP/设备端的权限与数据保护测试。

### Phase 3：Verifier 闭环与可配置规划/执行角色

- 多维 Verifier 报告和停滞检测；
- 实现同角色多候选扇出与 `CandidateSelectionPolicy`：并发生成、确定性硬淘汰、Jev 选择、选择闭环和扇出预算；
- PlanningRole 多假设诊断、Verifier 排序、ExecutionRole 最小 Probe；
- 支持角色级模型回退、预算升级和能力/成本画像，并保留 Luna/Sol 作为可选迁移预设；
- Probe 预算、最大升级次数和失败收敛；
- 轨迹中的 credit/blame 和 Router 事后评价。

### Phase 3.5：受约束多 Agent 审议

- 实现 `DeliberationGate`、`AgentCouncil`、`DebateProtocol` 和 `ConsensusJudge`；
- 先实现 `PLAN_REVIEW`、`FAULT_DEBATE` 和 `PATCH_REVIEW` 三种模式；
- Explorer/Reviewer 默认只读，ExecutionRole 只能执行 Judge 生成且重新通过 Safety Gate 的 `DecisionPacket`；
- 增加独立提案、定向质疑、有限修订、Probe 和 `ABSTAIN` 场景的回放测试；
- 用单 Agent 基线对比 solve rate、Verifier pass rate、成本、延迟、回归率和错误共识率。

### Phase 3.6：Dreaming 与 Memory Consolidation

- 实现 DreamScheduler、项目级锁、空闲/会话数/时间门控和可取消任务；
- 实现 Orient/Gather/Consolidate/Verify/Review/Prune 流程；
- 增加 MemoryVerifier、来源追踪、脱敏、冲突检测和候选审核 UI；
- 只允许低风险项目记忆按设置自动发布，安全记忆和 Profile Proposal 必须单独审查；
- 用历史 Trajectory 回放评估记忆是否降低重复工作，而不是只看模型主观评价。

### Phase 4：安全反向治理

- Safety Profile 驱动的逐级收紧；
- 安全历史达到门槛后的逐级放开；
- 人工审查、策略版本、审计导出和 quarantine 恢复流程；
- 安全事件告警和工作区/插件级隔离。

### Phase 5：受约束的策略优化

- 先离线回放历史 Trajectory，比较规则 Router 与候选策略；
- Bandit 先 shadow，再在 Safety Gate 过滤后的集合内小流量探索；
- 任何策略变更必须有版本、回滚点、离线评估和安全回归；
- 以成本、质量、延迟优化为目标，Safety 不参与可被抵消的加权总分。

## 14. 分阶段验收标准

所有场景都必须能在 UI 和 Trajectory 中解释。每一阶段只为已经具备安全闭环的能力放行，不能用后续规划替代本阶段的硬性验收。

### 14.1 Phase 0.5：App Server Adapter

1. 当前支持的官方 App Server 消息可以通过固定样例回放；`jsonrpc` framing、枚举值、审批结果和未知消息行为都有自动化测试。
2. Adapter 能发现可用模型、解析 Planner/Executor/Verifier 的角色绑定，并把实际模型、配置来源和回退原因写入 Trajectory。
3. `CodexAppServerAdapter` 分别满足 `ModelInvocationPort`、`ExecutorPort`、`WorkspacePort` 和 `ApprovalPort` 的契约测试，Core 不接触 Codex wire 类型。
4. 旧 `CodexSession`、`CodexTransport`、现有页面和 Mock 回归保持可用；不支持的协议能力被显式标记为 unavailable，而不是静默降级。
5. 网络断开、服务端错误、协议未知事件和超时均 fail-closed，不会触发未经确认的副作用。

### 14.2 Phase 1：只读、可解释 MVP

1. 总结、解释、搜索和静态检查任务被分类为 `EXPLAIN/INSPECT`，只在安全候选集合内选择角色与模型。
2. UI 只通过 `HarnessFacade` 提交命令并订阅 `HarnessReadModel`；页面不直接调用 `CodexSession`、Transport 或 Executor。
3. `HarnessCoordinator` 只维护 `TaskRun` 状态机，Agent Core 只依赖领域端口；Core、Router、Safety、Agent 和 Rule Verifier 不导入 Codex JSON-RPC/WebSocket 类型。
4. Planner、Executor 的解析结果及 `RoleContextHandle` 可回放；Jev 使用独立的有界决策输入，不能继承可写执行上下文；共享上下文必须显式配置，角色切换不会继承未声明的模型默认值。
5. 每次运行都记录分类、任务预检、候选过滤、路由、角色绑定、只读动作、Rule Verifier 证据、Jev 判断和最终结果；每个由 Agent 产生的关键决策在下游效果前有 committed Decision，包含候选、证据、选择和预期，结算后关联独立 Outcome。确定性 RuleRouter/Safety 继续使用各自权威事件。
6. Phase 1 不开放写文件、命令、测试执行或外部网络副作用；此类 `ActionIntent` 必须被拒绝或提示该能力尚未启用，并且不产生实际副作用。
7. 决策轨迹可以重建可观察选择序列，常规数据库、日志、UI 和导出不包含系统提示、reasoning token 或隐藏思维链；学习导出不存在 outcome leakage。

### 14.3 Phase 1.5：受控写入闭环

1. 文件修改、测试、命令和网络动作先形成 `ActionIntent`，经运行时 Safety Monitor 判定为 `CONFIRM`、`SANDBOX` 或更严格状态后，才可能获得一次性 `PolicyLease`。
2. `ExecutorPort` 在执行前校验租约的主体、动作、路径/网络 scope、工作区版本、过期时间和使用次数；不匹配、过期或重复使用均拒绝。
3. 用户拒绝、审批超时、连接断开、服务端错误、未知插件、数据库关键写入失败和 Jev 不确定性不会导致后续副作用；系统暂停、回滚可回滚步骤或 fail-closed。
4. PlanningRole、ExecutionRole、Jev Decision Plane 和 Council 默认使用隔离上下文；只有一个持有效租约的 ExecutionRole 可以修改目标工作区。
5. 每个副作用动作都能从 UI/Trajectory 追溯到候选过滤、Jev 决定、`ActionIntent`、SafetyDecision、审批、PolicyLease、执行事件和 Rule Verifier/Jev 结论。
6. 删除、越权路径、凭据外泄和未授权外部副作用会被任务预检、候选过滤或运行时监控阻断；Router 不能重新选择已被安全层排除的候选。

### 14.4 后续阶段

1. Rule Verifier 发现事实异常或 Jev 判断重复动作/无新证据时标记停滞；PlanningRole 生成多个假设，Jev 从有界 Probe 候选中选择，ExecutionRole 只执行有预算的最小 Probe。
2. 发生安全事件时，Safety Profile 立即收紧，后续动作被阻断；恢复必须经过隔离、观察和逐级放开。
3. Dreaming 只读取脱敏历史并生成带来源的 MemoryProposal；未经审核不能改变安全权限、执行代码或覆盖原始 Trajectory。
4. 复杂跨文件任务可以触发 Agent Council；提案、质疑、Jev 决定和最终 Probe 都能在 UI/Trajectory 中回放。
5. Council 达成错误共识、意见无法收敛或达到预算上限时，系统能 `ABSTAIN`、回到单 Agent + Rule Verifier + Jev 或请求用户，而不是无限讨论。
6. 多 Agent 方案只有在固定评估窗口内相对单 Agent 基线改善质量/成功率且成本增幅可接受时，才允许提高自动触发比例。

## 15. 主要风险与验证门

- **App Server 暴露面**：本地客户端优先通过 stdio、Unix socket 或 loopback 连接本机 App Server；远程 WebSocket 只用于明确配置的开发、试点或远程模式，并按要求配置认证和 TLS。客户端不能把 API key 或 bearer token 固化在应用包内。
- **本地 Executor**：Windows/Linux 首期以受控本地 Executor 为目标；HarmonyOS 本地执行只有在目标 API/设备完成进程、沙箱、资源、取消和恢复 POC 后启用，能力不足时明确降级为只读或兼容连接模式。
- **动态插件**：生产客户端采用随应用签名发布的编译期 ArkTS/HAR/HSP 注册；在线第三方能力走远端 Adapter。未来开放动态可执行代码必须新增 ADR、平台和供应链评审。
- **数据隐私**：Trajectory 会包含代码和命令上下文，必须提供脱敏、加密、保留期和用户清除入口。
- **决策轨迹污染与结果泄漏**：Agent 可能伪造依据、自评成功，或训练管线误把未来结果混入输入；必须冻结 decision-time snapshot、校验证据时序/身份，并只用独立 Outcome 作为标签。
- **后台任务约束**：消费者版不依赖常驻后台，首版 Dream 手动前台运行并支持 checkpoint；2in1 企业 AppServiceExtensionAbility 和自动 Dream 只有通过 ACL/设备 POC 后按 capability 启用。
- **记忆污染**：错误、过期或恶意输入可能被整理成长期记忆；所有记忆必须有来源、版本、有效期和撤回路径，安全事实保持追加式。
- **错误共识与相关失败**：多个 Agent 可能共享同一模型偏差、被第一个提案锚定，或共同相信看似合理的错误方案；必须保持独立起始、角色/模型差异、证据约束和 `ABSTAIN`。
- **成本与并发**：并行 Council 会增加 token、连接、数据库和工作区压力；人数、轮数、上下文、并发和预算必须硬限制，简单任务默认不触发。
- **并发写入与合并冲突**：多个 Agent 不能直接修改同一工作区；方案阶段使用只读快照，实际修改只由一个受 PolicyLease 控制的 Executor 完成。
- **Facade 状态一致性**：UI 只读模型可能落后于 Coordinator 的真实状态；命令必须携带 `TaskRun`/版本标识并支持幂等，不能根据过期 UI 状态直接执行副作用。
- **角色上下文串扰**：共享 Thread、缓存或工具状态可能让 Planner、Executor、Verifier 相互污染；默认隔离，显式共享也必须记录边界和清理策略。
- **Adapter 边界侵蚀**：为快速兼容而让 Core 依赖 Codex 事件或在旧 `CodexTransport` 上继续叠加职责，会把供应商协议重新耦合进核心；需要依赖规则和契约测试持续阻止反向引用。
- **跨 Agent 注入**：仓库内容、工具输出和其他 Agent 消息都可能包含恶意指令；消息按不可信数据处理，不能改变角色权限或 Safety Profile。
- **画像冷启动**：无历史数据时采用保守策略；不能因为候选新、模型新或插件新就自动获得 ALLOW。
- **模型注册与回退漂移**：provider、模型 ID、能力声明和可用性会变化；每次解析都要校验注册表并保存快照，回退链不得改变权限上限或绕过候选安全过滤。
- **Verifier 偏差**：模型式 Verifier 只能作为证据之一，不能单独触发放权；确定性测试和安全规则拥有更高优先级。

这份设计保留了当前 hmCodex 已有的聊天、工作区、审批和 App Server 基础，同时把分类、可配置角色路由、受约束多 Agent 审议、验证、轨迹、安全画像和跨会话记忆提升为一等模块。后续实现应从 Phase 0.5 的协议与 Adapter 合规基线开始，再交付 Phase 1 的只读、可解释闭环；只有 Phase 1.5 的运行时安全、审批、租约和 Verifier 闭环全部通过，才开放写入与命令能力。Deliberation、Dreaming、角色级自适应升级和策略学习均由真实轨迹评估结果决定是否启用。

## 16. 长期专项规范

- [长期设计规范索引](LONG_TERM_DESIGN_INDEX.md)
- [Harness Protocol](PROTOCOL_SPEC.md)
- [状态机](STATE_MACHINE.md)
- [数据模型](DATA_MODEL.md)
- [Agent Decision Trace 规范](DECISION_TRACE_SPEC.md)
- [安全模型](SECURITY_MODEL.md)
- [Plugin 规范](PLUGIN_SPEC.md)
- [部署拓扑](DEPLOYMENT_TOPOLOGY.md)
- [HarmonyOS 平台规范](HARMONYOS_PLATFORM.md)
- [评价与发布治理](EVALUATION_PLAN.md)
- [运维与隐私](OPERATIONS_AND_PRIVACY.md)
- [UI/UX 规范](UI_UX_SPEC.md)
- [Architecture Decision Records](adr/README.md)

## 17. 参考

- [OpenAI Codex repository](https://github.com/openai/codex)
- [Codex App Server documentation](https://developers.openai.com/codex/app-server)
- [HarmonyOS WebSocket data transmission](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V5/network-kit-data-transmission-V5)
- [Claude Code memory documentation](https://code.claude.com/docs/en/memory)
- [Anthropic: Dreaming in Claude Managed Agents](https://claude.com/blog/new-in-claude-managed-agents)
- [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325)
- [Should we be going MAD? A Look at Multi-Agent Debate Strategies for LLMs](https://proceedings.mlr.press/v235/smit24a.html)
- [SWE-Debate: Competitive Multi-Agent Debate for Software Issue Resolution](https://arxiv.org/abs/2507.23348)
- [Claude Platform: Multiagent orchestration](https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration)
