# hmCodex 多平台长期设计规范索引

版本：v1.2
状态：长期开发基线（Baseline）  
适用范围：HarmonyOS、Windows、Linux 客户端及其本地运行时的 Agent Harness。远程 Gateway 只属于可选连接模式；HarmonyOS 专属约束由 `HARMONYOS_PLATFORM.md` 单独规定。

## 1. 目的

本规范集把 `AGENT_HARNESS_DESIGN.md` 中的总体架构拆成可实现、可测试、可演进的长期契约。总体设计负责说明目标、边界和路线；本索引下的专项规范负责回答“具体如何实现”和“发生冲突时以谁为准”。

规范中的 **MUST/必须** 表示发布阻断条件，**SHOULD/应当** 表示默认规则，偏离时必须有 ADR，**MAY/可以** 表示兼容实现选择。

## 2. 规范权威顺序

发生冲突时按以下顺序处理：

1. `SECURITY_MODEL.md`：权限、信任边界、隐私和 fail-closed 规则。
2. `PROTOCOL_SPEC.md`、`STATE_MACHINE.md`、`DATA_MODEL.md`、`DECISION_TRACE_SPEC.md`：命令、事件、状态、持久化事实和 Agent 决策轨迹。
3. `DEPLOYMENT_TOPOLOGY.md`、`PLUGIN_SPEC.md`、`HARMONYOS_PLATFORM.md`：部署、扩展与平台能力。
4. `EVALUATION_PLAN.md`、`OPERATIONS_AND_PRIVACY.md`、`UI_UX_SPEC.md`：发布门槛、运行治理和交互。
5. `AGENT_HARNESS_DESIGN.md`：总体说明；不得覆盖专项规范中的硬约束。

如果同一层内存在矛盾，停止实现相关能力，新增 ADR 明确选择并同步修订所有受影响规范。

## 3. 文档地图

当前 Windows 剩余功能与验收执行入口：[阶段四实施计划](WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md)及[验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)。Linux 当前采用无界面 CLI 路线，实施入口为[Linux CLI 实施计划](LINUX_CLI_IMPLEMENTATION_PLAN.md)及配套契约文档。本轮 Linux 只规划和实现 CLI 应用层、平台适配层与本地 runtime 接入，不引入 Tauri GUI。App Server 接入已按用户要求取消。本索引中相关历史适配设想不构成当前 Windows 或 Linux CLI 的实现前置条件。

| 文档 | 负责内容 | 首次阻断阶段 |
| --- | --- | --- |
| [PROTOCOL_SPEC.md](PROTOCOL_SPEC.md) | 领域命令、事件、Port、错误、流式语义、Codex wire 映射 | Phase 0.5 |
| [STATE_MACHINE.md](STATE_MACHINE.md) | TaskRun、Approval、PolicyLease、RoleContext 的状态和恢复 | Phase 1 |
| [DATA_MODEL.md](DATA_MODEL.md) | relationalStore schema、事务、回放、迁移、保留 | Phase 1 |
| [DECISION_TRACE_SPEC.md](DECISION_TRACE_SPEC.md) | Agent/Jev 决策点、候选/证据/结果、Decision DAG、学习样本与思维链边界 | Phase 1 |
| [SECURITY_MODEL.md](SECURITY_MODEL.md) | 威胁模型、轨迹完整性、策略顺序、租约、路径/命令/网络和事件响应 | Phase 1（轨迹）；Phase 1.5（副作用） |
| [PLUGIN_SPEC.md](PLUGIN_SPEC.md) | manifest、ABI、权限、签名、生命周期、隔离与升级 | Phase 2 |
| [DEPLOYMENT_TOPOLOGY.md](DEPLOYMENT_TOPOLOGY.md) | 本地/远端/企业拓扑、身份、TLS、离线和故障转移 | Phase 0.5 |
| [MULTI_PLATFORM_ARCHITECTURE.md](MULTI_PLATFORM_ARCHITECTURE.md) | Windows/Linux/HarmonyOS 单客户端、本地运行时与可选远程模式 | Phase 0.5 |
| [LINUX_CLI_IMPLEMENTATION_PLAN.md](LINUX_CLI_IMPLEMENTATION_PLAN.md) | Linux CLI 分阶段实施、工作包、核心冻结范围与验收矩阵 | Linux L0 |
| [LINUX_CLI_CONTRACT.md](LINUX_CLI_CONTRACT.md) | Linux CLI 命令、JSONL、退出码、路径、信号和 Approval 契约 | Linux L0 |
| [LINUX_PLATFORM_ADAPTER_DESIGN.md](LINUX_PLATFORM_ADAPTER_DESIGN.md) | XDG 路径、POSIX 进程、环境、Executor 和平台身份边界 | Linux L2 |
| [adr/0023-linux-cli-client.md](adr/0023-linux-cli-client.md) | Linux 无界面 CLI 架构决策 | Linux L0 |
| [JEV_DECISION_PLANE_DESIGN.md](JEV_DECISION_PLANE_DESIGN.md) | Jev 证据决策、候选选择、工具门禁、行为判断与渐进迁移 | Phase 1.5 |
| [HARMONYOS_PLATFORM.md](HARMONYOS_PLATFORM.md) | ArkTS/ArkUI/Kits、并发、后台、文件和设备能力门控 | Phase 0.5 |
| [EVALUATION_PLAN.md](EVALUATION_PLAN.md) | 基线、数据集、指标、灰度、学习策略和回滚 | Phase 1 |
| [OPERATIONS_AND_PRIVACY.md](OPERATIONS_AND_PRIVACY.md) | 日志、遥测、容量、加密、保留、导出、删除和支持包 | Phase 1 |
| [UI_UX_SPEC.md](UI_UX_SPEC.md) | PC 信息架构、read model、审批、回放、无障碍和错误恢复 | Phase 1 |
| [adr/README.md](adr/README.md) | 架构决策记录流程与已接受决策 | 全阶段 |

