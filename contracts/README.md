# dda 跨平台契约目录

这里是 HarmonyOS、Windows 和 Linux 客户端及其本地运行时共用的协议事实源。Gateway 仅在未来远程模式中复用这些契约，不是本地客户端的必需组件。

## 规则

- 领域命令、事件、错误、ContextSummary 和能力快照以版本化 JSON Schema 固化；
- Codex JSON-RPC、OpenViking REST/MCP 和平台 API 不得直接出现在跨平台领域契约中；
- 每个协议版本配握手、Turn、审批、断线、未知事件和 OpenViking 降级 fixture；
- fixture 是跨平台回归输入，ArkTS、TypeScript、Rust 和本地运行时实现都必须通过同一行为断言；
- 凭据、完整源代码、隐藏思维链和 provider 原始 token 不得进入契约或 fixture。

当前规范来源：

- [Harness Protocol](../docs/PROTOCOL_SPEC.md)
- [多平台架构](../docs/MULTI_PLATFORM_ARCHITECTURE.md)
- [Agent Decision Trace](../docs/DECISION_TRACE_SPEC.md)
- [安全模型](../docs/SECURITY_MODEL.md)

首个实际 schema/fixture 在完成 Phase A 协议抽取时加入；在此之前不得让桌面端自行复制 `CodexProtocol.ets` 的供应商字段。

## 已落地契约

- `v1/harness-read-model.schema.json`：Windows MVP 使用的只读 UI 投影。
- `v1/fixtures/harness-read-model.ready.json`：桌面端 Mock 与契约测试共享的就绪状态。
- `v1/runtime-event.schema.json`：runtime 到桌面端的有序 JSONL 事件 envelope。
- `v1/action-intent.schema.json`：受控动作的不可变摘要、工作区快照和策略版本约束；requestSummary 覆盖命令、文件路径和网络目标（host/port/scheme/method）。
- `v1/verifier-report.schema.json`：确定性 Verifier 的状态和检查项。
- `v1/agent-decision.schema.json`：provider-neutral Agent Decision Trace（候选、证据、选择和预期），不含 prompt 或隐藏思维链。
- `v1/decision-outcome.schema.json`：Decision 的执行/验证/用户反馈结果关联。
- `v1/execution-state.schema.json`：持久化执行状态容器，约束 intent、approval 和 lease 记录的判别联合。
- `v1/execution-approval.schema.json`：Approval 状态机记录（`REQUESTED → PRESENTED → APPROVED/...`）。
- `v1/execution-lease.schema.json`：一次性 PolicyLease 状态机记录（`PROPOSED → ACTIVE → CONSUMING → CONSUMED`）。
- `v1/trajectory-record.schema.json`：本地脱敏 TrajectoryStore 的内部追加记录，要求协议、应用、存储、策略和生产者版本元数据。
- `v1/harness-event.schema.json`：跨平台持久事件的完整 envelope；适配器应在写入共享事件流前补齐 correlation、policy、producer 和 storage metadata。
- `runtime/src/harness-event-adapter.mjs`：将本地 Trajectory 记录适配为上述 canonical Harness Event；保留 event identity，并对缺失/非法 digest fail closed。
- `v1/fixtures/runtime-event.approval-requested.json`：审批请求事件的跨层 fixture。
- `v1/fixtures/execution-approval.presented.json` 与 `execution-lease.active.json`：受控状态机 fixture。
- `v1/fixtures/trajectory-record.task-created.json`：本地轨迹追加记录 fixture。

`runtime-event.schema.json` 是短期实时 UI 流的轻量 envelope；它与 `trajectory-record.schema.json`（本地存储格式）及 `harness-event.schema.json`（跨平台持久事件格式）刻意分离。Trajectory 写入器必须在最终落盘前补齐版本元数据；尚未补齐的旧记录只能由迁移/适配器处理，不能直接宣称符合共享契约。ReadModel `1.0` 仍保持默认只读兼容；受控任务的 Approval、PolicyLease、ActionIntent 和 Verifier 通过独立契约表达，避免把安全状态折叠成一个布尔字段。命令执行和文件写入仍必须由 runtime 的 Safety Monitor、一次性 Lease 和用户 Approval 共同授权。