## 4. 稳定契约与实现自由

长期稳定、不得由 Adapter 自行改变的契约：

- 领域 ID、事件 envelope、聚合版本和幂等语义；
- `TaskRun`、Approval、PolicyLease 的合法状态迁移；
- `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort` 的副作用链；
- Agent 关键决策的 `DecisionCommitted → downstream effect → DecisionOutcomeLinked` 顺序和不可变 decision-time snapshot；
- Core 仅依赖领域 Port，UI 仅依赖 `HarnessFacade`/`HarnessReadModel`；
- Safety deny precedence、权限上限和审计要求；
- Profile 更新必须基于可回放证据，不能直接扩大权限。

实现可以替换但必须通过契约测试的部分：

- Codex App Server、其他模型提供方和 Executor Adapter；
- relationalStore 的查询优化、索引和投影实现；
- Planner/Executor 的模型与提示、Jev Decision Engine 的 provider 适配；
- Router 算法、Rule Verifier 插件和 UI 视觉主题；
- 在平台允许范围内的后台与并发实现。

## 5. 版本体系

项目同时维护五类版本：

| 版本 | 示例 | 兼容含义 |
| --- | --- | --- |
| App 版本 | `1.3.0` | 用户可见产品版本，遵循 SemVer |
| Harness Protocol | `1.1` | 领域命令/事件/Port schema；major 破坏兼容，minor 只增可选字段或新 kind |
| Storage Schema | `7` | 单调整数；应用启动时执行显式迁移 |
| Plugin API | `1.2` | manifest 与插件 Port ABI；插件声明兼容范围 |
| Decision Trace | `1.0` | Agent Decision/Option/Evidence/Outcome schema；记录携带版本并独立校验 |

每个 Trajectory 事件必须记录 `protocolVersion`、`storageSchemaVersion`、`appVersion`、`policyVersion` 和产生事件的 Adapter/Plugin 版本。Agent Decision 还必须记录其 `schemaVersion`、binding/prompt template/feature snapshot 版本。Codex wire schema 使用独立 `adapterProtocolVersion`，不得冒充 Harness Protocol 版本。

## 6. 兼容与弃用政策

- 领域协议 minor 版本必须向后读取至少两个已发布 minor 版本。
- 数据库只保证逐版本向前迁移；跳跃迁移由顺序迁移组成，不直接猜测旧状态。
- 删除字段前至少经历一个发布周期的 deprecated 状态；Reader 先兼容，Writer 后停写，最后迁移删除。
- 未识别的事件 kind 必须保留原始 envelope，并把对应聚合置为 `PAUSED_UNSUPPORTED`；不得静默跳过影响权限或状态的事件。
- 未识别的可选显示事件可以降级为通用时间线项，但不得参与状态计算。
- 实验能力默认关闭，必须通过 capability negotiation、功能开关和独立 Trajectory 标记启用。

## 7. 设计变更流程

涉及以下任一内容必须新增 ADR：

- 改变依赖方向、信任边界或副作用执行链；
- 新增持久化聚合、外部执行拓扑或可执行插件形式；
- 修改 Harness Protocol major、Plugin API major 或 Profile 放权逻辑；
- 引入新的长期后台能力、跨设备同步或自动学习策略；
- 降低确认、沙箱、审计或数据保护要求。

变更顺序：提出 ADR → 威胁与兼容评审 → 更新专项规范 → 加契约/迁移/安全测试 → shadow/canary → 发布。代码先于规范合入属于流程错误。

## 8. 阶段发布门

### Phase 0.5

- 固定目标 Codex 版本及生成的 wire schema hash；
- 领域 Port、错误和事件 envelope 编译通过；
- 协议回放、初始化、过载、断线和未知消息测试通过；
- 明确当前设备可用的 WebSocket/TLS/凭据能力。

### Phase 1

- 只读 `TaskRun` 全状态路径可回放和崩溃恢复；
- read model 可以从事件表全量重建；
- 所有关键 Agent 决策先于下游效果持久化，Decision DAG、候选、证据和 outcome 可回放，`decisionCoverage=100%`；
- 无任何写工作区、shell 或外部网络副作用；
- 基准、隐私、容量和支持包最小能力上线。

### Phase 1.5

- Security Model 中所有 P0 威胁有确定性测试；
- Approval 与 PolicyLease 状态机、单次消费和撤销测试通过；
- 路径、命令、网络和秘密扫描在 Executor 权威侧再次校验；
- 未授权副作用率必须为零。

后续阶段分别受 Plugin、Evaluation、Dreaming 和多 Agent 的专项门槛约束，不能因产品时间表绕过。

## 9. 完备性定义

“长期设计完备”不表示未来没有新问题，而表示：

1. 每个外部输入、状态变化和副作用都有唯一的权威契约；
2. 每个故障都能映射为显式状态、错误类别和恢复路径；
3. 每个持久化事实可迁移、可回放、可删除或有明确保留理由；
4. 每个权限都能追溯到策略、审批和一次性租约；
5. 每个可替换组件都有版本、能力协商和契约测试；
6. 每个自动优化都有基线、发布门、回滚点和安全硬约束。
7. 每个关键 Agent 决策都能还原当时可见事实、候选、选择与预期，并与独立结果关联；不依赖或保存隐藏思维链。

满足上述定义后，可以长期增量演进，而不需要重写核心。
